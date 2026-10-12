/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Protocol types shared between the local server (localServer.ts) and
 * SshSessionClient (in-host). Both sides import from here.
 */

/** Ssh session protocol version. Bumped on breaking changes to framing or routes. */
export const SSH_SESSION_PROTOCOL_VERSION = 1;

/** Config handed to the server process via stdin (not argv, not env). */
export interface SshSessionServerConfig {
  /** IPC socket path the server listens on. */
  ipcHandlePath: string;
  /** ssh binary path. */
  sshCommand: string;
  /** ssh argv (host, -D, -o, etc.). Server spawns one ssh with these. */
  sshArgs: string[];
  /** Env for the ssh child (SSH_ASKPASS, etc.). No token, no secrets. */
  sshEnv?: Record<string, string>;
  /** Where to write the persistent data file (pid, ipcHandlePath, ...). */
  dataFilePath: string;
  /** Where to write a persistent log (survives detach). Empty = no file log. */
  logFilePath: string;
  /** Shutdown timer in ms. Starts when refcount hits 0. */
  shutdownTimeoutMs: number;
  /** Keepalive ping interval in ms. */
  keepaliveIntervalMs: number;
}

/** Persistent data file. No secrets. Keyed by destination. */
export interface SshSessionPersistenceRecord {
  pid: number;
  ipcHandlePath: string;
  socksPort: number;
  startupTime: number;
  sshSessionProtocolVersion: number;
}

/** /exec request body. */
export interface ExecRequest {
  id: string;
  command: string;
  timeoutMs?: number;
  /** If true, the server skips logging this exec (for polling). */
  quiet?: boolean;
}

/** /exec response body. */
export interface ExecResponse {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

/** /put-file request body. Replaces execWithStdin. */
export interface PutFileRequest {
  id: string;
  path: string;
  /** base64-encoded content. */
  content: string;
  mode?: string;
}

/** /status response. */
export interface StatusResponse {
  sshAlive: boolean;
  pid: number;
  socksPort: number;
  startupTime: number;
  sshSessionProtocolVersion: number;
}
