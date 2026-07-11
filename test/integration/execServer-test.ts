/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Standalone test for SshExecServer methods against the real remote.
 * Build: node esbuild.config.mjs --test
 * Run:   node dist/test-execServer.js
 */
import * as net from "node:net";
import { SshConnection } from "../../src/ssh/connection";
import { SshExecServer } from "../../src/server/execServer";

const HOST = "example.com";
const USER = "user";

const logger = {
  info: (...a: unknown[]) => console.log("[info]", ...a),
  debug: (..._a: unknown[]) => {},
  error: (...a: unknown[]) => console.error("[error]", ...a),
  show: () => {},
};

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else console.log("  PASS:", msg);
}

async function main(): Promise<void> {
  // Safety timeout - don't hang forever.
  setTimeout(() => {
    console.error("TIMEOUT");
    process.exit(1);
  }, 45_000);
  const conn = SshConnection.fromDestination(
    { host: HOST, user: USER },
    { logger: logger as any },
  );
  await conn.connect();
  console.log("connected\n");

  // Start SOCKS forward for tcpConnect
  const socksPort: number = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
  });

  const forward = conn.spawnProcess(undefined, [
    "-D",
    String(socksPort),
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
  ]);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`SOCKS on :${socksPort}\n`);

  const es = new SshExecServer(conn, socksPort, logger as any);

  // 1. env()
  console.log("=== env() ===");
  {
    const envInfo = await es.env();
    assert(
      envInfo.osPlatform === "linux",
      `osPlatform=linux (got ${envInfo.osPlatform})`,
    );
    assert(typeof envInfo.osRelease === "string", "osRelease is string");
    assert(Object.keys(envInfo.env).length > 0, "env has entries");
  }
  console.log();

  // 2. fs.stat()
  console.log("=== fs.stat('/etc/hostname') ===");
  {
    const stat = await es.fs.stat("/etc/hostname");
    assert(stat.type === 1, `stat type=1/File (got ${stat.type})`);
    assert(stat.size > 0, `stat size>0 (got ${stat.size})`);
  }
  console.log();

  // 3. fs.readdir()
  console.log("=== fs.readdir('/etc') ===");
  {
    const entries = await es.fs.readdir("/etc");
    assert(entries.length > 5, `readdir entries>5 (got ${entries.length})`);
    const hasHosts = entries.some((e: any) => e.name === "hostname");
    assert(hasHosts, "readdir contains 'hostname'");
  }
  console.log();

  // 4. fs.read()
  console.log("=== fs.read('/etc/hostname') ===");
  {
    const stream = await es.fs.read("/etc/hostname");
    const chunks: Uint8Array[] = [];
    stream.onDidReceiveMessage((d: Uint8Array) => chunks.push(d));
    await stream.onEnd;
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      "utf-8",
    );
    assert(text.length > 0, `read content non-empty (${text.length} bytes)`);
    console.log("  content:", text.trim());
  }
  console.log();

  // 5. fs.write() + fs.rm()
  console.log("=== fs.write('/tmp/exec-test.txt') + fs.rm ===");
  {
    const { stream, done } = await es.fs.write("/tmp/exec-test.txt");
    stream.write(new TextEncoder().encode("hello from exec server"));
    stream.end();
    await done;

    const catResult = await conn.exec("cat /tmp/exec-test.txt");
    assert(
      catResult.stdout.trim() === "hello from exec server",
      "write content matches",
    );

    await es.fs.rm("/tmp/exec-test.txt");
    const check = await conn.exec(
      "test -f /tmp/exec-test.txt && echo exists || echo gone",
    );
    assert(check.stdout.trim() === "gone", "rm removed file");
  }
  console.log();

  // 6. spawn()
  console.log("=== spawn('echo', ['hello from spawn']) ===");
  {
    const proc = await es.spawn("echo", ["hello", "from", "spawn"]);
    const chunks: Buffer[] = [];
    proc.stdout.onDidReceiveMessage((d: Uint8Array) =>
      chunks.push(Buffer.from(d)),
    );
    const exit = await proc.onExit;
    assert(exit.status === 0, `spawn exit=0 (got ${exit.status})`);
    const out = Buffer.concat(chunks.map((c) => Buffer.from(c)))
      .toString("utf-8")
      .trim();
    assert(out === "hello from spawn", `spawn stdout matches (got "${out}")`);
  }
  console.log();

  // 7. mkdirp + rename
  console.log("=== mkdirp + rename ===");
  {
    await es.fs.mkdirp("/tmp/exec-test-dir");
    const { stream, done } = await es.fs.write("/tmp/exec-test-dir/a.txt");
    stream.write(new TextEncoder().encode("test"));
    stream.end();
    await done;

    await es.fs.rename("/tmp/exec-test-dir/a.txt", "/tmp/exec-test-dir/b.txt");
    const ls = await conn.exec("ls /tmp/exec-test-dir/");
    assert(
      ls.stdout.trim() === "b.txt",
      `rename worked (got "${ls.stdout.trim()}")`,
    );
    await es.fs.rm("/tmp/exec-test-dir");
  }
  console.log();

  // 8. kill()
  console.log("=== kill() ===");
  {
    // Start a background sleep, capture its PID.
    // nohup + & + disown ensures the SSH exec returns immediately.
    const sleepResult = await conn.exec(
      "nohup sleep 60 >/dev/null 2>&1 & echo $!",
    );
    const pid = sleepResult.stdout.trim();
    assert(/^\d+$/.test(pid), `got numeric PID (got "${pid}")`);
    if (/^\d+$/.test(pid)) {
      await es.kill(parseInt(pid, 10));
      const check = await conn.exec(
        `ps -p ${pid} -o pid= 2>/dev/null || echo gone`,
      );
      assert(check.stdout.trim() === "gone", "kill removed process");
    }
  }
  console.log();

  // 9. tcpConnect()
  console.log("=== tcpConnect('127.0.0.1', 22) ===");
  {
    const { stream, done } = await es.tcpConnect("127.0.0.1", 22);
    const chunks: Uint8Array[] = [];
    stream.onDidReceiveMessage((d: Uint8Array) => chunks.push(d));
    await new Promise((r) => setTimeout(r, 2000));
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      "utf-8",
    );
    assert(
      text.includes("SSH-"),
      `tcpConnect got SSH banner (got "${text.trim()}")`,
    );
    stream.end();
    await done;
  }
  console.log();

  // Cleanup
  forward.kill();
  console.log(`=== done (${failures} failures) ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
