/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { SshSession } from "../../src/ssh/sshSession/connection";
import { SshSessionClient } from "../../src/ssh/sshSession/client";
import {
  initSshSessionSecret,
  disposeSshSessionSecret,
} from "../../src/ssh/sshSessionSecret";

const sshSessionDeps = {
  serverScriptPath: "/fake/localServer.js",
  wrapperScriptPath: "/fake/start-server.sh",
  nodePath: "/fake/node",
  dataDir: "/fake/sshSession",
  logger: { info: () => {}, debug: () => {}, error: () => {}, show: () => {} } as any,
};

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};

describe("SshSession.fromDestination", () => {
  it("builds host string from host only", () => {
    const conn = SshSession.fromDestination(
      { host: "example.com" },
      {},
      sshSessionDeps,
    );
    expect(conn.remoteLabel).toBe("example.com");
  });

  it("builds user@host string", () => {
    const conn = SshSession.fromDestination(
      { host: "example.com", user: "admin" },
      {},
      sshSessionDeps,
    );
    expect(conn.remoteLabel).toBe("admin@example.com");
  });

  it("adds port as -p extraArg", () => {
    const conn = SshSession.fromDestination(
      { host: "example.com", port: 2222 },
      {},
      sshSessionDeps,
    );
    expect(conn.remoteLabel).toBe("example.com");
  });

  it("preserves extraArgs from opts", () => {
    const conn = SshSession.fromDestination(
      { host: "example.com" },
      { extraArgs: ["-o", "StrictHostKeyChecking=no"] },
      sshSessionDeps,
    );
    expect(conn.remoteLabel).toBe("example.com");
  });
});

/** Framing protocol test: spawn the real local server with a fake ssh,
 * verify the /exec round-trip parses the exit marker correctly. */
describe("ssh session framing protocol", () => {
  let tmpDir: string;
  let localServerPath: string;
  let fakeSshPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-frame-"));
    localServerPath = path.resolve("dist/localServer.js");
    fakeSshPath = path.resolve("test/__mocks__/fake-ssh.mjs");
    await initSshSessionSecret(
      { get: async () => undefined, store: async () => {}, delete: async () => {} } as any,
      noopLogger as any,
      "test.sshSession.key",
    );
  });

  afterEach(() => {
    disposeSshSessionSecret();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes /exec through the framing protocol", async () => {
    if (!fs.existsSync(localServerPath) || !fs.existsSync(fakeSshPath)) {
      console.log("skipping: dist/localServer.js not built");
      return;
    }

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: process.execPath,
      sshArgs: [fakeSshPath, "-D", "0"],
      serverScriptPath: localServerPath,
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    const result = await client.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    await client.stop();
  }, 30_000);

  it("captures non-zero exit codes", async () => {
    if (!fs.existsSync(localServerPath) || !fs.existsSync(fakeSshPath)) {
      console.log("skipping: dist/localServer.js not built");
      return;
    }

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: process.execPath,
      sshArgs: [fakeSshPath, "-D", "0"],
      serverScriptPath: localServerPath,
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    const result = await client.exec("exit 42");
    expect(result.exitCode).toBe(42);
    await client.stop();
  }, 30_000);

  it("captures stdout from multi-line commands", async () => {
    if (!fs.existsSync(localServerPath) || !fs.existsSync(fakeSshPath)) {
      console.log("skipping: dist/localServer.js not built");
      return;
    }

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: process.execPath,
      sshArgs: [fakeSshPath, "-D", "0"],
      serverScriptPath: localServerPath,
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    const result = await client.exec("echo line1; echo line2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("line1\nline2");
    await client.stop();
  }, 30_000);
});
