/*
 * Remote integration test for SshTunnelClient through a real ssh -D
 * SOCKS forward to the real tunnel service on 40.160.143.180.
 * Exercises spawn with streaming stdin (the artizo install path).
 *
 * Usage: TUNNEL_PORT=<port> TUNNEL_TOKEN=<hex> npx tsx test/tunnelRemote.ts
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import { SshTunnelClient } from "../src/sshTunnel/client";

const REMOTE_HOST = "40.160.143.180";
const TUNNEL_PORT = parseInt(process.env.TUNNEL_PORT ?? "0", 10);
const TOKEN = process.env.TUNNEL_TOKEN ?? "";
const SOCKS_PORT = 1080;

function waitForPort(port: number, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tryConnect = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error("socks port timeout"));
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

async function pollFile(
  client: SshTunnelClient,
  path: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await client.getFile(path);
      const text = content.toString("utf-8").trim();
      if (text) return text;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`poll timeout: ${path}`);
}

async function main() {
  if (!TUNNEL_PORT || !TOKEN) {
    console.error("Set TUNNEL_PORT and TUNNEL_TOKEN env vars");
    process.exit(1);
  }

  // Start a SOCKS forward to the remote.
  console.log("[test] starting ssh -D SOCKS forward...");
  const ssh = spawn(
    "ssh",
    [
      "-D", String(SOCKS_PORT),
      "-N",
      "-o", "StrictHostKeyChecking=accept-new",
      REMOTE_HOST,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  ssh.stderr.on("data", (d) => process.stderr.write(`[ssh] ${d}`));

  try {
    await waitForPort(SOCKS_PORT, 10_000);
    console.log("[test] SOCKS forward up on", SOCKS_PORT);

    const client = new SshTunnelClient({
      socksPort: SOCKS_PORT,
      tunnelPort: TUNNEL_PORT,
      token: TOKEN,
    });

    // Test 1: simple echo
    console.log("\n[test 1] simple echo command");
    {
      const spawned = await client.spawn({
        command: "sh",
        args: ["-c", "echo hello from tunnel"],
      });
      console.log("[test 1] spawn pid:", spawned.pid);
      const out = await pollFile(client, spawned.stdoutPath);
      const exit = await pollFile(client, spawned.exitPath);
      console.log("[test 1] stdout:", out);
      console.log("[test 1] exit:", exit);
      if (exit !== "0") throw new Error("test 1 failed");
      console.log("[test 1] PASS");
    }

    // Test 2: stream stdin to cat
    console.log("\n[test 2] stream stdin to cat");
    {
      const stdinPath = ".ssh-remote/tunnel-tmp/test2.stdin";
      const { writer, done } = client.openPutFile(stdinPath);
      writer.write(Buffer.from("streamed "));
      writer.write(Buffer.from("stdin data"));
      writer.end();
      await done;
      console.log("[test 2] stdin uploaded");

      const spawned = await client.spawn({
        command: "sh",
        args: ["-c", "cat"],
        stdinPath,
      });
      const out = await pollFile(client, spawned.stdoutPath);
      const exit = await pollFile(client, spawned.exitPath);
      console.log("[test 2] stdout:", out);
      console.log("[test 2] exit:", exit);
      if (exit !== "0") throw new Error("test 2 failed");
      if (out !== "streamed stdin data") throw new Error("test 2 content mismatch");
      console.log("[test 2] PASS");
    }

    // Test 3: the artizo-like flow (tar extract from stdin)
    console.log("\n[test 3] tar extract from stdin (artizo-like)");
    {
      // Create a small tarball on the remote to use as stdin.
      const tarBytes = await new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        const ssh2 = spawn(
          "ssh",
          [REMOTE_HOST, "cd /tmp && echo 'artizo test content' > test-file.txt && tar czf - test-file.txt && rm test-file.txt"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        ssh2.stdout.on("data", (d) => parts.push(d));
        ssh2.on("close", () => resolve(Buffer.concat(parts)));
        ssh2.on("error", reject);
      });
      console.log(`[test 3] tarball size: ${tarBytes.length} bytes`);

      // Clean up any prior extract dir.
      await new Promise<void>((resolve) => {
        spawn("ssh", [REMOTE_HOST, "rm -rf ~/.ssh-remote/test-extract"], {
          stdio: "ignore",
        }).on("close", () => resolve());
      });

      const stdinPath = ".ssh-remote/tunnel-tmp/test3.stdin";
      const { writer, done } = client.openPutFile(stdinPath);
      writer.write(tarBytes);
      writer.end();
      await done;
      console.log("[test 3] tarball uploaded as stdin temp");

      const tarCmd = "mkdir -p ~/.ssh-remote/test-extract && tar xzf - -C ~/.ssh-remote/test-extract";
      const spawned = await client.spawn({
        command: "sh",
        args: ["-c", tarCmd],
        stdinPath,
      });
      console.log("[test 3] spawn pid:", spawned.pid);

      const exit = await pollFile(client, spawned.exitPath, 30_000);
      console.log("[test 3] exit:", exit);

      if (exit === "0") {
        // Verify the extracted file.
        const verify = await new Promise<string>((resolve) => {
          const ssh3 = spawn(
            "ssh",
            [REMOTE_HOST, "cat ~/.ssh-remote/test-extract/test-file.txt 2>/dev/null"],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          const parts: Buffer[] = [];
          ssh3.stdout.on("data", (d) => parts.push(d));
          ssh3.on("close", () => resolve(Buffer.concat(parts).toString("utf-8").trim()));
        });
        console.log("[test 3] extracted content:", verify);
        if (verify === "artizo test content") {
          console.log("[test 3] PASS: tarball extracted correctly");
        } else {
          throw new Error("test 3 content mismatch");
        }
      } else {
        const err = await pollFile(client, spawned.stderrPath).catch(() => "(no stderr)");
        console.log("[test 3] stderr:", err);
        throw new Error(`test 3 failed: tar exit ${exit}`);
      }
    }

    client.dispose();
    console.log("\n[test] ALL PASS");
  } finally {
    ssh.kill();
  }
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
