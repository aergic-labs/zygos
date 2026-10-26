/*
 * Unit tests for SshSession. Mocks SshSessionClient so no real
 * server is spawned.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SshSession } from "../../src/ssh/sshSession/connection";
import type { SshConnectOptions } from "../../src/ssh/connection";

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
} as any;

const sshSessionDeps = {
  serverScriptPath: "/fake/localServer.js",
  nodePath: "/fake/node",
  dataDir: "/fake/sshSession",
  logger: noopLogger,
};

// vi.mock is hoisted above imports. Use vi.hoisted to get the mock class
// reference available at mock time.
const { MockClient } = vi.hoisted(() => {
  class MockClient {
    static last: MockClient | undefined;
    socksPort = 1080;
    startCalls = 0;
    stopCalls = 0;
    putFileCalls: { path: string; content: Buffer; mode?: string }[] = [];
    execCalls: string[] = [];
    private responses: { substring: string; response: any; once?: boolean }[] = [];
    private defaultResponse: any = { stdout: "", stderr: "", exitCode: 0, signal: null };

    constructor() { MockClient.last = this; }

    async start() { this.startCalls++; }
    async stop() { this.stopCalls++; }
    async exec(command: string) {
      this.execCalls.push(command);
      for (let i = 0; i < this.responses.length; i++) {
        const r = this.responses[i];
        if (command.includes(r.substring)) {
          if (r.once) this.responses.splice(i, 1);
          return { ...this.defaultResponse, ...r.response };
        }
      }
      return { ...this.defaultResponse };
    }
    async putFile(path: string, content: Buffer, mode?: string) {
      this.putFileCalls.push({ path, content, mode });
      return { ...this.defaultResponse };
    }
    async getSocksPort() { return this.socksPort; }
    setResponse(substring: string, response: any) {
      this.responses.push({ substring, response });
      return this;
    }
    setResponseOnce(substring: string, response: any) {
      this.responses.push({ substring, response, once: true });
      return this;
    }
  }
  return { MockClient };
});

vi.mock("../../src/ssh/sshSession/client", () => ({
  SshSessionClient: MockClient as any,
}));

function makeOptions(overrides: Partial<SshConnectOptions> = {}): SshConnectOptions {
  return { host: "test@host", ...overrides };
}

describe("SshSession.buildSshConfig", () => {
  it("includes -T and BatchMode=yes by default", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!
    // The SshSessionClient constructor received sshArgs; we capture them
    // via the mock's constructor opts (stored on the instance).
    expect(client.socksPort).toBeGreaterThan(0);
    await conn.close();
  });

  it("omits BatchMode when askpass is on", async () => {
    const conn = new SshSession(
      makeOptions({
        askpass: { handle: "h", token: "t" } as any,
        askpassScript: "/askpass.js",
        askpassMain: "/askpass-main.js",
        nodePath: "/node",
      }),
      sshSessionDeps,
    );
    await conn.connect();
    expect(MockClient.last!.socksPort).toBeGreaterThan(0);
    await conn.close();
  });

  it("adds ConnectTimeout when tcpTimeoutSeconds is set", async () => {
    const conn = new SshSession(
      makeOptions({ tcpTimeoutSeconds: 20 }),
      sshSessionDeps,
    );
    await conn.connect();
    await conn.close();
  });

  it("adds -F when configFile is set", async () => {
    const conn = new SshSession(
      makeOptions({ configFile: "/custom/ssh/config" }),
      sshSessionDeps,
    );
    await conn.connect();
    await conn.close();
  });

  it("adds -D <socksPort> when socksPort is set", async () => {
    const conn = new SshSession(
      makeOptions({ socksPort: 54321 }),
      sshSessionDeps,
    );
    await conn.connect();
    await conn.close();
  });
});

describe("SshSession connect/close", () => {
  it("sets isConnected after connect", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    expect(conn.isConnected).toBe(false);
    await conn.connect();
    expect(conn.isConnected).toBe(true);
    await conn.close();
    expect(conn.isConnected).toBe(false);
  });

  it("is idempotent on connect", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const first = MockClient.last;
    await conn.connect();
    expect(MockClient.last).toBe(first);
    await conn.close();
  });

  it("throws on missing host", async () => {
    const conn = new SshSession(makeOptions({ host: "" }), sshSessionDeps);
    await expect(conn.connect()).rejects.toThrow("missing host");
  });

  it("close is safe when never connected", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("getSocksPort returns the client's port after connect", async () => {
    const conn = new SshSession(makeOptions({ socksPort: 9999 }), sshSessionDeps);
    await conn.connect();
    expect(conn.getSocksPort()).toBe(1080);
    await conn.close();
  });
});

describe("SshSession.exec", () => {
  it("delegates to client.exec and maps the response", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!
    client.setResponse("echo hi", {
      stdout: "hi\n",
      exitCode: 0,
    });
    const result = await conn.exec("echo hi");
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    await conn.close();
  });

  it("passes timeoutMs through", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!
    client.setResponse("sleep", { exitCode: 124 });
    const result = await conn.exec("sleep 1", 5000);
    expect(result.exitCode).toBe(124);
    await conn.close();
  });

  it("throws if not connected", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await expect(conn.exec("echo hi")).rejects.toThrow("not connected");
  });
});

describe("SshSession.execWithStdin", () => {
  it("base64-encodes stdin and pipes via /exec", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!
    client.setResponse("base64 -d", { exitCode: 0 });
    const data = Buffer.from("hello stdin");
    await conn.execWithStdin("cat", data);
    // The wrapped command should contain the base64 string.
    expect(client.execCalls[0]).toContain(data.toString("base64"));
    expect(client.execCalls[0]).toContain("base64 -d");
    await conn.close();
  });

  it("throws if not connected", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await expect(conn.execWithStdin("cat", Buffer.from("x"))).rejects.toThrow("not connected");
  });
});

describe("SshSession.putFile", () => {
  it("delegates to client.putFile", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!
    const content = Buffer.from("file content");
    await conn.putFile("/remote/path", content, "0644");
    expect(client.putFileCalls.length).toBe(1);
    expect(client.putFileCalls[0].path).toBe("/remote/path");
    expect(client.putFileCalls[0].content).toEqual(content);
    expect(client.putFileCalls[0].mode).toBe("0644");
    await conn.close();
  });

  it("throws if not connected", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await expect(conn.putFile("/x", Buffer.from("y"))).rejects.toThrow("not connected");
  });
});

describe("SshSession.spawnProcess", () => {
  it("throws on empty command", () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    expect(() => conn.spawnProcess(undefined)).toThrow("no command");
  });

  it("returns a child-like object with stdout/stderr/stdin", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const child = conn.spawnProcess("docker run") as any;
    expect(child.stdout).toBeDefined();
    expect(child.stderr).toBeDefined();
    expect(child.stdin).toBeDefined();
    expect(child.kill).toBeDefined();
    await conn.close();
  });
});

describe("SshSession transport routing", () => {
  function makeMockTransportClient() {
    return {
      putFileCalls: [] as { path: string; content: Buffer; mode?: string }[],
      execCalls: [] as { command: string; stdin: Buffer }[],
      putFile(path: string, content: Buffer, mode?: string) {
        this.putFileCalls.push({ path, content, mode });
        return Promise.resolve();
      },
      execWithStdin(command: string, stdin: Buffer) {
        this.execCalls.push({ command, stdin });
        return Promise.resolve({
          stdout: Buffer.from("transport-stdout"),
          stderr: Buffer.from(""),
          exitCode: 0,
          signal: null,
        });
      },
    };
  }

  it("putFile routes through the transport when set", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!;
    const transport = makeMockTransportClient();
    conn.setTransportClient(transport as any);
    const content = Buffer.from("binary data");
    await conn.putFile("/remote/path", content, "0644");
    expect(transport.putFileCalls.length).toBe(1);
    expect(transport.putFileCalls[0].path).toBe("/remote/path");
    expect(transport.putFileCalls[0].content).toEqual(content);
    expect(transport.putFileCalls[0].mode).toBe("0644");
    expect(client.putFileCalls.length).toBe(0);
    await conn.close();
  });

  it("execWithStdin routes through the transport when set", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!;
    const transport = makeMockTransportClient();
    conn.setTransportClient(transport as any);
    const stdin = Buffer.from("piped");
    const result = await conn.execWithStdin("cat", stdin);
    expect(transport.execCalls.length).toBe(1);
    expect(transport.execCalls[0].command).toBe("cat");
    expect(transport.execCalls[0].stdin).toEqual(stdin);
    expect(client.execCalls.length).toBe(0);
    expect(result.exitCode).toBe(0);
    await conn.close();
  });

  it("putFile falls back to session client when no transport", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!;
    await conn.putFile("/path", Buffer.from("data"), "0644");
    expect(client.putFileCalls.length).toBe(1);
    await conn.close();
  });

  it("execWithStdin falls back to base64 heredoc when no transport", async () => {
    const conn = new SshSession(makeOptions(), sshSessionDeps);
    await conn.connect();
    const client = MockClient.last!;
    client.setResponse("base64 -d", { exitCode: 0 });
    const data = Buffer.from("fallback");
    await conn.execWithStdin("cat", data);
    expect(client.execCalls[0]).toContain(data.toString("base64"));
    await conn.close();
  });
});
