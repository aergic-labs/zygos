/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SshTunnel: a small HTTP service on the remote, reached through the
 * existing SOCKS5 forward. Handles file transfers and spawn-with-stdin,
 * unclogging the ssh session shell.
 *
 * Bundled to dist/sshTunnel.js. No vscode dependency. The resolver starts
 * it with the remote node binary from the IDE server install.
 *
 * Config via argv: --token-file, --port, --port-file, --root. The bearer
 * token is read from a chmod 600 file, never environ.
 *
 * Routes (Bearer token required, timing-safe):
 *   PUT   /file?p=<path>&mode=<octal>  stream body to file
 *   GET   /file?p=<path>               stream file as body
 *   POST  /exec                        run command with stdin (buffered)
 *   POST  /spawn                       run command with stdin from temp (streaming)
 *
 * Paths must resolve under the configured root (default: user home).
 * Binds 127.0.0.1 only; reachable only through the SOCKS tunnel
 * (ssh-encrypted, ssh-authenticated).
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { timingSafeTokenCompare } from "../remote/shellQuote";

// --- Types ---

export interface TunnelConfig {
  /** Directory all file operations must stay under. */
  root: string;
  /** Directory for service-allocated temp files (stdout/stderr/exit). */
  tmpDir: string;
  /** Port to listen on (0 = pick free). */
  port: number;
  /** Where to write the actual port once listening. */
  portFile: string;
}

export interface SpawnRequest {
  command: string;
  args?: string[];
  stdinPath?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** POST /exec request. Runs `command` via `sh -c` with optional stdin.
 *  Buffered: returns stdout/stderr/exitCode in one response. For
 *  streaming spawn, use /spawn instead. */
export interface ExecRequest {
  command: string;
  /** stdin bytes, base64. Omit for no stdin. */
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** POST /exec response. stdout/stderr are base64 to handle binary. */
export interface ExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export interface SpawnResponse {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
}

export interface TunnelState {
  config: TunnelConfig;
  tokenHex: string;
  /** Refreshed on every authenticated request; the idle timer in main()
   *  reads it to decide self-exit. Optional: unit tests omit it. */
  lastActivity?: number;
}

// --- Path validation ---

/** Resolve a path under root, or throw. Rejects traversal (..) and
 *  absolute paths that escape root. */
export function resolveUnderRoot(root: string, requested: string): string {
  const cleanRoot = path.resolve(root);
  const resolved = path.resolve(cleanRoot, requested);
  if (resolved !== cleanRoot && !resolved.startsWith(cleanRoot + path.sep)) {
    throw new Error(`path outside root: ${requested}`);
  }
  return resolved;
}

// --- Token validation ---

export function validTunnelToken(state: TunnelState, provided: string | undefined): boolean {
  return timingSafeTokenCompare(provided, state.tokenHex);
}

// --- Idle timer ---

/** True when idle past the timeout. main() polls it; `idleTimeoutMs <= 0`
 *  disables. Exported for tests. */
export function idleTimedOut(
  lastActivity: number,
  now: number,
  idleTimeoutMs: number,
): boolean {
  if (idleTimeoutMs <= 0) return false;
  return now - lastActivity >= idleTimeoutMs;
}

// --- Request handlers ---

export async function handleTunnelRequest(
  state: TunnelState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const token = auth.slice(7);
  if (!validTunnelToken(state, token)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  // Authenticated request: refresh the idle deadline. The 401/403 paths
  // above don't, so a port scan can't keep an idle tunnel alive.
  state.lastActivity = Date.now();

  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const pathParam = url.searchParams.get("p") ?? "";
  tlogMsg(`[ssh-tunnel] ${req.method} ${p}${pathParam ? ` p=${pathParam}` : ""}`);

  if (p === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === "/file" && req.method === "PUT") {
    return handlePutFile(state, url, req, res);
  }
  if (p === "/file" && req.method === "GET") {
    return handleGetFile(state, url, res);
  }
  if (p === "/spawn" && req.method === "POST") {
    return handleSpawn(state, req, res);
  }
  if (p === "/exec" && req.method === "POST") {
    return handleExec(state, req, res);
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

/** PUT /file?p=<path>&mode=<octal>: stream body to file. */
async function handlePutFile(
  state: TunnelState,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const rawPath = url.searchParams.get("p");
  if (!rawPath) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing path" }));
    return;
  }
  let resolved: string;
  try {
    resolved = resolveUnderRoot(state.config.root, rawPath);
  } catch {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "path rejected" }));
    return;
  }

  const modeStr = url.searchParams.get("mode");
  const mode = modeStr ? parseInt(modeStr, 8) : undefined;

  const dir = path.dirname(resolved);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* may exist */ }

  // Write to a temp then rename, so a partial upload never leaves
  // a half-written file at the target path.
  const tmp = resolved + ".partial." + process.pid;
  const writeStream = fs.createWriteStream(tmp, { mode });
  let errored = false;

  req.pipe(writeStream);

  writeStream.on("finish", () => {
    if (errored) return;
    try {
      fs.renameSync(tmp, resolved);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `rename failed: ${errMessage(err)}` }));
    }
  });

  writeStream.on("error", (err) => {
    errored = true;
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `write failed: ${err.message}` }));
    }
  });

  req.on("error", (err) => {
    errored = true;
    writeStream.destroy();
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upload failed: ${err.message}` }));
    }
  });
}

/** GET /file?p=<path>&offset=<n>: stream file as body, starting at byte offset.
 *  Used by clients polling growing files (spawn stdout/stderr); avoids
 *  re-transferring the whole file each poll. */
async function handleGetFile(
  state: TunnelState,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const rawPath = url.searchParams.get("p");
  if (!rawPath) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing path" }));
    return;
  }
  let resolved: string;
  try {
    resolved = resolveUnderRoot(state.config.root, rawPath);
  } catch {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "path rejected" }));
    return;
  }

  const offsetStr = url.searchParams.get("offset");
  const offset = offsetStr ? parseInt(offsetStr, 10) || 0 : 0;

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(resolved, { start: offset });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
    }
    return;
  }

  // Wait for the file to open before sending 200. If the file is
  // missing, createReadStream emits 'error' (ENOENT) asynchronously,
  // and we need to send 404 instead of a premature 200.
  stream.on("open", () => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    stream.pipe(res);
  });
  stream.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (!res.headersSent) {
      if (e.code === "ENOENT") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      } else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `read failed: ${e.message}` }));
      }
    } else {
      res.destroy();
    }
  });
}

/** POST /spawn: run command with stdin from a temp file. */
export async function handleSpawn(
  state: TunnelState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  let body: SpawnRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }

  if (!body.command || typeof body.command !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing command" }));
    return;
  }

  let stdinPath: string | undefined;
  if (body.stdinPath) {
    try {
      stdinPath = resolveUnderRoot(state.config.root, body.stdinPath);
    } catch {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stdinPath rejected" }));
      return;
    }
  }

  // Allocate temp files for stdout/stderr/exit.
  const id = crypto.randomBytes(8).toString("hex");
  const tmpDir = state.config.tmpDir;
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* may exist */ }
  const stdoutPath = path.join(tmpDir, `${id}.out`);
  const stderrPath = path.join(tmpDir, `${id}.err`);
  const exitPath = path.join(tmpDir, `${id}.exit`);

  const outFd = fs.openSync(stdoutPath, "w", 0o600);
  const errFd = fs.openSync(stderrPath, "w", 0o600);

  let inFd: number | undefined;
  if (stdinPath) {
    try {
      inFd = fs.openSync(stdinPath, "r");
    } catch (err) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      try { fs.unlinkSync(stdoutPath); } catch { /* best effort */ }
      try { fs.unlinkSync(stderrPath); } catch { /* best effort */ }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `cannot open stdin: ${errMessage(err)}` }));
      return;
    }
  }

  const child = spawn(body.command, body.args ?? [], {
    cwd: body.cwd,
    env: body.env ?? process.env,
    stdio: [inFd ?? "ignore", outFd, errFd],
    detached: false,
  });

  // Close the parent's copies; the child has its own.
  if (inFd !== undefined) fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const pid = child.pid ?? 0;

  let errorWroteExit = false;
  child.on("close", (code, signal) => {
    if (errorWroteExit) return;
    const exitCode = code ?? (signal ? 1 : 0);
    try { fs.writeFileSync(exitPath, String(exitCode), { mode: 0o600 }); } catch { /* best effort */ }
  });
  child.on("error", (err) => {
    errorWroteExit = true;
    try { fs.writeFileSync(exitPath, `1:${err.message}`, { mode: 0o600 }); } catch { /* best effort */ }
  });

  const response: SpawnResponse = { pid, stdoutPath, stderrPath, exitPath };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
}

/** POST /exec handler. Runs a shell command string via `sh -c` with
 *  optional stdin, returns stdout/stderr/exitCode buffered in one
 *  response. No temp files, no polling. For streaming, use /spawn. */
export async function handleExec(
  _state: TunnelState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  let body: ExecRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }
  if (!body.command || typeof body.command !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing command" }));
    return;
  }
  const stdin = body.stdin ? Buffer.from(body.stdin, "base64") : undefined;
  const child = spawn("sh", ["-c", body.command], {
    cwd: body.cwd,
    env: body.env ?? process.env,
    stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  if (child.stdout) child.stdout.on("data", (c: Buffer) => outChunks.push(c));
  if (child.stderr) child.stderr.on("data", (c: Buffer) => errChunks.push(c));
  if (stdin && child.stdin) {
    child.stdin.end(stdin);
  } else if (child.stdin) {
    child.stdin.end();
  }
  child.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(err) }));
    }
  });
  child.on("close", (code, signal) => {
    if (res.headersSent) return;
    const response: ExecResponse = {
      stdout: Buffer.concat(outChunks).toString("base64"),
      stderr: Buffer.concat(errChunks).toString("base64"),
      exitCode: code ?? (signal ? 1 : 0),
      signal: signal ?? undefined,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
}

// --- Main (only runs when executed directly, not imported in tests) ---

function parseArgs(argv: string[]): {
  tokenFile: string;
  port: number;
  portFile: string;
  root: string;
  pidFile: string;
  idleTimeoutMs: number;
} {
  let tokenFile = "";
  let port = 0;
  let portFile = "";
  let root = os.homedir();
  let pidFile = "";
  // Default 24h. People walk away for long stretches; a zombie that ages
  // out after a day is bounded, while a shorter value would kill tunnels
  // mid-work-session. `--idle-timeout-ms 0` disables.
  let idleTimeoutMs = 24 * 60 * 60 * 1000;

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token-file" && i + 1 < argv.length) {
      tokenFile = argv[++i];
    } else if (a === "--port" && i + 1 < argv.length) {
      port = parseInt(argv[++i], 10) || 0;
    } else if (a === "--port-file" && i + 1 < argv.length) {
      portFile = argv[++i];
    } else if (a === "--root" && i + 1 < argv.length) {
      root = argv[++i];
    } else if (a === "--pid-file" && i + 1 < argv.length) {
      pidFile = argv[++i];
    } else if (a === "--idle-timeout-ms" && i + 1 < argv.length) {
      const v = parseInt(argv[++i], 10);
      if (!Number.isNaN(v)) idleTimeoutMs = v;
    }
  }

  if (!tokenFile) {
    console.error("[ssh-tunnel] --token-file required");
    process.exit(1);
  }
  return { tokenFile, port, portFile, root, pidFile, idleTimeoutMs };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Timestamped log. Writes to stdout (captured by the resolver's redirect
 *  to ~/.ssh-remote/ssh-tunnel.log). Matches the local server's format
 *  so the two logs are greppable together. */
function tlog(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

/** Timestamped error. */
function terror(msg: string): void {
  console.error(`${new Date().toISOString()} ${msg}`);
}

// --- Syslog-style request-log dedup ---
// Collapses repeated identical request lines (mainly the /health
// heartbeat) via a single-message cache, flushed on a count ceiling
// (MAX_REPEATS) or time ceiling (MAX_DURATION). Non-request lines go
// straight to tlog().
//
// Unlike syslog, the first suppressed repeat logs a notice naming the
// collapsed line, so a quiet log stays explainable.
const TUNNEL_LOG_MAX_REPEATS = 60;
const TUNNEL_LOG_MAX_DURATION_MS = 30 * 60 * 1000;
let dedupLast = "";
let dedupCount = 0;
let dedupStartedAt = 0;

function tlogMsgDedupFlush(): void {
  if (dedupCount > 0) {
    tlog(`[ssh-tunnel] last message repeated ${dedupCount} times`);
    dedupCount = 0;
  }
}

function tlogMsg(line: string): void {
  if (line === dedupLast) {
    dedupCount++;
    if (dedupCount === 1) {
      tlog(`[ssh-tunnel] suppressing repeated logs matching: ${line}`);
    }
    const now = Date.now();
    if (
      dedupCount >= TUNNEL_LOG_MAX_REPEATS ||
      now - dedupStartedAt >= TUNNEL_LOG_MAX_DURATION_MS
    ) {
      tlogMsgDedupFlush();
      dedupStartedAt = now;
    }
    return;
  }
  tlogMsgDedupFlush();
  tlog(line);
  dedupLast = line;
  dedupStartedAt = Date.now();
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv);

  let tokenHex: string;
  try {
    tokenHex = fs.readFileSync(cfg.tokenFile, "utf-8").trim();
  } catch (err) {
    terror(`[ssh-tunnel] cannot read token file: ${errMessage(err)}`);
    process.exit(1);
  }
  if (!tokenHex || !/^[0-9a-f]+$/.test(tokenHex)) {
    terror("[ssh-tunnel] invalid token (expected hex)");
    process.exit(1);
  }

  const tmpDir = path.join(cfg.root, ".ssh-remote", "tunnel-tmp");
  const state: TunnelState = {
    config: { root: cfg.root, tmpDir, port: cfg.port, portFile: cfg.portFile },
    tokenHex,
  };
  // Seed the idle deadline at startup so a tunnel that never receives a
  // request still ages out.
  state.lastActivity = Date.now();

  const server = http.createServer((req, res) => {
    handleTunnelRequest(state, req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `internal: ${errMessage(err)}` }));
      }
    });
  });

  server.listen(cfg.port, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : cfg.port;
    if (cfg.portFile) {
      try { fs.writeFileSync(cfg.portFile, String(actualPort), { mode: 0o600 }); } catch (err) {
        terror(`[ssh-tunnel] cannot write port file: ${errMessage(err)}`);
      }
    }
    // Write our own PID so the resolver can kill us on teardown. More
    // reliable than `echo $!` from a shell string (which can capture a
    // subshell pid). Best-effort: a missing pid file means the resolver
    // can't kill us; the idle timer still bounds our lifetime.
    if (cfg.pidFile) {
      try { fs.writeFileSync(cfg.pidFile, String(process.pid), { mode: 0o600 }); } catch (err) {
        terror(`[ssh-tunnel] cannot write pid file: ${errMessage(err)}`);
      }
    }
    tlog(`[ssh-tunnel] listening on 127.0.0.1:${actualPort}`);
  });

  server.on("error", (err) => {
    terror(`[ssh-tunnel] server error: ${err.message}`);
    tlogMsgDedupFlush();
    process.exit(1);
  });

  // Flush pending dedup count on signals so the summary line is not lost.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      tlogMsgDedupFlush();
      process.exit(0);
    });
  }

  // Idle self-exit: safety net for when the resolver can't kill us
  // (extension host crash, power loss, ssh session dies but the tunnel
  // lives on). Polls lastActivity, which handleTunnelRequest refreshes on
  // every authenticated request.
  if (cfg.idleTimeoutMs > 0) {
    // Poll at timeout/8, so the exit lands within ~12% of the deadline.
    // Default 120s -> every 15s -> an orphan dies 120-135s after its last
    // authenticated request.
    const interval = Math.min(60_000, Math.max(50, Math.floor(cfg.idleTimeoutMs / 8)));
    const idleTimer = setInterval(() => {
      if (idleTimedOut(state.lastActivity ?? 0, Date.now(), cfg.idleTimeoutMs)) {
        tlog(`[ssh-tunnel] idle for ${cfg.idleTimeoutMs}ms, exiting`);
        clearInterval(idleTimer);
        tlogMsgDedupFlush();
        process.exit(0);
      }
    }, interval);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ssh-tunnel] fatal: ${errMessage(err)}`);
    process.exit(1);
  });
}
