/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * TransportClient against the real Go server.
 *
 * Builds a host-platform binary of go/tunnel, starts it, and exercises the
 * protocol over a direct connection (no SOCKS). Skipped when Go is not
 * installed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { TransportClient } from "../../src/transport/client";
import { ZygosTransport } from "../../src/transport/zygos";

// Build a minimal gzip-compressed tarball in-memory. Avoids a runtime
// dependency on a host `tar` binary and lets the test craft exact entries
// (dirs, regular files, symlinks) and the strip-components case.
function octal(n: number, len: number): string {
  return n.toString(8).padStart(len, "0");
}
function tarHeader(
  name: string,
  size: number,
  typeflag: string,
  mode = 0o644,
  linkname = "",
): Buffer {
  const h = Buffer.alloc(512, 0);
  Buffer.from(name, "utf-8").copy(h, 0);
  h.write(octal(mode, 7), 100);
  h.write(octal(0, 7), 108);
  h.write(octal(0, 7), 116);
  h.write(octal(size, 11), 124);
  h.write(octal(0, 11), 136);
  h.write("        ", 148);
  h.write(typeflag, 156, "ascii");
  if (linkname) Buffer.from(linkname, "utf-8").copy(h, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum & 0o7777777, 6), 148);
  h[154] = 0;
  return h;
}
function makeTarGz(entries: { name: string; type: "file" | "dir" | "symlink"; content?: string; link?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    if (e.type === "dir") {
      blocks.push(tarHeader(e.name + "/", 0, "5", 0o755));
    } else if (e.type === "symlink") {
      blocks.push(tarHeader(e.name, 0, "2", 0o777, e.link ?? ""));
    } else {
      const data = Buffer.from(e.content ?? "", "utf-8");
      blocks.push(tarHeader(e.name, data.length, "0", 0o644));
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const ROOT = path.resolve(__dirname, "../..");
const GO_DIR = path.join(ROOT, "go", "tunnel");

function goAvailable(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGo = goAvailable();

describe.skipIf(!hasGo)("TransportClient (Go server)", () => {
  let binPath: string;
  let tmpDir: string;
  let server: ChildProcess;
  let port: number;
  let token: string;
  let client: TransportClient;
  let zygos: ZygosTransport;

  beforeAll(async () => {
    binPath = path.join(
      os.tmpdir(),
      `tunnel-test-${process.pid}${process.platform === "win32" ? ".exe" : ""}`,
    );
    execFileSync("go", ["build", "-o", binPath, "."], {
      cwd: GO_DIR,
      stdio: "inherit",
    });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-test-"));
    const metaFile = path.join(tmpDir, "meta.json");

    server = spawn(
      binPath,
      [
        "--port",
        "0",
        "--meta-file",
        metaFile,
        "--root",
        tmpDir,
        "--idle-timeout-ms",
        "60000",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );

    ({ port, token } = await waitForPortFile(metaFile));
    const connectFn = () =>
      new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1");
        s.on("connect", () => resolve(s));
        s.on("error", reject);
      });
    client = new TransportClient({ socksPort: 0, port, token, connectFn });
    zygos = new ZygosTransport({ socksPort: 0, port, token, connectFn });
  }, 60_000);

  afterAll(() => {
    server?.kill();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("health returns ok", async () => {
    await expect(client.health()).resolves.toBeUndefined();
  });

  it("rejects a wrong token", async () => {
    const bad = new TransportClient({
      socksPort: 0,
      port,
      token: "00".repeat(32),
      connectFn: () =>
        new Promise<net.Socket>((resolve, reject) => {
          const s = net.connect(port, "127.0.0.1");
          s.on("connect", () => resolve(s));
          s.on("error", reject);
        }),
    });
    await expect(bad.health()).rejects.toThrow();
  });

  it("exec runs a command", async () => {
    const r = await client.exec("echo", ["hello"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString("utf-8").trim()).toBe("hello");
  });

  it("exec captures non-zero exit and stderr", async () => {
    const r = await client.exec("sh", ["-c", "echo err >&2; exit 7"]);
    expect(r.exitCode).toBe(7);
    expect(r.stderr.toString("utf-8").trim()).toBe("err");
  });

  it("putFile + getFile round-trip", async () => {
    const p = path.join(tmpDir, "roundtrip.txt");
    await client.putFile(p, Buffer.from("hello world"), "0644");
    const got = await client.getFile(p);
    expect(got.toString("utf-8")).toBe("hello world");
  });

  it("getFile throws on missing", async () => {
    await expect(client.getFile(path.join(tmpDir, "nope.txt"))).rejects.toThrow(
      /not found/,
    );
  });

  it("openPutFile streams", async () => {
    const p = path.join(tmpDir, "stream.txt");
    const { writer, done } = await client.openPutFile(p, "0644");
    writer.write("chunk1 ");
    writer.write("chunk2");
    writer.end();
    await done;
    expect(fs.readFileSync(p, "utf-8")).toBe("chunk1 chunk2");
  });

  it("rejects paths outside root", async () => {
    await expect(
      client.putFile(path.join(tmpDir, "..", "escape.txt"), Buffer.from("x")),
    ).rejects.toThrow();
  });

  it("extract streams a gzip tarball and extracts with strip-components", async () => {
    const dest = path.join(tmpDir, "extract-test");
    fs.rmSync(dest, { recursive: true, force: true });
    // Top-level dir `top/` is stripped by strip-components=1.
    const tarGz = makeTarGz([
      { name: "top", type: "dir" },
      { name: "top/hello.txt", type: "file", content: "hello extract\n" },
      { name: "top/sub", type: "dir" },
      { name: "top/sub/nested.txt", type: "file", content: "nested\n" },
    ]);
    await client.extract(dest, 1, tarGz);
    expect(fs.readFileSync(path.join(dest, "hello.txt"), "utf-8")).toBe("hello extract\n");
    expect(fs.readFileSync(path.join(dest, "sub", "nested.txt"), "utf-8")).toBe("nested\n");
  });

  it("extract neutralizes a tarball entry that tries to escape dest with ..", async () => {
    const dest = path.join(tmpDir, "extract-escape");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const tarGz = makeTarGz([
      { name: "top", type: "dir" },
      // path.Clean collapses the .. to /escape.txt, strip removes top, so
      // the file lands as <dest>/escape.txt (inside dest), not outside.
      { name: "top/../../escape.txt", type: "file", content: "pwn" },
    ]);
    await client.extract(dest, 1, tarGz);
    // The file is inside dest, sanitized — never escapes to tmpDir.
    expect(fs.existsSync(path.join(dest, "escape.txt"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "escape.txt"))).toBe(false);
  });

  it("stat + readdir + mkdir + rename + rm", async () => {
    const dir = path.join(tmpDir, "sub");
    await client.mkdir(dir);
    const f = path.join(dir, "a.txt");
    await client.putFile(f, Buffer.from("abc"));
    const st = await client.stat(f);
    expect(st.size).toBe(3);
    expect(st.type).toBe(1);
    const entries = await client.readdir(dir);
    expect(entries.map((e) => e.name)).toContain("a.txt");
    const f2 = path.join(dir, "b.txt");
    await client.rename(f, f2);
    expect(fs.existsSync(f2)).toBe(true);
    await client.rm(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("env returns platform and env", async () => {
    const e = await client.env();
    expect(e.osPlatform.length).toBeGreaterThan(0);
    expect(typeof e.env).toBe("object");
  });

  it("spawn streams stdout", async () => {
    const proc = await client.spawn("echo", ["from spawn"]);
    const chunks: Buffer[] = [];
    proc.stdout.onData((d) => chunks.push(d));
    const exit = await proc.onExit;
    expect(exit.status).toBe(0);
    expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from spawn");
  });

  it("spawn separates stdout and stderr", async () => {
    const proc = await client.spawn("sh", ["-c", "echo out; echo err >&2"]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.onData((d) => out.push(d));
    proc.stderr.onData((d) => err.push(d));
    await proc.onExit;
    expect(Buffer.concat(out).toString("utf-8").trim()).toBe("out");
    expect(Buffer.concat(err).toString("utf-8").trim()).toBe("err");
  });

  it("spawn streams stdin", async () => {
    const proc = await client.spawn("cat");
    const out: Buffer[] = [];
    proc.stdout.onData((d) => out.push(d));
    proc.stdin.write(new TextEncoder().encode("piped "));
    proc.stdin.write(new TextEncoder().encode("input"));
    proc.stdin.end();
    await proc.onExit;
    expect(Buffer.concat(out).toString("utf-8")).toBe("piped input");
  });

  // SIGTERM is a no-op on Windows, so this only runs on POSIX hosts.
  it.skipIf(process.platform === "win32")(
    "kill terminates a spawned process",
    async () => {
      const pidFile = path.join(tmpDir, "spawn.pid");
      const proc = await client.spawn("sh", [
        "-c",
        `echo $$ > ${pidFile}; sleep 30`,
      ]);
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        } catch {
          /* not written yet */
        }
      }
      expect(pid).toBeGreaterThan(0);
      await client.kill(pid);
      const exit = await proc.onExit;
      expect(exit.status).not.toBe(0);
    },
    15_000,
  );

  it("lock acquires and unlock releases", async () => {
    const dir = path.join(tmpDir, "lockdir");
    expect((await zygos.lock(dir, 1800)).acquired).toBe(true);
    // Second acquire fails while held.
    expect((await zygos.lock(dir, 1800)).acquired).toBe(false);
    await zygos.unlock(dir);
    expect((await zygos.lock(dir, 1800)).acquired).toBe(true);
    await zygos.unlock(dir);
  });

  it("serverStatus reports no pid when files are absent", async () => {
    const installPath = path.join(tmpDir, "install");
    fs.mkdirSync(installPath, { recursive: true });
    const status = await zygos.serverStatus(installPath);
    expect(status.pid).toBeUndefined();
    expect(status.alive).toBe(false);
    expect(status.reusePort).toBeUndefined();
  });

  // exec -a and /proc are POSIX-only.
  it.skipIf(process.platform === "win32")(
    "serverFinalize writes pid/port files and releases the lock",
    async () => {
      const installPath = path.join(tmpDir, "install2");
      fs.mkdirSync(installPath, { recursive: true });
      // Spawn a process whose cmdline matches <installPath>/node.
      const proc = await client.spawn("sh", [
        "-c",
        `exec -a ${installPath}/node sleep 30`,
      ]);
      await new Promise((r) => setTimeout(r, 300));
      const lockDir = path.join(installPath, ".resolve-lock");
      fs.mkdirSync(lockDir, { recursive: true });
      const { pid } = await zygos.serverFinalize(installPath, 12345, true);
      expect(pid).toBeGreaterThan(0);
      expect(
        fs.readFileSync(path.join(installPath, ".server.pid"), "utf-8"),
      ).toBe(String(pid));
      expect(fs.existsSync(lockDir)).toBe(false);
      await client.kill(pid!);
      await proc.onExit;
    },
    15_000,
  );
});

async function waitForPortFile(
  metaFile: string,
): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8")) as {
        port?: number;
        pid?: number;
        token?: string;
      };
      if (meta.port && meta.port > 0 && meta.token) {
        return { port: meta.port, token: meta.token };
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not write a meta file");
}
