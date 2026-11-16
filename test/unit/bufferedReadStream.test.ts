/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { BufferedReadStream } from "../../src/remote/execServer";

/** Push through the protected method without widening the public API. */
function pushAll(stream: BufferedReadStream, chunks: string[]): void {
  for (const c of chunks) {
    (stream as unknown as { push(d: Uint8Array): void }).push(
      new TextEncoder().encode(c),
    );
  }
}

describe("BufferedReadStream", () => {
  it("replays chunks that arrived before the first listener", () => {
    const stream = new BufferedReadStream(Promise.resolve());
    pushAll(stream, ["abc", "def"]);

    const got: string[] = [];
    stream.onDidReceiveMessage((d) => got.push(new TextDecoder().decode(d)));

    expect(got).toEqual(["abc", "def"]);
  });

  it("delivers chunks pushed after a listener attached", () => {
    const stream = new BufferedReadStream(Promise.resolve());
    const got: string[] = [];
    stream.onDidReceiveMessage((d) => got.push(new TextDecoder().decode(d)));

    pushAll(stream, ["x", "y"]);

    expect(got).toEqual(["x", "y"]);
  });

  it("stops delivering after dispose", () => {
    const stream = new BufferedReadStream(Promise.resolve());
    const got: string[] = [];
    const sub = stream.onDidReceiveMessage((d) =>
      got.push(new TextDecoder().decode(d)),
    );
    pushAll(stream, ["a"]);
    sub.dispose();
    pushAll(stream, ["b"]);

    expect(got).toEqual(["a"]);
  });

  it("copies the chunk, so a reused source buffer is safe", () => {
    const stream = new BufferedReadStream(Promise.resolve());
    const buf = new Uint8Array([1, 2, 3]);
    (stream as unknown as { push(d: Uint8Array): void }).push(buf);
    buf[0] = 99; // source reuses its buffer

    let received: Uint8Array | undefined;
    stream.onDidReceiveMessage((d) => (received = d));
    expect(Array.from(received!)).toEqual([1, 2, 3]);
  });

  it("exposes the end promise it was built with", async () => {
    let resolveEnd!: () => void;
    const onEnd = new Promise<void>((r) => (resolveEnd = r));
    const stream = new BufferedReadStream(onEnd);

    let ended = false;
    void stream.onEnd.then(() => (ended = true));
    expect(ended).toBe(false);
    resolveEnd();
    await stream.onEnd;
    expect(ended).toBe(true);
  });
});