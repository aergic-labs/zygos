/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SshSession: ISshConnection backed by the persistent ssh session.
 *
 * Implements the same interface as SshConnection but routes exec
 * through the persistent local server (SshSessionClient) instead of
 * spawning a new ssh per call. One ssh handshake per session.
 */

import type { ChildProcess } from "node:child_process";
import type { Logger } from "../../common/logger";
import type { ISshConnection, ExecResult, SshConnectOptions } from "../connection";
import { shellQuote } from "../../remote/shellQuote";
import { SshSessionClient } from "./client";
import { SshSessionProcess } from "./process";
import type { SshTunnelClient } from "../../sshTunnel/client";

export class SshSession implements ISshConnection {
  private client: SshSessionClient | undefined;
  private connected = false;
  private readonly label: string;
  private sessionSocksPort = 0;
  private tunnelClient: SshTunnelClient | undefined;

  constructor(
    private readonly options: SshConnectOptions,
    private readonly sessionDeps: {
      serverScriptPath: string;
      nodePath: string;
      dataDir: string;
      logger: Logger;
    },
  ) {
    this.label = options.host;
  }

  static fromDestination(
    dest: { host: string; user?: string; port?: number },
    opts: Partial<SshConnectOptions>,
    sessionDeps: {
      serverScriptPath: string;
      nodePath: string;
      dataDir: string;
      logger: Logger;
    },
  ): SshSession {
    let hostStr = dest.host;
    if (dest.user) hostStr = `${dest.user}@${hostStr}`;
    const extraArgs = [...(opts.extraArgs ?? [])];
    if (dest.port) extraArgs.push("-p", String(dest.port));
    return new SshSession({ ...opts, host: hostStr, extraArgs }, sessionDeps);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get remoteLabel(): string {
    return this.label;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.options.host) throw new Error("missing host");
    this.sessionDeps.logger.info(`[ssh-session] setting enabled, using persistent connection for ${this.label}`);

    const { sshArgs, sshEnv } = this.buildSshConfig();

    this.client = new SshSessionClient({
      destination: this.label,
      sshCommand: this.options.sshPath ?? "ssh",
      sshArgs,
      sshEnv,
      serverScriptPath: this.sessionDeps.serverScriptPath,
      nodePath: this.sessionDeps.nodePath,
      dataDir: this.sessionDeps.dataDir,
      logger: this.sessionDeps.logger,
    });

    await this.client.start();
    this.sessionSocksPort = this.client.socksPort;
    this.connected = true;
    this.sessionDeps.logger.info(`[ssh] connected to ${this.label} (session)`);
  }

  getSocksPort(): number {
    return this.sessionSocksPort;
  }

  /** Build ssh args + env from connect options. Same shape as SshConnection. */
  private buildSshConfig(): {
    sshArgs: string[];
    sshEnv?: Record<string, string>;
  } {
    const opts = this.options;
    const sshArgs: string[] = [
      "-T",
      ...(opts.askpass ? [] : ["-o", "BatchMode=yes"]),
    ];
    if (opts.tcpTimeoutSeconds && opts.tcpTimeoutSeconds > 0) {
      sshArgs.push("-o", `ConnectTimeout=${opts.tcpTimeoutSeconds}`);
    }
    if (opts.configFile) {
      sshArgs.push("-F", opts.configFile);
    }
    sshArgs.push(...(opts.extraArgs ?? []));

    // Fold the SOCKS forward into the ssh child: ssh -D <port> ... sh.
    if (opts.socksPort) {
      sshArgs.push("-D", String(opts.socksPort));
    }

    let sshEnv: Record<string, string> | undefined;
    if (opts.askpass && opts.askpassScript && opts.askpassMain && opts.nodePath) {
      sshEnv = {
        SSH_ASKPASS: opts.askpassScript,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: "zygos",
        AERGIC_SSH_ASKPASS_HANDLE: opts.askpass.handle,
        AERGIC_SSH_ASKPASS_TOKEN: opts.askpass.token,
        AERGIC_SSH_ASKPASS_NODE: opts.nodePath,
        AERGIC_SSH_ASKPASS_MAIN: opts.askpassMain,
      };
    }

    return { sshArgs, sshEnv };
  }

  async exec(command: string, timeoutMs?: number, quiet = false): Promise<ExecResult> {
    this.requireConnected();
    const response = await this.client!.exec(command, timeoutMs, quiet);
    return {
      stdout: response.stdout,
      stderr: response.stderr ?? "",
      exitCode: response.exitCode,
      signal: response.signal ?? null,
    };
  }

  /** Inject the SshTunnel client. When set, putFile and execWithStdin
   *  route through the tunnel (binary HTTP-over-SOCKS5) instead of
   *  the base64 control-shell hack. */
  setTunnelClient(client: SshTunnelClient | undefined): void {
    this.tunnelClient = client;
  }

  async execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult> {
    this.requireConnected();
    if (this.tunnelClient) {
      const resp = await this.tunnelClient.execWithStdin(command, stdinData);
      return {
        stdout: Buffer.from(resp.stdout, "base64").toString("utf-8"),
        stderr: Buffer.from(resp.stderr, "base64").toString("utf-8"),
        exitCode: resp.exitCode,
        signal: resp.signal ?? null,
      };
    }
    // No tunnel: base64 heredoc via the control shell.
    const b64 = stdinData.toString("base64");
    const wrapped = `echo ${shellQuote(b64)} | base64 -d | ${command}`;
    return this.exec(wrapped);
  }

  async putFile(remotePath: string, content: Buffer, mode?: string): Promise<ExecResult> {
    this.requireConnected();
    if (this.tunnelClient) {
      await this.tunnelClient.putFile(remotePath, content, mode);
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    }
    return this.client!.putFile(remotePath, content, mode);
  }

  spawnProcess(command: string | undefined, _extraArgs: string[] = []): ChildProcess {
    // The session's ssh child is the control shell. spawnProcess
    // returns a virtual child that starts the command in the
    // background and polls for output. Stdin is not supported (control
    // shell stdin is shared).
    if (!command) {
      throw new Error("spawnProcess with no command not supported on ssh session");
    }
    return new SshSessionProcess(this.client!, command, this.sessionDeps.logger) as unknown as ChildProcess;
  }

  async close(): Promise<void> {
    if (this.tunnelClient) {
      this.tunnelClient.dispose();
      this.tunnelClient = undefined;
    }
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
    this.connected = false;
  }

  private requireConnected(): void {
    if (!this.connected) {
      throw new Error(`SSH connection to ${this.label} is not connected`);
    }
  }
}
