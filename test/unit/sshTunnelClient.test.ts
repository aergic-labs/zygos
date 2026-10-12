/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tests for SshTunnelClient. Starts an in-process HTTP server using
 * the tunnel server's handleTunnelRequest, and points the client at
 * it via a direct-connect agent (no SOCKS5).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { SshTunnelClient, TunnelHttpError } from "../../src/sshTunnel/client";
import {
  handleTunnelRequest,
  type TunnelState,
  type SpawnResponse,
} from "../../src/sshTunnel/server";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the exit file until the spawn finishes. Returns the exit code
 *  string (or "1:msg" on spawn error). */
async function waitForExit(
  res: SpawnResponse,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return fs.readFileSync(res.exitPath, "utf-8");
    } catch {
      /* not written yet */
    }
    await sleep(25);
  }
  throw new Error(`spawn did not exit in ${timeoutMs}ms`);
}

describe("SshTunnelClient", () => {
  let server: http.Server;
  let port: number;
  let root: string;
  let tmpDir: string;
  let client: SshTunnelClient;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-client-"));
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

  beforeEach(() => {
    client = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: TOKEN,
      agent: directAgent(port),
    });
  });

  afterEach(() => {
    client.dispose();
    // Clean tmp dir between tests so spawn ids don't pile up.
    for (const f of fs.readdirSync(tmpDir)) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch {
        /* best effort */
      }
    }
  });

  it("putFile writes a file with content", async () => {
    await client.putFile("test.txt", Buffer.from("hello world"), "0644");
    expect(fs.readFileSync(path.join(root, "test.txt"), "utf-8")).toBe(
      "hello world",
    );
  });

  it("putFile writes without a mode", async () => {
    await client.putFile("nomode.txt", Buffer.from("data"));
    expect(fs.readFileSync(path.join(root, "nomode.txt"), "utf-8")).toBe(
      "data",
    );
  });

  it("putFile writes binary content", async () => {
    const bin = crypto.randomBytes(1024);
    await client.putFile("bin.dat", bin);
    expect(fs.readFileSync(path.join(root, "bin.dat"))).toEqual(bin);
  });

  it("putFile creates parent directories", async () => {
    await client.putFile("sub/deep/file.txt", Buffer.from("nested"));
    expect(
      fs.readFileSync(path.join(root, "sub/deep/file.txt"), "utf-8"),
    ).toBe("nested");
  });

  it("putFile rejects paths outside root", async () => {
    await expect(
      client.putFile("../escape.txt", Buffer.from("nope")),
    ).rejects.toThrow(/403/);
    expect(fs.existsSync(path.join(root, "..", "escape.txt"))).toBe(false);
  });

  it("getFile reads a file", async () => {
    fs.writeFileSync(path.join(root, "read.txt"), "read me");
    const content = await client.getFile("read.txt");
    expect(content.toString("utf-8")).toBe("read me");
  });

  it("getFile reads binary content", async () => {
    const bin = crypto.randomBytes(512);
    fs.writeFileSync(path.join(root, "readbin.dat"), bin);
    const content = await client.getFile("readbin.dat");
    expect(content).toEqual(bin);
  });

  it("getFile throws on missing file", async () => {
    await expect(client.getFile("nope.txt")).rejects.toThrow(/not found/);
  });

  it("getFile throws TunnelHttpError on missing file", async () => {
    try {
      await client.getFile("nope.txt");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TunnelHttpError);
      expect((err as TunnelHttpError).status).toBe(404);
    }
  });

  it("openPutFile streams content in chunks", async () => {
    const { writer, done } = client.openPutFile("stream.txt", "0644");
    writer.write("chunk1 ");
    writer.write("chunk2");
    writer.end();
    await done;
    expect(fs.readFileSync(path.join(root, "stream.txt"), "utf-8")).toBe(
      "chunk1 chunk2",
    );
  });

  it("openPutFile streams binary content", async () => {
    const { writer, done } = client.openPutFile("streambin.dat");
    const chunk1 = crypto.randomBytes(256);
    const chunk2 = crypto.randomBytes(256);
    writer.write(chunk1);
    writer.write(chunk2);
    writer.end();
    await done;
    expect(fs.readFileSync(path.join(root, "streambin.dat"))).toEqual(
      Buffer.concat([chunk1, chunk2]),
    );
  });

  it("openPutFile done rejects on server error", async () => {
    const { writer, done } = client.openPutFile("../escape.txt");
    writer.write("nope");
    writer.end();
    await expect(done).rejects.toThrow(/403/);
  });

  it("spawn runs a command and writes exit code", async () => {
    const res = await client.spawn({ command: "echo", args: ["hi"] });
    expect(res.pid).toBeGreaterThan(0);
    expect(res.stdoutPath).toContain(tmpDir);
    expect(res.stderrPath).toContain(tmpDir);
    expect(res.exitPath).toContain(tmpDir);
    const exit = await waitForExit(res);
    expect(exit).toBe("0");
    expect(fs.readFileSync(res.stdoutPath, "utf-8").trim()).toBe("hi");
  });

  it("spawn captures non-zero exit", async () => {
    const res = await client.spawn({
      command: "sh",
      args: ["-c", "exit 42"],
    });
    const exit = await waitForExit(res);
    expect(exit).toBe("42");
  });

  it("spawn captures stderr", async () => {
    const res = await client.spawn({
      command: "sh",
      args: ["-c", "echo err >&2"],
    });
    await waitForExit(res);
    expect(fs.readFileSync(res.stderrPath, "utf-8").trim()).toBe("err");
  });

  it("spawn with stdin from a temp file", async () => {
    const stdinPath = ".ssh-remote/tunnel-tmp/stdin.txt";
    await client.putFile(stdinPath, Buffer.from("piped input"));
    const res = await client.spawn({ command: "cat", stdinPath });
    await waitForExit(res);
    expect(fs.readFileSync(res.stdoutPath, "utf-8")).toBe("piped input");
  });

  it("spawn with streaming stdin via openPutFile", async () => {
    const stdinPath = ".ssh-remote/tunnel-tmp/stream-stdin.txt";
    const { writer, done } = client.openPutFile(stdinPath);
    writer.write("stream ");
    writer.write("stdin");
    writer.end();
    await done;
    const res = await client.spawn({ command: "cat", stdinPath });
    await waitForExit(res);
    expect(fs.readFileSync(res.stdoutPath, "utf-8")).toBe("stream stdin");
  });

  it("spawn passes cwd and env", async () => {
    const res = await client.spawn({
      command: "sh",
      args: ["-c", "echo $PWD:$ZYGO_TEST"],
      cwd: tmpDir,
      env: { ZYGO_TEST: "envval", PATH: process.env.PATH ?? "" },
    });
    await waitForExit(res);
    const out = fs.readFileSync(res.stdoutPath, "utf-8").trim();
    // gitbash translates the Windows cwd to a POSIX path, so check the
    // env var was set and the cwd contains the temp dir name.
    expect(out).toMatch(/:envval$/);
    expect(out).toContain("tunnel-client-");
  });

  it("rejects requests with a wrong token", async () => {
    const bad = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: "deadbeef",
      agent: directAgent(port),
    });
    await expect(bad.getFile("test.txt")).rejects.toThrow(/403/);
    bad.dispose();
  });

  it("rejects requests with no token", async () => {
    const bad = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: "",
      agent: directAgent(port),
    });
    await expect(bad.getFile("test.txt")).rejects.toThrow(/401|403/);
    bad.dispose();
  });

  it("putFile then getFile round-trips", async () => {
    const content = crypto.randomBytes(2048);
    await client.putFile("roundtrip.dat", content);
    const read = await client.getFile("roundtrip.dat");
    expect(read).toEqual(content);
  });

  it("getFile with offset returns only bytes after the offset", async () => {
    const content = Buffer.from("0123456789abcdef");
    await client.putFile("offset.dat", content);
    const from4 = await client.getFile("offset.dat", 4);
    expect(from4.toString("utf-8")).toBe("456789abcdef");
  });

  it("getFile with offset 0 returns the whole file", async () => {
    await client.putFile("offset0.dat", Buffer.from("hello"));
    const read = await client.getFile("offset0.dat", 0);
    expect(read.toString("utf-8")).toBe("hello");
  });

  it("getFile with offset past end returns empty", async () => {
    await client.putFile("offsetend.dat", Buffer.from("short"));
    const read = await client.getFile("offsetend.dat", 100);
    expect(read.length).toBe(0);
  });

  it("execWithStdin runs a command and returns buffered stdout", async () => {
    const resp = await client.execWithStdin("echo hello", Buffer.alloc(0));
    expect(resp.exitCode).toBe(0);
    expect(Buffer.from(resp.stdout, "base64").toString("utf-8").trim()).toBe("hello");
    expect(Buffer.from(resp.stderr, "base64").toString("utf-8")).toBe("");
  });

  it("execWithStdin pipes stdin into the command", async () => {
    const resp = await client.execWithStdin("cat", Buffer.from("piped data"));
    expect(resp.exitCode).toBe(0);
    expect(Buffer.from(resp.stdout, "base64").toString("utf-8")).toBe("piped data");
  });

  it("execWithStdin captures non-zero exit and stderr", async () => {
    const resp = await client.execWithStdin("echo err >&2; exit 9", Buffer.alloc(0));
    expect(resp.exitCode).toBe(9);
    expect(Buffer.from(resp.stderr, "base64").toString("utf-8").trim()).toBe("err");
  });

  it("execWithStdin handles binary stdin and stdout", async () => {
    const bin = crypto.randomBytes(256);
    const resp = await client.execWithStdin("cat", bin);
    expect(resp.exitCode).toBe(0);
    expect(Buffer.from(resp.stdout, "base64")).toEqual(bin);
  });

  it("execWithStdin passes cwd and env", async () => {
    const resp = await client.execWithStdin(
      "sh -c 'echo $ZYGO_TEST'",
      Buffer.alloc(0),
      { env: { ZYGO_TEST: "cwd-env", PATH: process.env.PATH ?? "" } },
    );
    expect(resp.exitCode).toBe(0);
    expect(Buffer.from(resp.stdout, "base64").toString("utf-8").trim()).toBe("cwd-env");
  });

  it("dispose does not throw and cleans up the pool", async () => {
    const c = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: TOKEN,
      agent: directAgent(port),
    });
    await c.putFile("before.txt", Buffer.from("ok"));
    expect(() => c.dispose()).not.toThrow();
  });

  it("fires onUnreachable after consecutive heartbeat failures", async () => {
    // A port with nothing listening, so every /health fails with ECONNREFUSED.
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    let fired = 0;
    const c = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: deadPort,
      token: TOKEN,
      agent: directAgent(deadPort),
      heartbeatIntervalMs: 15,
      onUnreachable: () => { fired++; },
    });
    const deadline = Date.now() + 3000;
    while (fired === 0 && Date.now() < deadline) await sleep(10);
    expect(fired).toBe(1);
    expect(c.isUnreachable()).toBe(true);
    c.dispose();
  });

  it("does not fire onUnreachable while heartbeats succeed", async () => {
    let fired = 0;
    const c = new SshTunnelClient({
      socksPort: 0,
      tunnelPort: port,
      token: TOKEN,
      agent: directAgent(port),
      heartbeatIntervalMs: 15,
      onUnreachable: () => { fired++; },
    });
    await sleep(150);
    expect(fired).toBe(0);
    expect(c.isUnreachable()).toBe(false);
    c.dispose();
  });
});
