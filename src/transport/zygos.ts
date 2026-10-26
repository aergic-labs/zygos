/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ZygosTransport: the zygos-specific ops on top of the generic
 * TransportClient.
 *
 * Used only by the resolver's own lifecycle. Never exposed to other
 * extensions: they get the exec server, which wraps the base
 * TransportClient and only has the ExecServer contract methods.
 *
 * Op codes 1-99 are the ExecServer contract; 100+ are zygos's.
 */

import { TransportClient, ST, TransportError } from "./client";

/** Zygos op codes. Must match go/tunnel/zygos.go. */
const ZOP = {
  SERVER_STATUS: 100,
  SERVER_CLEANUP: 101,
  SERVER_FINALIZE: 102,
  LOCK: 103,
  UNLOCK: 104,
} as const;

export interface ServerStatus {
  /** PID from the pid file, if present and numeric. */
  pid?: number;
  /** Port from the port file, if present and numeric. */
  port?: number;
  /** True if the pid is alive. */
  alive: boolean;
  /** Set when the server is alive and its port responds: reuse it. */
  reusePort?: number;
}

export interface ServerCleanup {
  /** PID that was killed, if any. */
  killedPid?: number;
  /** Stray PIDs killed (matched the install path). */
  strays: number[];
}

export class ZygosTransport extends TransportClient {
  /** Read the server pid/port files, check liveness, probe the port. */
  async serverStatus(installPath: string): Promise<ServerStatus> {
    return this.requestJSON<ServerStatus>(ZOP.SERVER_STATUS, { installPath });
  }

  /** Kill the zombie server (pid file) plus strays matching the install
   *  path, and remove the pid/port files. */
  async serverCleanup(installPath: string): Promise<ServerCleanup> {
    return this.requestJSON<ServerCleanup>(ZOP.SERVER_CLEANUP, { installPath });
  }

  /** Find the running server pid, write the pid/port files, and optionally
   *  release the resolve lock. */
  async serverFinalize(
    installPath: string,
    port: number,
    releaseLock: boolean,
  ): Promise<{ pid?: number }> {
    return this.requestJSON<{ pid?: number }>(ZOP.SERVER_FINALIZE, {
      installPath,
      port,
      releaseLock,
    });
  }

  /** Acquire the resolve lock (mkdir, atomic) with stale reclaim. */
  async lock(dir: string, staleSec: number): Promise<{ acquired: boolean }> {
    return this.requestJSON<{ acquired: boolean }>(ZOP.LOCK, { dir, staleSec });
  }

  /** Release the resolve lock. */
  async unlock(dir: string): Promise<void> {
    const { status } = await this.request(ZOP.UNLOCK, { dir });
    if (status !== ST.OK) {
      throw new TransportError(status, `unlock ${dir} failed: ${status}`);
    }
  }
}
