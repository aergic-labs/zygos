/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Remote server lifecycle: zombie cleanup, PID/port file management,
 * and install locking.
 *
 * When the SSH connection drops (sleep, network), the remote server
 * process may keep running. On reconnect a fresh server would be started,
 * orphaning the old one. This module kills zombies before starting new
 * servers and writes PID/port files for future reconnects to detect or reuse.
 *
 * Files on the remote (under the server install dir):
 *   .server.pid  - PID of the running server process
 *   .server.port - port the server is listening on
 *   .resolve-lock/ - mkdir-based lock for concurrent resolve protection
 */

import type { Logger } from "../common/logger";
import type { ZygosTransport } from "../transport/zygos";

/** Stale-lock age threshold (seconds). A resolve lock older than this is
 * considered abandoned and reclaimed. */
const LOCK_STALE_AGE_SEC = 1800;

/** Result of finalizing a fresh server start. `pid` is the remote server's
 * PID if found; `log` describes what happened. The caller logs `log`. */
export interface FinalizeResult {
  /** Remote server PID, or undefined if pgrep found nothing. */
  pid?: number;
  /** Human-readable context for the caller to log. */
  log: string;
}

/**
 * Probe the remote server PID, write PID/port files, and optionally release
 * the resolve lock, all in a single SSH call.
 *
 * Folds probeServerPid + writeServerMetadata + releaseResolveLock into one
 * round-trip. Each step is a remote shell op with no dependency on a client
 * round-trip in between. Returns a `FinalizeResult` with the PID (if found)
 * and a `log` string.
 */
export async function finalizeServerStart(
  installPath: string,
  port: number,
  opts: { releaseLock: boolean },
  transport: ZygosTransport,
): Promise<FinalizeResult> {
  const { pid } = await transport.serverFinalize(
    installPath,
    port,
    opts.releaseLock,
  );
  if (pid) {
    return {
      pid,
      log: opts.releaseLock
        ? `wrote PID=${pid} port=${port}, released resolve lock`
        : `wrote PID=${pid} port=${port}`,
    };
  }
  return {
    log: opts.releaseLock
      ? "no remote server PID found, released resolve lock"
      : "no remote server PID found",
  };
}

/** Result of acquiring the resolve lock and probing for an existing
 * server, done in a single SSH round-trip. The caller branches on
 * `reusePort` (reuse existing server vs start fresh) and `locked`
 * (whether to release the lock later). `log` is for the caller to log. */
export interface LockProbeResult {
  /** True if we hold the resolve lock and must release it later. */
  locked: boolean;
  /** Remote port to reuse, or undefined to start a fresh server. */
  reusePort?: number;
  /** Human-readable context for the caller to log. */
  log: string;
}

/**
 * Acquire the resolve lock and probe for an existing/zombie server in a
 * single SSH call.
 *
 * Folds acquireResolveLock + cleanupZombieServer into one round-trip.
 * The lock is acquired first (mkdir-based, atomic), then the zombie probe
 * runs inside the lock. Returns a `LockProbeResult`.
 */
export async function acquireLockAndProbeZombie(
  installPath: string,
  transport: ZygosTransport,
): Promise<LockProbeResult> {
  const lockDir = `${installPath}/.resolve-lock`;

  const { acquired } = await transport.lock(lockDir, LOCK_STALE_AGE_SEC);
  if (!acquired) {
    return {
      locked: false,
      log: "could not acquire resolve lock - another resolve may be running",
    };
  }
  const status = await transport.serverStatus(installPath);
  if (status.reusePort) {
    return {
      locked: true,
      reusePort: status.reusePort,
      log: `acquired resolve lock, server alive on port ${status.reusePort}, reusing`,
    };
  }
  if (!status.pid) {
    return { locked: true, log: "acquired resolve lock, no existing PID file" };
  }
  if (!status.alive) {
    await transport.serverCleanup(installPath);
    return {
      locked: true,
      log: `acquired resolve lock, PID ${status.pid} is dead, cleaned up files`,
    };
  }
  const cleanup = await transport.serverCleanup(installPath);
  const strayMsg =
    cleanup.strays.length > 0
      ? `, killed strays ${cleanup.strays.join(", ")}`
      : "";
  return {
    locked: true,
    log: `acquired resolve lock, killed zombie PID ${cleanup.killedPid}${strayMsg}, cleanup complete`,
  };
}

/**
 * Remove the server metadata files. Called on clean shutdown.
 */
export async function removeServerMetadata(
  installPath: string,
  logger: Logger,
  transport: ZygosTransport,
): Promise<void> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;
  await transport.rm(pidFile);
  await transport.rm(portFile);
  logger.info("[lifecycle] removed PID/port files");
}

/**
 * Release the resolve lock. Best-effort.
 */
export async function releaseResolveLock(
  installPath: string,
  logger: Logger,
  transport: ZygosTransport,
): Promise<void> {
  const lockDir = `${installPath}/.resolve-lock`;
  await transport.unlock(lockDir);
  logger.info("[lifecycle] released resolve lock");
}
