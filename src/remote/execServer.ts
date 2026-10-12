/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ExecServer backed by SSH exec + SOCKS5.
 *
 * `resolveExecServer` returns one. The child resolver (artizo) drives
 * Docker, file writes, and container connections through it.
 */

import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Logger } from "../common/logger";
import type { ISshConnection, ExecResult } from "../ssh/connection";
import { shellQuote } from "../remote/busybox";
import { socks5Connect } from "../net/socks5";
import { wrapSocket } from "../net/managedConnection";
import { SimpleEvent } from "../common/event";
import { SshTunnelClient, TunnelHttpError } from "../sshTunnel/client";

// --- Types matching vscode.proposed.resolvers.d.ts ---

export interface ProcessExit {
  readonly status: number;
  readonly message?: string;
}

export interface ReadStream {
  readonly onDidReceiveMessage: (listener: (e: Uint8Array) => void) => {
    dispose(): void;
  };
  readonly onEnd: Promise<void>;
}

export interface WriteStream {
  write(data: Uint8Array): void;
  end(): void;
}

export interface SpawnedCommand {
  readonly stdin: WriteStream;
  readonly stdout: ReadStream;
  readonly stderr: ReadStream;
  readonly onExit: Promise<ProcessExit>;
}

export interface ExecEnvironment {
  readonly env: Record<string, string>;
  readonly osPlatform: string;
  readonly osRelease?: string;
}

export interface FileStat {
  readonly type: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

export interface DirectoryEntry {
  readonly type: number;
  readonly name: string;
}

// FileType bitmask values (from vscode namespace).
const FT_UNKNOWN = 0;
const FT_FILE = 1;
const FT_DIR = 2;
const FT_SYMLINK = 64;

// --- Stream wrappers ---

/** Wraps a ChildProcess stdout/stderr as a ReadStream. */
class ProcReadStream implements ReadStream {
  private readonly event = new SimpleEvent<Uint8Array>();
  readonly onEnd: Promise<void>;

  constructor(
    child: ChildProcess,
    stream: NodeJS.ReadableStream | null | undefined,
  ) {
    this.onEnd = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });
    stream?.on("data", (chunk: Buffer) => {
      this.event.fire(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    });
  }

  get onDidReceiveMessage() {
    return this.event.event;
  }
}

/** Wraps a ChildProcess stdin as a WriteStream. */
class ProcWriteStream implements WriteStream {
  constructor(
    private readonly stdin: NodeJS.WritableStream | null | undefined,
  ) {}
  write(data: Uint8Array): void {
    this.stdin?.write(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  end(): void {
    this.stdin?.end();
  }
}

/**
 * Buffers writes, flushes via conn.putFile on end(). For the session
 * path, where spawnProcess + stdin isn't available (control shell stdin
 * is shared). `done` resolves when putFile completes.
 */
class BufferingWriteStream implements WriteStream {
  private readonly chunks: Buffer[] = [];
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (err: Error) => void;

  constructor(
    private readonly flush: (content: Buffer) => Promise<ExecResult>,
  ) {
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  write(data: Uint8Array): void {
    this.chunks.push(Buffer.from(data));
  }

  end(): void {
    this.flush(Buffer.concat(this.chunks))
      .then((result) => {
        if (result.exitCode === 0 || result.exitCode === null) {
          this.resolveDone();
        } else {
          this.rejectDone(new Error(`write failed with code ${result.exitCode}`));
        }
      })
      .catch((err) => {
        this.rejectDone(
          new Error(`write failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      });
  }
}

/** Adapts a ManagedMessagePassing to ReadStream & WriteStream. */
class TcpStream implements WriteStream, ReadStream {
  private readonly event = new SimpleEvent<Uint8Array>();
  readonly onEnd: Promise<void>;

  constructor(passing: any) {
    this.onEnd = new Promise<void>((resolve) => {
      passing.onDidClose(() => resolve());
    });
    passing.onDidReceiveMessage((data: Uint8Array) => {
      this.event.fire(data);
    });
    // Wire write/end to the underlying passing.
    this._write = (data: Uint8Array) => passing.send(data);
    this._end = () => passing.end();
  }

  private _write: (data: Uint8Array) => void;
  private _end: () => void;

  get onDidReceiveMessage() {
    return this.event.event;
  }
  write(data: Uint8Array): void {
    this._write(data);
  }
  end(): void {
    this._end();
  }
}

/** WriteStream over a tunnel PUT. Chunks stream to the request body;
 *  end() closes it, and the server finalizes the temp file. */
class TunnelWriteStream implements WriteStream {
  constructor(private readonly req: http.ClientRequest) {}
  write(data: Uint8Array): void {
    this.req.write(Buffer.from(data));
  }
  end(): void {
    this.req.end();
  }
}

/** ReadStream over a tunnel temp file. Polls GET /file?offset=N, fires
 *  onDidReceiveMessage for new bytes, ends when `exited` resolves. */
class TunnelReadStream implements ReadStream {
  private readonly event = new SimpleEvent<Uint8Array>();
  readonly onEnd: Promise<void>;
  private offset = 0;

  constructor(
    private readonly client: SshTunnelClient,
    private readonly pathPromise: Promise<string>,
    private readonly exited: Promise<string>,
    private readonly logger: Logger,
  ) {
    this.onEnd = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let path: string;
    try {
      path = await this.pathPromise;
    } catch (err) {
      this.logger.info(
        `[execServer] tunnel read: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    let done = false;
    this.exited.then(
      () => { done = true; },
      () => { done = true; },
    );
    while (!done) {
      await this.readNew(path);
      await sleep(100);
    }
    // Final read after the command exits.
    await this.readNew(path);
  }

  private async readNew(path: string): Promise<void> {
    try {
      const content = await this.client.getFile(path, this.offset);
      if (content.length > 0) {
        this.offset += content.length;
        this.event.fire(
          new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
        );
      }
    } catch {
      /* file not written yet */
    }
  }

  get onDidReceiveMessage() {
    return this.event.event;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- ExecServer ---

export class SshExecServer {
  private readonly tunnelClient: SshTunnelClient | undefined;

  constructor(
    private readonly conn: ISshConnection,
    private readonly socksPort: number | undefined,
    private readonly logger: Logger,
    tunnelClient?: SshTunnelClient,
  ) {
    this.tunnelClient = tunnelClient;
  }

  /** Spawn a command, returning streaming stdin/stdout/stderr.
   *
   *  With a tunnel client: stdin goes to a temp file via PUT, the command
   *  starts via POST /spawn, stdout/stderr/exit are polled over HTTP. Keeps
   *  the control shell free and gives real stdin streaming.
   *
   *  Without a tunnel: spawn directly over SSH. Session path stdin is a
   *  no-op (control shell stdin is shared). */
  spawn(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<SpawnedCommand> {
    const fullCmd = this.buildCommand(command, args, options);
    this.logger.info(`[execServer] spawn: ${fullCmd}`);

    if (this.tunnelClient) {
      return this.spawnViaTunnel(fullCmd, this.tunnelClient);
    }

    const child = this.conn.spawnProcess(fullCmd);

    const stdout = new ProcReadStream(child, child.stdout);
    const stderr = new ProcReadStream(child, child.stderr);
    const stdin = new ProcWriteStream(child.stdin);

    const onExit = new Promise<ProcessExit>((resolve) => {
      child.on("close", (code, signal) => {
        const status = code ?? (signal ? 1 : 0);
        const msg = signal ? `killed by signal ${signal}` : undefined;
        if (status !== 0) {
          this.logger.info(`[execServer] spawn exited: ${status}${msg ? ` (${msg})` : ""}`);
        } else {
          this.logger.debug(`[execServer] spawn exited: 0`);
        }
        resolve({ status, message: msg });
      });
      child.on("error", (err) => {
        this.logger.info(`[execServer] spawn error: ${err.message}`);
        resolve({ status: 1, message: err.message });
      });
    });

    return Promise.resolve({ stdin, stdout, stderr, onExit });
  }

  /** Spawn via the SshTunnel service; see {@link spawn}. */
  private async spawnViaTunnel(
    fullCmd: string,
    client: SshTunnelClient,
  ): Promise<SpawnedCommand> {
    const id = crypto.randomBytes(8).toString("hex");
    const stdinPath = `.ssh-remote/tunnel-tmp/${id}.stdin`;

    // Open a streaming PUT for stdin. Chunks go straight to the socket.
    const { writer, done: putDone } = client.openPutFile(stdinPath);
    const stdin = new TunnelWriteStream(writer);

    // POST /spawn fires after the PUT completes (stdin closed). The
    // command starts with the temp file as fd 0.
    const spawnResponse = putDone.then(() =>
      client.spawn({
        command: "sh",
        args: ["-c", fullCmd],
        stdinPath,
      }),
    );

    // Shared exit signal: exit-file content on success, reject if the
    // tunnel dies. onExit and the read streams use it to stop polling.
    let resolveExit: (value: string) => void;
    let rejectExit: (err: Error) => void;
    const exited = new Promise<string>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    // Nobody awaits `exited` directly; the read streams attach handlers.
    // Swallow the rejection here so it is not reported as unhandled.
    void exited.catch(() => {});

    const onExit = spawnResponse.then(async (resp) => {
      const exitContent = await this.pollTunnelFile(client, resp.exitPath);
      resolveExit(exitContent);
      // Format: "0" or "N:errmsg".
      const colonIdx = exitContent.indexOf(":");
      if (colonIdx > 0) {
        const code = parseInt(exitContent.substring(0, colonIdx), 10);
        const msg = exitContent.substring(colonIdx + 1);
        this.logger.info(`[execServer] tunnel spawn exited: ${code} (${msg})`);
        return { status: code, message: msg };
      }
      const code = parseInt(exitContent, 10);
      if (code !== 0) this.logger.info(`[execServer] tunnel spawn exited: ${code}`);
      else this.logger.debug(`[execServer] tunnel spawn exited: 0`);
      return { status: code };
    });
    // Propagate failure to `exited` so the read streams stop; onExit
    // still rejects for the caller.
    onExit.catch((err) => {
      rejectExit(err instanceof Error ? err : new Error(String(err)));
    });

    // stdout/stderr poll their temp files, stop when exited resolves.
    const stdout = new TunnelReadStream(
      client,
      spawnResponse.then((r) => r.stdoutPath),
      exited,
      this.logger,
    );
    const stderr = new TunnelReadStream(
      client,
      spawnResponse.then((r) => r.stderrPath),
      exited,
      this.logger,
    );

    return { stdin, stdout, stderr, onExit };
  }

  /** Poll a tunnel temp file until it has content.
   *
   *  404 = not written yet, keep polling. Any other error is a real
   *  failure; after MAX_TUNNEL_FAILURES in a row, reject so `onExit`
   *  settles instead of spinning. */
  private async pollTunnelFile(
    client: SshTunnelClient,
    filePath: string,
  ): Promise<string> {
    const MAX_TUNNEL_FAILURES = 300; // ~30s at 100ms poll interval
    let consecutiveFailures = 0;
    while (true) {
      try {
        const content = await client.getFile(filePath);
        consecutiveFailures = 0;
        const text = content.toString("utf-8").trim();
        if (text) return text;
      } catch (err) {
        if (err instanceof TunnelHttpError && err.status === 404) {
          // File not written yet; process may still be running.
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_TUNNEL_FAILURES) {
            throw new Error(
              `pollTunnelFile ${filePath} failed: tunnel unreachable after ${MAX_TUNNEL_FAILURES} attempts`,
            );
          }
        }
      }
      await sleep(100);
    }
  }

  /** Get the remote environment + OS info. */
  async env(): Promise<ExecEnvironment> {
    const platResult = await this.conn.exec("uname -s");
    const platOut = platResult.stdout.trim();
    let osPlatform: string;
    switch (platOut) {
      case "Linux":
        osPlatform = "linux";
        break;
      case "Darwin":
        osPlatform = "darwin";
        break;
      default:
        osPlatform = platOut.toLowerCase();
        break;
    }

    const relResult = await this.conn.exec("uname -r");
    const osRelease = relResult.stdout.trim() || undefined;

    const envResult = await this.conn.exec("env");
    const env: Record<string, string> = {};
    for (const line of envResult.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.substring(0, eq)] = line.substring(eq + 1);
      }
    }

    this.logger.info(
      `[execServer] env: platform=${osPlatform} release=${osRelease ?? "?"} vars=${Object.keys(env).length}`,
    );
    return { env, osPlatform, osRelease };
  }

  /** Kill a process on the remote by PID. */
  async kill(processId: number): Promise<void> {
    this.logger.info(`[execServer] kill pid=${processId}`);
    await this.conn.exec(`kill ${processId}`);
  }

  /** Connect to a TCP host:port on the remote via SOCKS5. */
  async tcpConnect(
    host: string,
    port: number,
  ): Promise<{ stream: any; done: Promise<void> }> {
    if (!this.socksPort) {
      throw new Error("SOCKS port not available");
    }
    this.logger.info(
      `[execServer] tcpConnect ${host}:${port} via SOCKS :${this.socksPort}`,
    );
    try {
      const socket = await socks5Connect("127.0.0.1", this.socksPort, host, port);
      const passing = wrapSocket(socket);
      const stream = new TcpStream(passing);
      const done = new Promise<void>((resolve) => {
        passing.onDidClose(() => resolve());
      });
      this.logger.info(`[execServer] tcpConnect ${host}:${port} connected`);
      return { stream, done };
    } catch (err) {
      this.logger.info(
        `[execServer] tcpConnect ${host}:${port} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /** File system operations backed by SSH exec. */
  readonly fs = {
    stat: async (path: string): Promise<FileStat> => {
      this.logger.debug(`[execServer] fs.stat: ${path}`);
      const result = await this.conn.exec(
        `sh -c ${shellQuote('stat -c "%F %s %Y" "$1" 2>/dev/null || stat -f "%HT %z %m" "$1" 2>/dev/null')} sh ${shellQuote(path)}`,
      );
      if (result.exitCode !== 0) {
        this.logger.info(`[execServer] fs.stat failed: ${path}: ${result.stderr.trim()}`);
        throw new Error(`stat failed for ${path}: ${result.stderr}`);
      }
      // Output format: "<type> <size> <mtime>"
      // Type can be multi-word: "regular file", "directory",
      // "symbolic link", etc. Size and mtime are always integers.
      const trimmed = result.stdout.trim();
      // Split from the right: size and mtime are the last two tokens.
      const mtimeMatch = trimmed.match(/(\d+)\s*$/);
      const sizeMatch = trimmed.match(/(\d+)\s+\d+\s*$/);
      const typeStr = trimmed.replace(/\s*\d+\s+\d+\s*$/, "").trim();
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
      const mtime = mtimeMatch ? parseInt(mtimeMatch[1], 10) : 0;

      let type = FT_UNKNOWN;
      if (
        typeStr.startsWith("regular") ||
        typeStr === "File"
      ) {
        type = FT_FILE;
      } else if (typeStr.startsWith("directory") || typeStr === "Directory") {
        type = FT_DIR;
      } else if (
        typeStr.includes("symbolic link") ||
        typeStr.includes("link")
      ) {
        type = FT_SYMLINK;
      }

      return { type, ctime: mtime, mtime, size };
    },

    mkdirp: async (path: string): Promise<void> => {
      this.logger.debug(`[execServer] fs.mkdirp: ${path}`);
      const result = await this.conn.exec(`mkdir -p ${shellQuote(path)}`);
      if (result.exitCode !== 0) {
        this.logger.info(`[execServer] fs.mkdirp failed: ${path}: ${result.stderr.trim()}`);
        throw new Error(`mkdirp failed for ${path}: ${result.stderr}`);
      }
    },

    rm: async (path: string): Promise<void> => {
      this.logger.debug(`[execServer] fs.rm: ${path}`);
      await this.conn.exec(`rm -rf ${shellQuote(path)}`);
    },

    rename: async (fromPath: string, toPath: string): Promise<void> => {
      this.logger.debug(`[execServer] fs.rename: ${fromPath} -> ${toPath}`);
      const result = await this.conn.exec(
        `mv ${shellQuote(fromPath)} ${shellQuote(toPath)}`,
      );
      if (result.exitCode !== 0) {
        this.logger.info(`[execServer] fs.rename failed: ${fromPath} -> ${toPath}: ${result.stderr.trim()}`);
        throw new Error(
          `rename failed ${fromPath} -> ${toPath}: ${result.stderr}`,
        );
      }
    },

    readdir: async (path: string): Promise<DirectoryEntry[]> => {
      this.logger.debug(`[execServer] fs.readdir: ${path}`);
      const result = await this.conn.exec(`ls -A -F ${shellQuote(path)}`);
      if (result.exitCode !== 0) {
        this.logger.info(`[execServer] fs.readdir failed: ${path}: ${result.stderr.trim()}`);
        throw new Error(`readdir failed for ${path}: ${result.stderr}`);
      }
      const entries: DirectoryEntry[] = [];
      for (const line of result.stdout.split("\n")) {
        if (!line) continue;
        let type: number;
        let name = line;
        const last = line[line.length - 1];
        if (last === "/") {
          type = FT_DIR;
          name = line.slice(0, -1);
        } else if (last === "@") {
          type = FT_SYMLINK;
          name = line.slice(0, -1);
        } else if (last === "*" || last === "=" || last === "|") {
          type = last === "|" ? FT_UNKNOWN : FT_FILE;
          name = line.slice(0, -1);
        } else {
          type = FT_FILE;
        }
        entries.push({ type, name });
      }
      return entries;
    },

    read: (path: string): Promise<ReadStream> => {
      this.logger.debug(`[execServer] fs.read: ${path}`);
      const child = this.conn.spawnProcess(`cat ${shellQuote(path)}`);
      return Promise.resolve(new ProcReadStream(child, child.stdout));
    },

    write: (
      path: string,
    ): Promise<{ stream: WriteStream; done: Promise<void> }> => {
      this.logger.debug(`[execServer] fs.write: ${path}`);
      // Session path: buffer chunks and flush via putFile (control shell
      // stdin is shared, so spawnProcess + cat can't stream per-file stdin).
      if (this.conn.putFile) {
        const flush = (content: Buffer) => this.conn.putFile!(path, content);
        const stream = new BufferingWriteStream(flush);
        return Promise.resolve({ stream, done: stream.done });
      }
      const child = this.conn.spawnProcess(`cat > ${shellQuote(path)}`);
      const stream = new ProcWriteStream(child.stdin);
      const done = new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0 || code === null) resolve();
          else reject(new Error(`write failed with code ${code}`));
        });
        child.on("error", (err) =>
          reject(new Error(`write failed: ${err.message}`)),
        );
      });
      return Promise.resolve({ stream, done });
    },
  };

  // --- Helpers ---

  private buildCommand(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): string {
    const parts: string[] = [];
    if (options?.env) {
      // Use `env` to set vars instead of POSIX `K=V command` prefix syntax,
      // which non-POSIX shells (e.g. fish) don't understand.
      parts.push("env");
      for (const [k, v] of Object.entries(options.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`Invalid env var name: ${k}`);
        }
        parts.push(`${k}=${shellQuote(v)}`);
      }
    }
    if (options?.cwd) {
      // Use `sh -c 'cd "$0" && exec "$@"'` with cwd as $0 and command+args
      // as $@, so the script stays single-quote-free (no nested quoting)
      // and works regardless of the remote login shell.
      parts.push(
        `sh -c ${shellQuote('cd "$0" && exec "$@"')} ${shellQuote(options.cwd)}`,
      );
    }
    parts.push(command);
    for (const a of args) {
      parts.push(shellQuote(a));
    }
    return parts.join(" ");
  }
}
