/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ExecServer implementation backed by SSH exec + SOCKS.
 *
 * `resolveExecServer` returns an instance of this class. The child resolver
 * (e.g. artizo) calls methods on it to drive Docker, write files, and
 * connect to container servers - all over SSH exec and SOCKS5.
 */

import type { ChildProcess } from "node:child_process";
import type { Logger } from "../common/logger";
import { SshConnection } from "../ssh/connection";
import { shellQuote } from "../server/busybox";
import { socks5Connect } from "../net/socks5";
import { wrapSocket } from "../net/managedConnection";
import { SimpleEvent } from "../common/event";

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

// --- ExecServer ---

export class SshExecServer {
  constructor(
    private readonly conn: SshConnection,
    private readonly socksPort: number | undefined,
    private readonly logger: Logger,
  ) {}

  /** Spawn a command on the remote, returning streaming stdin/stdout/stderr. */
  spawn(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ): Promise<SpawnedCommand> {
    const fullCmd = this.buildCommand(command, args, options);
    this.logger.info(`[execServer] spawn: ${fullCmd}`);

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
    await this.conn.exec(`kill ${processId} 2>/dev/null || true`);
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
        `stat -c "%F %s %Y" ${shellQuote(path)} 2>/dev/null || ` +
          `stat -f "%HT %z %m" ${shellQuote(path)} 2>/dev/null`,
      );
      if (result.exitCode !== 0) {
        this.logger.info(`[execServer] fs.stat failed: ${path}: ${result.stderr.trim()}`);
        throw new Error(`stat failed for ${path}: ${result.stderr}`);
      }
      // Output format: "<type> <size> <mtime>"
      // Type can be multi-word: "regular file", "directory",
      // "symbolic link", etc. Size and mtime are always integers.
      const trimmed = result.stdout.trim();
      // Split from the right - size and mtime are the last two tokens.
      const mtimeMatch = trimmed.match(/(\d+)\s*$/);
      const sizeMatch = trimmed.match(/(\d+)\s+\d+\s*$/);
      const typeStr = trimmed.replace(/\s*\d+\s+\d+\s*$/, "").trim();
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
      const mtime = mtimeMatch ? parseInt(mtimeMatch[1], 10) : 0;

      let type = FT_UNKNOWN;
      if (
        typeStr === "regular file" ||
        typeStr === "regularfile" ||
        typeStr === "File"
      ) {
        type = FT_FILE;
      } else if (typeStr === "directory" || typeStr === "Directory") {
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
      await this.conn.exec(`rm -rf ${shellQuote(path)} 2>/dev/null || true`);
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
        } else if (last === "*") {
          type = FT_FILE;
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
      for (const [k, v] of Object.entries(options.env)) {
        parts.push(`${k}=${shellQuote(v)}`);
      }
    }
    if (options?.cwd) {
      parts.push(`cd ${shellQuote(options.cwd)} &&`);
    }
    parts.push(command);
    for (const a of args) {
      parts.push(shellQuote(a));
    }
    return parts.join(" ");
  }
}
