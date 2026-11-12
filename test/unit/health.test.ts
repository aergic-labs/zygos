/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tests for SleepDetector and ConnectionMonitor.
 *
 * Run: npm test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SleepDetector } from "../../src/health/sleepDetector";
import { ConnectionMonitor } from "../../src/health/connectionMonitor";
import type { MonitoredConnection } from "../../src/health/connectionMonitor";
import type { ISshConnection } from "../../src/ssh/connection";
import type { Logger } from "../../src/common/logger";

const mockLogger: any = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
  dispose: () => {},
};

function makeMockConnection(): MonitoredConnection {
  return {
    socksPort: 1080,
    remotePort: 3000,
    conn: {
      exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
    } as unknown as ISshConnection,
    dead: false,
  };
}

describe("SleepDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire on normal interval gaps", () => {
    const detector = new SleepDetector(5_000, 3);
    const listener = vi.fn();
    detector.onSleep(listener);
    detector.start();

    // Advance 5s at a time - normal.
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);

    expect(listener).not.toHaveBeenCalled();
    detector.stop();
  });

  it("fires on gap > threshold * interval", () => {
    const detector = new SleepDetector(5_000, 3);
    const listener = vi.fn();
    detector.onSleep(listener);
    detector.start();

    // First tick at 5s - normal.
    vi.advanceTimersByTime(5_000);
    expect(listener).not.toHaveBeenCalled();

    // Simulate sleep: jump the clock forward, then fire the pending tick.
    // Gap between lastFire (5s) and now (25s) exceeds threshold.
    vi.setSystemTime(new Date(Date.now() + 20_000));
    vi.advanceTimersByTime(5_000);

    expect(listener).toHaveBeenCalledTimes(1);
    // sleptMs = gap - interval = 25s - 5s = 20s.
    expect(listener).toHaveBeenCalledWith(20_000);
    detector.stop();
  });

  it("handles multiple sleep/wake cycles", () => {
    const detector = new SleepDetector(5_000, 3);
    const listener = vi.fn();
    detector.onSleep(listener);
    detector.start();

    vi.advanceTimersByTime(5_000); // normal tick
    vi.setSystemTime(new Date(Date.now() + 20_000)); // jump clock
    vi.advanceTimersByTime(5_000); // fire -> sleep 1 detected
    vi.advanceTimersByTime(5_000); // normal tick
    vi.setSystemTime(new Date(Date.now() + 30_000)); // jump clock
    vi.advanceTimersByTime(5_000); // fire -> sleep 2 detected

    expect(listener).toHaveBeenCalledTimes(2);
    detector.stop();
  });

  it("does not fire after stop()", () => {
    const detector = new SleepDetector(5_000, 3);
    const listener = vi.fn();
    detector.onSleep(listener);
    detector.start();
    detector.stop();

    vi.advanceTimersByTime(60_000);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("ConnectionMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Trigger sleep by jumping the clock, then flush the async probe. */
  async function triggerSleepAndProbe(): Promise<void> {
    vi.advanceTimersByTime(5_000); // normal tick
    vi.setSystemTime(new Date(Date.now() + 20_000)); // simulate sleep
    vi.advanceTimersByTime(5_000); // fire -> sleep detected
    // The onSleep handler is async (fire-and-forget). Flush its
    // microtask chain so the probe completes before assertions.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  it("marks dead when the ssh probe fails", async () => {
    const conn = makeMockConnection();
    (conn.conn.exec as any).mockRejectedValue(new Error("timeout"));

    const monitor = new ConnectionMonitor(conn, mockLogger);
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(true);
    monitor.stop();
  });

  it("marks dead when the ssh probe returns a non-zero exit", async () => {
    const conn = makeMockConnection();
    (conn.conn.exec as any).mockResolvedValue({ exitCode: 1 });

    const monitor = new ConnectionMonitor(conn, mockLogger);
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(true);
    monitor.stop();
  });

  it("stays alive when the ssh probe succeeds", async () => {
    const conn = makeMockConnection();
    (conn.conn.exec as any).mockResolvedValue({ exitCode: 0 });

    const monitor = new ConnectionMonitor(conn, mockLogger);
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(false);
    monitor.stop();
  });

  it("debounces rapid probes (no double-probe within MIN_PROBE_GAP)", async () => {
    const conn = makeMockConnection();
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    (conn.conn as any).exec = exec;

    const monitor = new ConnectionMonitor(conn, mockLogger);
    monitor.start();

    // Two probes with no clock advance between them: the second is within
    // MIN_PROBE_GAP_MS and is skipped.
    await (monitor as any).triggerProbe("a");
    await (monitor as any).triggerProbe("b");

    expect(exec.mock.calls.length).toBe(1);
    monitor.stop();
  });

  it("dedups overlapping probes (in-flight probe returns same promise)", async () => {
    const conn = makeMockConnection();
    // Make SSH exec slow - never resolves - so the probe stays in-flight.
    (conn.conn.exec as any).mockReturnValue(new Promise(() => {}));

    const monitor = new ConnectionMonitor(conn, mockLogger);
    monitor.start();

    // Trigger first sleep - probe starts, stays in-flight (SSH never resolves).
    vi.advanceTimersByTime(5_000);
    vi.setSystemTime(new Date(Date.now() + 20_000));
    vi.advanceTimersByTime(5_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Trigger another sleep while the probe is in-flight.
    vi.advanceTimersByTime(5_000);
    vi.setSystemTime(new Date(Date.now() + 20_000));
    vi.advanceTimersByTime(5_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The second probe was deduped to the in-flight one; no crash, stable.
    expect(conn.dead).toBe(false);
    monitor.stop();
  });
});
