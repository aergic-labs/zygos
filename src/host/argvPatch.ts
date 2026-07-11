/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * argv.json patch core, shared by the apex-local patch path
 * (ensureArgvProposedApi in services.ts) and the remote patch script
 * (argvPatchRemoteMain.ts, bundled and pushed over ssh stdin). This
 * module is intentionally free of any `vscode` import, allowing it to be
 * bundled into a standalone Node script that runs on the SSH remote.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pure patch: given argv.json content and an extension ID, return the
 * patched content (with the ID added to enable-proposed-api) or null if
 * already patched. Uses jsonc-parser to preserve JSONC comments.
 */
export function patchArgvContent(
  content: string,
  extensionId: string,
): { patched: string; changed: boolean } | null {
  const { parse, modify, applyEdits } = require("jsonc-parser");
  const parsed = parse(content) as Record<string, unknown>;
  const existing = parsed["enable-proposed-api"];
  if (Array.isArray(existing) && existing.includes(extensionId)) {
    return null;
  }
  const newValue = Array.isArray(existing)
    ? [...existing, extensionId]
    : [extensionId];
  const edits = modify(content, ["enable-proposed-api"], newValue, {
    formattingOptions: {
      eol: "\n",
      insertSpaces: true,
      tabSize: 4,
    },
  });
  return { patched: applyEdits(content, edits), changed: true };
}

/** Result of applying an argv.json patch to the filesystem. */
export interface ApplyArgvPatchResult {
  /** The argv.json path that was chosen (existing, or created). */
  path: string;
  /** True if the file was written; false if already patched. */
  changed: boolean;
  /** True if the file did not exist and was created. */
  created: boolean;
}

/**
 * Apply the argv.json patch to the filesystem.
 *
 * Probes the candidate paths, picks the first that exists (or the first
 * candidate if none exist, creating it). Patches enable-proposed-api via
 * patchArgvContent (comment-preserving) and writes back atomically: temp
 * file + fsync + rename. Returns the chosen path and what happened.
 *
 * Synchronous on purpose: the remote script runs once and exits, and the
 * sync fs calls keep the bundled script small and dependency-free.
 */
export function applyArgvPatch(
  extensionId: string,
  candidates: string[],
): ApplyArgvPatchResult {
  if (candidates.length === 0) {
    throw new Error("applyArgvPatch: no candidate paths provided");
  }

  let target = candidates[0];
  let exists = false;
  for (const c of candidates) {
    try {
      fs.accessSync(c);
      target = c;
      exists = true;
      break;
    } catch {
      // Not this one; try the next candidate.
    }
  }

  let content: string;
  let created = false;
  if (exists) {
    content = fs.readFileSync(target, "utf-8");
  } else {
    // Create at the first candidate. Seed with an empty object so the
    // jsonc patch adds enable-proposed-api as the only key.
    content = "{}";
    created = true;
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  const result = patchArgvContent(content, extensionId);
  if (!result) {
    return { path: target, changed: false, created: false };
  }

  writeFileAtomic(target, result.patched);
  return { path: target, changed: true, created };
}

/** Write a file atomically: temp file in the same dir + fsync + rename. */
function writeFileAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, "utf-8");
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync may fail on some filesystems; the rename still publishes
      // the new content, just without the durability guarantee.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}
