/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { wrapSocket } from "../../src/net/managedConnection";

/** Create a connected socket pair via a local TCP server. */
function createSocketPair(): Promise<{
  server: net.Server;
  client: net.Socket;
  serverSide: net.Socket;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      resolve({ server, client: pendingClient!, serverSide: socket });
    });
    let pendingClient: net.Socket | undefined;
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      pendingClient = net.connect(port, "127.0.0.1");
    });
  });
}

describe("wrapSocket", () => {
  let server: net.Server | undefined;
  let client: net.Socket | undefined;
  let serverSide: net.Socket | undefined;

  afterEach(() => {
    client?.destroy();
    serverSide?.destroy();
    server?.close();
  });

  it("receives data through onDidReceiveMessage", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const received: Uint8Array[] = [];
    mmp.onDidReceiveMessage((data) => received.push(data));

    serverSide.write("hello");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(Buffer.from(received[0]).toString()).toBe("hello");
  });

  it("send writes to the underlying socket", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const received: Buffer[] = [];
    serverSide.on("data", (c: Buffer) => received.push(c));

    mmp.send(new Uint8Array([104, 105])); // "hi"
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(received).toString()).toBe("hi");
  });

  it("fires onDidClose when the remote side closes", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const closeEvents: (Error | undefined)[] = [];
    mmp.onDidClose((err) => closeEvents.push(err));

    serverSide.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(closeEvents).toHaveLength(1);
    // Clean close, undefined error
    expect(closeEvents[0]).toBeUndefined();
  });

  it("fires onDidClose with error on socket error", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const closeEvents: (Error | undefined)[] = [];
    mmp.onDidClose((err) => closeEvents.push(err));

    client.destroy(new Error("test error"));
    await new Promise((r) => setTimeout(r, 50));
    expect(closeEvents).toHaveLength(1);
    expect(closeEvents[0]).toBeInstanceOf(Error);
  });

  it("fires onEnd when the remote signals end", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    let ended = false;
    mmp.onDidEnd(() => {
      ended = true;
    });

    serverSide.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(true);
  });

  it("end() closes the socket", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const serverData: Buffer[] = [];
    serverSide.on("data", (c: Buffer) => serverData.push(c));
    let serverEnded = false;
    serverSide.on("end", () => {
      serverEnded = true;
    });

    mmp.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(serverEnded).toBe(true);
  });

  it("listener disposable removes the listener", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const received: Uint8Array[] = [];
    const sub = mmp.onDidReceiveMessage((data) => received.push(data));
    sub.dispose();

    serverSide.write("ignored");
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);
  });

  it("only fires onDidClose once", async () => {
    const pair = await createSocketPair();
    server = pair.server;
    client = pair.client;
    serverSide = pair.serverSide;

    const mmp = wrapSocket(client);
    const closeEvents: (Error | undefined)[] = [];
    mmp.onDidClose((err) => closeEvents.push(err));

    // Destroy with error (fires 'error' then 'close')
    client.destroy(new Error("bang"));
    await new Promise((r) => setTimeout(r, 100));
    expect(closeEvents).toHaveLength(1);
  });
});
