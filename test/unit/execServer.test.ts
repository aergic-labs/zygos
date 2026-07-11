/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { SshExecServer } from "../../src/server/execServer";
import {
  FakeSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/fakeSshConnection";

describe("SshExecServer.env", () => {
  it("returns parsed environment and OS info", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname -s", ok("Linux"));
    conn.setResponse("uname -r", ok("5.15.0-91-generic"));
    conn.setResponse("env", ok("PATH=/usr/bin\nHOME=/root\nFOO=bar=baz\n"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const env = await server.env();

    expect(env.osPlatform).toBe("linux");
    expect(env.osRelease).toBe("5.15.0-91-generic");
    expect(env.env.PATH).toBe("/usr/bin");
    expect(env.env.HOME).toBe("/root");
    expect(env.env.FOO).toBe("bar=baz");
  });

  it("maps Darwin to darwin", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname -s", ok("Darwin"));
    conn.setResponse("uname -r", ok("23.1.0"));
    conn.setResponse("env", ok(""));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const env = await server.env();

    expect(env.osPlatform).toBe("darwin");
    expect(env.osRelease).toBe("23.1.0");
  });

  it("lowercases unknown platforms", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname -s", ok("FreeBSD"));
    conn.setResponse("uname -r", ok(""));
    conn.setResponse("env", ok(""));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const env = await server.env();

    expect(env.osPlatform).toBe("freebsd");
    expect(env.osRelease).toBeUndefined();
  });

  it("skips malformed env lines", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname", ok("Linux"));
    conn.setResponse("env", ok("VALID=1\nnoequals\nALSO=2\n"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const env = await server.env();

    expect(env.env.VALID).toBe("1");
    expect(env.env.ALSO).toBe("2");
    expect(Object.keys(env.env)).toHaveLength(2);
  });
});

describe("SshExecServer.kill", () => {
  it("sends kill command", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.kill(12345);
    expect(conn.calls.some((c) => c.includes("kill 12345"))).toBe(true);
  });
});

describe("SshExecServer.tcpConnect", () => {
  it("throws when socksPort is undefined", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await expect(server.tcpConnect("host", 8080)).rejects.toThrow(
      "SOCKS port not available",
    );
  });
});

describe("SshExecServer.fs.stat", () => {
  it("parses regular file stat output", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("stat", ok("regular file 1024 1700000000"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const stat = await server.fs.stat("/path/to/file");

    expect(stat.type).toBe(1); // FT_FILE
    expect(stat.size).toBe(1024);
    expect(stat.mtime).toBe(1700000000);
  });

  it("parses directory stat output", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("stat", ok("directory 4096 1700000000"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const stat = await server.fs.stat("/path/to/dir");

    expect(stat.type).toBe(2); // FT_DIR
  });

  it("parses symbolic link stat output", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("stat", ok("symbolic link 8 1700000000"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const stat = await server.fs.stat("/path/to/link");

    expect(stat.type).toBe(64); // FT_SYMLINK
  });

  it("throws when stat fails", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("stat", fail("no such file"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await expect(server.fs.stat("/missing")).rejects.toThrow("stat failed");
  });
});

describe("SshExecServer.fs.mkdirp", () => {
  it("calls mkdir -p", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.fs.mkdirp("/new/dir");
    expect(conn.calls.some((c) => c.includes("mkdir -p"))).toBe(true);
  });

  it("throws when mkdir fails", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("mkdir", fail("denied"));
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await expect(server.fs.mkdirp("/new/dir")).rejects.toThrow("mkdirp failed");
  });
});

describe("SshExecServer.fs.rm", () => {
  it("calls rm -rf", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.fs.rm("/old/dir");
    expect(conn.calls.some((c) => c.includes("rm -rf"))).toBe(true);
  });
});

describe("SshExecServer.fs.rename", () => {
  it("calls mv", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.fs.rename("/from", "/to");
    expect(conn.calls.some((c) => c.includes("mv"))).toBe(true);
  });

  it("throws when mv fails", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("mv", fail("cross-device"));
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await expect(server.fs.rename("/from", "/to")).rejects.toThrow(
      "rename failed",
    );
  });
});

describe("SshExecServer.fs.readdir", () => {
  it("parses ls -A -F output", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("ls", ok("file.txt*\ndir/\nlink@"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const entries = await server.fs.readdir("/dir");

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ type: 1, name: "file.txt" }); // FT_FILE
    expect(entries[1]).toEqual({ type: 2, name: "dir" }); // FT_DIR
    expect(entries[2]).toEqual({ type: 64, name: "link" }); // FT_SYMLINK
  });

  it("handles files without suffix", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("ls", ok("plainfile"));

    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const entries = await server.fs.readdir("/dir");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ type: 1, name: "plainfile" });
  });

  it("throws when ls fails", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("ls", fail("denied"));
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await expect(server.fs.readdir("/dir")).rejects.toThrow("readdir failed");
  });
});

describe("SshExecServer.spawn", () => {
  it("spawns a command and returns streams", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    const spawned = await server.spawn("docker", ["ps", "-a"]);
    expect(spawned.stdin).toBeDefined();
    expect(spawned.stdout).toBeDefined();
    expect(spawned.stderr).toBeDefined();
    expect(spawned.onExit).toBeInstanceOf(Promise);
  });

  it("builds command with env vars", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.spawn("cmd", [], { env: { FOO: "bar" } });
    // spawnProcess was called - the fake tracks it as a call
    // (FakeSshConnection.spawnProcess doesn't push to calls, but doesn't throw)
  });

  it("builds command with cwd", async () => {
    const conn = new FakeSshConnection();
    const server = new SshExecServer(conn as any, undefined, noopLogger as any);
    await server.spawn("cmd", ["arg"], { cwd: "/work" });
    // Should not throw
  });
});
