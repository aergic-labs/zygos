/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Connection health monitor.
 *
 * After a local sleep/wake cycle, the SSH transport and/or the remote server
 * process may have died (TCP keepalive timeouts, OS killing the suspended
 * process, etc.). The monitor:
 *
 *   1. Detects local sleep via `SleepDetector`.
 *   2. Probes the SOCKS forward process and the server process.
 *   3. Repairs what it can:
 *      - SOCKS forward dead, SSH alive -> restart `ssh -D` on a new port,
 *        update the connection's `socksPort`/`forwardProcess` in place.
 *        `makeConnection()` reads these on the next call - no re-resolve.
 *   4. Marks the connection dead if repair isn't possible (server died,
 *      SSH unreachable). `makeConnection()` checks the `dead` flag and
 *      fails fast, triggering core's reconnect -> `resolve()` with
 *      `resolveAttempt++`.
 *
 * Also runs a periodic probe every 60s to catch dead connections that
 * weren't preceded by a detectable sleep (e.g. network drop without local
 * sleep).
 */

import type { ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import type { SshConnection } from "../ssh/connection";
import { SleepDetector } from "./sleepDetector";

/**
 * Mutable connection state. `makeConnection()` reads `socksPort`,
 * `remotePort`, and `dead` from this object; the monitor updates them
 * without invalidating the closure.
 */
export interface MonitoredConnection {
  /** Local port the `ssh -D` SOCKS proxy is listening on. Mutable. */
  socksPort: number;
  /** Remote port the server is listening on (127.0.0.1). */
  remotePort: number;
  /** The `ssh -D` child process. Mutable (replaced on restart). */
  forwardProcess: ChildProcess | undefined;
  /** The server child process. */
  serverProcess: ChildProcess | undefined;
  /** SSH connection used for exec probes and forward restart. */
  conn: SshConnection;
  /** Set to true when the connection is unrecoverable. makeConnection() fast-fails. */
  dead: boolean;
  /** If false, we are reusing another window's server. Don't check serverProcess liveness. */
  ownsServer: boolean;
}

export interface ConnectionMonitorDeps {
  /** Find a free local TCP port. */
  findFreePort(): Promise<number>;
  /** Start a new SOCKS forward. Returns the child process. */
  startSocksForward(conn: SshConnection, socksPort: number): ChildProcess;
  /** Wait for a local port to accept connections. */
  waitForPort(port: number, timeoutMs: number): Promise<void>;
}

const PERIODIC_PROBE_MS = 60_000; // 60s
const MIN_PROBE_GAP_MS = 15_000; // debounce: never probe more than once per 15s

export class ConnectionMonitor {
  private readonly detector = new SleepDetector();
  private periodicTimer: NodeJS.Timeout | undefined;
  private lastProbeAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly conn: MonitoredConnection,
    private readonly deps: ConnectionMonitorDeps,
    private readonly logger: Logger,
    private readonly onStatus?: (msg: string) => void,
  ) {}

  start(): void {
    this.detector.onSleep((sleptMs) => this.onSleep(sleptMs));
    this.detector.start();
    this.schedulePeriodic();

    // Hybrid wake trigger: on focus regain, check the timer gap. A focus
    // event alone is noisy (alt-tabs, screen locks, multi-monitor focus
    // changes), but a focus event with a large gap is a reliable wake
    // signal. Catches wake ~5s faster than waiting for the next detector
    // tick (which polls every 5s).
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) return;
        if (this.conn.dead) return;
        if (!this.detector.isSleepingByGap()) return;
        const gap = this.detector.currentGap();
        this.logger.info(
          `[health] focus regain with gap=${Math.round(gap / 1000)}s, treating as wake`,
        );
        void this.triggerProbe("wake");
      }),
    );

    this.logger.info("[health] monitor started");
  }

  stop(): void {
    this.detector.stop();
    if (this.periodicTimer) {
      clearTimeout(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.logger.info("[health] monitor stopped");
  }

  private async onSleep(sleptMs: number): Promise<void> {
    const sleptSec = Math.round(sleptMs / 1000);
    this.logger.info(
      `[health] sleep detected (~${sleptSec}s), probing connection...`,
    );
    this.onStatus?.(`Restoring after sleep (~${sleptSec}s)...`);
    await this.triggerProbe("sleep");
  }

  private schedulePeriodic(): void {
    const tick = async (): Promise<void> => {
      if (this.conn.dead) return;
      await this.triggerProbe("periodic");
      if (this.conn.dead) return;
      this.periodicTimer = setTimeout(tick, PERIODIC_PROBE_MS);
      if (this.periodicTimer.unref) this.periodicTimer.unref();
    };
    this.periodicTimer = setTimeout(tick, PERIODIC_PROBE_MS);
    if (this.periodicTimer.unref) this.periodicTimer.unref();
  }

  /**
   * Trigger a probe with debounce and in-flight dedup.
   *
   * - Debounce: never probe more than once per MIN_PROBE_GAP_MS. Prevents a
   *   sleep event + periodic tick firing close together from double-probing
   *   (and double-restarting the forward).
   * - In-flight dedup: if a probe is already running, return that promise
   *   instead of starting a second one. Prevents two concurrent
   *   `restartForward()` calls racing on the same port allocation.
   */
  private async triggerProbe(_reason: string): Promise<void> {
    if (this.conn.dead) return;

    // In-flight dedup: return the existing probe if one is running.
    if (this.inFlight) {
      this.logger.info(
        `[health] probe already in-flight (${_reason} deferred)`,
      );
      return this.inFlight;
    }

    // Debounce: skip if we probed too recently.
    const now = Date.now();
    if (now - this.lastProbeAt < MIN_PROBE_GAP_MS) {
      this.logger.info(`[health] debounced ${_reason} probe`);
      return;
    }

    this.lastProbeAt = now;
    this.inFlight = this.probeAndRepair().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probeAndRepair(): Promise<void> {
    if (this.conn.dead) return;

    const forwardAlive = isAlive(this.conn.forwardProcess);
    const serverAlive = this.conn.ownsServer
      ? isAlive(this.conn.serverProcess)
      : true;

    this.logger.info(
      `[health] probe forwardAlive=${forwardAlive} serverAlive=${serverAlive} ownsServer=${this.conn.ownsServer}`,
    );

    if (forwardAlive && serverAlive) {
      // Both processes look alive. Verify SSH is actually responsive with a
      // quick exec. If the OS killed the TCP connection, the processes may
      // still report "alive" but are zombie shells.
      if (await this.sshAlive()) {
        this.onStatus?.("Connected");
        return;
      }
      // SSH is dead - can't repair.
      this.logger.info("[health] SSH probe failed after sleep, marking dead");
      this.conn.dead = true;
      this.onStatus?.("Reconnecting...");
      return;
    }

    // At least one process is dead. Check if SSH itself still works
    // before attempting repairs.
    if (!(await this.sshAlive())) {
      this.logger.info(
        "[health] SSH unreachable, cannot repair - marking dead",
      );
      this.conn.dead = true;
      this.onStatus?.("Reconnecting...");
      return;
    }

    this.logger.info(
      `[health] forwardAlive=${forwardAlive} serverAlive=${serverAlive}, SSH ok`,
    );

    if (!forwardAlive) {
      try {
        await this.restartForward();
      } catch (err) {
        this.logger.info(
          `[health] SOCKS forward restart failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.conn.dead = true;
        this.onStatus?.("Reconnecting...");
        return;
      }
    }

    if (!serverAlive) {
      // Server process died: can't restart it in-place (needs a fresh SSH
      // exec + port parse). Mark dead; core re-resolves.
      this.logger.info("[health] server process dead, marking for reconnect");
      this.conn.dead = true;
      this.onStatus?.("Reconnecting...");
      return;
    }

    this.onStatus?.("Connected");
  }

  private async restartForward(): Promise<void> {
    this.logger.info("[health] restarting SOCKS forward...");
    const newPort = await this.deps.findFreePort();
    const newForward = this.deps.startSocksForward(this.conn.conn, newPort);
    await this.deps.waitForPort(newPort, 10_000);

    // Kill the old process if it's somehow still around.
    try {
      this.conn.forwardProcess?.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.conn.socksPort = newPort;
    this.conn.forwardProcess = newForward;

    // Detect death of the *repaired* forward immediately. The resolver's exit
    // listener was bound to the original forward process, so without this a
    // restarted forward that dies would go unnoticed until the next 60s
    // periodic probe. On close, re-probe (which repairs again if SSH is alive,
    // or marks the connection dead).
    newForward.once("close", () => {
      if (this.conn.dead || this.conn.forwardProcess !== newForward) return;
      this.logger.info("[health] repaired SOCKS forward exited; re-probing");
      this.lastProbeAt = 0; // bypass debounce for an exit-triggered probe
      void this.triggerProbe("forward-exit");
    });

    this.logger.info(`[health] SOCKS forward restored on :${newPort}`);
  }

  private async sshAlive(): Promise<boolean> {
    try {
      const result = await this.conn.conn.exec("true", 10_000);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}

function isAlive(proc: ChildProcess | undefined): boolean {
  if (!proc) return false;
  return !proc.killed && proc.exitCode === null && proc.signalCode === null;
}
