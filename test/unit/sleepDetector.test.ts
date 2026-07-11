/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SleepDetector } from "../../src/health/sleepDetector";

describe("SleepDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("currentGap returns 0 before start", () => {
    const det = new SleepDetector(1000, 3);
    expect(det.currentGap()).toBe(0);
  });

  it("isSleepingByGap returns false before start", () => {
    const det = new SleepDetector(1000, 3);
    expect(det.isSleepingByGap()).toBe(false);
  });

  it("does not detect sleep within normal interval", () => {
    const det = new SleepDetector(5000, 3);
    det.start();

    const slept: number[] = [];
    det.onSleep((ms) => slept.push(ms));

    // Advance by one interval - no sleep.
    vi.advanceTimersByTime(5000);
    expect(slept).toHaveLength(0);
    det.stop();
  });

  it("detects sleep when gap exceeds threshold", () => {
    const det = new SleepDetector(5000, 3);
    det.start();

    const slept: number[] = [];
    det.onSleep((ms) => slept.push(ms));

    // First tick fires normally.
    vi.advanceTimersByTime(5000);
    // Simulate sleep: jump clock forward without firing timers.
    vi.setSystemTime(new Date(Date.now() + 20_000));
    // Fire the next pending tick - it sees a large gap.
    vi.advanceTimersByTime(5000);

    expect(slept).toHaveLength(1);
    det.stop();
  });

  it("currentGap reflects time since last fire", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    vi.advanceTimersByTime(5000); // first tick fires, lastFire updated
    expect(det.currentGap()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(det.currentGap()).toBe(3000);
    det.stop();
  });

  it("isSleepingByGap returns true when gap exceeds threshold", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    vi.advanceTimersByTime(5000); // first tick, lastFire updated
    // Jump clock forward past threshold (gap > 15s).
    vi.setSystemTime(new Date(Date.now() + 17_000));
    expect(det.isSleepingByGap()).toBe(true);
    det.stop();
  });

  it("isSleepingByGap returns false within threshold", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    vi.advanceTimersByTime(5000); // tick
    vi.advanceTimersByTime(10_000); // gap = 10s < 15s threshold
    expect(det.isSleepingByGap()).toBe(false);
    det.stop();
  });

  it("stop clears the timer and listeners", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    det.stop();

    const slept: number[] = [];
    det.onSleep((ms) => slept.push(ms));
    vi.advanceTimersByTime(20_000);
    expect(slept).toHaveLength(0);
  });

  it("start is idempotent", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    det.start(); // should not throw or double-schedule
    det.stop();
  });

  it("listener errors do not kill the detector", () => {
    const det = new SleepDetector(5000, 3);
    det.start();
    det.onSleep(() => {
      throw new Error("boom");
    });
    const slept: number[] = [];
    det.onSleep((ms) => slept.push(ms));

    // First tick fires normally.
    vi.advanceTimersByTime(5000);
    // Simulate sleep: jump clock forward.
    vi.setSystemTime(new Date(Date.now() + 20_000));
    vi.advanceTimersByTime(5000);

    // Second listener still received the event.
    expect(slept).toHaveLength(1);
    det.stop();
  });
});
