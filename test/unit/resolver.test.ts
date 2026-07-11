/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";

// Mock the platform module so detectPlatform/getProductInfo don't need
// build-time globals or a real product.json.
const mockAdapter = {
  serverApplicationName: "code-server-oss",
  serverDataFolderName: ".zygos-server",
  getServerDownloadUrl: () => "https://example.com/server",
  readAuthToken: undefined,
  getAuthTokenPath: undefined,
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
import {
  FakeSshConnection,
  ok,
  fail,
  noopLogger,
} from "../__mocks__/fakeSshConnection";
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

/** Create a resolver with a FakeSshConnection factory. */
function makeResolver(fake: FakeSshConnection): SshRemoteResolver {
  const factory: ConnectionFactory = () => fake as any;
  return new SshRemoteResolver(noopLogger as any, "/ext/path", factory);
}

/** Configure a FakeSshConnection with responses for the full resolve() flow. */
function configureForResolve(fake: FakeSshConnection, listenPort = 9876): void {
  fake.setResponse("printenv HOME", ok("/home/testuser"));
  fake.setResponse("uname", ok("x86_64\nBB_YES"));
  fake.setResponse("test -f", ok("ALREADY_INSTALLED"));
  fake.setResponse("echo ok", ok("ok"));
  fake.setResponse("umask", ok());
  fake.setSpawnStdout(`Extension host agent listening on ${listenPort}\n`);
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
    const srv = net.createServer();
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
    resolver = makeResolver(new FakeSshConnection());
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
    resolver = makeResolver(new FakeSshConnection());
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
  let fake: FakeSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new FakeSshConnection();
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
});

// --- resolve() happy path ---

describe("SshRemoteResolver.resolve - happy path", () => {
  let resolver: SshRemoteResolver;
  let fake: FakeSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new FakeSshConnection();
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
  let fake: FakeSshConnection;

  beforeEach(() => {
    resetConfig();
    setConfig("zygos.askpass", false);
    fake = new FakeSshConnection();
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
    const fake2 = new FakeSshConnection();
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
