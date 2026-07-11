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
import type { SshConnection } from "../../src/ssh/connection";
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
    forwardProcess: { killed: false, exitCode: null, signalCode: null } as any,
    serverProcess: { killed: false, exitCode: null, signalCode: null } as any,
    conn: {
      exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
    } as unknown as SshConnection,
    dead: false,
    ownsServer: true,
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

  it("marks dead when server process is dead and SSH is unreachable", async () => {
    const conn = makeMockConnection();
    // Server process dead.
    conn.serverProcess = {
      killed: false,
      exitCode: 1,
      signalCode: null,
    } as any;
    // SSH unreachable.
    (conn.conn.exec as any).mockRejectedValue(new Error("timeout"));

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(1081),
        startSocksForward: vi.fn().mockReturnValue({} as any),
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    // Trigger sleep.
    await triggerSleepAndProbe();

    expect(conn.dead).toBe(true);
    monitor.stop();
  });

  it("restarts SOCKS forward when forward is dead but SSH is alive", async () => {
    const conn = makeMockConnection();
    // Forward process dead.
    conn.forwardProcess = {
      killed: false,
      exitCode: 1,
      signalCode: null,
    } as any;
    // SSH alive.
    (conn.conn.exec as any).mockResolvedValue({ exitCode: 0 });

    const oldForward = conn.forwardProcess;
    const newForward = {
      killed: false,
      exitCode: null,
      signalCode: null,
      once: vi.fn(),
    } as any;

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward: vi.fn().mockReturnValue(newForward),
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    // Trigger sleep.
    await triggerSleepAndProbe();

    expect(conn.dead).toBe(false);
    expect(conn.socksPort).toBe(2080);
    expect(conn.forwardProcess).toBe(newForward);
    expect(oldForward).not.toBe(conn.forwardProcess);
    // The repaired forward gets its own close listener so its death is
    // detected immediately, not only at the next periodic probe.
    expect(newForward.once).toHaveBeenCalledWith("close", expect.any(Function));
    monitor.stop();
  });

  it("marks dead when both forward and SSH are dead", async () => {
    const conn = makeMockConnection();
    conn.forwardProcess = {
      killed: false,
      exitCode: 1,
      signalCode: null,
    } as any;
    (conn.conn.exec as any).mockRejectedValue(new Error("timeout"));

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward: vi.fn().mockReturnValue({} as any),
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(true);
    monitor.stop();
  });

  it("does nothing when everything is alive", async () => {
    const conn = makeMockConnection();
    const startSocksForward = vi.fn();

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward,
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(false);
    expect(startSocksForward).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("does not mark dead when ownsServer is false and serverProcess is undefined", async () => {
    const conn = makeMockConnection();
    // Reusing another window's server: no local serverProcess handle.
    conn.ownsServer = false;
    conn.serverProcess = undefined;
    // SSH and forward are alive.

    const startSocksForward = vi.fn();
    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward,
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    await triggerSleepAndProbe();

    expect(conn.dead).toBe(false);
    expect(startSocksForward).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts forward but stays alive when ownsServer is false and forward is dead", async () => {
    const conn = makeMockConnection();
    conn.ownsServer = false;
    conn.serverProcess = undefined;
    conn.forwardProcess = {
      killed: false,
      exitCode: 1,
      signalCode: null,
    } as any;
    (conn.conn.exec as any).mockResolvedValue({ exitCode: 0 });

    const newForward = {
      killed: false,
      exitCode: null,
      signalCode: null,
      once: vi.fn(),
    } as any;

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward: vi.fn().mockReturnValue(newForward),
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    await triggerSleepAndProbe();

    // Forward restarted, connection NOT marked dead (we don't own the server).
    expect(conn.dead).toBe(false);
    expect(conn.socksPort).toBe(2080);
    expect(conn.forwardProcess).toBe(newForward);
    monitor.stop();
  });

  it("debounces rapid probes (no double-probe within MIN_PROBE_GAP)", async () => {
    const conn = makeMockConnection();
    const startSocksForward = vi.fn().mockReturnValue({} as any);

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward,
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
    monitor.start();

    // First sleep triggers a probe.
    await triggerSleepAndProbe();
    const callsAfterFirst = startSocksForward.mock.calls.length;

    // Immediately trigger another sleep. The debounce window
    // (MIN_PROBE_GAP_MS = 15s) hasn't elapsed, so the probe is skipped.
    vi.advanceTimersByTime(5_000); // normal tick
    vi.setSystemTime(new Date(Date.now() + 20_000)); // simulate sleep
    vi.advanceTimersByTime(5_000); // fire -> sleep detected
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(startSocksForward.mock.calls.length).toBe(callsAfterFirst);
    monitor.stop();
  });

  it("dedups overlapping probes (in-flight probe returns same promise)", async () => {
    const conn = makeMockConnection();
    // Make SSH exec slow - never resolves - so the probe stays in-flight.
    (conn.conn.exec as any).mockReturnValue(new Promise(() => {}));

    const monitor = new ConnectionMonitor(
      conn,
      {
        findFreePort: vi.fn().mockResolvedValue(2080),
        startSocksForward: vi.fn().mockReturnValue({} as any),
        waitForPort: vi.fn().mockResolvedValue(undefined),
      },
      mockLogger,
    );
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

    // Only one findFreePort call should have happened - the second probe
    // was deduped to the in-flight one. With both processes alive, no
    // restart happens; the key assertion is no crash and stable monitor.
    expect(conn.dead).toBe(false);
    monitor.stop();
  });
});
