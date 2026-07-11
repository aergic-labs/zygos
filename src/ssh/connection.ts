/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH connection via the system `ssh` binary.
 *
 * Shells out to `ssh` (same approach as MS Remote-SSH): all auth, keys,
 * agent, known_hosts, ProxyJump, etc. are handled by OpenSSH itself.
 *
 * Each exec spawns an ssh process. A persistent ssh process with
 * ControlMaster for connection reuse is a future phase 2 improvement.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../common/logger";
import type { AskpassServer } from "./askpassServer";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export interface SshConnectOptions {
  /** Host alias or user@host:port - passed directly to ssh. */
  host: string;
  /** Custom ssh binary path. Defaults to "ssh". */
  sshPath?: string;
  /** Extra args to pass to ssh (e.g. ["-o", "ConnectTimeout=10"]). */
  extraArgs?: string[];
  /** Logger for ssh verbose output. */
  logger?: Logger;
  /** Askpass server (enables password/passphrase prompts via VS Code UI). */
  askpass?: AskpassServer;
  /** Path to the askpass wrapper script for the current platform. */
  askpassScript?: string;
  /** Path to askpass-main.js. */
  askpassMain?: string;
  /** Path to node executable (for askpass-main.js). */
  nodePath?: string;
}

/**
 * SSH connection backed by the system ssh binary.
 */
export class SshConnection {
  private readonly label: string;
  private readonly sshPath: string;
  private readonly extraArgs: string[];
  private readonly logger?: Logger;
  private readonly askpass?: AskpassServer;
  private readonly askpassScript?: string;
  private readonly askpassMain?: string;
  private readonly nodePath?: string;
  private connected = false;

  constructor(private readonly options: SshConnectOptions) {
    this.label = options.host;
    this.sshPath = options.sshPath ?? "ssh";
    this.extraArgs = options.extraArgs ?? [];
    this.logger = options.logger;
    this.askpass = options.askpass;
    this.askpassScript = options.askpassScript;
    this.askpassMain = options.askpassMain;
    this.nodePath = options.nodePath;
  }

  /**
   * Build a connection from a destination + overrides.
   * For subprocess mode, the destination is just the host string.
   */
  static fromDestination(
    dest: { host: string; user?: string; port?: number },
    opts: Partial<SshConnectOptions> = {},
  ): SshConnection {
    let hostStr = dest.host;
    if (dest.user) hostStr = `${dest.user}@${hostStr}`;
    const extraArgs = [...(opts.extraArgs ?? [])];
    if (dest.port) extraArgs.push("-p", String(dest.port));
    return new SshConnection({ ...opts, host: hostStr, extraArgs });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get remoteLabel(): string {
    return this.label;
  }

  /**
   * "Connect" - verifies ssh exists and the host is reachable by running
   * a trivial command. ssh verbose output is logged for diagnostics.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.logger?.info(`[ssh] connecting to ${this.label}...`);
    const result = await this.runExec("true", undefined, 15_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `SSH connect to ${this.label} failed: ${result.stderr || `exit code ${result.exitCode}`}`,
      );
    }
    this.connected = true;
    this.logger?.info(`[ssh] connected to ${this.label}`);
  }

  /** Exec a command on the remote. */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    this.requireConnected();
    return this.runExec(command, undefined, timeoutMs);
  }

  /** Exec a command and stream stdin data into it. */
  async execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult> {
    this.requireConnected();
    return this.runExec(command, stdinData);
  }

  /**
   * Spawn ssh and run a command. Collects stdout/stderr.
   *
   * -v sends ssh debug output to stderr, which is logged.
   * -T disables pseudo-terminal.
   * BatchMode=yes prevents hanging on interactive prompts - fail fast instead.
   *   Dropped when askpass is enabled (ssh prompts for passwords then).
   */
  private runExec(
    command: string,
    stdinData: Buffer | undefined,
    timeoutMs?: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const args = [
        "-T", // no PTY
        ...this.batchModeArgs(),
        "-o",
        "ConnectTimeout=15",
        ...this.extraArgs,
        this.options.host,
        command,
      ];

      this.logger?.debug(`[ssh] ${command}`);

      const child = spawn(this.sshPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: this.sshEnv(),
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

      if (stdinData) {
        // Write in chunks with backpressure handling - a single write() of
        // 188MB can stall the stream. Write 64KB at a time, wait for 'drain'
        // when the internal buffer is full, then end stdin.
        const CHUNK = 64 * 1024;
        let offset = 0;
        const writeNext = (): Promise<void> => {
          return new Promise<void>((resolve, reject) => {
            const writeChunk = () => {
              while (offset < stdinData.length) {
                const end = Math.min(offset + CHUNK, stdinData.length);
                const chunk = stdinData.subarray(offset, end);
                offset = end;
                if (!child.stdin.write(chunk)) {
                  // Buffer full - wait for drain before continuing.
                  child.stdin.once("drain", writeChunk);
                  return;
                }
              }
              // All chunks written - close stdin so remote pipe sees EOF.
              child.stdin.end();
              resolve();
            };
            writeChunk();
            child.stdin.on("error", reject);
          });
        };
        void writeNext();
      } else {
        child.stdin.end();
      }

      let timeoutHandle: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`SSH exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(new Error(`SSH spawn failed: ${err.message}. Is ssh in PATH?`));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.logger?.debug(`[ssh] exit=${code}`);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode: code,
          signal: signal,
        });
      });
    });
  }

  /**
   * Spawn a long-running ssh process (e.g. port forward `-N`, or a server
   * that stays in the foreground). Returns the raw ChildProcess for the
   * caller to read stdout/stderr and manage the lifecycle.
   */
  spawnProcess(
    command: string | undefined,
    extraArgs: string[] = [],
  ): ChildProcess {
    const args = [
      "-T",
      ...this.batchModeArgs(),
      "-o",
      "ConnectTimeout=15",
      ...this.extraArgs,
      ...extraArgs,
      this.options.host,
    ];
    if (command) args.push(command);

    this.logger?.debug(
      `[ssh] spawn: ${extraArgs.join(" ")} ${this.options.host} ${command ?? "(no command)"}`,
    );

    return spawn(this.sshPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.sshEnv(),
    });
  }

  /** Build the ssh arg list for a one-shot exec (without spawning). */
  buildExecArgs(command: string): string[] {
    return [
      "-T",
      ...this.batchModeArgs(),
      "-o",
      "ConnectTimeout=15",
      ...this.extraArgs,
      this.options.host,
      command,
    ];
  }

  /**
   * Returns ["-o", "BatchMode=yes"] when askpass is disabled, or [] when
   * enabled (askpass requires ssh to prompt for passwords).
   */
  private batchModeArgs(): string[] {
    return this.askpass ? [] : ["-o", "BatchMode=yes"];
  }

  /**
   * Build the environment for ssh. When askpass is enabled, sets
   * SSH_ASKPASS, DISPLAY (required by OpenSSH to use SSH_ASKPASS), and
   * the ZYGOS_SSH_ASKPASS_* vars that the askpass scripts read.
   */
  private sshEnv(): NodeJS.ProcessEnv {
    if (
      !this.askpass ||
      !this.askpassScript ||
      !this.askpassMain ||
      !this.nodePath
    ) {
      return undefined as unknown as NodeJS.ProcessEnv;
    }
    return {
      ...process.env,
      SSH_ASKPASS: this.askpassScript,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: this.options.host ? "zygos" : ":0", // any non-empty value works
      ZYGOS_SSH_ASKPASS_HANDLE: this.askpass.handle,
      ZYGOS_SSH_ASKPASS_TOKEN: this.askpass.token,
      ZYGOS_SSH_ASKPASS_NODE: this.nodePath,
      ZYGOS_SSH_ASKPASS_MAIN: this.askpassMain,
    };
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new Error(`SSH connection to ${this.label} is not connected`);
    }
  }
}
