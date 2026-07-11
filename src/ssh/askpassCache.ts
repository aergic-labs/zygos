/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Persistent encrypted passphrase/password cache for askpass.
 *
 * Survives across VS Code windows and restarts to avoid re-prompting on
 * every new connection. Uses:
 *
 *   - VS Code SecretStorage: stores a single 32-byte master key
 *     (OS-encrypted via Windows Credential Manager / macOS Keychain /
 *     libsecret).
 *   - node-dirty (vendored): append-only KV store at
 *     globalStorage/askpass.db, iterable for sweep.
 *
 * Security design:
 *
 *   The master key from SecretStorage is split into two independent
 *   subkeys via HKDF-SHA256:
 *     - hmacKey: for HMAC-SHA256 of the prompt to derive the db key.
 *       Hides the prompt (which contains the key file path) in the db.
 *     - aesKey:  for AES-256-GCM encryption of the value blob.
 *
 *   db key  = HMAC-SHA256(hmacKey, prompt) -> hex
 *   db val  = { ct, iv, tag } where ct = AES-256-GCM(aesKey, iv, plaintext)
 *   plaintext = JSON { password, keyPath, storedAt, keyMtime }
 *
 *   No sensitive data (prompt, key path, passphrase, timestamps) is
 *   stored in plaintext in the db file. Only the HMAC digest, the
 *   ciphertext, the IV, and the GCM auth tag appear on disk.
 *
 * TTL: 8 hours (configurable via zygos.askpassCacheTtl). Expired entries
 * are swept on activate and evicted lazily on read. Key file mtime is
 * tracked (inside the encrypted blob) to detect key rotation. On activate,
 * if the db file's own mtime is older than TTL, the entire file is deleted
 * (cold start after a long absence -> no stale cache). 0 = never expire.
 *
 * For key passphrase prompts, the passphrase is validated via ssh-keygen
 * before caching (wrong passphrase is never stored).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import type { Logger } from "../common/logger";
import { Dirty } from "../../vendor/node-dirty/dirty.js";

/** How long a cached secret is valid (ms). 8 hours - roughly a work
 * session. mtime handles key rotation; TTL just bounds stale entries.
 * Overridden by the zygos.askpassCacheTtl setting at init time. */
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
let TTL_MS = DEFAULT_TTL_MS;
/** SecretStorage key for the 32-byte master key. */
const MASTERKEY_ID = "zygos.askpass.masterkey";
/** HKDF info strings for subkey derivation. */
const HMAC_INFO = Buffer.from("zygos/askpass/hmac");
const AES_INFO = Buffer.from("zygos/askpass/aes");

/** Plaintext blob (encrypted before storage). */
interface Plaintext {
  /** The passphrase or password. */
  password: string;
  /** Key file path (for mtime re-check). Empty for non-key prompts. */
  keyPath: string;
  /** When the entry was stored (epoch ms). */
  storedAt: number;
  /** mtime of the key file when stored (ms). 0 for non-key entries. */
  keyMtime: number;
}

/** Encrypted entry stored in the dirty db. */
interface EncryptedEntry {
  /** AES-256-GCM ciphertext (base64). */
  ct: string;
  /** AES-256-GCM IV (base64, 12 bytes). */
  iv: string;
  /** AES-256-GCM auth tag (base64, 16 bytes). */
  tag: string;
}

// ---------------------------------------------------------------------------
// Pure functions (no state, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse a key file path from an askpass prompt.
 *
 * OpenSSH prompt formats (always English, no i18n):
 *   Enter passphrase for key 'C:\Users\user/.ssh/id_ed25519':
 *   Enter passphrase for key '/home/user/.ssh/id_rsa':
 *
 * Returns the path or undefined if the prompt isn't a key passphrase prompt.
 */
export function parseKeyPath(prompt: string): string | undefined {
  const idx = prompt.indexOf("for key");
  if (idx === -1) return undefined;

  const afterKey = prompt.slice(idx + "for key".length);
  const start = afterKey.indexOf("'");
  if (start === -1) return undefined;
  const end = afterKey.indexOf("'", start + 1);
  if (end === -1) return undefined;

  return afterKey.slice(start + 1, end);
}

/**
 * Validate a passphrase against a key file using ssh-keygen.
 *
 * Uses SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force to feed the passphrase
 * without a TTY. Piping via stdin doesn't work on Windows (ssh-keygen
 * uses the Console API, not stdin).
 *
 * The passphrase is passed to a temp Node script via an env var, never
 * written to disk. process.stdout.write is binary-safe.
 */
export function validatePassphrase(
  keyPath: string,
  passphrase: string,
): { valid: boolean; error?: string } {
  try {
    if (!fs.existsSync(keyPath)) {
      return { valid: false, error: `Key file not found: ${keyPath}` };
    }

    const isWin = process.platform === "win32";
    const envVar = `ZYGOS_ASKPASS_${crypto.randomBytes(8).toString("hex")}`;
    const id = crypto.randomBytes(8).toString("hex");
    const tmp = os.tmpdir();
    const jsPath = path.join(tmp, `zygos-ap-${id}.js`);
    const wrapperPath = path.join(
      tmp,
      `zygos-ap-${id}${isWin ? ".cmd" : ".sh"}`,
    );
    const nodePath = process.execPath;

    fs.writeFileSync(
      jsPath,
      `process.stdout.write(process.env["${envVar}"] || "");`,
    );

    if (isWin) {
      fs.writeFileSync(wrapperPath, `@"${nodePath}" "${jsPath}"`);
    } else {
      fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${jsPath}"`);
      fs.chmodSync(wrapperPath, 0o700);
    }

    try {
      execFileSync("ssh-keygen", ["-y", "-f", keyPath], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          [envVar]: passphrase,
          SSH_ASKPASS: wrapperPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: ":0",
        },
      });
      return { valid: true };
    } finally {
      try { fs.unlinkSync(jsPath); } catch { /* best effort */ }
      try { fs.unlinkSync(wrapperPath); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    const stderr =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    return { valid: false, error: stderr };
  }
}

// ---------------------------------------------------------------------------
// Persistent cache (module singleton)
// ---------------------------------------------------------------------------

let instance: PersistentAskpassCache | undefined;

/** Initialize the persistent cache. Call once in activate(). */
export async function initCache(
  secrets: vscode.SecretStorage,
  dbPath: string,
  logger: Logger,
  ttlHours?: number,
): Promise<void> {
  TTL_MS = ttlHours === undefined ? DEFAULT_TTL_MS : ttlHours * 60 * 60 * 1000;
  instance = new PersistentAskpassCache(secrets, dbPath, logger);
  await instance.init();
}

/** Dispose the cache and close the db file. Call in deactivate(). */
export async function disposeCache(): Promise<void> {
  instance?.dispose();
  instance = undefined;
}

/** Look up a cached secret. Returns undefined if missing, expired, or
 * if the key file was modified since caching. */
export async function getCached(prompt: string): Promise<string | undefined> {
  return instance?.get(prompt);
}

/** Store a secret, after validating if it's a key passphrase. */
export async function setCached(
  prompt: string,
  password: string,
): Promise<{ stored: boolean; error?: string }> {
  if (!instance) return { stored: false, error: "cache not initialized" };
  return instance.set(prompt, password);
}

/** Remove a single entry (e.g. on auth failure). */
export async function evict(prompt: string): Promise<void> {
  await instance?.evict(prompt);
}

/** Remove all entries from the persistent store. */
export async function clearAllCached(): Promise<void> {
  await instance?.clearAll();
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

class PersistentAskpassCache {
  private hmacKey: Buffer | undefined;
  private aesKey: Buffer | undefined;
  private db: Dirty<EncryptedEntry> | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly dbPath: string,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    // Load or generate the 32-byte master key from SecretStorage.
    const raw = await this.secrets.get(MASTERKEY_ID);
    let masterKey: Buffer;
    if (!raw) {
      masterKey = crypto.randomBytes(32);
      await this.secrets.store(MASTERKEY_ID, masterKey.toString("base64"));
      this.logger.info("[askpass-cache] generated new master key");
    } else {
      masterKey = Buffer.from(raw, "base64");
      this.logger.info("[askpass-cache] loaded existing master key");
    }

    // Derive independent subkeys via HKDF-SHA256.
    this.hmacKey = Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), HMAC_INFO, 32));
    this.aesKey = Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), AES_INFO, 32));

    // Ensure the db directory exists.
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // If the db file hasn't been modified in TTL, treat it as stale from
    // a previous session and delete it. This avoids re-prompting within
    // a work session (reopen VS Code within 8h -> cache survives) while
    // wiping on a true cold start (VS Code closed overnight -> cache gone).
    // TTL of 0 means never expire - skip the mtime check entirely.
    // The per-entry TTL sweep below handles entries that expired while
    // VS Code was running continuously.
    if (TTL_MS > 0) {
      try {
        const stat = fs.statSync(this.dbPath);
        if (Date.now() - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(this.dbPath);
          this.logger.info(
            `[askpass-cache] stale db (mtime ${new Date(stat.mtimeMs).toISOString()}), wiped`,
          );
        }
      } catch {
        // File doesn't exist - nothing to wipe.
      }
    }

    // Open the dirty db.
    this.db = new Dirty(this.dbPath) as Dirty<EncryptedEntry>;
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        this.db!.off("load", onLoad);
        this.db!.off("error", onError);
      };
      this.db!.on("load", onLoad);
      this.db!.on("error", onError);
    });

    // Restrict file permissions on Unix.
    if (process.platform !== "win32") {
      try { fs.chmodSync(this.dbPath, 0o600); } catch { /* best effort */ }
    }

    this.logger.info(`[askpass-cache] initialized (db=${this.dbPath})`);

    // Sweep expired entries from previous sessions.
    await this.sweep();
  }

  /** Derive the dirty db key from a prompt via HMAC-SHA256. */
  private dbKey(prompt: string): string {
    return crypto.createHmac("sha256", this.hmacKey!).update(prompt).digest("hex");
  }

  /** Encrypt a Plaintext blob into an EncryptedEntry. */
  private encrypt(plain: Plaintext): EncryptedEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.aesKey!, iv);
    const json = Buffer.from(JSON.stringify(plain), "utf8");
    let ct = cipher.update(json, undefined, "base64");
    ct += cipher.final("base64");
    const tag = cipher.getAuthTag();
    return { ct, iv: iv.toString("base64"), tag: tag.toString("base64") };
  }

  /** Decrypt an EncryptedEntry into a Plaintext blob. */
  private decrypt(entry: EncryptedEntry): Plaintext | undefined {
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.aesKey!,
        Buffer.from(entry.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      let pt = decipher.update(entry.ct, "base64", "utf8");
      pt += decipher.final("utf8");
      return JSON.parse(pt) as Plaintext;
    } catch {
      return undefined;
    }
  }

  async get(prompt: string): Promise<string | undefined> {
    if (!this.hmacKey || !this.aesKey || !this.db) return undefined;
    const key = this.dbKey(prompt);
    const entry = this.db.get(key);
    if (!entry) return undefined;

    const plain = this.decrypt(entry);
    if (!plain) {
      this.db.rm(key);
      return undefined;
    }

    // TTL check (0 = never expire).
    if (TTL_MS > 0 && Date.now() - plain.storedAt > TTL_MS) {
      this.db.rm(key);
      return undefined;
    }

    // Key file mtime check.
    if (plain.keyPath && plain.keyMtime > 0) {
      try {
        const stat = fs.statSync(plain.keyPath);
        if (stat.mtimeMs !== plain.keyMtime) {
          this.db.rm(key);
          return undefined;
        }
      } catch {
        this.db.rm(key);
        return undefined;
      }
    }

    return plain.password;
  }

  async set(
    prompt: string,
    password: string,
  ): Promise<{ stored: boolean; error?: string }> {
    if (!this.hmacKey || !this.aesKey || !this.db) {
      return { stored: false, error: "cache not initialized" };
    }

    // Validate key passphrases before caching.
    const keyPath = parseKeyPath(prompt);
    if (keyPath) {
      const result = validatePassphrase(keyPath, password);
      if (!result.valid) {
        return { stored: false, error: result.error };
      }
    }

    // Capture key file mtime for rotation detection.
    let keyMtime = 0;
    if (keyPath) {
      try { keyMtime = fs.statSync(keyPath).mtimeMs; } catch { /* key may be gone */ }
    }

    const plain: Plaintext = {
      password,
      keyPath: keyPath ?? "",
      storedAt: Date.now(),
      keyMtime,
    };

    const entry = this.encrypt(plain);
    this.db.set(this.dbKey(prompt), entry);
    return { stored: true };
  }

  async evict(prompt: string): Promise<void> {
    if (!this.db || !this.hmacKey) return;
    this.db.rm(this.dbKey(prompt));
  }

  async sweep(): Promise<void> {
    if (!this.db || !this.aesKey) return;
    const toEvict: string[] = [];
    this.db.forEach((key, val) => {
      if (!val) { toEvict.push(key); return; }
      const plain = this.decrypt(val);
      if (!plain) { toEvict.push(key); return; }
      if (TTL_MS > 0 && Date.now() - plain.storedAt > TTL_MS) {
        toEvict.push(key);
        return;
      }
      if (plain.keyPath && plain.keyMtime > 0) {
        try {
          const stat = fs.statSync(plain.keyPath);
          if (stat.mtimeMs !== plain.keyMtime) {
            toEvict.push(key);
          }
        } catch {
          toEvict.push(key);
        }
      }
    });
    for (const key of toEvict) {
      this.db.rm(key);
    }
    if (toEvict.length) {
      this.logger.info(
        `[askpass-cache] swept ${toEvict.length} expired entries`,
      );
    }

    // If the db is now empty, remove the file to avoid accumulating
    // tombstone rows from the append-only log. Reopen a fresh db.
    if (this.db.size() === 0) {
      this.db.close();
      try { fs.unlinkSync(this.dbPath); } catch { /* may not exist */ }
      this.db = new Dirty(this.dbPath) as Dirty<EncryptedEntry>;
      await new Promise<void>((resolve, reject) => {
        const onLoad = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const cleanup = () => {
          this.db!.off("load", onLoad);
          this.db!.off("error", onError);
        };
        this.db!.on("load", onLoad);
        this.db!.on("error", onError);
      });
    }
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    const keys: string[] = [];
    this.db.forEach((key) => { keys.push(key); });
    for (const key of keys) {
      this.db.rm(key);
    }
  }

  dispose(): void {
    this.db?.close();
    this.db = undefined;
    this.hmacKey = undefined;
    this.aesKey = undefined;
  }
}
