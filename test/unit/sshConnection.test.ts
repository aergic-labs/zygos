/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { SshConnection } from "../../src/ssh/connection";

describe("SshConnection.fromDestination", () => {
  it("builds host string from host only", () => {
    const conn = SshConnection.fromDestination({ host: "example.com" });
    expect(conn.remoteLabel).toBe("example.com");
  });

  it("builds user@host string", () => {
    const conn = SshConnection.fromDestination({
      host: "example.com",
      user: "admin",
    });
    expect(conn.remoteLabel).toBe("admin@example.com");
  });

  it("adds port as -p extraArg", () => {
    const conn = SshConnection.fromDestination({
      host: "example.com",
      port: 2222,
    });
    expect(conn.buildExecArgs("true")).toContain("-p");
    expect(conn.buildExecArgs("true")).toContain("2222");
  });

  it("preserves extraArgs from opts", () => {
    const conn = SshConnection.fromDestination(
      { host: "example.com" },
      { extraArgs: ["-o", "StrictHostKeyChecking=no"] },
    );
    const args = conn.buildExecArgs("true");
    expect(args).toContain("StrictHostKeyChecking=no");
  });

  it("merges port extraArgs with existing extraArgs", () => {
    const conn = SshConnection.fromDestination(
      { host: "example.com", port: 2222 },
      { extraArgs: ["-o", "ConnectTimeout=5"] },
    );
    const args = conn.buildExecArgs("true");
    expect(args).toContain("ConnectTimeout=5");
    expect(args).toContain("2222");
  });
});

describe("SshConnection.buildExecArgs", () => {
  it("includes -T flag", () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    expect(conn.buildExecArgs("ls")).toContain("-T");
  });

  it("includes BatchMode=yes when no askpass", () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    expect(conn.buildExecArgs("ls")).toContain("BatchMode=yes");
  });

  it("omits BatchMode when askpass is set", () => {
    const conn = SshConnection.fromDestination(
      { host: "h" },
      {
        askpass: { handle: "test", stop: () => {} } as any,
        askpassScript: "/script",
        askpassMain: "/main",
        nodePath: "/node",
      },
    );
    expect(conn.buildExecArgs("ls")).not.toContain("BatchMode=yes");
  });

  it("includes ConnectTimeout", () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    expect(conn.buildExecArgs("ls")).toContain("ConnectTimeout=15");
  });

  it("appends command last", () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    const args = conn.buildExecArgs("ls -la");
    expect(args[args.length - 1]).toBe("ls -la");
  });

  it("uses custom sshPath", () => {
    const conn = SshConnection.fromDestination(
      { host: "h" },
      { sshPath: "/usr/local/bin/ssh" },
    );
    // sshPath is internal; just verify buildExecArgs doesn't throw.
    expect(conn.buildExecArgs("true")).toBeDefined();
  });
});

describe("SshConnection.isConnected", () => {
  it("starts as not connected", () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    expect(conn.isConnected).toBe(false);
  });

  it("is false after close", async () => {
    const conn = SshConnection.fromDestination({ host: "h" });
    await conn.close();
    expect(conn.isConnected).toBe(false);
  });
});
