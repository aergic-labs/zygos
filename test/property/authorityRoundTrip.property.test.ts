/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Property tests for SSH authority encode/decode.
 *
 * Invariant: a destination survives a full `ssh-remote+<hex>` round-trip
 * unchanged, for any host / optional user / optional port - including values
 * with `@`, `:`, spaces, quotes, and non-ASCII, since the payload is
 * JSON-then-hex encoded specifically to survive VS Code's authority
 * lowercasing.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  encodeAuthority,
  decodeAuthority,
  parseAuthority,
  type SshDestination,
} from "../../src/ssh/destination";

// A destination arbitrary: non-empty host, optional user, optional port.
const destArb = fc.record({
  host: fc.string({ minLength: 1 }),
  user: fc.option(fc.string(), { nil: undefined }),
  port: fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
});

describe("authority encode/decode round-trip", () => {
  it("decodeAuthority reverses encodeAuthority for any destination", () => {
    fc.assert(
      fc.property(destArb, (dest: SshDestination) => {
        const decoded = decodeAuthority(encodeAuthority(dest));
        expect(decoded.host).toBe(dest.host);
        expect(decoded.user).toBe(dest.user);
        expect(decoded.port).toBe(dest.port);
      }),
    );
  });

  it("survives the full ssh-remote+<hex> authority round-trip", () => {
    fc.assert(
      fc.property(destArb, (dest: SshDestination) => {
        const authority = `ssh-remote+${encodeAuthority(dest)}`;
        const parsed = parseAuthority(authority);
        expect(parsed).not.toBeNull();
        expect(parsed!.scheme).toBe("ssh-remote");
        const decoded = decodeAuthority(parsed!.payload);
        expect(decoded).toEqual({
          host: dest.host,
          user: dest.user,
          port: dest.port,
        });
      }),
    );
  });

  it("produces a payload that is unchanged by lowercasing (hex is case-insensitive)", () => {
    fc.assert(
      fc.property(destArb, (dest: SshDestination) => {
        const hex = encodeAuthority(dest);
        // VS Code lowercases URI authorities; hex must already be lowercase
        // so the payload survives it byte-for-byte.
        expect(hex).toBe(hex.toLowerCase());
        expect(decodeAuthority(hex.toLowerCase())).toEqual(
          decodeAuthority(hex),
        );
      }),
    );
  });
});
