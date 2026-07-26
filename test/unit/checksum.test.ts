/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseChecksumBody,
  computeHash,
  verifyHash,
  fetchExpectedChecksum,
} from "../../src/remote/checksum";
import type { DownloadTemplateInfo } from "../../src/platform/downloadTypes";

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

// --- fetchExpectedChecksum tests (using injected fetchFn) ---

function makeResponse(
  status: number,
  body: string,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as Response;
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function makeInfo(
  overrides: Partial<DownloadTemplateInfo> = {},
): DownloadTemplateInfo {
  return {
    commit: "abc123",
    quality: "stable",
    version: "1.2.3",
    release: "1.2.3",
    verifyChecksum: true,
    onNoChecksum: "warn",
    ...overrides,
  };
}

describe("fetchExpectedChecksum - sidecar", () => {
  it("returns sidecar result on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(200, "abc123def456  filename.tar.gz"),
    );
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumAlgo: "sha256" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({
      expectedHash: "abc123def456",
      algo: "sha256",
      source: "sidecar",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/server.tar.gz.sha256",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns no-source on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(404, ""));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumAlgo: "sha256" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source on 403", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(403, ""));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumAlgo: "sha256" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumAlgo: "sha256" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when sidecar body is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(200, "   "));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumAlgo: "md5" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when checksumAlgo not set", async () => {
    const fetchFn = vi.fn();
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo(),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("fetchExpectedChecksum - manifest", () => {
  it("returns manifest result on success", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(200, JSON.stringify({ sha256hash: "deadbeef" })),
    );
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({
        checksumMethod: "manifest",
        manifestTemplate: "https://example.com/manifest.json",
        manifestField: "sha256hash",
      }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({
      expectedHash: "deadbeef",
      algo: "sha256",
      source: "manifest",
    });
  });

  it("defaults to sha256 when checksumAlgo not set", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(200, JSON.stringify({ sha256hash: "deadbeef" })),
    );
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({
        checksumMethod: "manifest",
        manifestTemplate: "https://example.com/manifest.json",
        manifestField: "sha256hash",
      }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    if ("expectedHash" in result) {
      expect(result.algo).toBe("sha256");
    } else {
      expect.fail("expected ChecksumResult");
    }
  });

  it("returns no-source on 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse(404, ""));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({
        checksumMethod: "manifest",
        manifestTemplate: "https://example.com/manifest.json",
        manifestField: "sha256hash",
      }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({
        checksumMethod: "manifest",
        manifestTemplate: "https://example.com/manifest.json",
        manifestField: "sha256hash",
      }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when field not in JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse(200, JSON.stringify({ other: "x" })),
    );
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({
        checksumMethod: "manifest",
        manifestTemplate: "https://example.com/manifest.json",
        manifestField: "sha256hash",
      }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
  });

  it("returns no-source when manifestTemplate/field missing", async () => {
    const fetchFn = vi.fn();
    const result = await fetchExpectedChecksum(
      "https://example.com/server.tar.gz",
      makeInfo({ checksumMethod: "manifest" }),
      "linux",
      "x64",
      makeLogger(),
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ reason: "no-source" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
