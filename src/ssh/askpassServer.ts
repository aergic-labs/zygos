/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH askpass server.
 *
 * Listens on a Unix socket (Unix) or named pipe (Windows). When ssh needs
 * a password/passphrase, the askpass script connects and sends the prompt;
 * a VS Code input box is shown and the password (or cancellation) returned.
 *
 * Flow:
 *   ssh -> askpass.sh/cmd -> askpass-main.js -> socket -> this server ->
 *   vscode.window.showInputBox({password: true}) -> response back
 *
 * The server is per-resolve (one socket per SSH connection) and is
 * disposed when the connection is torn down.
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { Logger } from "../common/logger";
import { getCached, setCached, evict, parseKeyPath, validatePassphrase } from "./askpassCache";

export interface AskpassServerDeps {
  /** Show the password prompt to the user. Returns the password or undefined.
   * errorMessage is shown when retrying after a wrong passphrase. */
  showPrompt(prompt: string, errorMessage?: string): Thenable<string | undefined>;
}

export class AskpassServer {
  private server: net.Server | undefined;
  private socketPath = "";
  private readonly pending = new Map<net.Socket, { buffer: string }>();
  /** Prompts for host passwords (non-key) handled this session.
   * Used to evict bad passwords on resolve failure. */
  private readonly hostPrompts = new Set<string>();
  /**
   * Per-server shared secret. The askpass client must present this token or
   * the request is rejected. Passed to the client out-of-band via an env var
   * (never on the command line), so co-resident local processes that discover
   * the socket cannot harvest cached secrets or trigger prompts.
   */
  private readonly authToken = crypto.randomBytes(32).toString("hex");

  constructor(
    private readonly logger: Logger,
    private readonly deps: AskpassServerDeps,
  ) {}

  /** The auth token the askpass client must present. */
  get token(): string {
    return this.authToken;
  }

  /**
   * Start the askpass server. Returns the socket path that the askpass
   * scripts connect to.
   */
  async start(): Promise<string> {
    this.socketPath = this.generateSocketPath();
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    server.on("error", (err) => {
      this.logger.error(`[askpass] server error: ${err.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(this.socketPath, () => resolve());
      server.once("error", reject);
    });
    // Restrict the socket to the current user (Unix). Named pipes on Windows
    // are namespaced separately; the unguessable name + token guard those.
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch (err) {
        this.logger.error(
          `[askpass] failed to chmod socket: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.info(`[askpass] listening on ${this.socketPath}`);
    return this.socketPath;
  }

  async stop(): Promise<void> {
    for (const [socket] of this.pending) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.server = undefined;
    }
    // Clean up the socket file (Unix only - named pipes are auto-removed).
    if (this.socketPath && process.platform !== "win32") {
      try {
        require("node:fs").unlinkSync(this.socketPath);
      } catch {
        // ignore - may already be gone
      }
    }
    this.logger.info("[askpass] stopped");
  }

  get handle(): string {
    return this.socketPath;
  }

  /** True if any host password prompts were handled this session. */
  get usedHostPassword(): boolean {
    return this.hostPrompts.size > 0;
  }

  /** Evict all host password cache entries from this session.
   * Called on resolve failure so a retry doesn't reuse a bad password. */
  async evictHostPasswords(): Promise<void> {
    for (const prompt of this.hostPrompts) {
      await evict(prompt);
    }
    this.hostPrompts.clear();
  }

  private handleConnection(socket: net.Socket): void {
    this.pending.set(socket, { buffer: "" });

    socket.on("data", (data: Buffer) => {
      const state = this.pending.get(socket);
      if (!state) return;
      state.buffer += data.toString("utf-8");
      if (state.buffer.includes("\n")) {
        this.handleRequest(socket, state.buffer);
      }
    });

    socket.on("error", () => {
      this.pending.delete(socket);
    });

    socket.on("close", () => {
      this.pending.delete(socket);
    });
  }

  /** Constant-time comparison of the presented token against ours. */
  private validToken(provided: unknown): boolean {
    if (typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.authToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private async handleRequest(socket: net.Socket, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw.trim());
      if (!this.validToken(parsed.token)) {
        this.logger.error("[askpass] rejected request with invalid token");
        this.respond(socket, { error: "unauthorized" });
        return;
      }
      if (typeof parsed.request !== "string") {
        this.respond(socket, { error: "missing 'request' field" });
        return;
      }
      const prompt = parsed.request;

      const cached = await getCached(prompt);
      if (cached !== undefined) {
        this.logger.info(`[askpass] CACHE HIT for: ${prompt}`);
        this.respond(socket, { password: cached });
        return;
      }
      this.logger.info(`[askpass] CACHE MISS for: ${prompt}`);

      // For key passphrases, validate before returning to ssh. ssh-keygen
      // does not retry askpass, so a wrong passphrase returned to ssh is a
      // dead end. Loop here: prompt, validate, re-prompt on failure. Up to
      // 3 attempts. Only cache and return after validation passes.
      const keyPath = parseKeyPath(prompt);
      const maxAttempts = keyPath ? 3 : 1;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this.logger.info(
          `[askpass] prompting for: ${prompt}${attempt > 0 ? " (retry " + attempt + ")" : ""}`,
        );
        const password = await this.deps.showPrompt(prompt, lastError);
        if (password === undefined) {
          this.respond(socket, { cancelled: true });
          return;
        }

        if (!keyPath) {
          // Non-key prompt (host password). Can't pre-validate. Cache
          // best-effort and return to ssh.
          this.hostPrompts.add(prompt);
          const result = await setCached(prompt, password);
          if (!result.stored) {
            this.logger.info(`[askpass] cache store failed: ${result.error}`);
          } else {
            this.logger.info(`[askpass] CACHED host password for: ${prompt}`);
          }
          this.respond(socket, { password });
          return;
        }

        const result = validatePassphrase(keyPath, password);
        if (result.valid) {
          await setCached(prompt, password);
          this.logger.info(`[askpass] CACHED passphrase for: ${prompt}`);
          this.respond(socket, { password });
          return;
        }

        lastError = result.error;
        this.logger.info(`[askpass] passphrase rejected: ${result.error}`);
      }

      // Exhausted all attempts.
      this.respond(socket, { error: lastError ?? "passphrase rejected" });
    } catch (err) {
      this.respond(socket, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private respond(socket: net.Socket, obj: object): void {
    socket.write(JSON.stringify(obj) + "\n");
    socket.end();
    this.pending.delete(socket);
  }

  private generateSocketPath(): string {
    const id = crypto.randomBytes(16).toString("hex");
    if (process.platform === "win32") {
      // Named pipes on Windows live in \\.\pipe\
      return `\\\\.\\pipe\\zygos-askpass-${id}`;
    }
    // Unix socket - use the OS temp dir, keep the path short
    // (108-char limit on Linux).
    const tmp = os.tmpdir();
    return path.join(tmp, `zygos-askpass-${id}.sock`);
  }
}
