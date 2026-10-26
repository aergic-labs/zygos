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
import type { TransportClient } from "../../transport/client";

export class SshSession implements ISshConnection {
  private client: SshSessionClient | undefined;
  private connected = false;
  private readonly label: string;
  private sessionSocksPort = 0;
  private transportClient: TransportClient | undefined;

  /** Floor for ready-handshake timeout when askpass is active, so password
   *  entry isn't rushed. Mirrors SshConnection.ASKPASS_CONNECT_FLOOR_MS. */
  private static readonly ASKPASS_CONNECT_FLOOR_MS = 120_000;

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

    // Mirror SshConnection's askpass floor: when askpass is active, the
    // ready handshake can pause on a host-authenticity or password prompt,
    // so the timeout must accommodate human response time. Without this,
    // a prompt that takes >30s times out the handshake underneath while the
    // input box stays open. The user can also raise the floor via
    // zygos.handshakeTimeout above 2min.
    const base = this.options.handshakeTimeoutMs ?? 30_000;
    const handshakeTimeoutMs = this.options.askpass
      ? Math.max(base, SshSession.ASKPASS_CONNECT_FLOOR_MS)
      : base;

    this.client = new SshSessionClient({
      destination: this.label,
      sshCommand: this.options.sshPath ?? "ssh",
      sshArgs,
      sshEnv,
      serverScriptPath: this.sessionDeps.serverScriptPath,
      nodePath: this.sessionDeps.nodePath,
      dataDir: this.sessionDeps.dataDir,
      logger: this.sessionDeps.logger,
      handshakeTimeoutMs,
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
    // Route through the Go transport when one is set and the caller didn't
    // request a timeout. The transport's exec runs `sh -c <command>` on the
    // remote, so shell semantics (pipes, redirects, && chains) are preserved.
    // Callers that pass a timeout (the health monitor's ssh-alive ping) want
    // to probe the control shell itself, not the transport; leave those on
    // the ssh-session local server path. Default non-session path never has
    // a transport set, so this branch is session-only.
    if (this.transportClient && !timeoutMs) {
      const r = await this.transportClient.exec("sh", ["-c", command]);
      return {
        stdout: r.stdout.toString("utf-8"),
        stderr: r.stderr.toString("utf-8"),
        exitCode: r.exitCode,
        signal: r.signal,
      };
    }
    const response = await this.client!.exec(command, timeoutMs, quiet);
    return {
      stdout: response.stdout,
      stderr: response.stderr ?? "",
      exitCode: response.exitCode,
      signal: response.signal ?? null,
    };
  }

  /** Inject the Go transport client. When set, exec, putFile, and
   *  execWithStdin route through the transport instead of the ssh-session
   *  control shell. */
  setTransportClient(client: TransportClient | undefined): void {
    this.transportClient = client;
  }

  async execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult> {
    this.requireConnected();
    if (this.transportClient) {
      const r = await this.transportClient.execWithStdin(command, stdinData);
      return {
        stdout: r.stdout.toString("utf-8"),
        stderr: r.stderr.toString("utf-8"),
        exitCode: r.exitCode,
        signal: r.signal,
      };
    }
    // No transport: base64 heredoc via the control shell.
    const b64 = stdinData.toString("base64");
    const wrapped = `echo ${shellQuote(b64)} | base64 -d | ${command}`;
    return this.exec(wrapped);
  }

  async putFile(
    remotePath: string,
    content: Buffer,
    mode?: string,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<ExecResult> {
    this.requireConnected();
    if (this.transportClient) {
      await this.transportClient.putFile(remotePath, content, mode, onProgress);
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    }
    return this.client!.putFile(remotePath, content, mode);
  }

  /** Stream a gzip tarball to the remote and extract it. Uses the Go
   *  transport when set (no remote gzip/tar/busybox needed); falls back to
   *  putFile + exec `gzip -dc | tar -xC` for the session-without-transport
   *  case (e.g. transport failed to start). */
  async extract(
    dest: string,
    stripComponents: number,
    content: Buffer,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<ExecResult> {
    this.requireConnected();
    if (this.transportClient) {
      try {
        await this.transportClient.extract(dest, stripComponents, content, onProgress);
        return { stdout: "", stderr: "", exitCode: 0, signal: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { stdout: "", stderr: msg, exitCode: 1, signal: null };
      }
    }
    // Fallback: upload to a tmp file, then exec gzip|tar.
    const tmp = `${dest}.tar.gz`;
    const putResult = await this.putFile(tmp, content, "0600", onProgress);
    if (putResult.exitCode !== 0) {
      void this.exec(`rm -f ${tmp}`).catch(() => {});
      return {
        stdout: putResult.stdout,
        stderr: putResult.stderr || putResult.stdout,
        exitCode: putResult.exitCode,
        signal: putResult.signal,
      };
    }
    const cmd =
      `gzip -dc ${tmp} | tar -xC ${dest} --strip-components=${stripComponents} && rm -f ${tmp}`;
    const result = await this.exec(cmd);
    if (result.exitCode !== 0) {
      void this.exec(`rm -f ${tmp}`).catch(() => {});
    }
    return result;
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
