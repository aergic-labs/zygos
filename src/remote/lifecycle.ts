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

/** Result of a zombie-server probe. `reusePort` is set when an existing
 * healthy server was found and should be reused; otherwise undefined and
 * `log` describes what happened. The caller branches on `reusePort` and
 * logs `log` verbatim. */
export interface ZombieResult {
  /** Remote port to reuse, or undefined to start a fresh server. */
  reusePort?: number;
  /** Human-readable context for the caller to log. */
  log: string;
}

/** Result of finalizing a fresh server start. `pid` is the remote server's
 * PID if found; `log` describes what happened. The caller logs `log`. */
export interface FinalizeResult {
  /** Remote server PID, or undefined if pgrep found nothing. */
  pid?: number;
  /** Human-readable context for the caller to log. */
  log: string;
}

/**
 * Check for a zombie server for this install path.
 *
 * A single remote script reads the PID and port files, checks liveness,
 * probes the port, and cleans up if needed. Returns a `ZombieResult`:
 * `reusePort` is set only when an existing healthy server was found,
 * otherwise `log` describes what happened (no PID file, dead PID, killed
 * zombie, etc.).
 *
 * Collapses what was 4-6 sequential SSH calls into one. The bookkeeping
 * round-trips (read PID, check alive, read port, probe, cleanup) are all
 * local to the remote shell; nothing they do requires a client round-trip
 * in between.
 */
export async function cleanupZombieServer(
  conn: SshConnection,
  home: string,
  installPath: string,
): Promise<ZombieResult> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;

  // Single sh script: read PID, validate, check alive, probe port,
  // clean up strays. All in one SSH call.
  const script = [
    `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null)`,
    `if [ -z "$pid" ]; then echo "EMPTY"; exit 0; fi`,
    `case "$pid" in *[!0-9]*) rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}; echo "INVALID"; exit 0;; esac`,
    `if ! kill -0 "$pid" 2>/dev/null; then rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}; echo "DEAD:$pid"; exit 0; fi`,
    `port=$(cat ${shellQuote(portFile)} 2>/dev/null)`,
    `if [ -n "$port" ]; then`,
    `  if curl -s -f -o /dev/null http://127.0.0.1:$port/version 2>/dev/null || wget -q -O /dev/null http://127.0.0.1:$port/version 2>/dev/null || (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then`,
    `    echo "REUSE:$port"; exit 0`,
    `  fi`,
    `fi`,
    `kill $pid 2>/dev/null; sleep 1; kill -9 $pid 2>/dev/null`,
    `rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}`,
    `strays="$(pgrep -f ${shellQuote(installPath)} 2>/dev/null)"`,
    `for p in $strays; do [ "$p" != "$pid" ] && kill -9 $p 2>/dev/null; done`,
    `echo "ZOMBIE:$pid:$strays"`,
  ].join("\n");

  const result = await bbExec(conn, home, script);
  const out = result.stdout.trim();

  if (out === "EMPTY") return { log: "no existing PID file, clean start" };
  if (out === "INVALID") return { log: "invalid PID file content, cleaned up" };
  if (out.startsWith("DEAD:")) {
    const pid = parseInt(out.slice(5), 10);
    return Number.isNaN(pid)
      ? { log: "invalid PID file content, cleaned up" }
      : { log: `PID ${pid} is dead, cleaned up files` };
  }
  if (out.startsWith("REUSE:")) {
    const port = parseInt(out.slice(6), 10);
    return Number.isNaN(port)
      ? { log: "could not parse REUSE port, starting fresh" }
      : { reusePort: port, log: `server alive on port ${port}, reusing` };
  }
  if (out.startsWith("ZOMBIE:")) {
    const rest = out.slice(7);
    const [pidStr, straysRaw] = rest.split(":", 2);
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) return { log: "could not parse ZOMBIE pid, cleaned up" };
    const strays = (straysRaw ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && s !== String(pid) && /^\d+$/.test(s));
    const strayMsg = strays.length > 0 ? `, killed strays ${strays.join(", ")}` : "";
    return { log: `killed zombie PID ${pid}${strayMsg}, cleanup complete` };
  }
  return { log: `unexpected cleanup output: ${out}` };
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
  conn: SshConnection,
  home: string,
  installPath: string,
  port: number,
  opts: { releaseLock: boolean },
): Promise<FinalizeResult> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;
  const lockDir = `${installPath}/.resolve-lock`;

  const lines: string[] = [
    `pid=$(pgrep -f -o ${shellQuote(`${installPath}/node`)} 2>/dev/null)`,
    `if [ -z "$pid" ]; then pid=$(pgrep -f -o ${shellQuote(installPath)} 2>/dev/null); fi`,
    `if [ -n "$pid" ]; then echo $pid > ${shellQuote(pidFile)} && echo ${port} > ${shellQuote(portFile)}; fi`,
  ];
  if (opts.releaseLock) {
    lines.push(`rm -rf ${shellQuote(lockDir)}`);
  }
  lines.push(`echo "PID=$pid"`);

  const result = await bbExec(conn, home, lines.join("\n"));
  const m = result.stdout.match(/PID=(\d+)/);
  if (m) {
    const pid = parseInt(m[1], 10);
    return {
      pid,
      log: opts.releaseLock
        ? `wrote PID=${pid} port=${port}, released resolve lock`
        : `wrote PID=${pid} port=${port}`,
    };
  }
  return {
    log: opts.releaseLock
      ? "no remote server PID found via pgrep, released resolve lock"
      : "no remote server PID found via pgrep",
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
  conn: SshConnection,
  home: string,
  installPath: string,
): Promise<LockProbeResult> {
  const pidFile = `${installPath}/.server.pid`;
  const portFile = `${installPath}/.server.port`;
  const lockDir = `${installPath}/.resolve-lock`;
  const staleMin = Math.floor(LOCK_STALE_AGE_SEC / 60);

  // One script: acquire lock, then probe zombie. Outputs one line:
  //   LOCKFAIL                - could not acquire lock
  //   LOCKED:EMPTY            - locked, no PID file
  //   LOCKED:INVALID         - locked, invalid PID, cleaned up
  //   LOCKED:DEAD:<pid>       - locked, PID dead, cleaned up
  //   LOCKED:REUSE:<port>     - locked, server alive, reuse
  //   LOCKED:ZOMBIE:<pid>     - locked, killed zombie + strays
  const script = [
    `# Acquire lock`,
    `if mkdir ${shellQuote(lockDir)} 2>/dev/null; then :; else`,
    `  if find ${shellQuote(lockDir)} -type d -mmin +${staleMin} 2>/dev/null | grep -q .; then`,
    `    rm -rf ${shellQuote(lockDir)} && mkdir ${shellQuote(lockDir)} || { echo LOCKFAIL; exit 0; }`,
    `  else`,
    `    echo LOCKFAIL; exit 0`,
    `  fi`,
    `fi`,
    `# Lock acquired. Probe zombie.`,
    `pid=$(cat ${shellQuote(pidFile)} 2>/dev/null)`,
    `if [ -z "$pid" ]; then echo "LOCKED:EMPTY"; exit 0; fi`,
    `case "$pid" in *[!0-9]*) rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}; echo "LOCKED:INVALID"; exit 0;; esac`,
    `if ! kill -0 "$pid" 2>/dev/null; then rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}; echo "LOCKED:DEAD:$pid"; exit 0; fi`,
    `port=$(cat ${shellQuote(portFile)} 2>/dev/null)`,
    `if [ -n "$port" ]; then`,
    `  if curl -s -f -o /dev/null http://127.0.0.1:$port/version 2>/dev/null || wget -q -O /dev/null http://127.0.0.1:$port/version 2>/dev/null || (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null; then`,
    `    echo "LOCKED:REUSE:$port"; exit 0`,
    `  fi`,
    `fi`,
    `kill $pid 2>/dev/null; sleep 1; kill -9 $pid 2>/dev/null`,
    `rm -f ${shellQuote(pidFile)} ${shellQuote(portFile)}`,
    `strays="$(pgrep -f ${shellQuote(installPath)} 2>/dev/null)"`,
    `for p in $strays; do [ "$p" != "$pid" ] && kill -9 $p 2>/dev/null; done`,
    `echo "LOCKED:ZOMBIE:$pid:$strays"`,
  ].join("\n");

  const result = await bbExec(conn, home, script);
  const out = result.stdout.trim();

  if (out === "LOCKFAIL") {
    return { locked: false, log: "could not acquire resolve lock - another resolve may be running" };
  }
  if (!out.startsWith("LOCKED:")) {
    return { locked: true, log: `unexpected lock+probe output: ${out}` };
  }
  const rest = out.slice(7);
  if (rest === "EMPTY") return { locked: true, log: "acquired resolve lock, no existing PID file" };
  if (rest === "INVALID") return { locked: true, log: "acquired resolve lock, invalid PID file cleaned up" };
  if (rest.startsWith("DEAD:")) {
    const pid = parseInt(rest.slice(5), 10);
    return Number.isNaN(pid)
      ? { locked: true, log: "acquired resolve lock, invalid PID file cleaned up" }
      : { locked: true, log: `acquired resolve lock, PID ${pid} is dead, cleaned up files` };
  }
  if (rest.startsWith("REUSE:")) {
    const port = parseInt(rest.slice(6), 10);
    return Number.isNaN(port)
      ? { locked: true, log: "acquired resolve lock, could not parse REUSE port" }
      : { locked: true, reusePort: port, log: `acquired resolve lock, server alive on port ${port}, reusing` };
  }
  if (rest.startsWith("ZOMBIE:")) {
    const [pidStr, straysRaw] = rest.slice(7).split(":", 2);
    const pid = parseInt(pidStr, 10);
    if (Number.isNaN(pid)) return { locked: true, log: "acquired resolve lock, could not parse ZOMBIE pid" };
    const strays = (straysRaw ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && s !== String(pid) && /^\d+$/.test(s));
    const strayMsg = strays.length > 0 ? `, killed strays ${strays.join(", ")}` : "";
    return { locked: true, log: `acquired resolve lock, killed zombie PID ${pid}${strayMsg}, cleanup complete` };
  }
  return { locked: true, log: `acquired resolve lock, unexpected probe output: ${rest}` };
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
  // Atomic stale reclaim: check age, remove, and mkdir in a single remote
  // command to avoid the race where two clients both see stale, one removes
  // the other's fresh lock, and both acquire.
  const reclaim = await bbExec(
    conn,
    home,
    `if find ${shellQuote(lockDir)} -type d -mmin +${staleMin} 2>/dev/null | grep -q .; then rm -rf ${shellQuote(lockDir)} && mkdir ${shellQuote(lockDir)} && echo OK; fi`,
  );
  if (reclaim.stdout.trim() === "OK") {
    logger.info(`[lifecycle] reclaimed resolve lock`);
    return true;
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
