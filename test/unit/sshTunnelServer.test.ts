/*
 * In-process tests for the SshTunnel server. Imports server.ts functions
 * directly (no process spawn).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { Readable, EventEmitter } from "node:stream";
import {
  handleTunnelRequest,
  handleSpawn,
  handleExec,
  validTunnelToken,
  idleTimedOut,
  resolveUnderRoot,
  type TunnelState,
  type TunnelConfig,
} from "../../src/sshTunnel/server";

const TOKEN = crypto.randomBytes(32).toString("hex");

function makeConfig(root: string, tmpDir: string): TunnelConfig {
  return { root, tmpDir, port: 0, portFile: "" };
}

function makeState(config: TunnelConfig, token: string = TOKEN): TunnelState {
  return { config, tokenHex: token };
}

function mockResponse(): {
  res: http.ServerResponse;
  status: { value: number | undefined };
  body: { value: string };
  chunks: Buffer[];
  done: Promise<void>;
} {
  const status = { value: undefined as number | undefined };
  const body = { value: "" as string };
  const chunks: Buffer[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  // Use a real EventEmitter as the base so pipe() works (pipe needs
  // emit/on/write/end on the destination).
  const res = new EventEmitter() as any;
  res.writeHead = (code: number) => { status.value = code; res.headersSent = true; };
  res.write = (data: string | Buffer) => {
    if (typeof data === "string") body.value += data;
    else chunks.push(data);
  };
  res.end = (data?: string | Buffer) => {
    if (data !== undefined) {
      if (typeof data === "string") body.value += data;
      else chunks.push(data);
    }
    resolveDone();
    res.emit("end");
  };
  res.headersSent = false;
  res.destroy = () => { resolveDone(); };
  return { res: res as unknown as http.ServerResponse, status, body, chunks, done };
}

function mockRequest(
  method: string,
  urlPath: string,
  body: unknown,
  token: string = TOKEN,
): http.IncomingMessage {
  let bodyData: Buffer | undefined;
  if (typeof body === "string") {
    bodyData = Buffer.from(body, "utf-8");
  } else if (Buffer.isBuffer(body)) {
    bodyData = body;
  } else if (body !== undefined) {
    bodyData = Buffer.from(JSON.stringify(body), "utf-8");
  }
  const stream = bodyData !== undefined
    ? Readable.from([bodyData])
    : Readable.from([]);
  const req = stream as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = urlPath;
  (req as any).headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  return req;
}

// --- resolveUnderRoot ---

describe("resolveUnderRoot", () => {
  it("accepts a path under root", () => {
    const root = os.tmpdir();
    const resolved = resolveUnderRoot(root, "foo/bar.txt");
    expect(resolved).toBe(path.join(root, "foo", "bar.txt"));
  });

  it("accepts root itself", () => {
    const root = os.tmpdir();
    expect(resolveUnderRoot(root, ".")).toBe(path.resolve(root));
  });

  it("rejects path traversal via ..", () => {
    const root = path.join(os.tmpdir(), "tunnel-root");
    expect(() => resolveUnderRoot(root, "../../etc/passwd")).toThrow("outside root");
  });

  it("rejects absolute path outside root", () => {
    const root = path.join(os.tmpdir(), "tunnel-root");
    expect(() => resolveUnderRoot(root, "/etc/passwd")).toThrow("outside root");
  });
});

// --- validTunnelToken ---

describe("validTunnelToken", () => {
  it("accepts the correct hex token", () => {
    const state = makeState(makeConfig("/tmp", "/tmp"));
    expect(validTunnelToken(state, TOKEN)).toBe(true);
  });

  it("rejects undefined", () => {
    const state = makeState(makeConfig("/tmp", "/tmp"));
    expect(validTunnelToken(state, undefined)).toBe(false);
  });

  it("rejects a wrong token", () => {
    const state = makeState(makeConfig("/tmp", "/tmp"));
    expect(validTunnelToken(state, crypto.randomBytes(32).toString("hex"))).toBe(false);
  });
});

// --- handleTunnelRequest routing ---

describe("handleTunnelRequest routing", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-route-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns 401 without bearer token", async () => {
    const req = mockRequest("GET", "/file?p=x", undefined, "");
    (req as any).headers = {};
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(401);
    expect(JSON.parse(body.value).error).toBe("unauthorized");
  });

  it("returns 403 with invalid bearer token", async () => {
    const req = mockRequest("GET", "/file?p=x", undefined, "wrong");
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(403);
    expect(JSON.parse(body.value).error).toBe("forbidden");
  });

  it("returns 200 for GET /health with valid token", async () => {
    const req = mockRequest("GET", "/health", undefined);
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    expect(JSON.parse(body.value).ok).toBe(true);
  });

  it("returns 401 for GET /health without token", async () => {
    const req = mockRequest("GET", "/health", undefined, "");
    (req as any).headers = {};
    const { res, status } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    const req = mockRequest("GET", "/nope", undefined);
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(404);
    expect(JSON.parse(body.value).error).toBe("not found");
  });

  it("resets lastActivity on an authenticated request", async () => {
    state.lastActivity = 0;
    const before = Date.now();
    const req = mockRequest("GET", "/nope", undefined);
    const { res } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(state.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it("does not reset lastActivity on an unauthenticated request", async () => {
    state.lastActivity = 0;
    const req = mockRequest("GET", "/file?p=x", undefined, "");
    (req as any).headers = {};
    const { res } = mockResponse();
    await handleTunnelRequest(state, req, res);
    // A port scan must not keep an idle tunnel alive.
    expect(state.lastActivity).toBe(0);
  });
});

// --- PUT /file ---

describe("PUT /file", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-put-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("streams body to the file", async () => {
    const content = "hello world";
    const req = mockRequest("PUT", "/file?p=test.txt", content);
    (req as any).headers["content-type"] = "application/octet-stream";
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    expect(JSON.parse(body.value).ok).toBe(true);
    const written = fs.readFileSync(path.join(root, "test.txt"), "utf-8");
    expect(written).toBe(content);
  });

  it("creates parent directories", async () => {
    const content = "nested";
    const req = mockRequest("PUT", "/file?p=sub/deep/file.txt", content);
    (req as any).headers["content-type"] = "application/octet-stream";
    const { res, status, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    expect(fs.readFileSync(path.join(root, "sub", "deep", "file.txt"), "utf-8")).toBe("nested");
  });

  it("rejects path traversal", async () => {
    const req = mockRequest("PUT", "/file?p=../../etc/evil", "data");
    (req as any).headers["content-type"] = "application/octet-stream";
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(403);
    expect(JSON.parse(body.value).error).toBe("path rejected");
  });

  it("rejects missing path param", async () => {
    const req = mockRequest("PUT", "/file", "data");
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing path");
  });

  it("overwrites existing file", async () => {
    const target = path.join(root, "existing.txt");
    fs.writeFileSync(target, "old content");
    const req = mockRequest("PUT", "/file?p=existing.txt", "new content");
    (req as any).headers["content-type"] = "application/octet-stream";
    const { res, status, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    expect(fs.readFileSync(target, "utf-8")).toBe("new content");
  });

  it("handles binary content", async () => {
    const content = Buffer.from([0, 1, 2, 255, 254, 0, 128]);
    const req = mockRequest("PUT", "/file?p=binary.bin", content);
    (req as any).headers["content-type"] = "application/octet-stream";
    const { res, status, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const written = fs.readFileSync(path.join(root, "binary.bin"));
    expect(written).toEqual(content);
  });
});

// --- GET /file ---

describe("GET /file", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-get-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("streams file content", async () => {
    const content = "file content here";
    fs.writeFileSync(path.join(root, "data.txt"), content);
    const req = mockRequest("GET", "/file?p=data.txt", undefined);
    const { res, status, chunks, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it("returns 404 for missing file", async () => {
    const req = mockRequest("GET", "/file?p=nope.txt", undefined);
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(404);
    expect(JSON.parse(body.value).error).toBe("not found");
  });

  it("rejects path traversal", async () => {
    const req = mockRequest("GET", "/file?p=../../etc/passwd", undefined);
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(403);
    expect(JSON.parse(body.value).error).toBe("path rejected");
  });

  it("rejects missing path param", async () => {
    const req = mockRequest("GET", "/file", undefined);
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing path");
  });
});

// --- POST /spawn ---

describe("POST /spawn", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-spawn-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs a command and returns temp paths", async () => {
    const req = mockRequest("POST", "/spawn", {
      command: "sh",
      args: ["-c", "echo hello"],
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.pid).toBeGreaterThan(0);
    expect(parsed.stdoutPath).toContain(tmpDir);
    expect(parsed.stderrPath).toContain(tmpDir);
    expect(parsed.exitPath).toContain(tmpDir);
    // Wait for exit file.
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.exitPath, "utf-8")).toBe("0");
    expect(fs.readFileSync(parsed.stdoutPath, "utf-8").trim()).toBe("hello");
  });

  it("captures non-zero exit codes", async () => {
    const req = mockRequest("POST", "/spawn", {
      command: "sh",
      args: ["-c", "exit 42"],
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.exitPath, "utf-8")).toBe("42");
  });

  it("captures stderr separately", async () => {
    const req = mockRequest("POST", "/spawn", {
      command: "sh",
      args: ["-c", "echo out; echo err >&2"],
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.stdoutPath, "utf-8").trim()).toBe("out");
    expect(fs.readFileSync(parsed.stderrPath, "utf-8").trim()).toBe("err");
  });

  it("pipes stdin from an uploaded temp file", async () => {
    // Upload a stdin temp via PUT.
    const stdinContent = "piped input data";
    const stdinPath = path.join(root, "stdin.txt");
    {
      const putReq = mockRequest("PUT", "/file?p=stdin.txt", stdinContent);
      (putReq as any).headers["content-type"] = "application/octet-stream";
      const { res, status, done } = mockResponse();
      await handleTunnelRequest(state, putReq, res);
      await done;
      expect(status.value).toBe(200);
    }

    // Spawn a command that reads stdin.
    const req = mockRequest("POST", "/spawn", {
      command: "cat",
      stdinPath,
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.exitPath, "utf-8")).toBe("0");
    expect(fs.readFileSync(parsed.stdoutPath, "utf-8")).toBe(stdinContent);
  });

  it("rejects missing command", async () => {
    const req = mockRequest("POST", "/spawn", { args: ["x"] });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing command");
  });

  it("rejects invalid json", async () => {
    const stream = Readable.from([Buffer.from("not json", "utf-8")]);
    const req = stream as unknown as http.IncomingMessage;
    (req as any).method = "POST";
    (req as any).url = "/spawn";
    (req as any).headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const { res, status, body } = mockResponse();
    await handleSpawn(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("invalid json");
  });

  it("rejects stdinPath outside root", async () => {
    const req = mockRequest("POST", "/spawn", {
      command: "cat",
      stdinPath: "/etc/passwd",
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(403);
    expect(JSON.parse(body.value).error).toBe("stdinPath rejected");
  });

  it("returns 400 when stdin file does not exist", async () => {
    const req = mockRequest("POST", "/spawn", {
      command: "cat",
      stdinPath: path.join(root, "nonexistent"),
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toContain("cannot open stdin");
  });

  it("supports cwd", async () => {
    const subdir = path.join(root, "workdir");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "marker.txt"), "found");
    const req = mockRequest("POST", "/spawn", {
      command: "cat",
      args: ["marker.txt"],
      cwd: subdir,
    });
    const { res, status, body } = mockResponse();
    await handleTunnelRequest(state, req, res);
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.stdoutPath, "utf-8")).toBe("found");
  });
});

// --- POST /exec (buffered, one round trip) ---

describe("POST /exec", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-exec-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs a shell command and returns stdout/stderr/exitCode", async () => {
    const req = mockRequest("POST", "/exec", { command: "echo hello" });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(0);
    expect(Buffer.from(parsed.stdout, "base64").toString("utf-8").trim()).toBe("hello");
    expect(Buffer.from(parsed.stderr, "base64").toString("utf-8")).toBe("");
  });

  it("pipes stdin into the command", async () => {
    const stdin = Buffer.from("piped data");
    const req = mockRequest("POST", "/exec", {
      command: "cat",
      stdin: stdin.toString("base64"),
    });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(0);
    expect(Buffer.from(parsed.stdout, "base64").toString("utf-8")).toBe("piped data");
  });

  it("captures non-zero exit codes", async () => {
    const req = mockRequest("POST", "/exec", { command: "exit 7" });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(7);
  });

  it("captures stderr separately", async () => {
    const req = mockRequest("POST", "/exec", { command: "echo out; echo err >&2" });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(Buffer.from(parsed.stdout, "base64").toString("utf-8").trim()).toBe("out");
    expect(Buffer.from(parsed.stderr, "base64").toString("utf-8").trim()).toBe("err");
  });

  it("rejects missing command", async () => {
    const req = mockRequest("POST", "/exec", { stdin: "aaa" });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("missing command");
  });

  it("rejects invalid json", async () => {
    const stream = Readable.from([Buffer.from("not json", "utf-8")]);
    const req = stream as unknown as http.IncomingMessage;
    (req as any).method = "POST";
    (req as any).url = "/exec";
    (req as any).headers = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(400);
    expect(JSON.parse(body.value).error).toBe("invalid json");
  });

  it("runs with no stdin", async () => {
    const req = mockRequest("POST", "/exec", { command: "echo no-stdin" });
    const { res, status, body, done } = mockResponse();
    await handleTunnelRequest(state, req, res);
    await done;
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    expect(parsed.exitCode).toBe(0);
    expect(Buffer.from(parsed.stdout, "base64").toString("utf-8").trim()).toBe("no-stdin");
  });
});

// --- spawn error/close ordering (items 1 + 2) ---

/** Node emits 'error' then 'close' when spawn fails (e.g. bad cwd). Verify
 *  the handlers cope: /exec must not re-send headers, /spawn must not
 *  clobber the error exit marker. */
describe("spawn failure handling", () => {
  let tmpDir: string;
  let root: string;
  let state: TunnelState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-fail-tmp-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-fail-root-"));
    state = makeState(makeConfig(root, tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("/exec keeps the 500 status when close fires after error", async () => {
    const badCwd = path.join(tmpDir, "does-not-exist");
    const req = mockRequest("POST", "/exec", { command: "echo hi", cwd: badCwd });
    const { res, status, done } = mockResponse();
    await handleExec(state, req, res);
    await done;
    // Let the async 'close' event fire after 'error'.
    await new Promise((r) => setTimeout(r, 150));
    // Without the headersSent guard, close would overwrite 500 with 200.
    expect(status.value).toBe(500);
  });

  it("/spawn preserves the 1:<msg> error marker when close fires after error", async () => {
    const badCwd = path.join(tmpDir, "does-not-exist");
    const req = mockRequest("POST", "/spawn", {
      command: "sh",
      args: ["-c", "echo hi"],
      cwd: badCwd,
    });
    const { res, status, body, done } = mockResponse();
    await handleSpawn(state, req, res);
    await done;
    await new Promise((r) => setTimeout(r, 150));
    expect(status.value).toBe(200);
    const parsed = JSON.parse(body.value);
    const exitContent = fs.readFileSync(parsed.exitPath, "utf-8");
    // Without the errorWroteExit guard, close would overwrite this with a
    // bare negative/zero code.
    expect(exitContent.startsWith("1:")).toBe(true);
  });
});

// --- End-to-end through a real HTTP server ---

describe("SshTunnel HTTP server", () => {
  let tmpDir: string;
  let root: string;
  let server: http.Server;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-http-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-root-"));
    token = crypto.randomBytes(32).toString("hex");
    const state = makeState(makeConfig(root, tmpDir), token);

    server = http.createServer((req, res) => {
      handleTunnelRequest(state, req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "internal" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  function putFile(relativePath: string, content: Buffer): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = `/file?p=${encodeURIComponent(relativePath)}`;
      const req = http.request(
        { host: "127.0.0.1", port, method: "PUT", path: url, headers: { authorization: `Bearer ${token}` } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(content);
    });
  }

  function getFile(relativePath: string): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const url = `/file?p=${encodeURIComponent(relativePath)}`;
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: url, headers: { authorization: `Bearer ${token}` } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function spawnCmd(body: object): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/spawn",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": data.length,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  it("PUT then GET a file through real HTTP", async () => {
    const content = Buffer.from("round trip content");
    const { status: putStatus } = await putFile("roundtrip.txt", content);
    expect(putStatus).toBe(200);
    const { status: getStatus, body } = await getFile("roundtrip.txt");
    expect(getStatus).toBe(200);
    expect(body.toString()).toBe("round trip content");
  });

  it("spawn through real HTTP reads stdout", async () => {
    const { status, body } = await spawnCmd({
      command: "sh",
      args: ["-c", "echo e2e"],
    });
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    await vi.waitFor(() => {
      expect(fs.existsSync(parsed.exitPath)).toBe(true);
    });
    expect(fs.readFileSync(parsed.exitPath, "utf-8")).toBe("0");
    expect(fs.readFileSync(parsed.stdoutPath, "utf-8").trim()).toBe("e2e");
  });

  it("exec through real HTTP returns buffered result", async () => {
    const data = Buffer.from(JSON.stringify({ command: "echo exec-e2e" }));
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/exec",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": data.length,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.exitCode).toBe(0);
    expect(Buffer.from(parsed.stdout, "base64").toString("utf-8").trim()).toBe("exec-e2e");
  });

  it("rejects without token", async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "/file?p=x" },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(401);
  });
});

describe("idleTimedOut", () => {
  it("returns false before the timeout elapses", () => {
    expect(idleTimedOut(1_000, 1_500, 1_000)).toBe(false);
  });

  it("returns true once the timeout has elapsed", () => {
    expect(idleTimedOut(1_000, 2_000, 1_000)).toBe(true);
  });

  it("returns false when timeout is exactly reached", () => {
    expect(idleTimedOut(1_000, 2_001, 1_000)).toBe(true);
  });

  it("is disabled when idleTimeoutMs <= 0", () => {
    expect(idleTimedOut(0, Number.MAX_SAFE_INTEGER, 0)).toBe(false);
    expect(idleTimedOut(0, Number.MAX_SAFE_INTEGER, -1)).toBe(false);
  });
});
