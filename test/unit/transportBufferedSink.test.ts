/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { bufferedSink } from "../../src/transport/client";

const b = (s: string) => Buffer.from(s, "utf-8");
const s = (d: Buffer) => d.toString("utf-8");

describe("bufferedSink", () => {
  it("replays chunks emitted before the first subscriber", () => {
    const sink = bufferedSink();
    sink.emit(b("abc"));
    sink.emit(b("def"));

    const got: string[] = [];
    sink.onData((d) => got.push(s(d)));

    expect(got).toEqual(["abc", "def"]);
  });

  it("streams after subscription", () => {
    const sink = bufferedSink();
    const got: string[] = [];
    sink.onData((d) => got.push(s(d)));
    sink.emit(b("x"));

    expect(got).toEqual(["x"]);
  });

  it("hands the buffered chunks to the first subscriber only once", () => {
    const sink = bufferedSink();
    sink.emit(b("first"));

    const a: string[] = [];
    sink.onData((d) => a.push(s(d)));
    const c: string[] = [];
    sink.onData((d) => c.push(s(d)));
    sink.emit(b("second"));

    expect(a).toEqual(["first", "second"]);
    // A later subscriber gets only what arrives after it attached.
    expect(c).toEqual(["second"]);
  });
});