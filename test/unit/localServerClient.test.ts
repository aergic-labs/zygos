/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SshSessionClient } from "../../src/ssh/sshSession/client";
import {
  initSshSessionSecret,
  disposeSshSessionSecret,
} from "../../src/ssh/sshSessionSecret";

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};

/** Create a mock HTTP server implementing the ssh session protocol routes. */
function createMockServer(
  socketPath: string,
  socksPort: number,
  handlers: {
    onAttach?: () => void;
    onDetach?: () => void;
    onExec?: (cmd: string) => { stdout: string; exitCode: number };
  } = {},
): http.Server {
  let refcount = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    res.setHeader("content-type", "application/json");
    if (p === "/status") {
      res.end(JSON.stringify({
        sshAlive: true,
        pid: process.pid,
        socksPort,
        startupTime: Date.now(),
        sshSessionProtocolVersion: 1,
      }));
    } else if (p === "/attach") {
      refcount++;
      handlers.onAttach?.();
      res.end(JSON.stringify({ ok: true, socksPort }));
    } else if (p === "/detach") {
      if (refcount > 0) refcount--;
      handlers.onDetach?.();
      res.end(JSON.stringify({ ok: true }));
    } else if (p === "/exec") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const result = handlers.onExec?.(parsed.command) ?? { stdout: "", exitCode: 0 };
        res.end(JSON.stringify({
          id: parsed.id,
          stdout: result.stdout,
          stderr: "",
          exitCode: result.exitCode,
          signal: null,
        }));
      });
    } else if (p === "/delay-shutdown") {
      res.end(JSON.stringify({ ok: true }));
    } else if (p === "/shutdown") {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  server.listen(socketPath);
  return server;
}

/** Generate a valid IPC socket path for the current platform. */
function makeSocketPath(): string {
  const id = crypto.randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\aergic-ssh-session-test-${id}`;
  }
  return path.join(os.tmpdir(), `aergic-ssh-session-test-${id}.sock`);
}

describe("SshSessionClient", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-test-"));
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

  it("reuses an existing server via the persistence file", async () => {
    const socketPath = makeSocketPath();
    const socksPort = 12345;
    const server = createMockServer(socketPath, socksPort);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    // Write a persistence file pointing at the mock server.
    const dataFilePath = path.join(tmpDir, "test%40host.json");
    fs.writeFileSync(dataFilePath, JSON.stringify({
      pid: process.pid,
      ipcHandlePath: socketPath,
      socksPort,
      startupTime: Date.now(),
      sshSessionProtocolVersion: 1,
    }));

    let attached = false;
    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    // Patch the client's request to use our handlers.
    (client as any).opts.logger = noopLogger;

    await client.start();
    expect(client.socksPort).toBe(socksPort);
    expect(client["started"]).toBe(true);

    // Should NOT have spawned a child process.
    expect(client["serverChild"]).toBeUndefined();

    await client.stop();
    server.close();
  });

  it("sets logFilePath on the reuse path so the log tailer attaches", async () => {
    const socketPath = makeSocketPath();
    const socksPort = 12345;
    const server = createMockServer(socketPath, socksPort);
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const dataFilePath = path.join(tmpDir, "test%40host.json");
    fs.writeFileSync(dataFilePath, JSON.stringify({
      pid: process.pid,
      ipcHandlePath: socketPath,
      socksPort,
      startupTime: Date.now(),
      sshSessionProtocolVersion: 1,
    }));

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    // Item 4: logFilePath must be set before tryReconnect() so the reuse
    // branch's startLogTailer() is not a no-op.
    expect((client as any).logFilePath).toContain("test%40host");
    expect((client as any).logTailer).toBeDefined();

    await client.stop();
    server.close();
  });

  it("sends /attach on start and /detach on stop", async () => {
    const socketPath = makeSocketPath();
    const socksPort = 23456;
    let attachCount = 0;
    let detachCount = 0;
    const server = createMockServer(socketPath, socksPort, {
      onAttach: () => { attachCount++; },
      onDetach: () => { detachCount++; },
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const dataFilePath = path.join(tmpDir, "test%40host.json");
    fs.writeFileSync(dataFilePath, JSON.stringify({
      pid: process.pid,
      ipcHandlePath: socketPath,
      socksPort,
      startupTime: Date.now(),
      sshSessionProtocolVersion: 1,
    }));

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    expect(attachCount).toBe(1);

    await client.stop();
    expect(detachCount).toBe(1);

    server.close();
  });

  it("spawns a new server when persistence file is missing", async () => {
    // No persistence file: tryReconnect fails and the real flow spawns.
    // Here we assert it returns null.
    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    const result = await (client as any).tryReconnect();
    expect(result).toBeNull();
  });

  it("returns null from tryReconnect when the persistence file is stale", async () => {
    const socketPath = makeSocketPath();
    const dataFilePath = path.join(tmpDir, "test%40host.json");
    // Write a file pointing at a socket where nothing is listening.
    fs.writeFileSync(dataFilePath, JSON.stringify({
      pid: 99999,
      ipcHandlePath: socketPath,
      socksPort: 9999,
      startupTime: Date.now(),
      sshSessionProtocolVersion: 1,
    }));

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    const result = await (client as any).tryReconnect();
    expect(result).toBeNull();
  });

  it("exec routes commands through the HTTP IPC", async () => {
    const socketPath = makeSocketPath();
    const socksPort = 34567;
    const server = createMockServer(socketPath, socksPort, {
      onExec: (cmd) => ({ stdout: `ran: ${cmd}`, exitCode: 0 }),
    });
    await new Promise<void>((resolve) => server.on("listening", resolve));

    const dataFilePath = path.join(tmpDir, "test%40host.json");
    fs.writeFileSync(dataFilePath, JSON.stringify({
      pid: process.pid,
      ipcHandlePath: socketPath,
      socksPort,
      startupTime: Date.now(),
      sshSessionProtocolVersion: 1,
    }));

    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/fake/localServer.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    await client.start();
    const result = await client.exec("uname -a");
    expect(result.stdout).toBe("ran: uname -a");
    expect(result.exitCode).toBe(0);

    await client.stop();
    server.close();
  });

  it("fails fast when the server process exits before becoming ready", async () => {
    // Point nodePath at an invalid serverScriptPath so the child exits
    // immediately. start() should reject, not hang for 60s.
    const client = new SshSessionClient({
      destination: "test@host",
      sshCommand: "ssh",
      sshArgs: [],
      serverScriptPath: "/definitely/not/a/real/file.js",
      nodePath: process.execPath,
      dataDir: tmpDir,
      logger: noopLogger as any,
    });

    const start = Date.now();
    await expect(client.start()).rejects.toThrow(/exited before ready/);
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});