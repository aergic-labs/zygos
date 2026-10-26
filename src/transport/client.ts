/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * TransportClient: raw-TCP client for the Go transport server.
 *
 * The server runs on the remote (127.0.0.1:<port>), reached through the
 * local SOCKS5 forward (127.0.0.1:<socksPort>). One op per connection.
 *
 * Protocol:
 *   request:  [token:32][op:u8][flags:u8][argLen:u32][args]
 *   response: [status:u8][argLen:u32][args]
 *
 * args is JSON for the small ops. For streaming ops the body follows:
 *   - PUT / GET: raw body, EOF-delimited via half-close.
 *   - SPAWN:     raw stdin one way; framed [stream:u8][len:u32][data]
 *                chunks the other way, terminated by an exit frame.
 */

import * as net from "node:net";
import { socks5Connect } from "../net/socks5";
import type { Logger } from "../common/logger";

/** Wire op codes. Must match go/tunnel/main.go. */
const OP = {
  EXEC: 1,
  SPAWN: 2,
  PUT: 3,
  GET: 4,
  STAT: 5,
  READDIR: 6,
  MKDIR: 7,
  RENAME: 8,
  RM: 9,
  ENV: 10,
  KILL: 11,
  HEALTH: 12,
  CONNECT: 13,
  WAIT_FILE: 14,
  EXTRACT: 105,
} as const;

/** Response status codes. Must match go/tunnel/main.go. */
export const ST = {
  OK: 0,
  ERROR: 1,
  MISSING: 2,
  BADREQ: 3,
  DENIED: 4,
} as const;

/** Spawn stream tags. Must match go/tunnel/main.go. */
const STREAM_STDOUT = 0;
const STREAM_STDERR = 1;
const STREAM_EXIT = 2;

export interface TransportClientOptions {
  /** Local SOCKS5 proxy port (ssh -D). */
  socksPort: number;
  /** Remote transport server port. */
  port: number;
  /** Bearer token (hex, 64 chars). */
  token: string;
  logger?: Logger;
  /** Override the connection. Tests use a direct connect (no SOCKS). */
  connectFn?: () => Promise<net.Socket>;
  /** Heartbeat interval in ms. Default 30s. */
  heartbeatIntervalMs?: number;
  /** Called once when the server has been unreachable for 3 consecutive
   *  heartbeats. Lets the caller treat a dead transport like a dead
   *  connection. */
  onUnreachable?: () => void;
}

/** Error thrown when the server returns a non-OK status. */
export class TransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: string | null;
}

export interface FileStat {
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

export interface DirectoryEntry {
  type: number;
  name: string;
}

export interface ExecEnvironment {
  osPlatform: string;
  osRelease: string;
  env: Record<string, string>;
}

export interface SpawnedCommand {
  stdin: { write(data: Uint8Array): void; end(): void };
  stdout: { onData(cb: (data: Buffer) => void): void };
  stderr: { onData(cb: (data: Buffer) => void): void };
  onExit: Promise<{ status: number }>;
}

export class TransportClient {
  private heartbeat: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;
  private unreachableReported = false;

  constructor(private readonly opts: TransportClientOptions) {
    this.startHeartbeat();
  }

  /** Stop the heartbeat. Call on teardown. */
  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Keep the server's idle timer reset while the client is alive, and
   *  detect an unreachable server. unref'd so it doesn't keep the
   *  extension host alive. */
  private startHeartbeat(): void {
    const tick = (): void => {
      this.health()
        .then(() => {
          this.consecutiveFailures = 0;
          this.unreachableReported = false;
        })
        .catch(() => {
          this.consecutiveFailures++;
          if (
            this.consecutiveFailures >= 3 &&
            !this.unreachableReported
          ) {
            this.unreachableReported = true;
            this.opts.onUnreachable?.();
          }
        });
    };
    tick();
    this.heartbeat = setInterval(
      tick,
      this.opts.heartbeatIntervalMs ?? 30_000,
    );
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  protected connect(): Promise<net.Socket> {
    if (this.opts.connectFn) return this.opts.connectFn();
    return socks5Connect(
      "127.0.0.1",
      this.opts.socksPort,
      "127.0.0.1",
      this.opts.port,
    );
  }

  protected writeHeader(sock: net.Socket, op: number, args: unknown): void {
    const argsBuf = Buffer.from(JSON.stringify(args ?? {}), "utf-8");
    const hdr = Buffer.alloc(6);
    hdr[0] = op;
    hdr[1] = 0;
    hdr.writeUInt32BE(argsBuf.length, 2);
    sock.write(Buffer.from(this.opts.token, "hex"));
    sock.write(hdr);
    sock.write(argsBuf);
  }

  /** Buffered request/response for the small ops. */
  protected async request(
    op: number,
    args: unknown,
  ): Promise<{ status: number; body: Buffer }> {
    const sock = await this.connect();
    try {
      this.writeHeader(sock, op, args);
      return await readResponse(sock);
    } finally {
      sock.destroy();
    }
  }

  protected async requestJSON<T>(op: number, args: unknown): Promise<T> {
    const { status, body } = await this.request(op, args);
    if (status !== ST.OK) {
      throw new TransportError(status, `op ${op} failed: status ${status}`);
    }
    return JSON.parse(body.toString("utf-8")) as T;
  }

  async health(): Promise<void> {
    const { status } = await this.request(OP.HEALTH, {});
    if (status !== ST.OK) {
      throw new TransportError(status, `health failed: status ${status}`);
    }
  }

  /** Block until `path` exists and is non-empty on the remote, or `timeoutMs`
   *  elapses. Returns the file content on success; throws `TransportError`
   *  (status MISSING) on timeout. The server polls the file locally; no
   *  wire round-trips during the wait. Replaces the resolver's poll loop of
   *  `cat` calls for the REH server ready-file. */
  async waitForFile(path: string, timeoutMs: number): Promise<Buffer> {
    const { status, body } = await this.request(OP.WAIT_FILE, {
      path,
      timeoutMs,
    });
    if (status !== ST.OK) {
      throw new TransportError(
        status,
        `waitForFile ${path} failed: status ${status}`,
      );
    }
    return body;
  }

  async exec(
    cmd: string,
    args: string[] = [],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ExecResult> {
    const r = await this.requestJSON<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>(OP.EXEC, { cmd, args, cwd: opts?.cwd, env: opts?.env });
    return {
      stdout: Buffer.from(r.stdout, "base64"),
      stderr: Buffer.from(r.stderr, "base64"),
      exitCode: r.exitCode,
      signal: null,
    };
  }

  async env(): Promise<ExecEnvironment> {
    return this.requestJSON<ExecEnvironment>(OP.ENV, {});
  }

  /** Run a shell command with buffered stdin, collect stdout/stderr/exit.
   *  Uses SPAWN under the hood (real streams). */
  async execWithStdin(command: string, stdin: Buffer): Promise<ExecResult> {
    const proc = await this.spawn("sh", ["-c", command]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.onData((d) => out.push(d));
    proc.stderr.onData((d) => err.push(d));
    proc.stdin.write(new Uint8Array(stdin));
    proc.stdin.end();
    const exit = await proc.onExit;
    return {
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err),
      exitCode: exit.status,
      signal: null,
    };
  }

  async kill(pid: number): Promise<void> {
    const { status } = await this.request(OP.KILL, { pid });
    if (status !== ST.OK) {
      throw new TransportError(status, `kill ${pid} failed: status ${status}`);
    }
  }

  async stat(path: string): Promise<FileStat> {
    return this.requestJSON<FileStat>(OP.STAT, { path });
  }

  async readdir(path: string): Promise<DirectoryEntry[]> {
    return this.requestJSON<DirectoryEntry[]>(OP.READDIR, { path });
  }

  async mkdir(path: string): Promise<void> {
    const { status } = await this.request(OP.MKDIR, { path });
    if (status !== ST.OK) {
      throw new TransportError(status, `mkdir ${path} failed: status ${status}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const { status } = await this.request(OP.RENAME, { from, to });
    if (status !== ST.OK) {
      throw new TransportError(status, `rename failed: status ${status}`);
    }
  }

  async rm(path: string): Promise<void> {
    const { status } = await this.request(OP.RM, { path });
    if (status !== ST.OK) {
      throw new TransportError(status, `rm ${path} failed: status ${status}`);
    }
  }

  /** Buffered PUT. Streams in chunks with backpressure, reporting progress. */
  async putFile(
    path: string,
    content: Buffer,
    mode?: string,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const sock = await this.connect();
    try {
      this.writeHeader(sock, OP.PUT, { path, mode });
      const CHUNK = 1 << 20;
      for (let off = 0; off < content.length; off += CHUNK) {
        const chunk = content.subarray(off, off + CHUNK);
        if (!sock.write(chunk)) {
          await new Promise<void>((resolve) => sock.once("drain", resolve));
        }
        onProgress?.(Math.min(off + CHUNK, content.length), content.length);
      }
      sock.end();
      const { status } = await readResponse(sock);
      if (status !== ST.OK) {
        throw new TransportError(status, `putFile ${path} failed: ${status}`);
      }
    } finally {
      sock.destroy();
    }
  }

  /** Stream a gzip-compressed tarball to the server, which extracts it to
   *  `dest` with `--strip-components=strip`. Replaces the base64/shell
   *  `gzip -dc | tar -xC` path: no remote gzip/tar/busybox dependency, and
   *  upload + extract pipeline in a single op. */
  async extract(
    dest: string,
    stripComponents: number,
    content: Buffer,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const sock = await this.connect();
    try {
      this.writeHeader(sock, OP.EXTRACT, { dest, stripComponents });
      const CHUNK = 1 << 20;
      for (let off = 0; off < content.length; off += CHUNK) {
        const chunk = content.subarray(off, off + CHUNK);
        if (!sock.write(chunk)) {
          await new Promise<void>((resolve) => sock.once("drain", resolve));
        }
        onProgress?.(Math.min(off + CHUNK, content.length), content.length);
      }
      sock.end();
      const { status } = await readResponse(sock);
      if (status !== ST.OK) {
        throw new TransportError(status, `extract to ${dest} failed: ${status}`);
      }
    } finally {
      sock.destroy();
    }
  }

  /** Streaming PUT. Write to `writer`, then `writer.end()`. */
  async openPutFile(
    path: string,
    mode?: string,
  ): Promise<{ writer: net.Socket; done: Promise<void> }> {
    const sock = await this.connect();
    this.writeHeader(sock, OP.PUT, { path, mode });
    const done = readResponse(sock).then(({ status }) => {
      sock.destroy();
      if (status !== ST.OK) {
        throw new TransportError(status, `putFile ${path} failed: ${status}`);
      }
    });
    return { writer: sock, done };
  }

  /** Buffered GET. */
  async getFile(path: string): Promise<Buffer> {
    const sock = await this.connect();
    try {
      this.writeHeader(sock, OP.GET, { path });
      const { status, body, rest } = await readResponse(sock);
      if (status === ST.MISSING) {
        throw new TransportError(ST.MISSING, `getFile ${path} not found`);
      }
      if (status !== ST.OK) {
        throw new TransportError(status, `getFile ${path} failed: ${status}`);
      }
      // The file body follows the header, so read to EOF.
      const tail = await readToEnd(sock);
      return Buffer.concat([body, rest, tail]);
    } finally {
      sock.destroy();
    }
  }

  /** Streaming GET. Returns a chunk emitter and an end promise. */
  async openGetFile(path: string): Promise<{
    onData(cb: (d: Buffer) => void): void;
    onEnd: Promise<void>;
  }> {
    const sock = await this.connect();
    this.writeHeader(sock, OP.GET, { path });
    const { status, rest } = await readResponse(sock);
    if (status !== ST.OK) {
      sock.destroy();
      throw new TransportError(status, `getFile ${path} failed: ${status}`);
    }
    const cbs: Array<(d: Buffer) => void> = [];
    const pending: Buffer[] = [];
    const emit = (c: Buffer) => {
      if (cbs.length === 0) pending.push(c);
      else for (const cb of cbs) cb(c);
    };
    if (rest.length) emit(rest);
    const onEnd = new Promise<void>((resolve) => {
      sock.on("data", emit);
      sock.on("end", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        resolve();
      });
    });
    return {
      onData: (cb) => {
        cbs.push(cb);
        for (const p of pending) cb(p);
        pending.length = 0;
      },
      onEnd,
    };
  }

  /** SPAWN: run a command with full-duplex stdin/stdout/stderr. */
  async spawn(
    cmd: string,
    args: string[] = [],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<SpawnedCommand> {
    const sock = await this.connect();
    this.writeHeader(sock, OP.SPAWN, {
      cmd,
      args,
      cwd: opts?.cwd,
      env: opts?.env,
    });

    const stdoutCbs: Array<(d: Buffer) => void> = [];
    const stderrCbs: Array<(d: Buffer) => void> = [];
    let resolveExit!: (v: { status: number }) => void;
    let rejectExit!: (e: Error) => void;
    const onExit = new Promise<{ status: number }>((res, rej) => {
      resolveExit = res;
      rejectExit = rej;
    });

    (async () => {
      try {
        const { status, rest } = await readResponse(sock);
        if (status !== ST.OK) {
          throw new TransportError(status, `spawn failed: status ${status}`);
        }
        await readFrames(sock, rest, {
          stdout: (d) => stdoutCbs.forEach((cb) => cb(d)),
          stderr: (d) => stderrCbs.forEach((cb) => cb(d)),
          exit: (code) => resolveExit({ status: code }),
        });
      } catch (err) {
        rejectExit(err instanceof Error ? err : new Error(String(err)));
      } finally {
        sock.destroy();
      }
    })();

    return {
      stdin: {
        write: (data: Uint8Array) =>
          sock.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
        end: () => sock.end(),
      },
      stdout: { onData: (cb) => stdoutCbs.push(cb) },
      stderr: { onData: (cb) => stderrCbs.push(cb) },
      onExit,
    };
  }

  /** fs.connect: duplex relay to a unix socket on the remote. */
  async connectUnix(path: string): Promise<net.Socket> {
    const sock = await this.connect();
    this.writeHeader(sock, OP.CONNECT, { path });
    const { status } = await readResponse(sock);
    if (status !== ST.OK) {
      sock.destroy();
      throw new TransportError(status, `connect ${path} failed: ${status}`);
    }
    return sock;
  }
}

/** Read a 5-byte response header, then the inline body. Returns any
 *  trailing bytes (`rest`) so streaming callers don't lose them. */
function readResponse(
  sock: net.Socket,
): Promise<{ status: number; body: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let need = 5;
    let status = 0;
    let settled = false;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 5 && need === 5) {
        status = buf[0];
        need = 5 + buf.readUInt32BE(1);
      }
      if (buf.length >= need) {
        settled = true;
        sock.off("data", onData);
        resolve({
          status,
          body: buf.subarray(5, need),
          rest: buf.subarray(need),
        });
      }
    };
    sock.on("data", onData);
    sock.on("error", (err) => {
      if (!settled) reject(err);
    });
    sock.on("close", () => {
      if (!settled) reject(new Error("connection closed before response"));
    });
  });
}

/** Read until EOF. */
function readToEnd(sock: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks)));
    sock.on("error", reject);
  });
}

/** Read spawn frames until the exit frame. `initial` is any bytes already
 *  read past the response header. */
function readFrames(
  sock: net.Socket,
  initial: Buffer,
  cb: {
    stdout: (d: Buffer) => void;
    stderr: (d: Buffer) => void;
    exit: (code: number) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = initial;
    let settled = false;
    const drain = () => {
      for (;;) {
        if (buf.length < 5) return;
        const tag = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        const data = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (tag === STREAM_STDOUT) cb.stdout(Buffer.from(data));
        else if (tag === STREAM_STDERR) cb.stderr(Buffer.from(data));
        else if (tag === STREAM_EXIT) {
          settled = true;
          sock.off("data", onData);
          cb.exit(data.length >= 4 ? data.readUInt32BE(0) : 0);
          resolve();
          return;
        }
      }
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      drain();
    };
    sock.on("data", onData);
    sock.on("error", (err) => {
      if (!settled) reject(err);
    });
    sock.on("close", () => {
      if (!settled) reject(new Error("connection closed before exit frame"));
    });
    drain();
  });
}

/** Read exactly `n` bytes from a socket, or reject on timeout / close.
 *  Used by the one-off probe path, which doesn't want the full
 *  `readResponse` framing (no body to drain). */
function readNBytes(
  sock: net.Socket,
  n: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      sock.off("data", onData);
      sock.off("error", onError);
      sock.off("end", onEnd);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`read ${n} bytes timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(buf.subarray(0, n));
      }
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`connection closed before ${n} bytes`));
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("end", onEnd);
  });
}

/** Probe a Go transport at (`socksPort` -> `port`) with `token`. Sends the
 *  HEALTH op over a fresh SOCKS5 connection and returns true if the server
 *  responds `stOK`. Used by the resolver to detect a still-running
 *  transport from a prior session (reload case) before re-shipping the
 *  binary and orphaning the old one.
 *
 *  Any failure (SOCKS dial, write, read, timeout, non-OK status) returns
 *  false; the caller falls through to the existing ship-and-start path. */
export async function probeTransportAlive(
  socksPort: number,
  port: number,
  token: string,
  timeoutMs = 2000,
): Promise<boolean> {
  let sock: net.Socket | undefined;
  try {
    sock = await socks5Connect(
      "127.0.0.1",
      socksPort,
      "127.0.0.1",
      port,
      timeoutMs,
    );
    const tokBuf = Buffer.from(token, "hex");
    if (tokBuf.length !== 32) return false;
    const hdr = Buffer.alloc(6);
    hdr[0] = OP.HEALTH;
    hdr[1] = 0;
    hdr.writeUInt32BE(0, 2);
    sock.write(tokBuf);
    sock.write(hdr);
    const resp = await readNBytes(sock, 5, timeoutMs);
    return resp[0] === ST.OK;
  } catch {
    return false;
  } finally {
    sock?.destroy();
  }
}
