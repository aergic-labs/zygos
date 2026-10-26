/*
 * In-process tests for the ssh session local server handlers and framing
 * protocol. Imports localServer.ts functions directly (no process spawn),
 * uses a mock ssh child to simulate the remote interactive shell.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { Readable, EventEmitter } from "node:stream";
import {
  createServerState,
  handleRequest,
  handleExec,
  handlePutFile,
  validToken,
  writePersistenceFile,
  resetShutdownTimer,
  cleanup,
  runExec,
  doRunShellCommand,
  EXIT_PREFIX,
  EXIT_SUFFIX,
  type ServerState,
} from "../../src/ssh/localServer";
import type { SshSessionServerConfig } from "../../src/ssh/sshSession/protocol";
import { createMockSshChild, type MockSshChild } from "../__mocks__/mockSshChild";

const TOKEN = crypto.randomBytes(32).toString("hex");

function makeConfig(dataFilePath: string): SshSessionServerConfig {
  return {
    ipcHandlePath: "/tmp/test-ipc.sock",
    sshCommand: "ssh",
    sshArgs: ["-D", "12345", "sh", "-i"],
    sshEnv: undefined,
    dataFilePath,
    logFilePath: "",
    shutdownTimeoutMs: 60000,
    keepaliveIntervalMs: 6000,
  };
}

function makeState(config: SshSessionServerConfig, child?: MockSshChild): ServerState {
  return createServerState(config, TOKEN, child, () => {});
}

/** Build a mock http.ServerResponse. Access .status and .body
 *  AFTER the handler runs (they are mutable refs). */
function mockResponse(): {
  res: http.ServerResponse;
  status: { value: number | undefined };
  body: { value: string };
} {
  const emitter = new EventEmitter();
  const status = { value: undefined as number | undefined };
  const body = { value: "" as string };
  const res = {
    writeHead: (code: number) => { status.value = code; },
    end: (data?: string) => { body.value = data ?? ""; emitter.emit("end"); },
    headersSent: false,
    on: (ev: string, fn: (...a: unknown[]) => void) => { emitter.on(ev, fn); },
    once: (ev: string, fn: (...a: unknown[]) => void) => { emitter.once(ev, fn); },
  } as unknown as http.ServerResponse;
  return { res, status, body };
}

/** Build a mock http.IncomingMessage with an async-iterable body. */
function mockRequest(
  method: string,
  urlPath: string,
  body: unknown,
  token: string = TOKEN,
): http.IncomingMessage {
  const bodyData = body !== undefined
    ? Buffer.from(JSON.stringify(body), "utf-8")
    : undefined;
  const stream = bodyData !== undefined
    ? Readable.from([bodyData])
    : Readable.from([]);
  // Attach http-like properties.
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = urlPath;
  (req as any).headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  return req;
}

describe("ssh session server: validToken", () => {
  it("accepts the correct hex token", () => {
    const state = makeState(makeConfig("/tmp/x"), undefined);
    expect(validToken(state, TOKEN)).toBe(true);
  });

  it("rejects undefined", () => {
    const state = makeState(makeConfig("/tmp/x"), undefined);
    expect(validToken(state, undefined)).toBe(false);
  });

  it("rejects a wrong-length token", () => {
    const state = makeState(makeConfig("/tmp/x"), undefined);
    expect(validToken(state, "deadbeef")).toBe(false);
  });

  it("rejects a different token", () => {
    const state = makeState(makeConfig("/tmp/x"), undefined);
    const other = crypto.randomBytes(32).toString("hex");
    expect(validToken(state, other)).toBe(false);
  });
});

describe("ssh session server: handleRequest routing", () => {
  let tmpDir: string;
  let config: SshSessionServerConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-srv-"));
    config = makeConfig(path.join(tmpDir, "persist.json"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 401 without bearer token", async () => {
    const state = makeState(config);
    const req = mockRequest("GET", "/status", undefined, "");
    const { res, status, body } = mockResponse();
    // Override headers to remove auth
    (req as any).headers = {};
    await handleRequest(state, req, res);
    expect(status.value).toBe(401);
    expect(JSON.parse(body.value).error).toBe("unauthorized");
  });

  it("returns 403 with invalid bearer token", async () => {
    const state = makeState(config);
    const req = mockRequest("GET", "/status", undefined, "wrong");
    const { res, status, body } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(403);
    expect(JSON.parse(body.value).error).toBe("forbidden");
  });

  it("returns 404 for unknown routes", async () => {
    const state = makeState(config);
    const req = mockRequest("GET", "/nope", undefined);
    const { res, status, body } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(404);
    expect(JSON.parse(body.value).error).toBe("not found");
  });

  it("/status returns sshAlive + socksPort", async () => {
    const child = createMockSshChild();
    const state = makeState(config, child);
    const req = mockRequest("GET", "/status", undefined);
    const { res, status, body } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.sshAlive).toBe(true);
    expect(parsed.socksPort).toBe(12345);
  });

  it("/attach increments refcount", async () => {
    const state = makeState(config);
    const req = mockRequest("POST", "/attach", undefined);
    const { res, status, body } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(200);
    expect(state.refcount).toBe(1);
    expect(JSON.parse(body.value).socksPort).toBe(12345);
  });

  it("/detach decrements refcount", async () => {
    const state = makeState(config);
    state.refcount = 2;
    const req = mockRequest("POST", "/detach", undefined);
    const { res, status } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(200);
    expect(state.refcount).toBe(1);
  });

  it("/detach floors at 0", async () => {
    const state = makeState(config);
    state.refcount = 0;
    const req = mockRequest("POST", "/detach", undefined);
    const { res } = mockResponse();
    await handleRequest(state, req, res);
    expect(state.refcount).toBe(0);
  });

  it("/delay-shutdown does not error", async () => {
    const state = makeState(config);
    const req = mockRequest("POST", "/delay-shutdown", undefined);
    const { res, status } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(200);
    if (state.shutdownTimer) clearTimeout(state.shutdownTimer);
  });
});

describe("ssh session server: /exec handler", () => {
  let tmpDir: string;
  let config: SshSessionServerConfig;
  let child: MockSshChild;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-exec-"));
    config = makeConfig(path.join(tmpDir, "persist.json"));
    child = createMockSshChild();
    state = makeState(config, child);
  });

  afterEach(() => {
    cleanup(state);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns stdout and exitCode from the framed command", async () => {
    const id = "abc123";
    const req = mockRequest("POST", "/exec", { id, command: "echo hello" });
    const { res, status, body } = mockResponse();

    // Start the handler, then emit the response from the mock shell.
    const pending = handleExec(state, req, res);
    // Wait for the command to be written to stdin.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (child.stdinWrites.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    child.emitStdout(`hello\n\n${marker}:0\n`);
    await pending;

    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.trim()).toBe("hello");
  });

  it("captures non-zero exit codes", async () => {
    const id = "xyz789";
    const req = mockRequest("POST", "/exec", { id, command: "exit 42" });
    const { res, status, body } = mockResponse();

    const pending = handleExec(state, req, res);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (child.stdinWrites.length > 0) { clearInterval(check); resolve(); }
      }, 5);
    });

    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    child.emitStdout(`\n${marker}:42\n`);
    await pending;

    expect(status.value).toBe(200);
    expect(JSON.parse(body.value).exitCode).toBe(42);
  });

  it("merges stderr into stdout (2>&1)", async () => {
    const id = "err1";
    const req = mockRequest("POST", "/exec", { id, command: "write to stderr" });
    const { res, body } = mockResponse();

    const pending = handleExec(state, req, res);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (child.stdinWrites.length > 0) { clearInterval(check); resolve(); }
      }, 5);
    });

    // The 2>&1 is in the command, so stderr text appears on stdout.
    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    child.emitStdout(`err msg\n\n${marker}:0\n`);
    await pending;

    expect(JSON.parse(body.value).stdout).toContain("err msg");
  });

  it("rejects missing id", async () => {
    const req = mockRequest("POST", "/exec", { command: "echo hi" });
    const { res, status, body } = mockResponse();
    await handleExec(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing id or command");
  });

  it("rejects invalid json", async () => {
    const bodyData = Buffer.from("not json", "utf-8");
    const stream = Readable.from([bodyData]);
    const req = stream as unknown as http.IncomingMessage;
    (req as any).method = "POST";
    (req as any).url = "/exec";
    (req as any).headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const { res, status, body } = mockResponse();
    await handleExec(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("invalid json");
  });
});

describe("ssh session server: /put-file handler", () => {
  let tmpDir: string;
  let config: SshSessionServerConfig;
  let child: MockSshChild;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-put-"));
    config = makeConfig(path.join(tmpDir, "persist.json"));
    child = createMockSshChild();
    state = makeState(config, child);
  });

  afterEach(() => {
    cleanup(state);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file content and returns exit code", async () => {
    const id = "pf1";
    const content = Buffer.from("hello world").toString("base64");
    const req = mockRequest("POST", "/put-file", {
      id,
      path: "/tmp/test.txt",
      content,
      mode: "0644",
    });
    const { res, status, body } = mockResponse();

    const pending = handlePutFile(state, req, res);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (child.stdinWrites.length > 0) { clearInterval(check); resolve(); }
      }, 5);
    });

    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    child.emitStdout(`\n${marker}:0\n`);
    await pending;

    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(0);
    // Verify the stdin write pipes the base64 content through echo, not
    // as a bare stdin line fed to base64 -d.
    expect(child.stdinWrites[0]).toContain(`echo '${content}' | base64 -d`);
    // Verify the parent dir is mkdir'd before the redirect, so putFile
    // works on a fresh install path whose dir doesn't exist yet.
    expect(child.stdinWrites[0]).toContain(`mkdir -p '/tmp'`);
  });

  it("rejects missing fields", async () => {
    const req = mockRequest("POST", "/put-file", { id: "x" });
    const { res, status, body } = mockResponse();
    await handlePutFile(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing fields");
  });

  it("rejects invalid json", async () => {
    const stream = Readable.from([Buffer.from("not json", "utf-8")]);
    const req = stream as unknown as http.IncomingMessage;
    (req as any).method = "POST";
    (req as any).url = "/put-file";
    (req as any).headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const { res, status, body } = mockResponse();
    await handlePutFile(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("invalid json");
  });
});

describe("ssh session server: framing protocol (doRunShellCommand)", () => {
  let tmpDir: string;
  let config: SshSessionServerConfig;
  let child: MockSshChild;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-frame-"));
    config = makeConfig(path.join(tmpDir, "persist.json"));
    child = createMockSshChild();
    state = makeState(config, child);
  });

  afterEach(() => {
    cleanup(state);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses stdout and exit code from a single chunk", async () => {
    const id = "frame1";
    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    const cmd = `echo hi\nprintf '\\n${marker}:%s\\n' "$?"\n`;

    const pending = doRunShellCommand(state, marker, cmd);
    // Write is synchronous; emit response.
    child.emitStdout(`hi\n\n${marker}:0\n`);
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("accumulates stdout across multiple chunks", async () => {
    const id = "frame2";
    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    const cmd = `echo long\n`;

    const pending = doRunShellCommand(state, marker, cmd);
    // Split output into multiple chunks.
    child.emitStdout(`line1\n`);
    child.emitStdout(`line2\n`);
    child.emitStdout(`\n${marker}:0\n`);
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
  });

  it("handles output with no trailing newline before marker", async () => {
    const id = "frame3";
    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    const cmd = `printf nonewline`;

    const pending = doRunShellCommand(state, marker, cmd);
    child.emitStdout(`nonewline\n${marker}:7\n`);
    const result = await pending;
    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe("nonewline");
  });

  it("rejects if ssh child is gone", async () => {
    const marker = `${EXIT_PREFIX}gone${EXIT_SUFFIX}`;
    state.sshChild = undefined;
    await expect(doRunShellCommand(state, marker, "echo hi")).rejects.toThrow("ssh not alive");
  });

  it("rejects on timeout", async () => {
    const id = "frame4";
    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    const cmd = `sleep 999`;
    const pending = doRunShellCommand(state, marker, cmd, 50);
    await expect(pending).rejects.toThrow("timed out");
  });
});

describe("ssh session server: runExec", () => {
  let tmpDir: string;
  let config: SshSessionServerConfig;
  let child: MockSshChild;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-re-"));
    config = makeConfig(path.join(tmpDir, "persist.json"));
    child = createMockSshChild();
    state = makeState(config, child);
  });

  afterEach(() => {
    cleanup(state);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps command in a subshell so exit doesn't kill the control shell", async () => {
    const id = "re1";
    const pending = runExec(state, { id, command: "exit 42" });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (child.stdinWrites.length > 0) { clearInterval(check); resolve(); }
      }, 5);
    });
    // Verify the command was wrapped in ( ) not { ; }
    expect(child.stdinWrites[0]).toContain("( exit 42 )");
    expect(child.stdinWrites[0]).not.toContain("{ exit 42; }");

    const marker = `${EXIT_PREFIX}${id}${EXIT_SUFFIX}`;
    child.emitStdout(`\n${marker}:42\n`);
    const result = await pending;
    expect(result.exitCode).toBe(42);
  });
});

describe("ssh session server: writePersistenceFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-persist-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes pid, ipcHandlePath, socksPort to the data file", () => {
    const child = createMockSshChild();
    const config = makeConfig(path.join(tmpDir, "p.json"));
    const state = makeState(config, child);
    writePersistenceFile(state);
    const raw = fs.readFileSync(config.dataFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(99999);
    expect(parsed.ipcHandlePath).toBe("/tmp/test-ipc.sock");
    expect(parsed.socksPort).toBe(12345);
  });

  it("does not write if ssh child has no pid", () => {
    const config = makeConfig(path.join(tmpDir, "p.json"));
    const state = makeState(config, undefined);
    writePersistenceFile(state);
    expect(fs.existsSync(config.dataFilePath)).toBe(false);
  });
});

describe("ssh session server: resetShutdownTimer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-timer-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onShutdown when the timer fires", async () => {
    let called = false;
    const config: SshSessionServerConfig = {
      ...makeConfig(path.join(tmpDir, "p.json")),
      shutdownTimeoutMs: 20,
    };
    const state = createServerState(config, TOKEN, undefined, () => { called = true; });
    resetShutdownTimer(state);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(called).toBe(true);
  });

  it("clears the previous timer when reset", () => {
    let called = false;
    const config: SshSessionServerConfig = {
      ...makeConfig(path.join(tmpDir, "p.json")),
      shutdownTimeoutMs: 20,
    };
    const state = createServerState(config, TOKEN, undefined, () => { called = true; });
    resetShutdownTimer(state);
    resetShutdownTimer(state); // should clear the first timer
    expect(state.shutdownTimer).toBeDefined();
    clearTimeout(state.shutdownTimer!);
  });
});

describe("ssh session server: /shutdown route", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-session-shut-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls onShutdown (does not process.exit in tests)", async () => {
    let called = false;
    const config = makeConfig(path.join(tmpDir, "p.json"));
    const state = createServerState(config, TOKEN, undefined, () => { called = true; });
    const req = mockRequest("POST", "/shutdown", undefined);
    const { res, status } = mockResponse();
    await handleRequest(state, req, res);
    expect(status.value).toBe(200);
    expect(called).toBe(true);
  });
});
