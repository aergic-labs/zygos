/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SshTunnelClient: HTTP-over-SOCKS5 client for the remote SshTunnel
 * service.
 *
 * The tunnel service runs on the remote (127.0.0.1:tunnelPort), reached
 * through the local SOCKS5 forward (127.0.0.1:socksPort). All requests
 * carry the bearer token (timing-safe checked on the server).
 *
 * Methods:
 *   putFile(path, content, mode?)   buffered PUT (small files)
 *   openPutFile(path, mode?)        streaming PUT (large files / stdin)
 *   getFile(path)                   buffered GET
 *   spawn(req)                       POST /spawn
 *
 * Used by execServer.spawn on the ssh session path to stream stdin and
 * read stdout/stderr/exit without clogging the control shell.
 */

import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import type { Logger } from "../common/logger";
import { socks5Connect } from "../net/socks5";
import type { SpawnRequest, SpawnResponse, ExecResponse } from "./server";

/** Heartbeat interval. Keeps an active tunnel's idle timer reset so it
 *  doesn't self-exit while the client is alive but idle (user reading
 *  code, not running commands). The server's idle timeout is 120s, so a
 *  30s ping gives 4x headroom before the tunnel would age out. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Consecutive /health failures before the client reports the tunnel
 *  unreachable. At 30s per beat this is ~90s: above a transient blip,
 *  below the server's 120s idle deadline. */
const UNREACHABLE_THRESHOLD = 3;

export interface SshTunnelClientOptions {
  /** Local SOCKS5 proxy port (ssh -D). */
  socksPort: number;
  /** Remote tunnel service port. */
  tunnelPort: number;
  /** Bearer token (hex). */
  token: string;
  /** Logger (optional). */
  logger?: Logger;
  /** Custom agent (tests). Default: SOCKS5-based agent. */
  agent?: http.Agent;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** If set, heartbeat diagnostics are appended to this file (in
   *  addition to the logger). For diagnosis when the output channel
   *  is not visible. */
  logFilePath?: string;
  /** Called once when the tunnel has been unreachable for
   *  UNREACHABLE_THRESHOLD consecutive heartbeats. Lets the caller treat a
   *  dead tunnel like a dead connection instead of only logging. */
  onUnreachable?: () => void;
  /** Heartbeat interval override in ms. Defaults to HEARTBEAT_INTERVAL_MS.
   *  Tests use a short interval; production leaves it unset. */
  heartbeatIntervalMs?: number;
}

/** Result of a buffered HTTP request to the tunnel. */
export interface TunnelResponse {
  status: number;
  body: Buffer;
}

/** Error thrown when the tunnel returns a non-200 response. */
export class TunnelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TunnelHttpError";
  }
}

export class SshTunnelClient {
  private readonly agent: http.Agent;
  private readonly timeoutMs: number;
  private heartbeat: NodeJS.Timeout | undefined;
  private consecutiveHeartbeatFailures = 0;
  private unreachableReported = false;

  constructor(private readonly opts: SshTunnelClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.agent = opts.agent ?? this.createSocksAgent();
    this.startHeartbeat();
  }

  /** Release the agent's socket pool and stop the heartbeat. Call when done. */
  dispose(): void {
    this.stopHeartbeat();
    this.agent.destroy();
  }

  /** True once the heartbeat has failed UNREACHABLE_THRESHOLD times in a
   *  row (reset on the next success). */
  isUnreachable(): boolean {
    return this.consecutiveHeartbeatFailures >= UNREACHABLE_THRESHOLD;
  }

  /** Heartbeat to keep the tunnel's idle timer reset while the client is
   *  alive, and to detect an unreachable tunnel. Transient errors are
   *  logged and tolerated; after UNREACHABLE_THRESHOLD consecutive failures
   *  the client reports unreachable via opts.onUnreachable so the caller can
   *  treat it like a dead connection. unref'd so it doesn't keep the
   *  extension host alive. */
  private startHeartbeat(): void {
    let ticks = 0;
    const log = (msg: string): void => {
      const line = `${new Date().toISOString()} ${msg}\n`;
      this.opts.logger?.info(msg);
      if (this.opts.logFilePath) {
        try { fs.appendFileSync(this.opts.logFilePath, line); } catch { /* best effort */ }
      }
    };
    const tick = (): void => {
      ticks++;
      this.request("GET", "/health")
        .then((res) => {
          this.consecutiveHeartbeatFailures = 0;
          this.unreachableReported = false;
          if (ticks <= 5 || ticks % 20 === 0) {
            log(`[tunnel] heartbeat #${ticks} ok (status=${res.status})`);
          }
        })
        .catch((err) => {
          this.consecutiveHeartbeatFailures++;
          log(
            `[tunnel] heartbeat #${ticks} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (
            this.consecutiveHeartbeatFailures >= UNREACHABLE_THRESHOLD &&
            !this.unreachableReported
          ) {
            this.unreachableReported = true;
            log(
              `[tunnel] unreachable (${this.consecutiveHeartbeatFailures} consecutive heartbeat failures)`,
            );
            this.opts.onUnreachable?.();
          }
        });
    };
    // Fire one immediately so we know the client started and the first
    // ping landed (or failed) before the 120s idle deadline.
    tick();
    this.heartbeat = setInterval(
      tick,
      this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Build the default SOCKS5-based agent. Each socket is a SOCKS5
   *  tunnel to 127.0.0.1:tunnelPort through the local SOCKS proxy.
   *  Subclasses http.Agent and overrides createConnection directly,
   *  because passing createConnection in the Agent constructor options
   *  is not reliably picked up by http.request on all Node versions. */
  private createSocksAgent(): http.Agent {
    const { socksPort, tunnelPort } = this.opts;
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: 8,
    });
    (agent as any).createConnection = (
      _options: net.NetConnectOpts,
      callback: (err: Error | null, socket: net.Socket) => void,
    ) => {
      socks5Connect("127.0.0.1", socksPort, "127.0.0.1", tunnelPort)
        .then((socket) => callback(null, socket))
        .catch((err) => callback(err as Error, undefined as any));
    };
    return agent;
  }

  private baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Host: `127.0.0.1:${this.opts.tunnelPort}`,
    };
  }

  /** Buffered PUT /file. For small files. Throws on non-200. */
  async putFile(remotePath: string, content: Buffer, mode?: string): Promise<void> {
    const params = new URLSearchParams({ p: remotePath });
    if (mode) params.set("mode", mode);
    const res = await this.request(
      "PUT",
      `/file?${params.toString()}`,
      content,
      "application/octet-stream",
    );
    if (res.status !== 200) {
      throw new TunnelHttpError(
        res.status,
        `putFile ${remotePath} failed: ${res.status} ${res.body.toString("utf-8")}`,
      );
    }
  }

  /** Streaming PUT /file. Returns the request (a writable stream) and a
   *  promise that resolves when the server confirms the write. Write
   *  content to `writer`, then call `writer.end()`. No client-side
   *  buffering: chunks go straight to the socket. */
  openPutFile(remotePath: string, mode?: string): {
    writer: http.ClientRequest;
    done: Promise<void>;
  } {
    const params = new URLSearchParams({ p: remotePath });
    if (mode) params.set("mode", mode);
    const pathname = `/file?${params.toString()}`;
    const req = http.request({
      method: "PUT",
      host: "127.0.0.1",
      port: this.opts.tunnelPort,
      path: pathname,
      headers: this.baseHeaders(),
      agent: this.agent,
      timeout: this.timeoutMs,
    });
    const done = new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else {
            reject(
              new TunnelHttpError(
                res.statusCode ?? 0,
                `putFile ${remotePath} failed: ${res.statusCode} ${Buffer.concat(chunks).toString("utf-8")}`,
              ),
            );
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("tunnel putFile timed out"));
      });
    });
    return { writer: req, done };
  }

  /** Buffered GET /file. Returns the full body (from byte offset).
   *  Throws TunnelHttpError on non-200. A 404 is reported as not-found. */
  async getFile(remotePath: string, offset?: number): Promise<Buffer> {
    const params = new URLSearchParams({ p: remotePath });
    if (offset && offset > 0) params.set("offset", String(offset));
    const res = await this.request("GET", `/file?${params.toString()}`);
    if (res.status === 404) {
      throw new TunnelHttpError(404, `getFile ${remotePath} not found`);
    }
    if (res.status !== 200) {
      throw new TunnelHttpError(
        res.status,
        `getFile ${remotePath} failed: ${res.status} ${res.body.toString("utf-8")}`,
      );
    }
    return res.body;
  }

  /** POST /exec. Run a shell command with buffered stdin, get
   *  stdout/stderr/exitCode back in one round trip. No temp files.
   *  `stdin` is raw bytes; encoded base64 for transport. */
  async execWithStdin(command: string, stdin: Buffer, options?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResponse> {
    const payload = JSON.stringify({
      command,
      stdin: stdin.toString("base64"),
      cwd: options?.cwd,
      env: options?.env,
    });
    const res = await this.request("POST", "/exec", Buffer.from(payload, "utf-8"), "application/json");
    if (res.status !== 200) {
      throw new TunnelHttpError(
        res.status,
        `exec failed: ${res.status} ${res.body.toString("utf-8")}`,
      );
    }
    return JSON.parse(res.body.toString("utf-8")) as ExecResponse;
  }

  /** POST /spawn. Returns the allocated temp paths. */
  async spawn(req: SpawnRequest): Promise<SpawnResponse> {
    const body = Buffer.from(JSON.stringify(req), "utf-8");
    const res = await this.request("POST", "/spawn", body, "application/json");
    if (res.status !== 200) {
      throw new TunnelHttpError(
        res.status,
        `spawn failed: ${res.status} ${res.body.toString("utf-8")}`,
      );
    }
    return JSON.parse(res.body.toString("utf-8")) as SpawnResponse;
  }

  /** Issue a buffered HTTP request through the SOCKS5 agent. */
  private request(
    method: string,
    pathname: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<TunnelResponse> {
    return new Promise<TunnelResponse>((resolve, reject) => {
      const headers = this.baseHeaders();
      if (body !== undefined) {
        if (contentType) headers["Content-Type"] = contentType;
        headers["Content-Length"] = String(body.length);
      }
      const req = http.request(
        {
          method,
          host: "127.0.0.1",
          port: this.opts.tunnelPort,
          path: pathname,
          headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("tunnel request timed out"));
      });
      if (body !== undefined) req.end(body);
      else req.end();
    });
  }
}
