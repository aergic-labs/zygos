/*
 * Unit tests for SshSessionProcess. Mocks SshSessionClient.exec so no
 * real server is needed.
 *
 * Uses fake timers to control the 500ms poll interval.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SshSessionProcess } from "../../src/ssh/sshSession/process";
import { MockSshSessionClient } from "../__mocks__/mockSshSessionClient";

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
} as any;

describe("SshSessionProcess.start", () => {
  it("parses the pid from the start command response", async () => {
    const client = new MockSshSessionClient();
    // The start command ends with `printf '%s' "$!"` which outputs the pid.
    client.setResponse("$!", { stdout: "12345\n", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "docker run", noopLogger);
    // Wait for the async start to complete (polling starts after).
    await vi.waitFor(() => expect(child.pid).toBe(12345));
    child.kill();
  });

  it("sets pid to 0 if the start command returns no pid", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "some cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(0));
    child.kill();
  });
});

describe("SshSessionProcess polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits stdout data as it appears in the out file", async () => {
    const client = new MockSshSessionClient();
    // Start command returns pid.
    client.setResponse("$!", { stdout: "999\n", exitCode: 0 });
    // First poll: dd returns some output.
    client.setResponseOnce("dd if", { stdout: "hello\n", exitCode: 0 });
    // First poll: no exit file yet (default returns "").
    const child = new SshSessionProcess(client as any, "echo hello", noopLogger);

    const dataChunks: Buffer[] = [];
    child.stdout.on("data", (buf: Buffer) => dataChunks.push(buf));

    // Let start() complete.
    await vi.waitFor(() => expect(child.pid).toBe(999));

    // Advance past one poll interval (500ms).
    await vi.advanceTimersByTimeAsync(600);

    expect(dataChunks.length).toBe(1);
    expect(dataChunks[0].toString()).toBe("hello\n");
    child.kill();
  });

  it("detects exit code and emits close", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "42\n", exitCode: 0 });
    // dd returns empty (no new output).
    client.setResponse("dd if", { stdout: "", exitCode: 0 });
    // exit file cat returns the exit code. Use .exit to match the
    // quoted path (shellQuote wraps in single quotes).
    client.setResponseOnce(".exit", { stdout: "7", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "exit 7", noopLogger);

    let closeEvent: { code: number | null; signal: string | null } | undefined;
    child.on("close", (code, signal) => {
      closeEvent = { code, signal };
    });

    await vi.waitFor(() => expect(child.pid).toBe(42));
    await vi.advanceTimersByTimeAsync(600);

    expect(child.exitCode).toBe(7);
    expect(closeEvent?.code).toBe(7);
    child.kill();
  });

  it("flushes remaining stdout on settle", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "1\n", exitCode: 0 });

    // Poll 1: dd returns partial output.
    client.setResponseOnce("dd if", { stdout: "part1\n", exitCode: 0 });
    // Poll 1: exit file has exit code (triggers settle).
    client.setResponseOnce(".exit", { stdout: "0", exitCode: 0 });
    // On settle, cat the full out file (returns everything).
    // Use "cat " to match the full-cat command (shellQuote adds a quote
    // so "cat /tmp" won't match; "cat " matches before the quote).
    client.setResponse("cat ", { stdout: "part1\npart2\n", exitCode: 0 });
    // rm cleanup.
    client.setResponse("rm -f", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "echo", noopLogger);
    const dataChunks: Buffer[] = [];
    child.stdout.on("data", (buf: Buffer) => dataChunks.push(buf));

    let closeFired = false;
    child.on("close", () => { closeFired = true; });

    await vi.waitFor(() => expect(child.pid).toBe(1));
    await vi.advanceTimersByTimeAsync(600);

    // After settle, we should have received part1 (from poll) + part2 (from flush).
    const all = dataChunks.map((b) => b.toString()).join("");
    expect(all).toContain("part1");
    expect(all).toContain("part2");
    expect(closeFired).toBe(true);
  });
});

describe("SshSessionProcess poll overlap guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start a second poll while one is in flight", async () => {
    let releaseDd: (() => void) | undefined;
    const execCalls: string[] = [];
    const client = {
      exec: async (cmd: string) => {
        execCalls.push(cmd);
        if (cmd.includes('"$!"')) {
          return { id: "s", stdout: "5\n", stderr: "", exitCode: 0, signal: null };
        }
        if (cmd.startsWith("dd if")) {
          // Hang until released, simulating a slow link where a poll
          // takes longer than the 500ms interval.
          await new Promise<void>((r) => { releaseDd = r; });
          return { id: "d", stdout: "", stderr: "", exitCode: 0, signal: null };
        }
        return { id: "c", stdout: "", stderr: "", exitCode: 0, signal: null };
      },
    };
    const child = new SshSessionProcess(client as any, "some cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(5));

    // Advance two poll intervals while the first dd is still pending.
    await vi.advanceTimersByTimeAsync(1200);

    const ddCalls = execCalls.filter((c) => c.startsWith("dd if"));
    expect(ddCalls.length).toBe(1);

    releaseDd?.();
    child.kill();
  });
});

describe("SshSessionProcess.kill", () => {
  it("sends a kill command with the pid", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "555\n", exitCode: 0 });
    client.setResponse("kill -TERM 555", { stdout: "", exitCode: 0 });
    client.setResponse("dd if=", { stdout: "", exitCode: 0 });
    client.setResponse("cat /tmp/zygos-spawn", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(555));

    child.kill("TERM");
    expect(child.killed).toBe(true);

    // Verify the kill command was sent.
    expect(client.execCalls.some((c) => c.includes("kill -TERM 555"))).toBe(true);
  });

  it("defaults to SIGTERM", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "3\n", exitCode: 0 });
    client.setResponse("dd if=", { stdout: "", exitCode: 0 });
    client.setResponse("cat /tmp/zygos-spawn", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(3));

    child.kill();
    expect(client.execCalls.some((c) => c.includes("kill -TERM 3"))).toBe(true);
  });

  it("does not send kill if pid is 0", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "", exitCode: 0 });
    client.setResponse("dd if=", { stdout: "", exitCode: 0 });
    client.setResponse("cat /tmp/zygos-spawn", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(0));

    child.kill();
    expect(child.killed).toBe(true);
    // No kill command should have been sent (pid is 0).
    expect(client.execCalls.some((c) => c.includes("kill -"))).toBe(false);
  });
});

describe("SshSessionProcess stdin", () => {
  it("stdin write and end are no-ops", async () => {
    const client = new MockSshSessionClient();
    client.setResponse("$!", { stdout: "1\n", exitCode: 0 });
    client.setResponse("dd if=", { stdout: "", exitCode: 0 });
    client.setResponse("cat /tmp/zygos-spawn", { stdout: "", exitCode: 0 });

    const child = new SshSessionProcess(client as any, "cmd", noopLogger);
    await vi.waitFor(() => expect(child.pid).toBe(1));

    // Should not throw.
    expect(() => child.stdin.write()).not.toThrow();
    expect(() => child.stdin.end()).not.toThrow();
    child.kill();
  });
});
