/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "../../src/common/logger";
import type { SshConnection, ExecResult } from "../../src/ssh/connection";
import {
  cleanupZombieServer,
  writeServerMetadata,
  removeServerMetadata,
  acquireResolveLock,
  releaseResolveLock,
  probeServerPid,
} from "../../src/server/lifecycle";

// --- Helpers ---

const noopLogger: any = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};

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

// --- cleanupZombieServer ---

describe("cleanupZombieServer", () => {
  it("returns empty when no PID file exists", async () => {
    const conn = makeFakeConn({
      "cat ": ok(""), // empty stdout, no PID
    });
    const result = await cleanupZombieServer(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
    );
    expect(result.reusePort).toBeUndefined();
  });

  it("returns empty and cleans files when PID is dead", async () => {
    const conn = makeFakeConn({
      "cat ": ok("12345"),
      "kill -0": fail(), // process not alive
    });
    const result = await cleanupZombieServer(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
    );
    expect(result.reusePort).toBeUndefined();
    expect(conn.calls.some((c) => c.includes("rm -f"))).toBe(true);
  });

  it("reuses server when PID alive and port responds", async () => {
    const conn = makeFakeConn({
      "cat ": ok("12345"), // first cat: PID file
      "kill -0": ok(), // alive
      // second cat: port file. FakeConn matches on prefix, so both cats
      // get the same response.
      curl: ok(), // port probe succeeds
    });
    const result = await cleanupZombieServer(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
    );
    expect(result.reusePort).toBe(12345);
  });

  it("kills zombie when PID alive but port not responding", async () => {
    const conn = makeFakeConn({
      "cat ": ok("12345"),
      "kill -0": ok(), // alive
      curl: fail(), // port probe fails
      wget: fail(),
      pgrep: ok(""), // no strays
    });
    const result = await cleanupZombieServer(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
    );
    expect(result.reusePort).toBeUndefined();
    expect(conn.calls.some((c) => c.includes("kill 12345"))).toBe(true);
  });

  it("kills stray processes found via pgrep", async () => {
    const conn = makeFakeConn({
      "cat ": ok("12345"),
      "kill -0": ok(),
      curl: fail(),
      wget: fail(),
      pgrep: ok("12345\n67890\n"),
    });
    await cleanupZombieServer(conn, "/home/user", "/install/path", noopLogger);
    expect(conn.calls.some((c) => c.includes("kill -9 67890"))).toBe(true);
  });
});

// --- writeServerMetadata ---

describe("writeServerMetadata", () => {
  it("writes PID and port to files", async () => {
    const conn = makeFakeConn({});
    await writeServerMetadata(
      conn,
      "/home/user",
      "/install/path",
      12345,
      8080,
      noopLogger,
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
    await removeServerMetadata(conn, "/home/user", "/install/path", noopLogger);
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
      noopLogger,
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
      noopLogger,
    );
    expect(result).toBe(false);
  });

  it("reclaims stale lock based on age", async () => {
    const conn = makeFakeConn({});
    let mkdirCallCount = 0;
    conn.exec = async (command: string) => {
      conn.calls.push(command);
      if (command.includes("mkdir")) {
        mkdirCallCount++;
        return ok(mkdirCallCount === 1 ? "fail" : "ok");
      }
      if (command.includes("find")) return ok("stale");
      return ok();
    };

    const result = await acquireResolveLock(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
    );
    expect(result).toBe(true);
  });
});

// --- releaseResolveLock ---

describe("releaseResolveLock", () => {
  it("removes the lock directory", async () => {
    const conn = makeFakeConn({});
    await releaseResolveLock(conn, "/home/user", "/install/path", noopLogger);
    expect(
      conn.calls.some(
        (c) => c.includes("rm -rf") && c.includes(".resolve-lock"),
      ),
    ).toBe(true);
  });
});

// --- probeServerPid ---

describe("probeServerPid", () => {
  it("returns the first PID from pgrep", async () => {
    const conn = makeFakeConn({
      pgrep: ok("12345\n67890\n"),
    });
    const pid = await probeServerPid(
      conn,
      "/home/user",
      "/install/path",
      noopLogger,
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
      noopLogger,
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
      noopLogger,
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
      noopLogger,
    );
    expect(pid).toBeUndefined();
  });
});
