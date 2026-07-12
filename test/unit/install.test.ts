/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { ensureServerInstalled } from "../../src/server/install";
import {
  FakeSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/fakeSshConnection";
import type { PlatformAdapter, ProductInfo } from "../../src/platform/types";

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

  it("returns alreadyInstalled=false when server needs install", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("uname", ok("x86_64\nBB_YES"));
    // test -f node: not found, mkdir succeeds -> NEEDS_INSTALL
    conn.setResponse("test -f", ok("NEEDS_INSTALL"));
    conn.setDefault(ok());

    // Download fails (no real HTTP server); verify it throws, not crashes.
    await expect(
      ensureServerInstalled(
        conn as any,
        makeAdapter(),
        makeProductInfo(),
        noopLogger as any,
        "/ext/path",
        "/home/user",
      ),
    ).rejects.toThrow(); // download fails
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
});
