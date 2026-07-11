/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  writeConnectionTokenFile,
  removeConnectionTokenFile,
} from "../../src/server/connectionToken";
import {
  FakeSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/fakeSshConnection";

describe("writeConnectionTokenFile", () => {
  it("writes token via bbExecWithStdin and returns the path", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    const path = await writeConnectionTokenFile(
      conn as any,
      "/home/user",
      "secret-token",
      noopLogger as any,
    );
    expect(path).toBe("/home/user/.ssh-remote/conn-token");
    expect(conn.calls.length).toBeGreaterThan(0);
    // stdin should contain the token
    const stdinEntry = Array.from(conn.stdinData.values())[0];
    expect(stdinEntry.toString()).toBe("secret-token");
  });

  it("throws when write fails", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("cat", fail("permission denied"));
    await expect(
      writeConnectionTokenFile(
        conn as any,
        "/home/user",
        "token",
        noopLogger as any,
      ),
    ).rejects.toThrow("Failed to write connection token");
  });
});

describe("removeConnectionTokenFile", () => {
  it("calls rm -f on the token file", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    await removeConnectionTokenFile(
      conn as any,
      "/home/user/.ssh-remote/conn-token",
      noopLogger as any,
    );
    expect(conn.calls.some((c) => c.includes("rm -f"))).toBe(true);
    expect(conn.calls.some((c) => c.includes("conn-token"))).toBe(true);
  });

  it("does not throw when rm fails", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.setResponse("rm", fail("no such file"));
    // Should not throw - best-effort cleanup
    await expect(
      removeConnectionTokenFile(
        conn as any,
        "/home/user/.ssh-remote/conn-token",
        noopLogger as any,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw when rm throws", async () => {
    const conn = new FakeSshConnection();
    await conn.connect();
    conn.exec = async () => {
      throw new Error("connection lost");
    };
    await expect(
      removeConnectionTokenFile(
        conn as any,
        "/home/user/.ssh-remote/conn-token",
        noopLogger as any,
      ),
    ).resolves.toBeUndefined();
  });
});
