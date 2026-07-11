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
} from "../../src/server/busybox";
import { FakeSshConnection, ok, fail, noopLogger } from "../__mocks__/fakeSshConnection";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-bb-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("probeHome", () => {
  it("returns HOME from printenv", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("printenv", ok("/home/user"));
    const home = await probeHome(conn as any);
    expect(home).toBe("/home/user");
  });

  it("falls back to /tmp when HOME is empty", async () => {
    const conn = new FakeSshConnection();
    conn.setResponse("printenv", ok(""));
    const home = await probeHome(conn as any);
    expect(home).toBe("/tmp");
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
  it("reads local binary and streams it to remote", async () => {
    // Create a fake busybox binary
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    const bbPath = path.join(busyboxDir, "bb-x64");
    fs.writeFileSync(bbPath, Buffer.from("fake-busybox-content"));

    const conn = new FakeSshConnection();
    await conn.connect();
    // All commands succeed
    conn.setDefault(ok());

    await bootstrapBusybox(
      conn as any,
      "/home/user",
      "x64",
      tmpDir,
      noopLogger as any,
    );

    // Should have called mkdir, cat, chmod, verify, --install
    expect(conn.calls.some((c) => c.includes("mkdir -p"))).toBe(true);
    expect(conn.calls.some((c) => c.includes("cat >"))).toBe(true);
    expect(conn.calls.some((c) => c.includes("chmod +x"))).toBe(true);
    expect(conn.calls.some((c) => c.includes("--install"))).toBe(true);

    // cat > should have received the binary content via stdin
    const catStdin = Array.from(conn.stdinData.values()).find((b) =>
      b.toString().includes("fake-busybox-content"),
    );
    expect(catStdin).toBeDefined();
  });

  it("throws when mkdir fails", async () => {
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    fs.writeFileSync(path.join(busyboxDir, "bb-x64"), Buffer.from("x"));

    const conn = new FakeSshConnection();
    conn.setResponse("mkdir", fail("permission denied"));

    await expect(
      bootstrapBusybox(
        conn as any,
        "/home/user",
        "x64",
        tmpDir,
        noopLogger as any,
      ),
    ).rejects.toThrow("Failed to create");
  });

  it("throws when cat write fails", async () => {
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    fs.writeFileSync(path.join(busyboxDir, "bb-x64"), Buffer.from("x"));

    const conn = new FakeSshConnection();
    conn.setResponse("mkdir", ok());
    conn.setResponse("cat", fail("disk full"));

    await expect(
      bootstrapBusybox(
        conn as any,
        "/home/user",
        "x64",
        tmpDir,
        noopLogger as any,
      ),
    ).rejects.toThrow("Failed to write busybox");
  });

  it("throws when chmod fails", async () => {
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    fs.writeFileSync(path.join(busyboxDir, "bb-x64"), Buffer.from("x"));

    const conn = new FakeSshConnection();
    conn.setResponse("mkdir", ok());
    conn.setResponse("cat", ok());
    conn.setResponse("chmod", fail("not permitted"));

    await expect(
      bootstrapBusybox(
        conn as any,
        "/home/user",
        "x64",
        tmpDir,
        noopLogger as any,
      ),
    ).rejects.toThrow("Failed to chmod");
  });

  it("throws when verify (busybox true) fails", async () => {
    const busyboxDir = path.join(tmpDir, "tools", "busybox");
    fs.mkdirSync(busyboxDir, { recursive: true });
    fs.writeFileSync(path.join(busyboxDir, "bb-x64"), Buffer.from("x"));

    const conn = new FakeSshConnection();
    conn.setResponse("mkdir", ok());
    conn.setResponse("cat", ok());
    conn.setResponse("chmod", ok());
    conn.setResponse("true", fail("noexec"));

    await expect(
      bootstrapBusybox(
        conn as any,
        "/home/user",
        "x64",
        tmpDir,
        noopLogger as any,
      ),
    ).rejects.toThrow("won't execute");
  });
});
