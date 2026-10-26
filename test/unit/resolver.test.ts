/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as path from "node:path";

// Mock the platform module so detectPlatform/getProductInfo don't need
// build-time globals or a real product.json.
const mockAdapter = {
  serverApplicationName: "code-server-oss",
  serverDataFolderName: ".zygos-server",
  getServerDownloadUrl: () => "https://example.com/server",
  readAuthFiles: undefined,
};
const mockProductInfo = {
  commit: "abc123",
  quality: "stable",
  version: "0.0.1",
  release: "0.0.1",
  serverApplicationName: "code-server-oss",
  serverDataFolderName: ".zygos-server",
  serverDownloadUrlTemplate: undefined,
};

vi.mock("../../src/platform", () => ({
  detectPlatform: () => mockAdapter,
  getProductInfo: () => mockProductInfo,
  readProductJson: () => ({}),
}));

// Mutable flag for the session-secret mock. Tests flip it to exercise the
// session (shared-transport) path; default false preserves the legacy
// non-session behavior for the existing tests.
let sessionSecretReady = false;
vi.mock("../../src/ssh/sshSessionSecret", () => ({
  sshSessionSecretReady: () => sessionSecretReady,
  initSshSessionSecret: async () => {},
  deriveSshSessionToken: () => Buffer.alloc(32),
  disposeSshSessionSecret: () => {},
}));

// Mutable probe result for the transport probe. Tests flip it to exercise
// the reuse vs re-ship branches in startTransport (session path). Default
// false keeps the existing re-ship behavior intact.
export const probeTransportAliveMock = vi.fn<
  (socksPort: number, port: number, token: string, timeoutMs?: number) => Promise<boolean>
>();
vi.mock("../../src/transport/client", () => ({
  // TransportClient is only used as a type annotation in the resolver;
  // a bare class stub is enough at runtime.
  TransportClient: class {},
  probeTransportAlive: (
    socksPort: number,
    port: number,
    token: string,
    timeoutMs?: number,
  ) => probeTransportAliveMock(socksPort, port, token, timeoutMs),
}));

// Stub ZygosTransport so the resolver can "start" the Go transport without a
// real server. Methods resolve to safe values that steer the resolve flow
// down the reuse-existing-server branch (no startServerSession, no
// finalizeServerStart with transport).
//
// `exec` is a spy so tests can assert that session-path bookkeeping execs
// (the nohup wrapper, the cat ready-file poll, bbExec-driven reads) ride
// the transport instead of the ssh-session control shell.
export const transportExecMock = vi.fn<
  (cmd: string, args: string[]) => Promise<{
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
    signal: string | null;
  }>
>();
// ServerStatus result for the lock-and-probe step. Tests flip reusePort to
// 0 to force the fresh-start path (which runs startServerSession and thus
// waitForFile). Default keeps the existing reuse-branch behavior intact.
export const transportServerStatusMock = vi.fn<
  () => Promise<{ reusePort: number; pid: number; alive: boolean }>
>();
// waitForFile mock for the startServerSession ready-file wait. Default
// returns a Buffer with a valid port so the fresh-start path completes.
export const transportWaitForFileMock = vi.fn<
  (path: string, timeoutMs: number) => Promise<Buffer>
>();
vi.mock("../../src/transport/zygos", () => {
  class ZygosTransportStub {
    static instances: ZygosTransportStub[] = [];
    constructor(public opts: unknown) {
      (ZygosTransportStub.instances as any).push(this);
    }
    async lock() {
      return { acquired: true };
    }
    async unlock() {}
    async serverStatus() {
      return transportServerStatusMock();
    }
    async serverCleanup() {
      return { killedPid: 0, strays: [] };
    }
    async serverFinalize() {
      return { pid: 0 };
    }
    async rm() {}
    async mkdir() {}
    async rename() {}
    async kill() {}
    async putFile() {}
    async exec(cmd: string, args: string[]) {
      return transportExecMock(cmd, args);
    }
    async execWithStdin() {
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    }
    async waitForFile(path: string, timeoutMs: number) {
      return transportWaitForFileMock(path, timeoutMs);
    }
    async health() {}
    dispose() {}
  }
  return { ZygosTransport: ZygosTransportStub };
});

// Fake SOCKS5 connect: returns a net.Socket (unconnected) so waitForRemotePort
// and makeConnection don't try to talk to a real proxy. Existing tests don't
// rely on real SOCKS behavior. Per-test overrides: set `socks5ConnectMock`
// to a custom impl to simulate connect failures (e.g. for verifyServerPort
// unreachable-port assertions).
export const socks5ConnectMock = vi.fn<
  (host: string, socksPort: number, targetHost: string, targetPort: number, timeoutMs?: number) => Promise<net.Socket>
>();
socks5ConnectMock.mockImplementation(async () => new net.Socket());
vi.mock("../../src/net/socks5", () => ({
  socks5Connect: (
    host: string,
    socksPort: number,
    targetHost: string,
    targetPort: number,
    timeoutMs?: number,
  ) => socks5ConnectMock(host, socksPort, targetHost, targetPort, timeoutMs),
}));

import {
  SshRemoteResolver,
  type ConnectionFactory,
  generateToken,
  findFreePort,
  waitForPort,
  collectProxyEnv,
  registerLabelFormatter,
  registerResolver,
} from "../../src/resolver/index";
import { encodeAuthority } from "../../src/ssh/destination";
import { ZygosTransport } from "../../src/transport/zygos";
import {
  MockSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/mockSshConnection";
import {
  setConfig,
  resetConfig,
  resetStatusBarItems,
  registeredLabelFormatters,
  registeredResolvers,
  createdStatusBarItems as statusBarItemsRef,
} from "../__mocks__/vscode";

// --- Helpers ---

/** Build an ssh-remote authority for a destination string. */
function authority(dest: string): string {
  return "ssh-remote+" + encodeAuthority({ host: dest });
}

/** Create a resolver with a MockSshConnection factory. */
function makeResolver(fake: MockSshConnection): SshRemoteResolver {
  const factory: ConnectionFactory = () => fake as any;
  return new SshRemoteResolver(noopLogger as any, "/ext/path", factory);
}

/** Configure a MockSshConnection with responses for the full resolve() flow. */
function configureForResolve(fake: MockSshConnection, listenPort = 9876): void {
  // probeRemote: home, arch, busybox, installed (nonce-marker format)
  fake.setProbeResponse("/home/testuser", "x86_64", "yes", "yes");
  fake.setResponse("echo ok", ok("ok"));
  fake.setResponse("umask", ok());
  fake.setSpawnStdout(`Extension host agent listening on ${listenPort}\n`);
}

/** sshSessionDeps pointing at the real wrapper script (scripts/sshSession/start-server.sh). */
const SESSION_DEPS = {
  serverScriptPath: path.join(__dirname, "..", "..", "dist", "localServer.js"),
  wrapperScriptPath: path.join(
    __dirname,
    "..",
    "..",
    "scripts",
    "sshSession",
    "start-server.sh",
  ),
  nodePath: process.execPath,
  dataDir: path.join(__dirname, "..", "..", ".tmp-session-data"),
};

/** Configure a MockSshConnection for the session (shared-transport) resolve path.
 *  Probe says installed=yes (skip download); a tunnel-meta.json response
 *  makes startTransport succeed; a conn-token response feeds the reuse
 *  branch. The meta file is read in one round-trip by probeExistingTransport
 *  (port+pid+token in one cat) and again by the startTransport poll loop. */
function configureForSession(fake: MockSshConnection): void {
  fake.setProbeResponse("/home/testuser", "x86_64", "yes", "yes");
  fake.setResponse(
    "tunnel-meta.json",
    ok(JSON.stringify({ port: 4242, pid: 0, token: "a".repeat(64) })),
  );
  fake.setResponse("conn-token", ok("a".repeat(32) + "\n"));
}

/** Make a resolver with a MockSshConnection factory and sshSessionDeps. */
function makeSessionResolver(fake: MockSshConnection): SshRemoteResolver {
  const factory: ConnectionFactory = () => fake as any;
  return new SshRemoteResolver(
    noopLogger as any,
    path.join(__dirname, "..", ".."),
    factory,
    undefined,
    SESSION_DEPS as any,
  );
}

// --- Tests ---

describe("generateToken", () => {
  it("returns a 32-char hex string", () => {
    const t = generateToken();
    expect(t).toHaveLength(32);
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns different values on each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe("findFreePort", () => {
  it("returns a usable port number", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("the returned port is initially free (can be bound)", async () => {
    const port = await findFreePort();
    const srv: net.Server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.listen(port, "127.0.0.1", resolve);
      srv.on("error", reject);
    });
    srv.close();
  });
});

describe("waitForPort", () => {
  it("resolves when a server starts listening on the port", async () => {
    const port = await findFreePort();
    const srv = net.createServer();
    await new Promise<void>((resolve) =>
      srv.listen(port, "127.0.0.1", resolve),
    );

    await expect(waitForPort(port, 2000)).resolves.toBeUndefined();
    srv.close();
  });

  it("rejects after timeout if nothing listens", async () => {
    // Use a port that's almost certainly not listening.
    const port = 59999;
    await expect(waitForPort(port, 300)).rejects.toThrow(/not ready/);
  });
});

describe("collectProxyEnv", () => {
  beforeEach(() => resetConfig());

  it("returns empty object when no proxy settings", () => {
    expect(collectProxyEnv()).toEqual({});
  });

  it("includes http_proxy when set", () => {
    setConfig("zygos.httpProxy", "http://proxy:8080");
    expect(collectProxyEnv()).toEqual({ http_proxy: "http://proxy:8080" });
  });

  it("includes https_proxy when set", () => {
    setConfig("zygos.httpsProxy", "http://proxy:8443");
    expect(collectProxyEnv()).toEqual({ https_proxy: "http://proxy:8443" });
  });

  it("includes both when set", () => {
    setConfig("zygos.httpProxy", "http://p1:8080");
    setConfig("zygos.httpsProxy", "http://p2:8443");
    expect(collectProxyEnv()).toEqual({
      http_proxy: "http://p1:8080",
      https_proxy: "http://p2:8443",
    });
  });

  it("trims whitespace and ignores empty strings", () => {
    setConfig("zygos.httpProxy", "  ");
    setConfig("zygos.httpsProxy", " http://p:8443 ");
    expect(collectProxyEnv()).toEqual({ https_proxy: "http://p:8443" });
  });
});

describe("registerLabelFormatter", () => {
  beforeEach(() => {
    registeredLabelFormatters.length = 0;
  });

  it("registers a formatter with the authority and host label", () => {
    registerLabelFormatter("ssh-remote+abcd1234", "user@host");
    expect(registeredLabelFormatters).toHaveLength(1);
    const fmt = registeredLabelFormatters[0] as any;
    expect(fmt.scheme).toBe("vscode-remote");
    expect(fmt.authority).toBe("ssh-remote+abcd1234");
    expect(fmt.formatting.workspaceSuffix).toBe("SSH: user@host");
  });
});

// --- resolve() error paths ---

describe("SshRemoteResolver.resolve - error paths", () => {
  let resolver: SshRemoteResolver;

  beforeEach(() => {
    resetConfig();
    resetStatusBarItems();
    resolver = makeResolver(new MockSshConnection());
  });

  it("throws for an authority without +", async () => {
    await expect(
      resolver.resolve("invalid", { resolveAttempt: 1 }),
    ).rejects.toThrow("Not an ssh-remote authority");
  });

  it("throws for an authority with empty payload", async () => {
    await expect(
      resolver.resolve("ssh-remote+", { resolveAttempt: 1 }),
    ).rejects.toThrow();
  });
});

// --- resolveExecServer() error paths ---

describe("SshRemoteResolver.resolveExecServer - error paths", () => {
  let resolver: SshRemoteResolver;

  beforeEach(() => {
    resetConfig();
    resolver = makeResolver(new MockSshConnection());
  });

  it("throws for an authority without +", async () => {
    await expect(
      resolver.resolveExecServer("invalid", { resolveAttempt: 1 }),
    ).rejects.toThrow("Not an ssh-remote authority");
  });
});

// --- resolveExecServer() happy path ---

describe("SshRemoteResolver.resolveExecServer - happy path", () => {
  let resolver: SshRemoteResolver;
  let fake: MockSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new MockSshConnection();
    resolver = makeResolver(fake);
  });

  afterEach(() => {
    fake.stopSocksListeners();
    resolver.dispose();
  });

  it("returns an exec server object and stores the connection", async () => {
    const auth = authority("10.0.0.42");
    const result = await resolver.resolveExecServer(auth, {
      resolveAttempt: 1,
    });
    expect(result).toBeDefined();
    // The connection should be stored under authority:execServer.
    const connections = (resolver as any).connections as Map<string, unknown>;
    expect(connections.has(`${auth}:execServer`)).toBe(true);
  });

  it("creates a SOCKS forward that listens on a real port", async () => {
    await resolver.resolveExecServer(authority("host1"), {
      resolveAttempt: 1,
    });
    // The fake opened a real TCP listener for -D.
    expect(fake.socksServers.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps -N on the exec-server forward (no agent role)", async () => {
    await resolver.resolveExecServer(authority("host2"), {
      resolveAttempt: 1,
    });
    const fwd = fake.spawns.find((s) => s.args.includes("-D"))!;
    expect(fwd.command).toBeUndefined();
    expect(fwd.args).toContain("-N");
  });
});

// --- resolve() happy path ---

describe("SshRemoteResolver.resolve - happy path", () => {
  let resolver: SshRemoteResolver;
  let fake: MockSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new MockSshConnection();
    configureForResolve(fake);
    resolver = makeResolver(fake);
  });

  afterEach(() => {
    fake.stopSocksListeners();
    resolver.dispose();
  });

  it("resolves and returns makeConnection + connectionToken", async () => {
    const auth = authority("10.0.0.99");
    const result = await resolver.resolve(auth, { resolveAttempt: 1 });
    expect(result.makeConnection).toBeTypeOf("function");
    expect(result.connectionToken).toBeTypeOf("string");
    expect(result.connectionToken).toHaveLength(32);
  });

  it("stores the connection for cleanup on reconnect", async () => {
    const auth = authority("10.0.0.100");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    const connections = (resolver as any).connections as Map<string, unknown>;
    expect(connections.has(auth)).toBe(true);
  });

  it("creates a status bar item and disposes it after resolve", async () => {
    const auth = authority("10.0.0.101");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    // At least one status bar item was created and disposed.
    expect(statusBarItemsRef.length).toBeGreaterThanOrEqual(1);
    const last = statusBarItemsRef[statusBarItemsRef.length - 1];
    expect(last.disposed).toBe(true);
  });

  it("runs the agent command on the forward instead of -N", async () => {
    await resolver.resolve(authority("10.0.0.103"), { resolveAttempt: 1 });
    const fwd = fake.spawns.find((s) => s.args.includes("-D"))!;
    expect(fwd.command).toMatch(/ZYAGENT-[0-9a-f]+/);
    expect(fwd.args).not.toContain("-N");
  });

  it("sets extensionHostEnv SSH_AUTH_SOCK to the window's link", async () => {
    const result = await resolver.resolve(authority("10.0.0.104"), {
      resolveAttempt: 1,
    });
    expect(result.extensionHostEnv?.SSH_AUTH_SOCK).toMatch(
      /^\/home\/testuser\/\.ssh-remote\/agent-[0-9a-f]{16}$/,
    );
  });

  it("does not set extensionHostEnv without a forwarded agent", async () => {
    fake.setAgentReport("");
    const result = await resolver.resolve(authority("10.0.0.105"), {
      resolveAttempt: 1,
    });
    expect(result.extensionHostEnv).toBeUndefined();
  });

  it("keeps the same link across re-resolves and reuses", async () => {
    const auth = authority("10.0.0.106");
    const first = await resolver.resolve(auth, { resolveAttempt: 1 });
    // Reuse path (connection still healthy).
    const reused = await resolver.resolve(auth, { resolveAttempt: 1 });
    expect(reused.extensionHostEnv).toEqual(first.extensionHostEnv);
    // Fresh resolve after the connection dies.
    const connections = (resolver as any).connections as Map<string, any>;
    connections.get(auth)!.dead = true;
    const again = await resolver.resolve(auth, { resolveAttempt: 2 });
    expect(again.extensionHostEnv).toEqual(first.extensionHostEnv);
  });

  it("persists the link id in workspaceState", async () => {
    const store = new Map<string, unknown>();
    const memento = {
      get: (k: string) => store.get(k),
      update: async (k: string, v: unknown) => void store.set(k, v),
    };
    const auth = authority("10.0.0.107");
    const r1 = new SshRemoteResolver(
      noopLogger as any,
      "/ext/path",
      () => fake as any,
      memento as any,
    );
    const first = await r1.resolve(auth, { resolveAttempt: 1 });
    r1.dispose();
    fake.stopSocksListeners();

    // A new resolver (window reload) reads the same id.
    const r2 = new SshRemoteResolver(
      noopLogger as any,
      "/ext/path",
      () => fake as any,
      memento as any,
    );
    const second = await r2.resolve(auth, { resolveAttempt: 1 });
    r2.dispose();
    expect(second.extensionHostEnv).toEqual(first.extensionHostEnv);
  });

  it("makeConnection throws when connection is dead", async () => {
    const auth = authority("10.0.0.102");
    const result = await resolver.resolve(auth, { resolveAttempt: 1 });
    // Mark the connection dead.
    const connections = (resolver as any).connections as Map<string, any>;
    connections.get(auth)!.dead = true;
    await expect(result.makeConnection()).rejects.toThrow("dead");
  });
});

// --- dispose() ---

describe("SshRemoteResolver.dispose", () => {
  let resolver: SshRemoteResolver;
  let fake: MockSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new MockSshConnection();
    configureForResolve(fake, 5555);
    resolver = makeResolver(fake);
  });

  afterEach(() => {
    fake.stopSocksListeners();
  });

  it("clears the connections map", async () => {
    const auth = authority("dispose-test");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    const connections = (resolver as any).connections as Map<string, unknown>;
    expect(connections.size).toBe(1);
    resolver.dispose();
    expect(connections.size).toBe(0);
  });

  it("is safe to call with no active connections", () => {
    expect(() => resolver.dispose()).not.toThrow();
  });

  it("handles multiple connections", async () => {
    await resolver.resolve(authority("h1"), { resolveAttempt: 1 });
    // Need a fresh fake for the second resolve (different SOCKS port).
    const fake2 = new MockSshConnection();
    configureForResolve(fake2, 7777);
    // Replace the factory to use fake2.
    (resolver as any).connectionFactory = () => fake2 as any;
    await resolver.resolve(authority("h2"), { resolveAttempt: 1 });

    const connections = (resolver as any).connections as Map<string, unknown>;
    expect(connections.size).toBe(2);
    resolver.dispose();
    expect(connections.size).toBe(0);
    fake2.stopSocksListeners();
  });
});

// --- Shared transport (session path) ---

describe("SshRemoteResolver shared transport (session path)", () => {
  let resolver: SshRemoteResolver;
  let fake: MockSshConnection;
  let factoryCalls: number;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    setConfig("zygos.usePersistentConnection", true);
    sessionSecretReady = true;
    factoryCalls = 0;
    (ZygosTransport as any).instances.length = 0;
    probeTransportAliveMock.mockReset();
    // Default: probe reports dead so the existing tests re-ship the
    // binary as before. The reuse test flips this to true.
    probeTransportAliveMock.mockResolvedValue(false);
    transportExecMock.mockReset();
    // Default: transport exec returns empty stdout, exit 0. Individual
    // tests override this when they assert on routing or specific output.
    transportExecMock.mockResolvedValue({
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      exitCode: 0,
      signal: null,
    });
    transportServerStatusMock.mockReset();
    // Default: lock-and-probe sees a reusable server, so the reuse branch
    // returns early (no startServerSession, no waitForFile). The
    // waitForFile test flips reusePort to 0 to force the fresh-start path.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 9999,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockReset();
    // Default: ready-file wait returns port 9876 (matches setSpawnStdout
    // where applicable). Tests that need to assert on the call override
    // the resolved value.
    transportWaitForFileMock.mockResolvedValue(Buffer.from("9876\n"));
    fake = new MockSshConnection();
    configureForSession(fake);
    const factory: ConnectionFactory = (_dest, opts) => {
      factoryCalls++;
      // Apply the socksPort the resolver picked so the mock opens a listener
      // and getSocksPort() reports it (used by waitForPort in onProbed).
      (fake as any).socksPortFromOpts = opts?.socksPort;
      return fake as any;
    };
    resolver = new SshRemoteResolver(
      noopLogger as any,
      path.join(__dirname, "..", ".."),
      factory,
      undefined,
      SESSION_DEPS as any,
    );
  });

  afterEach(() => {
    resolver.dispose();
    fake.stopSocksListeners();
    sessionSecretReady = false;
  });

  it("resolve() then resolveExecServer() share one transport (refs=2)", async () => {
    const auth = authority("session-share-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    await resolver.resolveExecServer(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const connections = (resolver as any).connections as Map<string, any>;

    expect(transports.size).toBe(1);
    const shared = transports.get(auth);
    expect(shared).toBeDefined();
    expect(shared.refs).toBe(2);
    expect(shared.conn).toBe(fake);
    expect(factoryCalls).toBe(1);
    expect((ZygosTransport as any).instances.length).toBe(1);
    expect(connections.has(auth)).toBe(true);
    expect(connections.has(`${auth}:execServer`)).toBe(true);
  });

  it("resolveExecServer() then resolve() also share one transport", async () => {
    const auth = authority("session-share-rev-host");
    await resolver.resolveExecServer(auth, { resolveAttempt: 1 });
    await resolver.resolve(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    expect(transports.size).toBe(1);
    expect(transports.get(auth).refs).toBe(2);
    expect(factoryCalls).toBe(1);
    expect((ZygosTransport as any).instances.length).toBe(1);
  });

  it("dispose() tears down the shared transport and both flows", async () => {
    const auth = authority("session-dispose-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    await resolver.resolveExecServer(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const connections = (resolver as any).connections as Map<string, any>;
    expect(transports.size).toBe(1);
    expect(connections.size).toBe(2);

    resolver.dispose();
    expect(transports.size).toBe(0);
    expect(connections.size).toBe(0);
  });

  it("re-resolve on a healthy session connection reuses without bumping refs", async () => {
    const auth = authority("session-reresolve-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const sharedBefore = transports.get(auth);
    const refsBefore = sharedBefore.refs;
    const connsBefore = (resolver as any).connections.size;

    // Second resolve() on the same healthy authority: reuse early-return,
    // no new ref, no new flow, no new ssh connection.
    await resolver.resolve(auth, { resolveAttempt: 1 });

    expect(transports.size).toBe(1);
    expect(transports.get(auth)).toBe(sharedBefore);
    expect(transports.get(auth).refs).toBe(refsBefore);
    expect((resolver as any).connections.size).toBe(connsBefore);
    expect(factoryCalls).toBe(1);
    expect((ZygosTransport as any).instances.length).toBe(1);
  });

  it("reuses an existing live go transport (probe alive) - no binary ship", async () => {
    // tunnel-meta.json present + probe alive: startTransport must reuse the
    // existing port + token and skip the binary ship entirely.
    const tokenHex = "b".repeat(64);
    fake.setResponse(
      "tunnel-meta.json",
      ok(JSON.stringify({ port: 4242, pid: 1234, token: tokenHex })),
    );
    probeTransportAliveMock.mockResolvedValue(true);

    const auth = authority("session-probe-reuse-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const shared = transports.get(auth);
    expect(shared).toBeDefined();
    // Reused port + token from the existing tunnel-meta.json.
    expect(shared.transportPort).toBe(4242);
    expect(shared.transportToken).toBe(tokenHex);
    // No binary ship: putFile never called for zygos-tunnel-x64.new.
    const binShip = fake.putFileCalls.find((c) =>
      c.path.includes("zygos-tunnel-x64.new"),
    );
    expect(binShip).toBeUndefined();
    // The probe actually ran.
    expect(probeTransportAliveMock).toHaveBeenCalled();
    const [socksPort, port, token] = probeTransportAliveMock.mock.calls[0];
    expect(socksPort).toBe(shared.socksPort);
    expect(port).toBe(4242);
    expect(token).toBe(tokenHex);
  });

  it("re-ships the binary when the probe reports the transport dead", async () => {
    // tunnel-meta.json present but probe dead: fall through to ship + start.
    // The stale pid in the meta file is reaped before re-shipping so the
    // dying process doesn't race the new binary (ETXTBSY / port conflict).
    const tokenHex = "c".repeat(64);
    fake.setResponse(
      "tunnel-meta.json",
      ok(JSON.stringify({ port: 4242, pid: 1234, token: tokenHex })),
    );
    probeTransportAliveMock.mockResolvedValue(false);

    const auth = authority("session-probe-dead-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const shared = transports.get(auth);
    expect(shared).toBeDefined();
    // Port comes from the meta-file poll after re-shipping (4242).
    expect(shared.transportPort).toBe(4242);
    // Token comes from the meta file written by the newly-spawned Go
    // binary (which self-generates its bearer from crypto/rand). The stub
    // returns the same meta content on every read, so the token equals
    // the stub's token; in production the binary overwrites the file with
    // a fresh token before the poll loop reads it.
    expect(shared.transportToken).toBe(tokenHex);
    expect(shared.transportToken.length).toBe(64);
    // Binary was re-shipped.
    const binShip = fake.putFileCalls.find((c) =>
      c.path.includes("zygos-tunnel-x64.new"),
    );
    expect(binShip).toBeDefined();
    expect(probeTransportAliveMock).toHaveBeenCalled();
    // The stale pid was reaped via the control shell (transport isn't up
    // yet at probe time).
    const killCall = fake.calls.find((c) => c.includes("kill 1234"));
    expect(killCall).toBeDefined();
    // No --token-file flag in the start command: the Go binary generates
    // its own token and writes it into the meta file.
    const startCall = fake.calls.find((c) => c.includes("--detach"));
    expect(startCall).toBeDefined();
    expect(startCall).not.toContain("--token-file");
  });

  it("routes session-path bookkeeping execs through the go transport", async () => {
    // On the session path, after startTransportClient injects the
    // transport, every conn.exec that doesn't pass a timeout must ride the
    // transport instead of the ssh-session control shell. The reuse branch
    // (lockProbe.reusePort=9999 from the stub) runs readConnectionTokenFile,
    // which uses bbExec -> conn.exec, so transport.exec must be called with
    // `sh -c <wrapped cat conn-token>`.
    const auth = authority("session-routing-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    expect(transportExecMock).toHaveBeenCalled();
    // Every call is `sh -c <command>` (the routing wrap).
    for (const [cmd, args] of transportExecMock.mock.calls) {
      expect(cmd).toBe("sh");
      expect(args[0]).toBe("-c");
      expect(typeof args[1]).toBe("string");
    }
    // At least one call is the conn-token read from the reuse branch.
    const tokenRead = transportExecMock.mock.calls.find(([, args]) =>
      (args[1] as string).includes("conn-token"),
    );
    expect(tokenRead).toBeDefined();
    // The control shell never saw the routed command (the mock's calls log
    // records only pre-transport execs like the port-file poll).
    const controlTokenRead = fake.calls.find((c) => c.includes("conn-token"));
    expect(controlTokenRead).toBeUndefined();
  });

  it("uses transport.waitForFile for the server ready-file on a fresh start", async () => {
    // Force the fresh-start branch (no reusable server) so the flow runs
    // startServerSession. With the transport up, the ready-file wait must
    // ride the transport's waitForFile op in a single blocking call instead
    // of the 1s poll loop. Default serverStatus returns reusePort=9999; flip
    // to 0 here to take the fresh-start path.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 0,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockResolvedValue(Buffer.from("9876\n"));

    const auth = authority("session-waitfile-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    // waitForFile was called with a ready-file path under .ssh-remote and a
    // timeout in milliseconds.
    expect(transportWaitForFileMock).toHaveBeenCalled();
    const [readyPath, timeoutMs] = transportWaitForFileMock.mock.calls[0];
    expect(readyPath).toContain(".ssh-remote");
    expect(typeof timeoutMs).toBe("number");
    expect(timeoutMs).toBeGreaterThan(0);
    // The returned port propagated to the per-flow connection record.
    const connections = (resolver as any).connections as Map<string, any>;
    const flow = connections.get(auth);
    expect(flow).toBeDefined();
    expect(flow.remotePort).toBe(9876);
  });

  it("removes the ready file before starting the server (regression: stale port)", async () => {
    // Regression: a stale `server-ready` file from a prior resolve used to
    // cause waitForFile to return the dead server's port immediately,
    // before the new wrapper wrote the current server's port. The resolver
    // must `rm -f` the ready file before launching the nohup wrapper so
    // waitForFile blocks until the new wrapper writes the current port.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 0,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockResolvedValue(Buffer.from("9876\n"));

    const auth = authority("session-rm-ready-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });

    // Find the rm -f server-ready call and the nohup wrapper call in the
    // transport exec stream (session-path execs route through transport).
    const calls = transportExecMock.mock.calls.map(([, a]) => a[1] as string);
    const rmIdx = calls.findIndex(
      (c) => c.includes("rm -f") && c.includes("server-ready"),
    );
    const nohupIdx = calls.findIndex((c) => c.includes("ssh-session-start-server.sh"));
    // Both calls must exist.
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(nohupIdx).toBeGreaterThanOrEqual(0);
    // The rm must come BEFORE the nohup wrapper launch. If it comes after,
    // waitForFile can read a stale file and return a dead port.
    expect(rmIdx).toBeLessThan(nohupIdx);
  });

  it("rejects resolve when the reported server port is unreachable (regression: silent swallow)", async () => {
    // Regression: verifyServerPort used to log an error and proceed when the
    // reported port wasn't reachable through SOCKS, handing VS Code a dead
    // port and causing every subsequent reconnect to fail with "Connection
    // refused" forever. It must throw so the user sees a real failure.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 0,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockResolvedValue(Buffer.from("9876\n"));
    // Make every SOCKS5 connect fail so waitForRemotePort returns false.
    socks5ConnectMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const auth = authority("session-unreachable-host");
    // waitForRemotePort polls every 250ms for 10s before giving up; give
    // vitest enough headroom to let it run.
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/not reachable/);

    // Restore the default for subsequent tests.
    socks5ConnectMock.mockImplementation(async () => new net.Socket());
  }, 15_000);

  it("rejects resolve when the go transport fails to start (regression: silent base64 fallback)", async () => {
    // Regression: startTransport's catch in onProbed used to log
    // "falling back to base64" at info level and proceed with
    // transportClient=undefined. The resolver then ran install through the
    // busybox path, which on a fresh remote hit the handlePutFile mkdir bug
    // and produced a confusing "Tarball extraction failed" 27s later — the
    // user saw a symptom, not the cause. onProbed must throw so the real
    // failure surfaces immediately.
    //
    // Force the ship-and-start branch (probe dead, no reuse) and make the
    // binary putFile fail. startTransport throws -> onProbed must re-throw
    // with a message naming the transport, not a downstream symptom.
    probeTransportAliveMock.mockResolvedValue(false);
    fake.setPutFileResponse(
      "zygos-tunnel-x64.new",
      fail("sh: cannot create: Directory nonexistent"),
    );

    const auth = authority("session-transport-fail-host");
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/Failed to start the Go transport/);
  });

  it("rejects resolve when transport.waitForFile fails (regression: poll-loop fallback)", async () => {
    // Regression: when the transport was up but waitForFile rejected (e.g.
    // the transport died mid-wait), the resolver used to log "falling back
    // to poll" at info level and run a 1s poll loop of `cat server-ready`
    // through the control shell — silently routing around the transport.
    // The poll would either find the same dead port (handing VS Code a port
    // nothing is listening on, causing "Connection refused" forever) or
    // time out after 60s. The resolver must surface the transport failure
    // immediately so the user sees the cause, not a 60s hang or a dead
    // port.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 0,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockRejectedValue(
      new Error("transport closed"),
    );

    const auth = authority("session-waitfile-fail-host");
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/Failed to wait for the server-ready file via the Go transport/);
  });

  it("rejects resolve when waitForFile returns a malformed port (regression: silent fallthrough)", async () => {
    // Regression: when waitForFile resolved with empty/garbage content,
    // parseInt returned NaN, `port > 0` was false, and the resolver silently
    // fell through to the poll loop — masking a wrapper bug that wrote
    // garbage to the ready file. The resolver must throw on malformed
    // content so the wrapper bug surfaces instead of being hidden behind
    // a 60s poll timeout.
    transportServerStatusMock.mockResolvedValue({
      reusePort: 0,
      pid: 0,
      alive: false,
    });
    transportWaitForFileMock.mockResolvedValue(Buffer.from(""));

    const auth = authority("session-waitfile-malformed-host");
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/Server-ready file contained a malformed port/);
  });

  it("rejects resolve when tunnel-meta.json is malformed (regression: silent re-ship)", async () => {
    // Regression: when tunnel-meta.json existed but contained garbage (e.g.
    // a partial write, disk corruption, manual edit), probeExistingTransport
    // used to return null and silently re-ship the binary — overwriting the
    // corruption instead of surfacing it. The probe must throw on a
    // malformed meta file so the user sees the corruption rather than
    // having it silently repaired. The Go binary writes the file atomically
    // (temp + rename), so a malformed file is a real error, not a "no
    // transport" state.
    fake.setResponse("tunnel-meta.json", ok("{not valid json"));

    const auth = authority("session-meta-malformed-host");
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/tunnel-meta.json exists but is malformed/);
  });

  it("rejects resolve when tunnel-meta.json token is not 64-char hex", async () => {
    // The token is the bearer the transport validates on every request. A
    // non-hex or wrong-length token means the meta file was tampered with or
    // written by something other than the Go binary. Treat it as a real
    // error, not a "no transport" state.
    fake.setResponse(
      "tunnel-meta.json",
      ok(JSON.stringify({ port: 4242, pid: 1234, token: "not-hex" })),
    );

    const auth = authority("session-meta-bad-token-host");
    await expect(
      resolver.resolve(auth, { resolveAttempt: 1 }),
    ).rejects.toThrow(/tunnel-meta.json has an invalid token/);
  });
});

// --- Non-session path: no shared transport ---

describe("SshRemoteResolver non-session path (no sharing)", () => {
  let resolver: SshRemoteResolver;
  let fake: MockSshConnection;
  let factoryCalls: number;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    // usePersistentConnection stays false; sessionSecretReady stays false.
    factoryCalls = 0;
    (ZygosTransport as any).instances.length = 0;
    fake = new MockSshConnection();
    configureForResolve(fake);
    const factory: ConnectionFactory = () => {
      factoryCalls++;
      return fake as any;
    };
    resolver = new SshRemoteResolver(
      noopLogger as any,
      "/ext/path",
      factory,
    );
  });

  afterEach(() => {
    fake.stopSocksListeners();
    resolver.dispose();
  });

  it("resolve() and resolveExecServer() use separate connections (no transport map entry)", async () => {
    const auth = authority("nosession-host");
    await resolver.resolve(auth, { resolveAttempt: 1 });
    await resolver.resolveExecServer(auth, { resolveAttempt: 1 });

    const transports = (resolver as any).transports as Map<string, any>;
    const connections = (resolver as any).connections as Map<string, any>;

    // Non-session path: no shared transport registered.
    expect(transports.size).toBe(0);
    // Both flows still registered.
    expect(connections.has(auth)).toBe(true);
    expect(connections.has(`${auth}:execServer`)).toBe(true);
    // Factory called twice (one conn per flow).
    expect(factoryCalls).toBe(2);
    // No ZygosTransport constructed (non-session doesn't start the Go transport).
    expect((ZygosTransport as any).instances.length).toBe(0);
  });
});

// --- registerResolver() ---

describe("registerResolver", () => {
  beforeEach(() => {
    resetConfig();
    Object.keys(registeredResolvers).forEach(
      (k) => delete registeredResolvers[k],
    );
  });

  it("registers the resolver under ssh-remote scheme", () => {
    const fakeContext = {
      extensionPath: "/ext",
      globalStorageUri: { fsPath: "/ext/storage" },
      subscriptions: [] as Array<{ dispose(): void }>,
    };
    const resolver = registerResolver(fakeContext as any, noopLogger as any);
    expect(registeredResolvers["ssh-remote"]).toBeDefined();
    const reg = registeredResolvers["ssh-remote"] as any;
    expect(typeof reg.resolve).toBe("function");
    expect(typeof reg.resolveExecServer).toBe("function");
    // Subscription should be registered for cleanup.
    expect(fakeContext.subscriptions.length).toBe(1);
    // Disposing the subscription should call resolver.dispose.
    resolver.dispose();
  });
});
