/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { copyAuthFiles } from "../../src/remote/authToken";
import { FakeSshConnection, noopLogger } from "../__mocks__/fakeSshConnection";
import type { PlatformAdapter } from "../../src/platform/types";

function makeAdapter(files: { path: string; content: string }[] | undefined): PlatformAdapter {
  return {
    name: "Test",
    dataFolderName: ".test",
    serverDataFolderName: ".test-server",
    serverApplicationName: "test-server",
    getServerDownloadUrl: () => "",
    needsArgvPatch: () => false,
    isValidRuntime: () => true,
    readAuthFiles: files === undefined ? undefined : () => files!,
  };
}

describe("copyAuthFiles", () => {
  it("skips when adapter has no readAuthFiles", async () => {
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
      // no readAuthFiles
    };
    await copyAuthFiles(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBe(0);
  });

  it("skips when adapter returns no files", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const adapter = makeAdapter([]);
    await copyAuthFiles(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBe(0);
  });

  it("streams path/b64 pairs + blank terminator in one call", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const adapter = makeAdapter([
      { path: ".aws/sso/cache/kiro-auth-token.json", content: '{"token":"a"}' },
      { path: ".aws/sso/cache/abc.json", content: '{"client":"b"}' },
    ]);
    await copyAuthFiles(conn as any, "/home/user", adapter, noopLogger as any);
    expect(conn.calls.length).toBeGreaterThan(0);
    const stdin = Array.from(conn.stdinData.values())[0] as Buffer;
    const lines = stdin.toString().split("\n");
    // path / b64 / path / b64 / blank terminator
    expect(lines[0]).toBe(".aws/sso/cache/kiro-auth-token.json");
    expect(lines[1]).toBe(
      Buffer.from('{"token":"a"}', "utf-8").toString("base64"),
    );
    expect(lines[2]).toBe(".aws/sso/cache/abc.json");
    expect(lines[3]).toBe(
      Buffer.from('{"client":"b"}', "utf-8").toString("base64"),
    );
    expect(lines[4]).toBe(""); // blank terminator
    // Remote script should use temp+mv (atomic, non-fatal).
    const cmd = conn.calls.join(" ");
    expect(cmd).toContain("mv -f");
    expect(cmd).toContain("base64 -d");
  });

  it("throws when remote command fails", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("sh", {
      stdout: "",
      stderr: "denied",
      exitCode: 1,
      signal: null,
    });
    const adapter = makeAdapter([
      { path: ".cache/token.json", content: "x" },
    ]);
    await expect(
      copyAuthFiles(conn as any, "/home/user", adapter, noopLogger as any),
    ).rejects.toThrow("Failed to copy auth files");
  });
});
