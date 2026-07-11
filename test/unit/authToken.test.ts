/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { copyAuthToken } from "../../src/server/authToken";
import { FakeSshConnection, noopLogger } from "../__mocks__/fakeSshConnection";
import type { PlatformAdapter } from "../../src/platform/types";

function makeAdapter(token: string | undefined, path: string): PlatformAdapter {
  return {
    name: "Test",
    dataFolderName: ".test",
    serverDataFolderName: ".test-server",
    serverApplicationName: "test-server",
    getServerDownloadUrl: () => "",
    needsArgvPatch: () => false,
    isValidRuntime: () => true,
    readAuthToken: () => token,
    getAuthTokenPath: () => path,
  };
}

describe("copyAuthToken", () => {
  it("skips when adapter has no readAuthToken", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const adapter: PlatformAdapter = {
      name: "Test",
      dataFolderName: ".test",
      serverDataFolderName: ".test-server",
      serverApplicationName: "test-server",
      getServerDownloadUrl: () => "",
      needsArgvPatch: () => false,
      isValidRuntime: () => true,
      // no readAuthToken / getAuthTokenPath
    };
    await copyAuthToken(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBe(0);
  });

  it("skips when no local token is present", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const adapter = makeAdapter(undefined, ".cache/token.json");
    await copyAuthToken(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBe(0);
  });

  it("writes token to remote path via bbExecWithStdin", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const adapter = makeAuthTokenAdapter("my-token", ".cache/token.json");
    await copyAuthToken(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBeGreaterThan(0);
    const stdin = Array.from(conn.stdinData.values())[0];
    expect(stdin.toString()).toBe("my-token");
    // Command should mkdir the parent and write to the path
    expect(conn.calls.some((c) => c.includes("mkdir -p"))).toBe(true);
    expect(conn.calls.some((c) => c.includes(".cache/token.json"))).toBe(true);
  });

  it("throws when write fails", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("cat", {
      stdout: "",
      stderr: "denied",
      exitCode: 1,
      signal: null,
    });
    const adapter = makeAuthTokenAdapter("my-token", ".cache/token.json");
    await expect(
      copyAuthToken(conn as any, "/home/user", adapter, noopLogger as any),
    ).rejects.toThrow("Failed to copy auth token");
  });
});

function makeAuthTokenAdapter(token: string, path: string): PlatformAdapter {
  return makeAdapter(token, path);
}
