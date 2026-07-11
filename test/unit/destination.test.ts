/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  parseSshDestination,
  formatSshDestination,
  encodeAuthority,
  decodeAuthority,
  parseAuthority,
} from "../../src/ssh/destination";

describe("parseSshDestination", () => {
  it("parses user@host:port", () => {
    const d = parseSshDestination("user@10.0.0.1:2222");
    expect(d).toEqual({ host: "10.0.0.1", user: "user", port: 2222 });
  });

  it("parses host only", () => {
    const d = parseSshDestination("example.com");
    expect(d).toEqual({
      host: "example.com",
      user: undefined,
      port: undefined,
    });
  });

  it("parses user@host without port", () => {
    const d = parseSshDestination("admin@server");
    expect(d).toEqual({ host: "server", user: "admin", port: undefined });
  });

  it("parses host:port without user", () => {
    const d = parseSshDestination("example.com:2222");
    expect(d).toEqual({ host: "example.com", user: undefined, port: 2222 });
  });

  it("rejects empty string", () => {
    expect(() => parseSshDestination("")).toThrow();
  });
});

describe("formatSshDestination", () => {
  it("round-trips user@host:port", () => {
    const input = "user@10.0.0.1:2222";
    expect(formatSshDestination(parseSshDestination(input))).toBe(input);
  });

  it("omits missing parts", () => {
    expect(formatSshDestination({ host: "h" })).toBe("h");
    expect(formatSshDestination({ host: "h", user: "u" })).toBe("u@h");
    expect(formatSshDestination({ host: "h", port: 22 })).toBe("h:22");
  });
});

describe("authority encode/decode", () => {
  it("round-trips a full destination", () => {
    const dest = { host: "My-Host.UPPER", user: "myuser", port: 2222 };
    const authority = `ssh-remote+${encodeAuthority(dest)}`;
    expect(authority).not.toMatch(/[A-Z]/); // hex is lowercase, survives VS Code lowercasing

    const parsed = parseAuthority(authority);
    expect(parsed).not.toBeNull();
    const decoded = decodeAuthority(parsed!.payload);
    expect(decoded).toEqual(dest);
  });

  it("handles user-less, port-less destinations", () => {
    const dest = { host: "example.com" };
    const encoded = encodeAuthority(dest);
    const decoded = decodeAuthority(encoded);
    expect(decoded).toEqual(dest);
  });

  it("parseAuthority returns null for non-ssh-remote authority", () => {
    expect(parseAuthority("wsl+Ubuntu")).not.toBeNull(); // has a +
    expect(parseAuthority("plainhost")).toBeNull(); // no +
  });
});
