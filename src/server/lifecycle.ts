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

import type { SshConnection } from "../ssh/connection";
import type { Logger } from "../common/logger";
import { bbExec, shellQuote } from "./busybox";

/** Stale-lock age threshold (seconds). A resolve lock older than this is
 * considered abandoned and reclaimed. */
const LOCK_STALE_AGE_SEC = 1800;

/**
 * Check for a zombie server for this install path.
 *
 * Reads the PID and port files. If the PID is alive AND the server is
 * responding on its port, it's not a zombie - it's a healthy server
 * from another window. Returns { reusePort } so the resolver can skip
 * starting a new server and just connect to the existing one.
 *
 * If the PID is dead or the server is not responding, cleans up the
 * files and kills any strays. Returns { reusePort: undefined }.
 */
export async function cleanupZombieServer(
  conn: SshConnection,
  home: string,
  installPath: string,
  logger: Logger,
): Promise<{ reusePort?: number }> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;

  const readResult = await bbExec(
    conn,
    home,
    `cat ${shellQuote(pidFile)} 2>/dev/null`,
  );
  if (readResult.exitCode !== 0 || !readResult.stdout.trim()) {
    logger.info("[lifecycle] no existing PID file, clean start");
    return {};
  }

  const pid = readResult.stdout.trim();
  logger.info(`[lifecycle] found PID file: ${pid}`);

  // Check if the process is alive.
  const aliveResult = await bbExec(conn, home, `kill -0 ${pid} 2>/dev/null`);
  if (aliveResult.exitCode !== 0) {
    logger.info(`[lifecycle] PID ${pid} is dead, cleaning up files`);
    await bbExec(
      conn,
      home,
      `rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}`,
    );
    return {};
  }

  // Process is alive. Read the port file and probe the server.
  const portResult = await bbExec(
    conn,
    home,
    `cat ${shellQuote(portFile)} 2>/dev/null`,
  );
  if (portResult.exitCode === 0 && portResult.stdout.trim()) {
    const port = portResult.stdout.trim();
    logger.info(`[lifecycle] found port file: ${port}, probing server...`);
    // Probe the port. Try curl first (common on Linux), then busybox wget,
    // then /dev/tcp as a last resort. Any success means the server is alive.
    const probeResult = await bbExec(
      conn,
      home,
      `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/version 2>/dev/null || ` +
        `wget -q -O /dev/null http://127.0.0.1:${port}/version 2>/dev/null || ` +
        `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null`,
    );
    if (probeResult.exitCode === 0) {
      // Server is alive and responding - reuse it.
      logger.info(
        `[lifecycle] server PID ${pid} is alive on port ${port}, reusing`,
      );
      return { reusePort: Number(port) };
    }
    logger.info(
      `[lifecycle] PID ${pid} alive but port ${port} not responding, killing`,
    );
  }

  // Process is alive but server is not responding - it's a real zombie.
  logger.info(`[lifecycle] killing zombie server PID ${pid}`);
  await bbExec(
    conn,
    home,
    `kill ${pid} 2>/dev/null; sleep 1; kill -9 ${pid} 2>/dev/null`,
  );

  await bbExec(
    conn,
    home,
    `rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}`,
  );

  const strayResult = await bbExec(
    conn,
    home,
    `pgrep -f ${shellQuote(installPath)} 2>/dev/null`,
  );
  if (strayResult.exitCode === 0 && strayResult.stdout.trim()) {
    const strayPids = strayResult.stdout.trim().split("\n");
    for (const strayPid of strayPids) {
      const p = strayPid.trim();
      if (p && p !== pid) {
        logger.info(`[lifecycle] killing stray PID ${p}`);
        await bbExec(conn, home, `kill -9 ${p} 2>/dev/null`);
      }
    }
  }

  logger.info("[lifecycle] zombie cleanup complete");
  return {};
}

/**
 * Write the server PID and port to files on the remote.
 * Called after the server starts and the port is parsed.
 */
export async function writeServerMetadata(
  conn: SshConnection,
  home: string,
  installPath: string,
  pid: number,
  port: number,
  logger: Logger,
): Promise<void> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;

  const result = await bbExec(
    conn,
    home,
    `echo ${pid} > ${shellQuote(pidFile)} && echo ${port} > ${shellQuote(portFile)}`,
  );
  if (result.exitCode !== 0) {
    logger.info(`[lifecycle] failed to write PID/port files: ${result.stderr}`);
  } else {
    logger.info(`[lifecycle] wrote PID=${pid} port=${port}`);
  }
}

/**
 * Remove the server metadata files. Called on clean shutdown.
 */
export async function removeServerMetadata(
  conn: SshConnection,
  home: string,
  installPath: string,
  logger: Logger,
): Promise<void> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;
  await bbExec(
    conn,
    home,
    `rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}`,
  );
  logger.info("[lifecycle] removed PID/port files");
}

/**
 * Acquire a mkdir-based resolve lock for the given install path.
 * Returns true if acquired (or reclaimed from a stale holder), false if
 * another live resolve holds it.
 *
 * mkdir is atomic on POSIX, so the directory creation is the lock.
 * Stale detection: PID-liveness check + age timeout (LOCK_STALE_AGE_SEC).
 */
export async function acquireResolveLock(
  conn: SshConnection,
  home: string,
  installPath: string,
  logger: Logger,
): Promise<boolean> {
  const lockDir = `${installPath}/.resolve-lock`;
  const staleMin = Math.floor(LOCK_STALE_AGE_SEC / 60);

  // mkdir is atomic on POSIX, so a successful create IS the lock.
  const tryCreate = async (): Promise<boolean> => {
    const r = await bbExec(
      conn,
      home,
      `mkdir ${shellQuote(lockDir)} 2>/dev/null && echo ok || echo fail`,
    );
    return r.stdout.trim() === "ok";
  };

  if (await tryCreate()) {
    logger.info(`[lifecycle] acquired resolve lock at ${lockDir}`);
    return true;
  }

  // Lock exists. The only reason to reclaim is an abandoned lock left by a
  // crashed resolve. Reclaim purely on age: there is no persistent remote
  // process to check PID-liveness against (the resolve driver runs locally in
  // the extension host, so `$$` inside a one-shot `sh -c` was the PID of a
  // shell that had already exited - a liveness check on it always reported
  // "dead", which made a live lock look reclaimable and defeated mutual
  // exclusion). Age-based reclaim + atomic mkdir is the correct guarantee.
  logger.info(`[lifecycle] resolve lock exists, checking age`);
  const age = await bbExec(
    conn,
    home,
    `find ${shellQuote(lockDir)} -type d -mmin +${staleMin} 2>/dev/null`,
  );
  if (age.stdout.trim()) {
    logger.info(
      `[lifecycle] resolve lock stale (age > ${staleMin}m), reclaiming`,
    );
    await bbExec(conn, home, `rm -rf ${shellQuote(lockDir)}`);
    if (await tryCreate()) {
      logger.info(`[lifecycle] reclaimed resolve lock`);
      return true;
    }
    return false;
  }

  logger.info(`[lifecycle] resolve lock held (not stale)`);
  return false;
}

/**
 * Release the resolve lock. Best-effort.
 */
export async function releaseResolveLock(
  conn: SshConnection,
  home: string,
  installPath: string,
  logger: Logger,
): Promise<void> {
  const lockDir = `${installPath}/.resolve-lock`;
  await bbExec(conn, home, `rm -rf ${shellQuote(lockDir)}`);
  logger.info("[lifecycle] released resolve lock");
}

/**
 * Find the PID of the remote server process running from the given install
 * path. The SSH child process spawned locally isn't the server PID - the
 * server is a node process on the remote. Probed via pgrep matching the
 * install path in the process args.
 *
 * Returns the PID, or undefined if not found.
 */
export async function probeServerPid(
  conn: SshConnection,
  home: string,
  installPath: string,
  logger: Logger,
): Promise<number | undefined> {
  // A bare install-path match also matches the busybox `sh` wrappers that
  // launched the server (`sh -c '... .../bin/<server> --start-server ...'`).
  // Those shells have lower PIDs, so taking the first pgrep line returned the
  // wrapper, not the node server. Match the server's node binary specifically
  // and take the oldest such process with `-o` (the main server, not its
  // forked workers). Fall back to the broad match for launchers that don't
  // exec `<installPath>/node` directly.
  let result = await bbExec(
    conn,
    home,
    `pgrep -f -o ${shellQuote(`${installPath}/node`)} 2>/dev/null`,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    result = await bbExec(
      conn,
      home,
      `pgrep -f -o ${shellQuote(installPath)} 2>/dev/null`,
    );
  }
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    logger.info("[lifecycle] no remote server PID found via pgrep");
    return undefined;
  }
  const first = result.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  const pid = first ? parseInt(first, 10) : NaN;
  if (Number.isNaN(pid)) {
    logger.info(
      `[lifecycle] could not parse PID from pgrep output: ${result.stdout}`,
    );
    return undefined;
  }
  logger.info(`[lifecycle] found remote server PID ${pid}`);
  return pid;
}
