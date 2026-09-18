/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  bootstrapBusybox,
  probeHome,
  probeArch,
  isBootstrapped,
  probeRemote,
} from "../../src/remote/busybox";
import { FakeSshConnection, ok, fail, noopLogger } from "../__mocks__/fakeSshConnection";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-bb-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("probeRemote", () => {
  it("returns home, arch, busybox, and install status in one call", async () => {
    const conn = new FakeSshConnection();
    conn.setProbeResponse("/home/user", "x86_64", "yes", "no");
    conn.setDefault(ok());

    const result = await probeRemote(conn as any, ".test-server", "abc123");

    expect(result.home).toBe("/home/user");
    expect(result.arch).toBe("x64");
    expect(result.busyboxPresent).toBe(true);
    expect(result.installPresent).toBe(false);
  });

  it("ignores shell-init noise before the marker", async () => {
    const conn = new FakeSshConnection();
    // Simulate the bug-report scenario: rc file emits a terminal-title
    // echo before the probe output (issue #6).
    conn.setProbeResponse("/home/user", "x86_64", "yes", "no", '-ne "\\033]0;$(hostname)\\007"\n');
    conn.setDefault(ok());

    const result = await probeRemote(conn as any, ".test-server", "abc123");

    expect(result.home).toBe("/home/user");
    expect(result.arch).toBe("x64");
    expect(result.busyboxPresent).toBe(true);
    expect(result.installPresent).toBe(false);
  });

  it("throws when HOME is empty", async () => {
    const conn = new FakeSshConnection();
    conn.setProbeResponse("", "x86_64", "no", "no");
    conn.setDefault(ok());

    await expect(
      probeRemote(conn as any, ".test-server", "abc123"),
    ).rejects.toThrow(/HOME is empty/);
  });

  it("throws on unsupported arch", async () => {
    const conn = new FakeSshConnection();
    conn.setProbeResponse("/home/user", "mips", "no", "no");
    conn.setDefault(ok());

    await expect(
      probeRemote(conn as any, ".test-server", "abc123"),
    ).rejects.toThrow("Unsupported");
  });

  it("throws when the marker is missing from output", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("printenv", ok("garbage"));
    conn.setDefault(ok());

    await expect(
      probeRemote(conn as any, ".test-server", "abc123"),
    ).rejects.toThrow("marker not found");
  });

  it("reports installPresent=true when node exists", async () => {
    const conn = new FakeSshConnection();
    conn.setProbeResponse("/home/user", "aarch64", "yes", "yes");
    conn.setDefault(ok());

    const result = await probeRemote(conn as any, ".test-server", "abc123");
    expect(result.installPresent).toBe(true);
    expect(result.arch).toBe("arm64");
  });
});

describe("probeHome", () => {
  it("returns HOME from printenv", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("printenv", ok("/home/user"));
    const home = await probeHome(conn as any);
    expect(home).toBe("/home/user");
  });

  it("throws when HOME is empty", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("printenv", ok(""));
    await expect(probeHome(conn as any)).rejects.toThrow(/HOME is empty/);
  });
});

describe("probeArch", () => {
  it("detects x86_64", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname", ok("x86_64"));
    const arch = await probeArch(conn as any);
    expect(arch).toBe("x64");
  });

  it("detects aarch64", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname", ok("aarch64"));
    const arch = await probeArch(conn as any);
    expect(arch).toBe("arm64");
  });

  it("throws on unsupported arch", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname", ok("mips"));
    await expect(probeArch(conn as any)).rejects.toThrow("Unsupported");
  });

  it("throws when uname fails", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("uname", fail("command not found"));
    await expect(probeArch(conn as any)).rejects.toThrow("detect architecture");
  });
});

describe("isBootstrapped", () => {
  it("returns true when sh is executable", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("test -x", ok());
    const result = await isBootstrapped(conn as any, "/home/user");
    expect(result).toBe(true);
  });

  it("returns false when sh is not executable", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("test -x", fail());
    const result = await isBootstrapped(conn as any, "/home/user");
    expect(result).toBe(false);
  });
});

describe("bootstrapBusybox", () => {
  it("reads local binary and streams it to remote in one call", async () => {
    // Create a fake busybox binary
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    const bbPath = path.join(busyboxDir, "bb-x64");
    fs.writeFileSync(bbPath, Buffer.from("fake-busybox-content"));

    const conn = new FakeSshConnection();
    await conn.connect();
    // Single call: mkdir && cat && chmod && verify && --install
    conn.setDefault(ok());

    await bootstrapBusybox(
      conn as any,
      "/home/user",
      "x64",
      tmpDir,
      noopLogger as any,
    );

    // One call containing all steps.
    expect(conn.calls).toHaveLength(1);
    const cmd = conn.calls[0];
    expect(cmd).toContain("mkdir -p");
    expect(cmd).toContain("cat >");
    expect(cmd).toContain("chmod +x");
    expect(cmd).toContain("--install");

    // Binary content should have been sent via stdin.
    const stdin = Array.from(conn.stdinData.values()).find((b) =>
      b.toString().includes("fake-busybox-content"),
    );
    expect(stdin).toBeDefined();
  });

  it("throws when the bootstrap command fails", async () => {
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    fs.writeFileSync(path.join(busyboxDir, "bb-x64"), Buffer.from("x"));

    const conn = new FakeSshConnection();
    conn.setDefault(fail("permission denied"));

    await expect(
      bootstrapBusybox(
        conn as any,
        "/home/user",
        "x64",
        tmpDir,
        noopLogger as any,
      ),
    ).rejects.toThrow("Bootstrap failed");
  });
});
