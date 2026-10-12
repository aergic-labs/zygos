/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Master key for the ssh session IPC auth token.
 *
 * Decoupled from the askpass cache: the ssh session must work when
 * askpass is off. Same SecretStorage pattern, separate key, no shared
 * state.
 *
 * The token is `HMAC-SHA256(masterKey, "zygos-ssh-session:" + destination)`,
 * 32 bytes. Both sides derive it independently; nothing is stored on
 * disk. Master key rotates every 7 days, same as askpass.
 */

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { Logger } from "../common/logger";

const DEFAULT_ROTATION_MS = 7 * 24 * 60 * 60 * 1000;

interface MasterKeyRecord {
  /** 32-byte master key (base64). */
  key: string;
  /** When the key was created (epoch ms). */
  createdAt: number;
}

let instance: SshSessionSecret | undefined;

class SshSessionSecret {
  private masterKey: Buffer | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly logger: Logger,
    private readonly masterKeyId: string,
    private readonly rotationMs: number,
  ) {}

  async init(): Promise<void> {
    const raw = await this.secrets.get(this.masterKeyId);
    let masterKey: Buffer;
    let createdAt: number;
    if (!raw) {
      masterKey = crypto.randomBytes(32);
      createdAt = Date.now();
      await this.secrets.store(
        this.masterKeyId,
        JSON.stringify({ key: masterKey.toString("base64"), createdAt }),
      );
      this.logger.info("[ssh-session-secret] generated new master key");
    } else {
      const record = JSON.parse(raw) as MasterKeyRecord;
      if (!record.key || typeof record.createdAt !== "number") {
        throw new Error("invalid ssh session master key format");
      }
      masterKey = Buffer.from(record.key, "base64");
      createdAt = record.createdAt;
      this.logger.info("[ssh-session-secret] loaded existing master key");
    }

    this.masterKey = masterKey;

    if (this.rotationMs > 0 && Date.now() - createdAt > this.rotationMs) {
      await this.rotate();
    }
  }

  /** Derive the IPC auth token for a destination. */
  deriveToken(destination: string): Buffer {
    if (!this.masterKey) throw new Error("ssh session secret not initialized");
    return crypto
      .createHmac("sha256", this.masterKey)
      .update("zygos-ssh-session:" + destination)
      .digest();
  }

  private async rotate(): Promise<void> {
    this.logger.info("[ssh-session-secret] rotating master key");
    const newKey = crypto.randomBytes(32);
    const newCreatedAt = Date.now();
    await this.secrets.store(
      this.masterKeyId,
      JSON.stringify({ key: newKey.toString("base64"), createdAt: newCreatedAt }),
    );
    this.masterKey = newKey;
    this.logger.info("[ssh-session-secret] master key rotated");
  }

  dispose(): void {
    this.masterKey = undefined;
  }
}

/** Initialize the ssh session secret. Call once in activate() when the session is enabled. */
export async function initSshSessionSecret(
  secrets: vscode.SecretStorage,
  logger: Logger,
  masterKeyId: string,
  rotationDays?: number,
): Promise<void> {
  const rotationMs =
    rotationDays === undefined
      ? DEFAULT_ROTATION_MS
      : rotationDays * 24 * 60 * 60 * 1000;
  instance = new SshSessionSecret(secrets, logger, masterKeyId, rotationMs);
  await instance.init();
}

/** Derive the IPC auth token for a destination. Throws if not initialized. */
export function deriveSshSessionToken(destination: string): Buffer {
  if (!instance) throw new Error("ssh session secret not initialized");
  return instance.deriveToken(destination);
}

/** Whether the ssh session secret is initialized. */
export function sshSessionSecretReady(): boolean {
  return instance !== undefined;
}

/** Dispose. Call in deactivate(). */
export function disposeSshSessionSecret(): void {
  instance?.dispose();
  instance = undefined;
}
