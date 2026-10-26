/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Local server envelope: a standalone node process that owns one
 * persistent ssh child and exposes an HTTP API over a local socket.
 *
 * Bundled to dist/localServer.js. No vscode dependency. Spawned
 * detached by SshSessionClient. Config and auth token arrive via
 * stdin (not argv, not env) to keep /proc/<pid>/environ and process
 * inspection clean.
 *
 * Framing: each exec is a single line sent to the remote interactive
 * shell (`sh`). The command's stderr is merged into stdout (2>&1)
 * and terminated by a nonce exit marker line. Same nonce-marker
 * pattern as probeRemote (busybox.ts): random nonce can't collide
 * with shell-init noise or command output.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path/posix";
import { spawn, type ChildProcess } from "node:child_process";
import { shellQuote, timingSafeTokenCompare } from "../remote/shellQuote";
import type {
  SshSessionServerConfig,
  ExecRequest,
  ExecResponse,
  PutFileRequest,
  StatusResponse,
  SshSessionPersistenceRecord,
} from "./sshSession/protocol";
import { SSH_SESSION_PROTOCOL_VERSION } from "./sshSession/protocol";

const READY_PREFIX = "AERGIC_SSH_SESSION_READY_";
export const EXIT_PREFIX = "AERGIC_SSH_SESSION_";
export const EXIT_SUFFIX = "_EXIT";

export interface ServerState {
  config: SshSessionServerConfig;
  tokenHex: string;
  sshChild: ChildProcess | undefined;
  sshAlive: boolean;
  socksPort: number;
  startupTime: number;
  /** Serializes exec writes to the shell. One command at a time. */
  execQueue: Promise<void>;
  shutdownTimer: NodeJS.Timeout | undefined;
  refcount: number;
  /** Called when the shutdown timer fires or /shutdown is hit.
   *  Production: process.exit(0). Tests: no-op or custom. */
  onShutdown: () => void;
}

/** Factory for tests: build a ServerState with a mock ssh child. */
export function createServerState(
  config: SshSessionServerConfig,
  tokenHex: string,
  sshChild: ChildProcess | undefined,
  onShutdown: () => void = () => {},
): ServerState {
  let socksPort = 0;
  for (let i = 0; i < config.sshArgs.length; i++) {
    if (config.sshArgs[i] === "-D" && i + 1 < config.sshArgs.length) {
      socksPort = parseInt(config.sshArgs[i + 1], 10) || 0;
      break;
    }
  }
  return {
    config,
    tokenHex,
    sshChild,
    sshAlive: sshChild !== undefined,
    socksPort,
    startupTime: Date.now(),
    execQueue: Promise.resolve(),
    shutdownTimer: undefined,
    refcount: 0,
    onShutdown,
  };
}

async function main(): Promise<void> {
  // Read config + token from stdin (first line is JSON).
  const raw = await readStdinLine();
  let parsed: { config: SshSessionServerConfig; token: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(1);
  }
  const { config, token } = parsed;
  if (!token || typeof token !== "string") process.exit(1);

  // Set the log file path so log() can append to it.
  logFilePath = config.logFilePath || "";

  const handshakeStart = Date.now();
  log(`[ssh-session] ssh handshake starting`);
  const child = spawn(config.sshCommand, config.sshArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...config.sshEnv },
  });

  const state = createServerState(config, token, child, () => process.exit(0));

  child.on("error", (err) => {
    log(`[ssh-session] ssh spawn error: ${err.message}`);
    state.sshAlive = false;
    cleanup(state);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    log(`[ssh-session] ssh exited (code=${code} signal=${signal})`);
    state.sshAlive = false;
    cleanup(state);
    process.exit(0);
  });

  // After detach, the local server's own stdio pipes to the parent are
  // broken. Swallow EPIPE on stdout/stderr so it doesn't kill the process.
  process.stdout?.on?.("error", (err: any) => { if (err?.code !== "EPIPE") throw err; });
  process.stderr?.on?.("error", (err: any) => { if (err?.code !== "EPIPE") throw err; });
  process.on("SIGTERM", () => log(`[ssh-session] local server received SIGTERM`));
  process.on("SIGHUP", () => log(`[ssh-session] local server received SIGHUP`));
  process.on("uncaughtException", (err) => {
    if (err && typeof err === "object" && "code" in err && (err as any).code === "EPIPE") {
      return;
    }
    try { log(`[ssh-session] uncaughtException: ${err.stack || err.message}`); } catch { /* best effort */ }
  });
  process.on("unhandledRejection", (reason) => {
    try { log(`[ssh-session] unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`); } catch { /* best effort */ }
  });

  // Log ssh stderr for diagnostics, skipping shell prompt noise.
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8").trimEnd();
    if (!text) return;
    if (/^(>|\$|\$ >|> >)\s*$/.test(text)) return;
    if (/can't access tty|job control turned off/.test(text)) return;
    log(`[ssh-session-ssh] ${text}`);
  });

  // Ready handshake: flush shell-init noise by echoing a nonce marker.
  const readyNonce = crypto.randomBytes(8).toString("hex");
  const readyMarker = `${READY_PREFIX}${readyNonce}`;
  try {
    await waitForReady(child, readyMarker, config.handshakeTimeoutMs ?? 30_000);
  } catch (err) {
    const elapsed = Date.now() - handshakeStart;
    log(`[ssh-session] ssh handshake failed ms=${elapsed}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  state.sshAlive = true;
  const elapsed = Date.now() - handshakeStart;
  log(`[ssh-session] ssh handshake done ms=${elapsed}`);

  // Write the persistence file (no secrets).
  writePersistenceFile(state);

  // Start the shutdown timer. Reset by /delay-shutdown.
  resetShutdownTimer(state);

  const server = http.createServer((req, res) => handleRequest(state, req, res));
  server.on("error", (err) => {
    log(`[ssh-session] http server error: ${err.message}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.ipcHandlePath, () => {
      log(`[ssh-session] listening on ${config.ipcHandlePath}`);
      resolve();
    });
    server.once("error", reject);
  });

  // Keep the process alive until ssh dies or shutdown fires.
  await new Promise<void>(() => {
    // The child's close handler and the shutdown timer both call
    // process.exit(0). This promise never resolves; the process exits
    // via one of those paths.
  });
}

function log(msg: string): void {
  // Append to a file so logs survive detach. Don't write to stderr: after
  // detach the parent's pipe is gone and the EPIPE error event on the socket
  // causes uncaughtException. File-only logging is safe.
  const line = `${new Date().toISOString()} ${msg}\n`;
  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, line); } catch { /* best effort */ }
  }
}

let logFilePath = "";

function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("error", reject);
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", reject);
    process.stdin.on("end", () => {
      if (buf) resolve(buf.trim());
      else reject(new Error("stdin closed before config"));
    });
  });
}

/** Wait for the ready marker on ssh stdout, ignoring shell-init noise. */
function waitForReady(
  child: ChildProcess,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const cmd = `printf '${marker}\n'\n`;
  child.stdin?.write(cmd);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.stdout?.removeListener("data", onData);
      reject(new Error("ready handshake timed out"));
    }, timeoutMs);

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      for (const line of lines) {
        if (line.trim() === marker) {
          clearTimeout(timeout);
          child.stdout?.removeListener("data", onData);
          resolve();
          return;
        }
      }
      // Keep the last partial line.
      buf = lines[lines.length - 1] ?? "";
    };
    child.stdout?.on("data", onData);
  });
}

/** Write the persistence file (no secrets). */
export function writePersistenceFile(state: ServerState): void {
  if (!state.sshChild?.pid) return;
  const record: SshSessionPersistenceRecord = {
    pid: state.sshChild.pid,
    ipcHandlePath: state.config.ipcHandlePath,
    socksPort: state.socksPort,
    startupTime: state.startupTime,
    sshSessionProtocolVersion: SSH_SESSION_PROTOCOL_VERSION,
  };
  try {
    fs.writeFileSync(state.config.dataFilePath, JSON.stringify(record));
    if (process.platform !== "win32") {
      try { fs.chmodSync(state.config.dataFilePath, 0o600); } catch { /* best effort */ }
    }
  } catch (err) {
    log(`[ssh-session] failed to write persistence file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function resetShutdownTimer(state: ServerState): void {
  if (state.shutdownTimer) clearTimeout(state.shutdownTimer);
  state.shutdownTimer = setTimeout(() => {
    log("[ssh-session] shutdown timer fired, exiting");
    cleanup(state);
    state.onShutdown();
  }, state.config.shutdownTimeoutMs);
}

export function cleanup(state?: ServerState): void {
  if (state?.shutdownTimer) clearTimeout(state.shutdownTimer);
  if (state?.sshChild) {
    try { state.sshChild.kill("SIGTERM"); } catch { /* best effort */ }
  }
  if (state?.config.ipcHandlePath && process.platform !== "win32") {
    try { fs.unlinkSync(state.config.ipcHandlePath); } catch { /* may not exist */ }
  }
  if (state?.config.dataFilePath) {
    try { fs.unlinkSync(state.config.dataFilePath); } catch { /* may not exist */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

export function validToken(state: ServerState, provided: string | undefined): boolean {
  return timingSafeTokenCompare(provided, state.tokenHex);
}

export async function handleRequest(
  state: ServerState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Bearer token check.
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    log(`[ssh-session] rejected request: missing bearer token`);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (!validToken(state, auth.slice(7))) {
    log(`[ssh-session] rejected request: invalid bearer token`);
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/status") {
      handleStatus(state, res);
    } else if (path === "/exec") {
      await handleExec(state, req, res);
    } else if (path === "/put-file") {
      await handlePutFile(state, req, res);
    } else if (path === "/attach") {
      state.refcount++;
      resetShutdownTimer(state);
      log(`[ssh-session] attached (refcount=${state.refcount})`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, socksPort: state.socksPort }));
    } else if (path === "/detach") {
      if (state.refcount > 0) state.refcount--;
      log(`[ssh-session] detached (refcount=${state.refcount})`);
      if (state.refcount === 0) {
        resetShutdownTimer(state);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (path === "/delay-shutdown") {
      resetShutdownTimer(state);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (path === "/shutdown") {
      log("[ssh-session] shutdown requested");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      cleanup(state);
      state.onShutdown();
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[ssh-session] request error: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }
}

export function handleStatus(state: ServerState, res: http.ServerResponse): void {
  const body: StatusResponse = {
    sshAlive: state.sshAlive,
    pid: state.sshChild?.pid ?? 0,
    socksPort: state.socksPort,
    startupTime: state.startupTime,
    sshSessionProtocolVersion: SSH_SESSION_PROTOCOL_VERSION,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handleExec(
  state: ServerState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: ExecRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }
  if (!body.id || typeof body.command !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing id or command" }));
    return;
  }

  if (!body.quiet) {
    const cmd = body.command.length > 120
      ? `${body.command.slice(0, 120)}...[truncated]`
      : body.command;
    log(`[ssh-session] exec id=${body.id} cmd=${cmd}`);
  }
  const start = Date.now();
  const result = await runExec(state, body);
  if (!body.quiet) log(`[ssh-session] exec id=${body.id} exit=${result.exitCode} ms=${Date.now() - start}`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}

export async function handlePutFile(
  state: ServerState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: PutFileRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return;
  }
  if (!body.id || typeof body.path !== "string" || typeof body.content !== "string") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing fields" }));
    return;
  }

  const bytes = Math.floor((body.content.length * 3) / 4);
  log(`[ssh-session] put-file id=${body.id} path=${body.path} bytes=${bytes}`);
  const start = Date.now();

  // Build the remote command: echo the base64 content through a pipe so
  // base64 -d reads from the pipe, not the shell's shared stdin. The
  // exit marker printf runs as a separate command after base64 finishes.
  // mkdir -p the parent so the `>` redirect can create the file even on
  // a fresh install path whose dir doesn't exist yet (matches what the
  // Go transport's doPut already does).
  const mode = body.mode ?? "0644";
  const exitMarker = `${EXIT_PREFIX}${body.id}${EXIT_SUFFIX}`;
  const parentDir = path.dirname(body.path);
  const cmd =
    `mkdir -p ${shellQuote(parentDir)} && echo ${shellQuote(body.content)} | base64 -d > ${shellQuote(body.path)} && chmod ${mode} ${shellQuote(body.path)}\n` +
    `printf '\n${exitMarker}:%s\n' "$?"\n`;

  const result = await runShellCommand(state, exitMarker, cmd, undefined);
  log(`[ssh-session] put-file id=${body.id} exit=${result.exitCode} ms=${Date.now() - start}`);
  const response: ExecResponse = {
    id: body.id,
    stdout: result.stdout,
    stderr: "",
    exitCode: result.exitCode,
    signal: null,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// Shell command execution (serialized)
// ---------------------------------------------------------------------------

/**
 * Run a one-shot exec. The command runs in the remote interactive shell,
 * stderr merged into stdout (2>&1). A nonce exit marker terminates the
 * read. Serialized: one command at a time.
 *
 * Because stderr is merged into stdout, the returned `stderr` field is
 * always `""`. Error text appears in `stdout`. Callers that inspect
 * `stderr` for diagnostics will not see it on this path; use the fallback
 * pattern `stderr || stdout`.
 */
export async function runExec(
  state: ServerState,
  body: ExecRequest,
): Promise<ExecResponse> {
  const exitMarker = `${EXIT_PREFIX}${body.id}${EXIT_SUFFIX}`;
  // Merge stderr into stdout so we capture error text. The exit marker
  // uses a random nonce that can't collide with command output.
  const cmd =
    `( ${body.command} ) 2>&1\n` +
    `printf '\n${exitMarker}:%s\n' "$?"\n`;

  const result = await runShellCommand(state, exitMarker, cmd, body.timeoutMs);
  return {
    id: body.id,
    stdout: result.stdout,
    stderr: "",
    exitCode: result.exitCode,
    signal: null,
  };
}

export interface ShellResult {
  stdout: string;
  exitCode: number;
}

/**
 * Write a command to the ssh shell stdin and read stdout until the exit
 * marker. Serialized via execQueue.
 */
export function runShellCommand(
  state: ServerState,
  exitMarker: string,
  cmd: string,
  timeoutMs?: number,
): Promise<ShellResult> {
  const next = state.execQueue.then(() =>
    doRunShellCommand(state, exitMarker, cmd, timeoutMs),
  );
  state.execQueue = next.then(() => undefined, () => undefined);
  return next;
}

export function doRunShellCommand(
  state: ServerState,
  exitMarker: string,
  cmd: string,
  timeoutMs?: number,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve, reject) => {
    const child = state.sshChild;
    if (!child?.stdin || !child.stdout) {
      reject(new Error("ssh not alive"));
      return;
    }

    let buf = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      child.stdout?.removeListener("data", onData);
      if (timer) clearTimeout(timer);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf-8");
      // Only scan up to the last complete line (the tail may be a
      // partial marker). Keep the full buffer so stdout from earlier
      // chunks survives until the marker arrives.
      const nl = buf.lastIndexOf("\n");
      if (nl === -1) return;
      const lines = buf.slice(0, nl + 1).split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Exact line match: "<exitMarker>:<code>". No regex (the marker
        // is a random nonce, so collisions are impossible; regex only
        // adds escape risk).
        const prefix = `${exitMarker}:`;
        if (line.startsWith(prefix)) {
          const codeStr = line.slice(prefix.length);
          if (/^\d+$/.test(codeStr)) {
            settled = true;
            cleanup();
            // stdout is everything before the marker line.
            const stdoutLines = lines.slice(0, i);
            const stdout = stdoutLines.join("\n").replace(/^\n/, "");
            resolve({ stdout, exitCode: parseInt(codeStr, 10) });
            return;
          }
        }
      }
      // No trim: keep the buffer until the marker arrives. Bounded by
      // the command's output.
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on("data", onData);
    child.stdin.write(cmd);
  });
}

main().catch((err) => {
  log(`[ssh-session] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
