/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  parseChecksumBody,
  computeHash,
  verifyHash,
} from "../../src/server/checksum";

describe("parseChecksumBody", () => {
  it("parses bare hash", () => {
    expect(parseChecksumBody("bc637215ffbe3fd5945bd3fdb235cb60")).toBe(
      "bc637215ffbe3fd5945bd3fdb235cb60",
    );
  });

  it("parses bare hash with trailing newline", () => {
    expect(parseChecksumBody("bc637215ffbe3fd5945bd3fdb235cb60\n")).toBe(
      "bc637215ffbe3fd5945bd3fdb235cb60",
    );
  });

  it("parses sumfile format (hash + filename)", () => {
    expect(
      parseChecksumBody(
        "c7ae39dbdf5b75b71f227aa9905c5169  qoder-reh-linux-x64-1.13.3.tar.gz",
      ),
    ).toBe("c7ae39dbdf5b75b71f227aa9905c5169");
  });

  it("parses sumfile format with multiple spaces", () => {
    expect(
      parseChecksumBody(
        "c7ae39dbdf5b75b71f227aa9905c5169    qoder-reh-linux-x64-1.13.3.tar.gz",
      ),
    ).toBe("c7ae39dbdf5b75b71f227aa9905c5169");
  });

  it("parses sumfile format with leading whitespace", () => {
    expect(
      parseChecksumBody(
        "  c7ae39dbdf5b75b71f227aa9905c5169  filename.tar.gz\n",
      ),
    ).toBe("c7ae39dbdf5b75b71f227aa9905c5169");
  });

  it("returns undefined for empty body", () => {
    expect(parseChecksumBody("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only body", () => {
    expect(parseChecksumBody("   \n\t  \n")).toBeUndefined();
  });
});

describe("computeHash", () => {
  it("computes sha256 correctly", () => {
    const data = Buffer.from("hello");
    const hash = computeHash(data, "sha256");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("computes md5 correctly", () => {
    const data = Buffer.from("hello");
    const hash = computeHash(data, "md5");
    expect(hash).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("produces consistent output for same input", () => {
    const data = Buffer.from("test data");
    expect(computeHash(data, "sha256")).toBe(computeHash(data, "sha256"));
  });
});

describe("verifyHash", () => {
  it("returns true for matching sha256", () => {
    const data = Buffer.from("hello");
    const expected = computeHash(data, "sha256");
    expect(verifyHash(data, expected, "sha256")).toBe(true);
  });

  it("returns true for matching md5", () => {
    const data = Buffer.from("hello");
    const expected = computeHash(data, "md5");
    expect(verifyHash(data, expected, "md5")).toBe(true);
  });

  it("returns false for mismatched hash", () => {
    const data = Buffer.from("hello");
    const expected = "0".repeat(64);
    expect(verifyHash(data, expected, "sha256")).toBe(false);
  });

  it("returns false for different length hash", () => {
    const data = Buffer.from("hello");
    const expected = "abc123";
    expect(verifyHash(data, expected, "sha256")).toBe(false);
  });

  it("returns false for empty expected hash", () => {
    const data = Buffer.from("hello");
    expect(verifyHash(data, "", "sha256")).toBe(false);
  });
});
