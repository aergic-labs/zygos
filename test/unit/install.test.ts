/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import { ensureServerInstalled } from "../../src/remote/install";
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
vi.mock("../../src/remote/download", () => ({
  downloadToBuffer: async () => Buffer.alloc(0),
}));

// Mock bootstrapBusybox so tests that take the busybox-missing path don't
// need the real vendored binary on disk.
const { mockBootstrapBusybox } = vi.hoisted(() => ({
  mockBootstrapBusybox: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/remote/busybox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/remote/busybox")>();
  return { ...actual, bootstrapBusybox: mockBootstrapBusybox };
});

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
  it("probes and returns early when server is already installed", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    // Probe output: home:::arch:::busybox:::installed
    conn.setResponse(
      "printenv",
      ok("/home/user:::x86_64:::yes:::yes"),
    );
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
    expect(result.home).toBe("/home/user");
  });

  it("bootstraps busybox even when server is already installed (issue #3)", async () => {
    // Host provisioned by another extension: server present, busybox
    // missing. Without the fix, the early return skipped bootstrap and
    // every later bbExec call failed with exit 127.
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse(
      "printenv",
      ok("/home/user:::x86_64:::no:::yes"),
    );
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
    );

    expect(result.alreadyInstalled).toBe(true);
    expect(result.busyboxBootstrapped).toBe(true);
    // Bootstrap call ran.
    expect(mockBootstrapBusybox).toHaveBeenCalled();
  });

  it("completes the install when server needs install", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    // Probe: busybox present, install absent
    conn.setResponse(
      "printenv",
      ok("/home/user:::x86_64:::yes:::no"),
    );
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
    );

    expect(result.alreadyInstalled).toBe(false);
    expect(result.installPath).toBe("/home/user/.test-server/bin/abc123");
  });

  it("throws when arch is unsupported", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse(
      "printenv",
      ok("/home/user:::mips:::no:::no"),
    );
    conn.setDefault(ok());

    await expect(
      ensureServerInstalled(
        conn as any,
        makeAdapter(),
        makeProductInfo(),
        noopLogger as any,
        "/ext/path",
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("patches the extracted product.json commit to match the IDE", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse(
      "printenv",
      ok("/home/user:::x86_64:::yes:::no"),
    );
    // The combined patch+verify call: sed -n returns a different commit,
    // sed -i returns success, test -f node succeeds.
    conn.setResponse("sed -n", ok("def456"));
    conn.setResponse("sed -i", ok(""));
    conn.setResponse("node", ok(""));
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
    );

    expect(result.alreadyInstalled).toBe(false);
    expect(result.installPath).toBe("/home/user/.test-server/bin/abc123");

    // The patch command must target <installPath>/product.json and
    // substitute the IDE commit.
    const sedCall = conn.calls.find(
      (c) => c.includes("sed -i") && c.includes("product.json"),
    );
    expect(sedCall).toBeDefined();
    expect(sedCall!).toContain("'/home/user/.test-server/bin/abc123/product.json'");
    expect(sedCall!).toContain('"commit": "abc123"');
    expect(sedCall!).toMatch(/"commit": "[0-9a-f]*"/);
  });

  it("includes a commit-match guard in the patch+verify command", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse(
      "printenv",
      ok("/home/user:::x86_64:::yes:::no"),
    );
    conn.setResponse("sed -n", ok("abc123"));
    conn.setDefault(ok());

    const result = await ensureServerInstalled(
      conn as any,
      makeAdapter(),
      makeProductInfo(),
      noopLogger as any,
      "/ext/path",
    );

    expect(result.alreadyInstalled).toBe(false);
    // The combined patch+verify command has an if guard that skips sed -i
    // when the REH commit already matches the IDE commit. Verify the guard
    // is present (the remote sh evaluates it at runtime).
    const combinedCall = conn.calls.find(
      (c) => c.includes("sed -n") && c.includes("product.json"),
    );
    expect(combinedCall).toBeDefined();
    expect(combinedCall!).toContain('"$reh" != "abc123"');
    expect(combinedCall!).toContain("sed -i");
  });
});
