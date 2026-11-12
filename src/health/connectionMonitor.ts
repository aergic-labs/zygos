/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Connection health monitor.
 *
 * After a local sleep/wake cycle, the ssh session may have died (TCP
 * keepalive timeouts, OS killing the suspended process, etc.). The monitor:
 *
 *   1. Detects local sleep via `SleepDetector`.
 *   2. Probes the ssh session with a quick exec.
 *   3. Marks the connection dead if the probe fails. `makeConnection()`
 *      checks the `dead` flag and fails fast, triggering core's reconnect
 *      -> `resolve()` with `resolveAttempt++`.
 *
 * Also runs a periodic probe every 60s to catch dead connections that
 * weren't preceded by a detectable sleep (e.g. network drop without local
 * sleep).
 */

import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import type { ISshConnection } from "../ssh/connection";
import type { AgentForward } from "../remote/busybox";
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
  /** SSH connection used for exec probes. */
  conn: ISshConnection;
  /** Set to true when the connection is unrecoverable. makeConnection() fast-fails. */
  dead: boolean;
  /** Set when the forward owns this window's agent symlink. */
  agent?: AgentForward;
}

const PERIODIC_PROBE_MS = 60_000; // 60s
const MIN_PROBE_GAP_MS = 15_000; // debounce: never probe more than once per 15s

export class ConnectionMonitor {
  private readonly detector = new SleepDetector();
  private periodicTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private lastProbeAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last status reported via onStatus, to suppress duplicate logs. */
  private lastStatus = "";

  constructor(
    private readonly conn: MonitoredConnection,
    private readonly logger: Logger,
    private readonly onStatus?: (msg: string) => void,
  ) {}

  /** Report status only when it changes, so periodic probes don't spam the log. */
  private reportStatus(msg: string): void {
    if (msg === this.lastStatus) return;
    this.lastStatus = msg;
    this.onStatus?.(msg);
  }

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
    this.stopped = true;
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
    this.reportStatus(`Restoring after sleep (~${sleptSec}s)...`);
    await this.triggerProbe("sleep");
  }

  /** Diagnostic: was the last probe an onSleep, wake, or periodic tick? */
  private lastProbeReason = "";
  private probeSeq = 0;

  private schedulePeriodic(): void {
    const tick = async (): Promise<void> => {
      if (this.stopped || this.conn.dead) return;
      await this.triggerProbe("periodic");
      if (this.stopped || this.conn.dead) return;
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
   *   sleep event + periodic tick firing close together from double-probing.
   * - In-flight dedup: if a probe is already running, return that promise
   *   instead of starting a second one.
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
    this.lastProbeReason = _reason;
    this.inFlight = this.probeAndRepair().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probeAndRepair(): Promise<void> {
    if (this.conn.dead) return;

    // The forward lives inside the ssh child. No in-place repair possible.
    // Probe ssh; dead = full reconnect.
    const seq = ++this.probeSeq;
    const alive = await this.sshAlive();
    this.logger.info(
      `[health] session probe #${seq} (${this.lastProbeReason}) -> ${alive ? "alive" : "dead"}`,
    );
    if (alive) {
      this.reportStatus("Connected");
    } else {
      this.logger.info("[health] ssh session unreachable, marking dead");
      this.conn.dead = true;
      this.reportStatus("Reconnecting...");
    }
  }

  private async sshAlive(): Promise<boolean> {
    try {
      const t0 = Date.now();
      const result = await this.conn.conn.exec("true", 10_000);
      const ms = Date.now() - t0;
      this.logger.info(
        `[health] sshAlive probe exitCode=${result.exitCode} ms=${ms}`,
      );
      return result.exitCode === 0;
    } catch (err) {
      this.logger.info(
        `[health] sshAlive probe threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
