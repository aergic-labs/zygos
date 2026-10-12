/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Integration tests for SshExecServer.spawn via the SshTunnel path.
 * Starts a real in-process tunnel HTTP server and connects a real
 * SshTunnelClient with a direct-connect agent (no SOCKS5).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { SshExecServer } from "../../src/remote/execServer";
import { SshTunnelClient } from "../../src/sshTunnel/client";
import {
  handleTunnelRequest,
  type TunnelState,
} from "../../src/sshTunnel/server";
import { MockSshConnection, noopLogger } from "../__mocks__/mockSshConnection";

const TOKEN = crypto.randomBytes(32).toString("hex");

function startTestServer(
  root: string,
  tmpDir: string,
  token: string,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const state: TunnelState = {
      config: { root, tmpDir, port: 0, portFile: "" },
      tokenHex: token,
    };
    const server = http.createServer((req, res) => {
      handleTunnelRequest(state, req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

/** Agent that connects directly to 127.0.0.1:port (no SOCKS5). */
function directAgent(port: number): http.Agent {
  const agent = new http.Agent({
    keepAlive: true,
  });
  (agent as any).createConnection = (
    _options: net.NetConnectOpts,
    callback: (err: Error | null, socket: net.Socket) => void,
  ) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => callback(null, socket));
    socket.once("error", (err) => callback(err, undefined as any));
  };
  return agent;
}

/** Collect all data from a ReadStream into a Buffer. */
function collectStream(stream: { onDidReceiveMessage: (l: (e: Uint8Array) => void) => { dispose: () => void }; onEnd: Promise<void> }): { chunks: Buffer[]; done: Promise<void> } {
  const chunks: Buffer[] = [];
  const sub = stream.onDidReceiveMessage((data) => {
    chunks.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
  const done = stream.onEnd.then(() => sub.dispose());
  return { chunks, done };
}

describe("SshExecServer.spawn via tunnel", () => {
  let server: http.Server;
  let port: number;
  let root: string;
  let tmpDir: string;
  let client: SshTunnelClient;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-exec-"));
    tmpDir = path.join(root, ".ssh-remote", "tunnel-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const s = await startTestServer(root, tmpDir, TOKEN);
    server = s.server;
    port = s.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    client?.dispose();
    for (const f of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* best effort */ }
    }
  });

  function makeExecServer(): SshExecServer {
    client = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: TOKEN,
      agent: directAgent(port),
    });
    const conn = new MockSshConnection();
    return new SshExecServer(conn as any, 0, noopLogger as any, client);
  }

  it("runs a simple command and collects stdout", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("echo", ["hello"]);
    const out = collectStream(spawned.stdout);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks).toString("utf-8").trim()).toBe("hello");
  });

  it("streams stdin to a command that reads it", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("cat", []);
    const out = collectStream(spawned.stdout);
    spawned.stdin.write(new Uint8Array(Buffer.from("chunk1 ")));
    spawned.stdin.write(new Uint8Array(Buffer.from("chunk2")));
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks).toString("utf-8")).toBe("chunk1 chunk2");
  });

  it("streams large stdin in multiple chunks", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("cat", []);
    const out = collectStream(spawned.stdout);
    const data = crypto.randomBytes(64 * 1024);
    // Write in 4KB chunks.
    for (let i = 0; i < data.length; i += 4096) {
      spawned.stdin.write(new Uint8Array(data.subarray(i, i + 4096)));
    }
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks)).toEqual(data);
  });

  it("captures non-zero exit code", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("sh", ["-c", "exit 42"]);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    expect(exit.status).toBe(42);
  });

  it("captures stderr output", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("sh", ["-c", "echo err >&2"]);
    const err = collectStream(spawned.stderr);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await err.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(err.chunks).toString("utf-8").trim()).toBe("err");
  });

  it("captures both stdout and stderr", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("sh", ["-c", "echo out; echo err >&2"]);
    const out = collectStream(spawned.stdout);
    const err = collectStream(spawned.stderr);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await Promise.all([out.done, err.done]);
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks).toString("utf-8").trim()).toBe("out");
    expect(Buffer.concat(err.chunks).toString("utf-8").trim()).toBe("err");
  });

  it("pipes stdin through tar-like command", async () => {
    // Simulate the artizo install: read stdin, write a file.
    const outPath = path.join(root, "pipe-out.txt");
    const exec = makeExecServer();
    const spawned = await exec.spawn("sh", [
      "-c",
      `cat > "${outPath.replace(/\\/g, "/")}"`,
    ]);
    spawned.stdin.write(new Uint8Array(Buffer.from("tarball content")));
    spawned.stdin.end();
    const exit = await spawned.onExit;
    expect(exit.status).toBe(0);
    expect(fs.readFileSync(outPath, "utf-8")).toBe("tarball content");
  });

  it("resolves onEnd for stdout and stderr after exit", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("echo", ["done"]);
    spawned.stdin.end();
    await spawned.onExit;
    expect(await spawned.stdout.onEnd).toBeUndefined();
    expect(await spawned.stderr.onEnd).toBeUndefined();
  });

  it("handles empty stdin", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("echo", ["noinput"]);
    const out = collectStream(spawned.stdout);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks).toString("utf-8").trim()).toBe("noinput");
  });

  it("passes env vars via buildCommand", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("sh", ["-c", "echo $TESTVAR"], {
      env: { TESTVAR: "envval" },
    });
    const out = collectStream(spawned.stdout);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(out.chunks).toString("utf-8").trim()).toBe("envval");
  });

  it("passes cwd via buildCommand", async () => {
    const exec = makeExecServer();
    const spawned = await exec.spawn("pwd", [], { cwd: tmpDir });
    const out = collectStream(spawned.stdout);
    spawned.stdin.end();
    const exit = await spawned.onExit;
    await out.done;
    expect(exit.status).toBe(0);
    // gitbash translates the cwd to a POSIX path; check the dir name.
    const outStr = Buffer.concat(out.chunks).toString("utf-8").trim();
    expect(outStr).toContain("tunnel-tmp");
  });
});

describe("SshExecServer.spawn via tunnel: unreachable tunnel (item 5)", () => {
  it("settles onExit and stops the read streams instead of spinning", async () => {
    vi.useFakeTimers();
    try {
      // Every GET fails as a non-404: the tunnel is unreachable, not
      // merely "file not written yet".
      const fakeClient = {
        openPutFile: () => ({
          writer: { write: () => {}, end: () => {} },
          done: Promise.resolve(),
        }),
        spawn: async () => ({
          pid: 1,
          stdoutPath: "/o",
          stderrPath: "/e",
          exitPath: "/x",
        }),
        getFile: async () => {
          throw new Error("tunnel unreachable");
        },
      };
      const conn = new MockSshConnection();
      const exec = new SshExecServer(
        conn as any,
        0,
        noopLogger as any,
        fakeClient as any,
      );
      const spawned = await exec.spawn("echo", ["hi"]);
      spawned.stdin.end();

      let rejected = false;
      void spawned.onExit.then(() => {}, () => { rejected = true; });
      let readEnded = false;
      void spawned.stdout.onEnd.then(() => { readEnded = true; });
      void spawned.stderr.onEnd.then(() => { readEnded = true; });

      // 450 x 100ms: comfortably past the ~30s failure threshold.
      await vi.advanceTimersByTimeAsync(45_000);

      expect(rejected).toBe(true);
      // The read streams must also stop, not poll the dead tunnel forever.
      expect(readEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
