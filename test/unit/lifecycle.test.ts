/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import type { SshConnection, ExecResult } from "../../src/ssh/connection";
import {
  cleanupZombieServer,
  acquireLockAndProbeZombie,
  finalizeServerStart,
  writeServerMetadata,
  removeServerMetadata,
  acquireResolveLock,
  releaseResolveLock,
  probeServerPid,
} from "../../src/remote/lifecycle";

// --- Helpers ---

/** Map of command -> ExecResult. Fake bbExec matches by substring. */
function makeFakeConn(
  responses: Record<string, ExecResult>,
): SshConnection & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(command: string): Promise<ExecResult> {
      calls.push(command);
      for (const [key, result] of Object.entries(responses)) {
        if (command.includes(key)) return result;
      }
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    },
    async execWithStdin(command: string, _stdin: Buffer): Promise<ExecResult> {
      calls.push(command);
      for (const [key, result] of Object.entries(responses)) {
        if (command.includes(key)) return result;
      }
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    },
  } as unknown as SshConnection & { calls: string[] };
}

const ok = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
});

const fail = (stderr = "error"): ExecResult => ({
  stdout: "",
  stderr,
  exitCode: 1,
  signal: null,
});

/** Fake conn whose single bbExec call returns the given stdout. */
function makeSingleCallConn(stdout: string): SshConnection & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(): Promise<ExecResult> {
      return { stdout, stderr: "", exitCode: 0, signal: null };
    },
    async execWithStdin(): Promise<ExecResult> {
      return { stdout, stderr: "", exitCode: 0, signal: null };
    },
  } as unknown as SshConnection & { calls: string[] };
}

// --- cleanupZombieServer ---

describe("cleanupZombieServer", () => {
  it("reports empty when no PID file exists", async () => {
    const conn = makeSingleCallConn("EMPTY");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/no existing PID file/);
  });

  it("reports invalid when PID file is not a number", async () => {
    const conn = makeSingleCallConn("INVALID");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/invalid PID file/);
  });

  it("reports dead and cleans files when PID is not running", async () => {
    const conn = makeSingleCallConn("DEAD:12345");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/PID 12345 is dead/);
  });

  it("reuses server when PID alive and port responds", async () => {
    const conn = makeSingleCallConn("REUSE:12345");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBe(12345);
    expect(r.log).toMatch(/reusing/);
  });

  it("reports zombie when PID alive but port not responding", async () => {
    const conn = makeSingleCallConn("ZOMBIE:12345:");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/killed zombie PID 12345/);
    expect(r.log).not.toMatch(/stray/);
  });

  it("includes stray PIDs in the log when pgrep found them", async () => {
    const conn = makeSingleCallConn("ZOMBIE:12345:67890\n11111");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/killed zombie PID 12345/);
    expect(r.log).toMatch(/67890/);
    expect(r.log).toMatch(/11111/);
  });

  it("handles unexpected output defensively", async () => {
    const conn = makeSingleCallConn("WHAT\nIS\nTHIS");
    const r = await cleanupZombieServer(conn, "/home/u", "/install");
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/unexpected/);
  });
});

// --- acquireLockAndProbeZombie ---

describe("acquireLockAndProbeZombie", () => {
  it("reports lock fail when mkdir fails and lock is not stale", async () => {
    const conn = makeSingleCallConn("LOCKFAIL");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(false);
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/could not acquire/);
  });

  it("locks and reports empty when no PID file exists", async () => {
    const conn = makeSingleCallConn("LOCKED:EMPTY");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(true);
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/no existing PID file/);
  });

  it("locks and reports dead PID", async () => {
    const conn = makeSingleCallConn("LOCKED:DEAD:12345");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(true);
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/PID 12345 is dead/);
  });

  it("locks and reuses server when alive", async () => {
    const conn = makeSingleCallConn("LOCKED:REUSE:12345");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(true);
    expect(r.reusePort).toBe(12345);
    expect(r.log).toMatch(/reusing/);
  });

  it("locks and reports zombie kill", async () => {
    const conn = makeSingleCallConn("LOCKED:ZOMBIE:12345:");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(true);
    expect(r.reusePort).toBeUndefined();
    expect(r.log).toMatch(/killed zombie PID 12345/);
  });

  it("includes stray PIDs in the log", async () => {
    const conn = makeSingleCallConn("LOCKED:ZOMBIE:12345:67890\n11111");
    const r = await acquireLockAndProbeZombie(conn, "/home/u", "/install");
    expect(r.locked).toBe(true);
    expect(r.log).toMatch(/67890/);
    expect(r.log).toMatch(/11111/);
  });
});

// --- finalizeServerStart ---

describe("finalizeServerStart", () => {
  it("writes PID/port files and returns pid when pgrep finds the server", async () => {
    const conn = makeSingleCallConn("PID=12345");
    const r = await finalizeServerStart(
      conn,
      "/home/u",
      "/install",
      8080,
      { releaseLock: false },
    );
    expect(r.pid).toBe(12345);
    expect(r.log).toMatch(/wrote PID=12345 port=8080/);
    expect(r.log).not.toMatch(/released/);
  });

  it("releases the lock and mentions it in the log when requested", async () => {
    const conn = makeSingleCallConn("PID=12345");
    const r = await finalizeServerStart(
      conn,
      "/home/u",
      "/install",
      8080,
      { releaseLock: true },
    );
    expect(r.pid).toBe(12345);
    expect(r.log).toMatch(/released resolve lock/);
  });

  it("returns no pid when pgrep finds nothing", async () => {
    const conn = makeSingleCallConn("PID=");
    const r = await finalizeServerStart(
      conn,
      "/home/u",
      "/install",
      8080,
      { releaseLock: false },
    );
    expect(r.pid).toBeUndefined();
    expect(r.log).toMatch(/no remote server PID/);
  });

  it("releases lock and reports no pid when pgrep finds nothing", async () => {
    const conn = makeSingleCallConn("PID=");
    const r = await finalizeServerStart(
      conn,
      "/home/u",
      "/install",
      8080,
      { releaseLock: true },
    );
    expect(r.pid).toBeUndefined();
    expect(r.log).toMatch(/released resolve lock/);
  });
});

// --- writeServerMetadata (unchanged; still used on dispose) ---

describe("writeServerMetadata", () => {
  it("writes PID and port to files", async () => {
    const conn = makeFakeConn({});
    await writeServerMetadata(
      conn,
      "/home/user",
      "/install/path",
      12345,
      8080,
      { info: () => {} } as any,
    );
    expect(
      conn.calls.some(
        (c) => c.includes("echo 12345") && c.includes(".server.pid"),
      ),
    ).toBe(true);
    expect(
      conn.calls.some(
        (c) => c.includes("echo 8080") && c.includes(".server.port"),
      ),
    ).toBe(true);
  });
});

// --- removeServerMetadata ---

describe("removeServerMetadata", () => {
  it("removes PID and port files", async () => {
    const conn = makeFakeConn({});
    await removeServerMetadata(conn, "/home/user", "/install/path", { info: () => {} } as any);
    expect(
      conn.calls.some((c) => c.includes("rm -f") && c.includes(".server.pid")),
    ).toBe(true);
  });
});

// --- acquireResolveLock ---

describe("acquireResolveLock", () => {
  it("acquires lock when mkdir succeeds", async () => {
    const conn = makeFakeConn({
      mkdir: ok("ok"),
    });
    const result = await acquireResolveLock(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(result).toBe(true);
  });

  it("returns false when the lock exists and is not stale", async () => {
    const conn = makeFakeConn({
      mkdir: ok("fail"),
      find: ok(""), // not stale (mkdir atomicity holds the lock)
    });
    const result = await acquireResolveLock(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(result).toBe(false);
  });

  it("reclaims stale lock based on age", async () => {
    const conn = makeFakeConn({});
    conn.exec = async (command: string) => {
      conn.calls.push(command);
      // Atomic reclaim: find + rm + mkdir in one command, outputs OK.
      if (command.includes("find") && command.includes("mkdir")) {
        return ok("OK");
      }
      // Initial mkdir attempt (fresh lock).
      if (command.includes("mkdir")) {
        return ok("fail");
      }
      return ok();
    };

    const result = await acquireResolveLock(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(result).toBe(true);
  });
});

// --- releaseResolveLock ---

describe("releaseResolveLock", () => {
  it("removes the lock directory", async () => {
    const conn = makeFakeConn({});
    await releaseResolveLock(conn, "/home/user", "/install/path", { info: () => {} } as any);
    expect(
      conn.calls.some(
        (c) => c.includes("rm -rf") && c.includes(".resolve-lock"),
      ),
    ).toBe(true);
  });
});

// --- probeServerPid (kept for the dispose path; not used by the start
// flow anymore, which uses finalizeServerStart) ---

describe("probeServerPid", () => {
  it("returns the first PID from pgrep", async () => {
    const conn = makeFakeConn({
      pgrep: ok("12345\n67890\n"),
    });
    const pid = await probeServerPid(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(pid).toBe(12345);
  });

  it("returns undefined when pgrep finds nothing", async () => {
    const conn = makeFakeConn({
      pgrep: ok(""),
    });
    const pid = await probeServerPid(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(pid).toBeUndefined();
  });

  it("returns undefined when pgrep fails", async () => {
    const conn = makeFakeConn({
      pgrep: fail(),
    });
    const pid = await probeServerPid(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(pid).toBeUndefined();
  });

  it("returns undefined for non-numeric pgrep output", async () => {
    const conn = makeFakeConn({
      pgrep: ok("notanumber\n"),
    });
    const pid = await probeServerPid(
      conn,
      "/home/user",
      "/install/path",
      { info: () => {} } as any,
    );
    expect(pid).toBeUndefined();
  });
});
