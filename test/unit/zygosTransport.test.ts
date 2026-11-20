/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import { ZygosTransport } from "../../src/transport/zygos";
import { ST, TransportError } from "../../src/transport/client";

/** Instance without a socket: only the request plumbing is exercised. */
function makeTransport(request: () => Promise<{ status: number }>) {
  const transport = Object.create(ZygosTransport.prototype) as ZygosTransport;
  (transport as unknown as { request: unknown }).request = vi.fn(request);
  return transport;
}

describe("ZygosTransport server ops", () => {
  function makeJsonTransport() {
    const requestJSON = vi.fn(
      async (_op: number, _args: unknown): Promise<unknown> => ({}),
    );
    const transport = Object.create(
      ZygosTransport.prototype,
    ) as ZygosTransport;
    (transport as unknown as { requestJSON: unknown }).requestJSON = requestJSON;
    return { transport, requestJSON };
  }

  it("serverCleanup sends the install path", async () => {
    const { transport, requestJSON } = makeJsonTransport();
    await transport.serverCleanup("/srv/install");
    expect(requestJSON).toHaveBeenCalledTimes(1);
    expect(requestJSON.mock.calls[0][1]).toEqual({ installPath: "/srv/install" });
  });

  it("serverFinalize sends port and release flag", async () => {
    const { transport, requestJSON } = makeJsonTransport();
    await transport.serverFinalize("/srv/install", 8123, true);
    expect(requestJSON).toHaveBeenCalledTimes(1);
    expect(requestJSON.mock.calls[0][1]).toEqual({
      installPath: "/srv/install",
      port: 8123,
      releaseLock: true,
    });
  });
});

describe("ZygosTransport.unlock", () => {
  it("resolves on OK", async () => {
    const transport = makeTransport(async () => ({ status: ST.OK }));
    await expect(transport.unlock("/tmp/lock")).resolves.toBeUndefined();
  });

  it("throws TransportError on a non-OK status", async () => {
    const transport = makeTransport(async () => ({ status: 7 }));
    await expect(transport.unlock("/tmp/lock")).rejects.toBeInstanceOf(
      TransportError,
    );
  });
});