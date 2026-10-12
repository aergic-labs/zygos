/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SshSessionClient: in-host client for the ssh session local server.
 *
 * Spawns the detached local server process (dist/localServer.js),
 * sends HTTP IPC over a named pipe / Unix socket, manages keepalive,
 * and reconnects on window reload via the persistence file.
 *
 * The bearer token is derived from the ssh session master key
 * (sshSessionSecret.ts) and delivered to the server via stdin, not
 * env or argv.
 */

import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../common/logger";
import { deriveSshSessionToken } from "../sshSessionSecret";
import { LogTailer } from "./logTailer";
import type {
  SshSessionServerConfig,
  ExecRequest,
  ExecResponse,
  PutFileRequest,
  StatusResponse,
} from "./protocol";

const SHUTDOWN_TIMEOUT_MS = 18_000;
const KEEPALIVE_INTERVAL_MS = 6_000;

export interface SshSessionClientOptions {
  /** Destination label (user@host:port). */
  destination: string;
  /** ssh binary path. */
  sshCommand: string;
  /** ssh args (without the host; the client appends host + sh). */
  sshArgs: string[];
  /** Env for the ssh child (SSH_ASKPASS, etc.). */
  sshEnv?: Record<string, string>;
  /** Path to dist/localServer.js. */
  serverScriptPath: string;
  /** Path to node executable (for spawning the server). */
  nodePath: string;
  /** Directory for the persistence file. */
  dataDir: string;
  /** Logger. */
  logger: Logger;
}

export class SshSessionClient {
  private serverChild: ChildProcess | undefined;
  private ipcHandlePath = "";
  private tokenHex = "";
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private dataFilePath = "";
  private logFilePath = "";
  private logTailer: LogTailer | undefined;
  private started = false;
  /** Actual SOCKS port (from the server, after start/reconnect). */
  socksPort = 0;

  constructor(private readonly opts: SshSessionClientOptions) {}

  /** Start the local server and wait for it to be ready. */
  async start(): Promise<void> {
    if (this.started) return;
    this.dataFilePath = path.join(
      this.opts.dataDir,
      `${encodeURIComponent(this.opts.destination)}.json`,
    );

    const token = deriveSshSessionToken(this.opts.destination);
    this.tokenHex = token.toString("hex");

    // Assign the log file path before reconnect so the tailer can attach
    // to an existing server's log on reuse.
    this.logFilePath = path.join(this.opts.dataDir, `${encodeURIComponent(this.opts.destination)}.local-server.log`);

    // Try to reconnect to an existing server via the persistence file.
    const reused = await this.tryReconnect();
    if (reused) {
      this.started = true;
      this.startKeepalive();
      this.startLogTailer();
      this.opts.logger.info(`[ssh-session] reusing existing local server pid=${reused.pid} socks=${this.socksPort}`);
      return;
    }

    this.ipcHandlePath = this.generateIpcPath();

    const config: SshSessionServerConfig = {
      ipcHandlePath: this.ipcHandlePath,
      sshCommand: this.opts.sshCommand,
      sshArgs: [...this.opts.sshArgs, this.opts.destination, "sh"],
      sshEnv: this.opts.sshEnv,
      dataFilePath: this.dataFilePath,
      logFilePath: this.logFilePath,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
    };

    this.opts.logger.info(`[ssh-session] spawning local server ipc=${this.ipcHandlePath}`);
    const child = spawn(
      this.opts.nodePath,
      [this.opts.serverScriptPath],
      {
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
        windowsHide: true,
        env: { ...process.env },
      },
    );
    this.serverChild = child;

    // Write config + token to stdin (not env, not argv).
    const payload = JSON.stringify({ config, token: this.tokenHex }) + "\n";
    child.stdin.write(payload);
    child.stdin.end();

    // Detach so the server survives a window close (until shutdown timer).
    child.unref();

    // Tail the server log file into the output channel. The server writes
    // to the file only (not stderr), so this works across reloads.
    this.startLogTailer();

    // Wait for the server to be ready (poll /status). Fail fast if the
    // server process exits before becoming ready (ssh handshake failure,
    // config error, etc).
    const exitPromise = new Promise<never>((_, reject) => {
      child.once("close", (code) => {
        reject(new Error(`ssh session server exited before ready (code=${code})`));
      });
    });
    await Promise.race([this.waitForReady(), exitPromise]);

    const status = await this.status();
    this.socksPort = status.socksPort;

    // Attach (increment refcount).
    await this.request("/attach", "POST").catch(() => {});

    this.startKeepalive();

    this.started = true;
    this.opts.logger.info(`[ssh-session] local server ready pid=${child.pid} ipc=${this.ipcHandlePath} socks=${this.socksPort}`);
  }

  /** Try to reconnect to an existing server via the persistence file.
   *
   *  Does a real exec probe (not only /status) because the ssh child's
   *  TCP connection can be dead while the node wrapper is still alive
   *  (sshAlive flag is stale until the ssh child's close event fires).
   *  If the probe fails, delete the stale persistence file and return
   *  null so a fresh local server starts. */
  private async tryReconnect(): Promise<StatusResponse | null> {
    let record: { pid: number; ipcHandlePath: string; socksPort: number };
    try {
      const raw = fs.readFileSync(this.dataFilePath, "utf-8");
      record = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!record?.ipcHandlePath || typeof record.socksPort !== "number") {
      return null;
    }
    this.ipcHandlePath = record.ipcHandlePath;
    this.socksPort = record.socksPort;
    try {
      const status = await this.status();
      if (!status.sshAlive || status.socksPort !== record.socksPort) {
        return null;
      }
      // Real exec probe: the ssh child's TCP connection may be dead
      // even though the node wrapper reports sshAlive. A `true` exec
      // verifies the shell is responsive.
      const probe = await this.exec("true", 5_000, true);
      if (probe.exitCode !== 0 && probe.exitCode !== null) {
        throw new Error(`probe exited with ${probe.exitCode}`);
      }
      await this.request("/attach", "POST").catch(() => {});
      return status;
    } catch {
      // Stale persistence file, dead ssh connection, or wrong token.
      // Delete the file so a fresh local server starts.
      try { fs.unlinkSync(this.dataFilePath); } catch { /* best effort */ }
      return null;
    }
  }

  /** Stop the local server. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopKeepalive();
    this.stopLogTailer();
    const pid = this.serverChild?.pid;
    // Detach: decrement refcount. If it hits 0, the shutdown timer
    // fires and the server exits on its own. Don't /shutdown: that
    // would kill the server for other attached windows.
    try {
      await this.request("/detach", "POST");
      this.opts.logger.info(`[ssh-session] detached from local server pid=${pid}`);
    } catch {
      // Server may already be gone.
    }
    this.started = false;
  }

  /** Tail the local server log file into the output channel. */
  private startLogTailer(): void {
    if (this.logTailer || !this.logFilePath) return;
    this.logTailer = new LogTailer(this.logFilePath, (line) => {
      this.opts.logger.info(`[ssh-session-server] ${line}`);
    });
    void this.logTailer.start();
  }

  private stopLogTailer(): void {
    this.logTailer?.dispose();
    this.logTailer = undefined;
  }

  /** Execute a one-shot command. */
  async exec(command: string, timeoutMs?: number, quiet = false): Promise<ExecResponse> {
    const id = crypto.randomBytes(8).toString("hex");
    const body: ExecRequest = { id, command, timeoutMs, quiet };
    return this.request("/exec", "POST", body);
  }

  /** Write a file to the remote. Replaces execWithStdin for binary data. */
  async putFile(
    remotePath: string,
    content: Buffer,
    mode?: string,
  ): Promise<ExecResponse> {
    const id = crypto.randomBytes(8).toString("hex");
    const body: PutFileRequest = {
      id,
      path: remotePath,
      content: content.toString("base64"),
      mode,
    };
    return this.request("/put-file", "POST", body);
  }

  /** Get the SOCKS port from the server. */
  async getSocksPort(): Promise<number> {
    const status = await this.status();
    return status.socksPort;
  }

  /** Check server status. */
  async status(): Promise<StatusResponse> {
    return this.request("/status", "GET");
  }

  private generateIpcPath(): string {
    const id = crypto.randomBytes(16).toString("hex");
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\aergic-ssh-session-${id}`;
    }
    return path.join(os.tmpdir(), `aergic-ssh-session-${id}.sock`);
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        await this.status();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error("ssh session server failed to become ready within 60s");
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(async () => {
      try {
        await this.request("/delay-shutdown", "POST");
      } catch (err) {
        this.opts.logger.info(`[ssh-session] ping failed: ${err instanceof Error ? err.message : String(err)}`);
        this.stopKeepalive();
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  private async request(
    routePath: string,
    method: string,
    body?: unknown,
  ): Promise<any> {
    if (!this.ipcHandlePath) throw new Error("ssh session not started");

    const opts: http.RequestOptions = {
      method,
      path: routePath,
      socketPath: this.ipcHandlePath,
      headers: {
        authorization: `Bearer ${this.tokenHex}`,
        "content-type": "application/json",
      },
    };

    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`ssh session ${routePath} failed (${res.statusCode}): ${text}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            reject(new Error(`ssh session ${routePath}: invalid json response`));
          }
        });
      });
      req.on("error", (err) => reject(new Error(`ssh session ${routePath}: ${err.message}`)));
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
