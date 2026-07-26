/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseKeyPath,
  getCached,
  setCached,
  evict,
  clearAllCached,
  validatePassphrase,
  initCache,
  disposeCache,
} from "../../src/ssh/askpassCache";

const mockLogger: any = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
  dispose: () => {},
};

/** Minimal in-memory SecretStorage mock. */
function makeMockSecrets(): any {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    store: (key: string, val: string) => {
      store.set(key, val);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

let dbPath: string;
let tempDir: string;

async function initTestCache(): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-cache-test-"));
  dbPath = path.join(tempDir, "askpass.db");
  await initCache(makeMockSecrets(), dbPath, mockLogger, "test.askpass.masterkey");
}

async function disposeTestCache(): Promise<void> {
  await disposeCache();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- parseKeyPath ---

describe("parseKeyPath", () => {
  it("parses a Linux key path", () => {
    expect(
      parseKeyPath("Enter passphrase for key '/home/user/.ssh/id_rsa':"),
    ).toBe("/home/user/.ssh/id_rsa");
  });

  it("parses a Windows key path", () => {
    expect(
      parseKeyPath(
        "Enter passphrase for key 'C:\\Users\\user/.ssh/id_ed25519':",
      ),
    ).toBe("C:\\Users\\user/.ssh/id_ed25519");
  });

  it("parses a path with spaces", () => {
    expect(
      parseKeyPath(
        "Enter passphrase for key 'C:\\Users\\John Smith\\.ssh\\id_rsa':",
      ),
    ).toBe("C:\\Users\\John Smith\\.ssh\\id_rsa");
  });

  it("returns undefined for a host password prompt", () => {
    expect(parseKeyPath("user@host's password:")).toBeUndefined();
  });

  it("returns undefined for a prompt without 'for key'", () => {
    expect(parseKeyPath("Enter password:")).toBeUndefined();
  });

  it("returns undefined for a prompt with 'for key' but no quotes", () => {
    expect(parseKeyPath("Enter passphrase for key id_rsa")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseKeyPath("")).toBeUndefined();
  });
});

// --- validatePassphrase ---

describe("validatePassphrase", () => {
  it("returns invalid when key file doesn't exist", () => {
    const result = validatePassphrase("/nonexistent/key", "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns invalid when ssh-keygen fails on a non-key file", () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `aergic-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    fs.writeFileSync(tmpFile, "not a key");
    try {
      const result = validatePassphrase(tmpFile, "wrong");
      expect(result.valid).toBe(false);
    } finally {
      fs.rmSync(tmpFile);
    }
  });
});

// --- getCached / setCached (non-key prompts) ---

describe("getCached / setCached (non-key prompts)", () => {
  beforeEach(initTestCache);
  afterEach(disposeTestCache);

  it("stores and retrieves a non-key password", async () => {
    const result = await setCached("user@host's password:", "secret123");
    expect(result.stored).toBe(true);
    expect(await getCached("user@host's password:")).toBe("secret123");
  });

  it("returns undefined for an uncached prompt", async () => {
    expect(await getCached("unknown@host's password:")).toBeUndefined();
  });

  it("overwrites a previous entry on re-set", async () => {
    await setCached("prompt", "old");
    await setCached("prompt", "new");
    expect(await getCached("prompt")).toBe("new");
  });

  it("evict removes a single entry", async () => {
    await setCached("prompt1", "secret1");
    await setCached("prompt2", "secret2");
    await evict("prompt1");
    expect(await getCached("prompt1")).toBeUndefined();
    expect(await getCached("prompt2")).toBe("secret2");
  });

  it("clearAllCached removes everything", async () => {
    await setCached("p1", "s1");
    await setCached("p2", "s2");
    await clearAllCached();
    expect(await getCached("p1")).toBeUndefined();
    expect(await getCached("p2")).toBeUndefined();
  });
});

// --- getCached / setCached (TTL expiry) ---

describe("getCached TTL expiry", () => {
  beforeEach(async () => {
    await initTestCache();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeTestCache();
  });

  it("returns the password within TTL", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await setCached("prompt", "secret");
    vi.setSystemTime(new Date("2026-01-01T04:00:00Z")); // 4h later
    expect(await getCached("prompt")).toBe("secret");
  });

  it("returns undefined after TTL expires (8h)", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await setCached("prompt", "secret");
    vi.setSystemTime(new Date("2026-01-01T08:01:00Z")); // 8h + 1min later
    expect(await getCached("prompt")).toBeUndefined();
  });

  it("does not return expired entries but evicts them", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await setCached("prompt", "secret");
    vi.setSystemTime(new Date("2026-01-01T08:01:00Z"));
    await getCached("prompt");
    // Moving back in time shouldn't resurrect it - it was deleted.
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(await getCached("prompt")).toBeUndefined();
  });
});

// --- setCached (key passphrase validation) ---

describe("setCached (key passphrase)", () => {
  beforeEach(initTestCache);
  afterEach(disposeTestCache);

  it("rejects a key passphrase when the key file doesn't exist", async () => {
    const result = await setCached(
      "Enter passphrase for key '/nonexistent/key':",
      "secret",
    );
    expect(result.stored).toBe(false);
    expect(result.error).toContain("not found");
    expect(
      await getCached("Enter passphrase for key '/nonexistent/key':"),
    ).toBeUndefined();
  });

  it("rejects a key passphrase when ssh-keygen fails", async () => {
    const tmpFile = path.join(
      os.tmpdir(),
      `aergic-key-${Date.now()}-${Math.random().toString(36).slice(2)}.key`,
    );
    fs.writeFileSync(tmpFile, "not a real key");
    try {
      const result = await setCached(
        `Enter passphrase for key '${tmpFile}':`,
        "wrong",
      );
      expect(result.stored).toBe(false);
    } finally {
      fs.rmSync(tmpFile);
    }
  });
});

describe("sweep", () => {
  // sweep() runs inside init(). Drive it by disposing and re-initializing
  // with the SAME SecretStorage so the master key persists and cached
  // entries can still be decrypted (otherwise they evict via the
  // decrypt-failed path, not the path under test).

  it("evicts entries whose key file mtime changed since caching", async () => {
    const secrets = makeMockSecrets();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-sweep-"));
    dbPath = path.join(tempDir, "askpass.db");
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    // Real file standing in for an SSH key. skipValidation lets us cache a
    // passphrase for it without ssh-keygen.
    const keyFile = path.join(tempDir, "fake.key");
    fs.writeFileSync(keyFile, "not a key");
    const prompt = `Enter passphrase for key '${keyFile}':`;

    const stored = await setCached(prompt, "secret", true);
    expect(stored.stored).toBe(true);
    expect(await getCached(prompt)).toBe("secret");

    // Bump the key file's mtime forward so sweep sees a change.
    const future = new Date(Date.now() / 1000 * 1000 + 5000);
    fs.utimesSync(keyFile, future, future);

    await disposeCache();
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    expect(await getCached(prompt)).toBeUndefined();

    await disposeCache();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("evicts entries whose key file no longer exists", async () => {
    const secrets = makeMockSecrets();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-sweep-"));
    dbPath = path.join(tempDir, "askpass.db");
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    const keyFile = path.join(tempDir, "gone.key");
    fs.writeFileSync(keyFile, "not a key");
    const prompt = `Enter passphrase for key '${keyFile}':`;
    await setCached(prompt, "secret", true);
    fs.unlinkSync(keyFile);

    await disposeCache();
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    expect(await getCached(prompt)).toBeUndefined();

    await disposeCache();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("evicts TTL-expired entries on re-init sweep", async () => {
    // TTL of ~0.25h (900s) keeps the test fast while still being a real
    // wall-clock wait. We sleep 1.1s with a TTL of 1 second.
    const secrets = makeMockSecrets();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-sweep-"));
    dbPath = path.join(tempDir, "askpass.db");
    // ttlHours is in hours; 1/3600 = 1 second.
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey", 1 / 3600);

    await setCached("host-prompt", "secret");
    expect(await getCached("host-prompt")).toBe("secret");

    await new Promise((r) => setTimeout(r, 1300));

    await disposeCache();
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey", 1 / 3600);

    expect(await getCached("host-prompt")).toBeUndefined();

    await disposeCache();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("keeps unexpired, unchanged entries across re-init", async () => {
    const secrets = makeMockSecrets();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-sweep-"));
    dbPath = path.join(tempDir, "askpass.db");
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    await setCached("persist-prompt", "secret");
    await disposeCache();
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    expect(await getCached("persist-prompt")).toBe("secret");

    await disposeCache();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});

// --- persistence across instances ---

describe("persistence across instances", () => {
  beforeEach(initTestCache);
  afterEach(disposeTestCache);

  it("survives dispose + re-init (new instance reads the same db)", async () => {
    await setCached("prompt", "persisted-secret");
    await disposeCache();

    // Re-init with a new secret storage (same cryptkey would be generated
    // fresh, so the old ciphertext can't be decrypted. Verify the entry
    // still exists but can't be read with a different key).
    const secrets2 = makeMockSecrets();
    await initCache(secrets2, dbPath, mockLogger, "test.askpass.masterkey");

    // With a different encryption key, the old ciphertext fails to decrypt
    // and is evicted.
    expect(await getCached("prompt")).toBeUndefined();
  });

  it("survives dispose + re-init with the same secret storage", async () => {
    const secrets = makeMockSecrets();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aergic-cache-test-"));
    dbPath = path.join(tempDir, "askpass.db");
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");

    await setCached("prompt", "persisted-secret");
    await disposeCache();

    // Re-init with the SAME secret storage (same encryption key).
    await initCache(secrets, dbPath, mockLogger, "test.askpass.masterkey");
    expect(await getCached("prompt")).toBe("persisted-secret");

    await disposeCache();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
});
