/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import { ensureServerInstalled } from "../../src/server/install";
import {
  FakeSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/fakeSshConnection";
import type { PlatformAdapter, ProductInfo } from "../../src/platform/types";

// Mock downloadToBuffer so the install flow can reach extraction + patching
// without a real HTTP server. Returns an empty buffer; the fake ssh conn
// returns success for tar extraction regardless of stdin contents.
vi.mock("../../src/server/download", () => ({
  downloadToBuffer: async () => Buffer.alloc(0),
}));

function makeAdapter(): PlatformAdapter {
  return {
    name: "Test",
    dataFolderName: ".test",
    serverDataFolderName: ".test-server",
    serverApplicationName: "test-server",
    getServerDownloadUrl: () =>
      "https://example.com/test-server-linux-x64.tar.gz",
    needsArgvPatch: () => false,
    isValidRuntime: () => true,
  };
}

function makeProductInfo(): ProductInfo {
  return {
    commit: "abc123",
    quality: "stable",
    version: "1.0.0",
    release: "1.0.0",
    serverApplicationName: "test-server",
    serverDataFolderName: ".test-server",
    verifyChecksum: false,
    onNoChecksum: "warn",
  };
}

describe("ensureServerInstalled", () => {
  it("probes HOME, arch, and busybox in one call when HOME is unknown", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    // Probe output: line 0=HOME, line 1=arch, then BB_YES/BB_NO
    conn.setResponse("printenv", ok("/home/user\nx86_64\nBB_YES"));
    // Server already installed
    conn.setResponse("test -f", ok("ALREADY_INSTALLED"));
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
    );

    expect(result.alreadyInstalled).toBe(true);
    expect(result.installPath).toContain("abc123");
    expect(result.arch).toBe("x64");
  });

  it("uses HOME from resolver when provided", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    // When HOME is known, probe does: uname -m; test -x ... && echo BB_YES
    conn.setResponse("uname", ok("aarch64\nBB_YES"));
    // Server already installed
    conn.setResponse("test -f", ok("ALREADY_INSTALLED"));
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
      "/home/known",
    );

    expect(result.alreadyInstalled).toBe(true);
    expect(result.arch).toBe("arm64");
  });

  it("completes the install when server needs install", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("uname", ok("x86_64\nBB_YES"));
    // test -f node: not found, mkdir succeeds -> NEEDS_INSTALL
    conn.setResponse("test -f", ok("NEEDS_INSTALL"));
    conn.setDefault(ok());

    // downloadToBuffer is mocked to return an empty buffer; the fake ssh
    // conn returns success for tar extraction, sed commit patch, and the
    // final node-binary check.
    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
      "/home/user",
    );

    expect(result.alreadyInstalled).toBe(false);
    expect(result.installPath).toBe("/home/user/.test-server/bin/abc123");
  });

  it("throws when arch is unsupported", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("uname", ok("mips\nBB_YES"));
    conn.setDefault(ok());

    await expect(
      ensureServerInstalled(
        conn as any,
        makeAdapter(),
        makeProductInfo(),
        noopLogger as any,
        "/ext/path",
        "/home/user",
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("patches the extracted product.json commit to match the IDE", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("uname", ok("x86_64\nBB_YES"));
    conn.setResponse("test -f", ok("NEEDS_INSTALL"));
    // sed returns success; verify (test -f node) succeeds.
    conn.setResponse("sed", ok(""));
    conn.setResponse("node", ok(""));
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
      "/home/user",
    );

    expect(result.alreadyInstalled).toBe(false);
    expect(result.installPath).toBe("/home/user/.test-server/bin/abc123");

    // The sed command must target <installPath>/product.json and substitute
    // the IDE commit. Match by substring on the captured calls.
    const sedCall = conn.calls.find(
      (c) => c.includes("sed") && c.includes("product.json"),
    );
    expect(sedCall).toBeDefined();
    expect(sedCall!).toContain("'/home/user/.test-server/bin/abc123/product.json'");
    expect(sedCall!).toContain('"commit": "abc123"');
    expect(sedCall!).toMatch(/"commit": "[0-9a-f]*"/);
  });
});
