/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Local sleep detection via `setTimeout` gap analysis.
 *
 * When the OS suspends (hibernate, sleep), the Node event loop pauses and
 * pending timers don't fire. On wake, the gap between the expected fire time
 * and the actual fire time far exceeds the interval. Reliable signal, no
 * native modules, no false positives on lock screen / alt-tab (validated
 * empirically).
 *
 * Detects LOCAL sleep (the machine running the IDE). Remote SSH targets are
 * servers and are expected not to sleep; if they do, disable power
 * management on the remote host.
 */

export type SleepListener = (sleptMs: number) => void;

const DEFAULT_INTERVAL_MS = 5_000; // 5s
const DEFAULT_THRESHOLD_MULTIPLE = 3; // gap > 3x interval = sleep

/**
 * Detects local sleep by scheduling a recurring `setTimeout` and checking
 * the gap between actual fire times. On sleep, the gap jumps well beyond
 * the interval.
 */
export class SleepDetector {
  private timer: NodeJS.Timeout | undefined;
  private lastFire = 0;
  private readonly listeners = new Set<SleepListener>();

  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly thresholdMultiple: number = DEFAULT_THRESHOLD_MULTIPLE,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastFire = Date.now();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  onSleep(listener: SleepListener): void {
    this.listeners.add(listener);
  }

  /**
   * Returns the gap (ms) between now and the last timer fire. Used by
   * focus-regain handlers to confirm sleep: a focus event alone is noisy
   * (alt-tabs, screen locks), but a focus event with a large gap is a
   * reliable wake signal.
   */
  currentGap(): number {
    return this.lastFire > 0 ? Date.now() - this.lastFire : 0;
  }

  /**
   * Returns true if the current gap exceeds the sleep threshold.
   * Lets focus listeners decide whether to fire the wake probe.
   */
  isSleepingByGap(): boolean {
    if (this.lastFire === 0) return false;
    return this.currentGap() > this.intervalMs * this.thresholdMultiple;
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
    // Don't keep the process alive just for sleep detection.
    if (this.timer.unref) this.timer.unref();
  }

  private tick(): void {
    const now = Date.now();
    const gap = now - this.lastFire;
    this.lastFire = now;

    if (gap > this.intervalMs * this.thresholdMultiple) {
      const sleptMs = gap - this.intervalMs;
      for (const listener of this.listeners) {
        try {
          listener(sleptMs);
        } catch {
          // Listener errors must not kill the detector.
        }
      }
    }

    this.scheduleNext();
  }
}
