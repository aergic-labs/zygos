/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH connection interfaces.
 *
 * The persistent ssh session (`SshSession`, in `sshSession/connection.ts`)
 * is the only production implementation. `ISshConnection` / `ExecResult` /
 * `SshConnectOptions` are shared with the mock used in unit tests.
 */

import type { ChildProcess } from "node:child_process";
import type { Logger } from "../common/logger";
import type { AskpassServer } from "./askpassServer";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

export interface SshConnectOptions {
  /** Host alias or user@host:port, passed directly to ssh. */
  host: string;
  /** Custom ssh binary path. Defaults to "ssh". */
  sshPath?: string;
  /** Path to a custom ssh config file (-F). Empty = ssh default. */
  configFile?: string;
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
  /** Max wait (ms) for the initial SSH handshake. Default 30s. */
  handshakeTimeoutMs?: number;
  /** TCP-only timeout in seconds (maps to -o ConnectTimeout=N). 0 = omit. */
  tcpTimeoutSeconds?: number;
  /** Local SOCKS5 port for the session's ssh -D. Only used by SshSession. */
  socksPort?: number;
}

/**
 * Interface for an SSH connection. Backed by the persistent local ssh
 * session server (`SshSession`). The mock used in unit tests implements
 * the same interface.
 */
export interface ISshConnection {
  connect(): Promise<void>;
  exec(command: string, timeoutMs?: number, quiet?: boolean): Promise<ExecResult>;
  execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult>;
  spawnProcess(command: string | undefined, extraArgs?: string[]): ChildProcess;
  close(): Promise<void>;
  readonly isConnected: boolean;
  readonly remoteLabel: string;
  /** Write a file to the remote via the Go transport. Requires the
   *  transport. */
  putFile(
    remotePath: string,
    content: Buffer,
    mode?: string,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<ExecResult>;
  /** Write a file over the ssh-session control shell (base64 + nonce exit
   *  marker). The deliberate pre-transport path: the Go binary bootstrap ships
   *  this way, since the transport isn't up yet. */
  putFileViaControlShell(
    remotePath: string,
    content: Buffer,
    mode?: string,
  ): Promise<ExecResult>;
  /** Stream a gzip-compressed tarball to the remote and extract it to `dest`
   *  with `--strip-components=strip`. Requires the transport (no remote
   *  gzip/tar/busybox needed). */
  extract(
    dest: string,
    stripComponents: number,
    content: Buffer,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<ExecResult>;
  /** Actual SOCKS port. Read after connect(). */
  getSocksPort(): number;
  /** Inject the Go transport client. When set, exec, putFile, and
   *  execWithStdin route through the transport instead of the ssh-session
   *  control shell. */
  setTransportClient(client: unknown): void;
}
