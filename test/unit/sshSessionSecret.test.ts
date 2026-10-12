/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  initSshSessionSecret,
  deriveSshSessionToken,
  disposeSshSessionSecret,
} from "../../src/ssh/sshSessionSecret";

// Stub SecretStorage: in-memory key-value, matches the real interface shape.
class FakeSecrets {
  private map = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};

afterEach(() => {
  disposeSshSessionSecret();
});

describe("sshSessionSecret", () => {
  it("derives a 32-byte token", async () => {
    await initSshSessionSecret(
      new FakeSecrets() as unknown as vscode.SecretStorage,
      noopLogger as any,
      "test.sshSession.key",
    );
    const token = deriveSshSessionToken("ubuntu@host");
    expect(token.length).toBe(32);
  });

  it("is deterministic for the same destination", async () => {
    await initSshSessionSecret(
      new FakeSecrets() as unknown as vscode.SecretStorage,
      noopLogger as any,
      "test.sshSession.key",
    );
    const a = deriveSshSessionToken("ubuntu@host");
    const b = deriveSshSessionToken("ubuntu@host");
    expect(a.equals(b)).toBe(true);
  });

  it("differs per destination", async () => {
    await initSshSessionSecret(
      new FakeSecrets() as unknown as vscode.SecretStorage,
      noopLogger as any,
      "test.sshSession.key",
    );
    const a = deriveSshSessionToken("ubuntu@host1");
    const b = deriveSshSessionToken("ubuntu@host2");
    expect(a.equals(b)).toBe(false);
  });

  it("differs per master key", async () => {
    const secrets1 = new FakeSecrets();
    await initSshSessionSecret(secrets1 as any, noopLogger as any, "test.sshSession.key");
    const a = deriveSshSessionToken("ubuntu@host");
    disposeSshSessionSecret();

    const secrets2 = new FakeSecrets();
    await initSshSessionSecret(secrets2 as any, noopLogger as any, "test.sshSession.key");
    const b = deriveSshSessionToken("ubuntu@host");

    expect(a.equals(b)).toBe(false);
  });

  it("reuses the stored master key across inits", async () => {
    const secrets = new FakeSecrets();
    await initSshSessionSecret(secrets as any, noopLogger as any, "test.sshSession.key");
    const a = deriveSshSessionToken("ubuntu@host");
    disposeSshSessionSecret();

    // Same secrets store: load the existing key, not a new one.
    await initSshSessionSecret(secrets as any, noopLogger as any, "test.sshSession.key");
    const b = deriveSshSessionToken("ubuntu@host");

    expect(a.equals(b)).toBe(true);
  });

  it("throws when not initialized", () => {
    expect(() => deriveSshSessionToken("ubuntu@host")).toThrow();
  });

  it("matches the HMAC-SHA256 spec", async () => {
    const secrets = new FakeSecrets();
    await initSshSessionSecret(secrets as any, noopLogger as any, "test.sshSession.key");

    // Read the stored key and compute the expected token independently.
    const raw = await secrets.get("test.sshSession.key");
    const record = JSON.parse(raw!);
    const key = Buffer.from(record.key, "base64");
    const expected = crypto
      .createHmac("sha256", key)
      .update("zygos-ssh-session:ubuntu@host")
      .digest();

    const actual = deriveSshSessionToken("ubuntu@host");
    expect(actual.equals(expected)).toBe(true);
  });
});
