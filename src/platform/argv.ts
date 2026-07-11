/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Patch the IDE's argv.json to add the extension ID to
 * `enable-proposed-api`.
 *
 * Forks based on VS Code require proposed-API extensions to be listed in
 * argv.json (not just `enabledApiProposals` in package.json). Without it,
 * calling `registerRemoteAuthorityResolver` throws:
 *   "Extension '...' CANNOT use API proposal: resolvers."
 *
 * Uses jsonc-parser for comment-preserving edits, atomic writes
 * (temp + fsync + rename), and multiple candidate path probing.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import type { PlatformAdapter } from "../platform/types";
import type { Logger } from "../common/logger";
import { applyArgvPatch } from "../host/argvPatch";

// Build-time flag determines the published extension name (zygos-kiro vs
// zygos-vscodium). The argv.json entry must match the installed VSIX's
// extension ID, or the proposed-API gate rejects the extension and
// registerResolver throws before commands are wired.
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_VSCODIUM_ADAPTER: boolean;

/** Resolve the extension ID for argv.json from build-time adapter flags. */
function getArgvExtensionId(): string {
  return HAS_KIRO_ADAPTER ? "aergic.zygos-kiro" : "aergic.zygos-vscodium";
}

/** The extension ID to add to argv.json. */
const EXTENSION_ID = getArgvExtensionId();

/**
 * Ensure the extension is listed in argv.json's enable-proposed-api array.
 * Returns true if the file was modified (caller should prompt for restart).
 */
export async function ensureArgvProposedApi(
  platform: PlatformAdapter,
  logger: Logger,
): Promise<boolean> {
  if (!platform.needsArgvPatch()) {
    logger.info("[argv] needsArgvPatch=false, skipping");
    return false;
  }

  const home = os.homedir();
  const folderNames = platform.getArgvDataFolderNames?.() ?? [
    platform.dataFolderName,
  ];
  const candidates = folderNames.map((f) => path.join(home, f, "argv.json"));

  logger.info(`[argv] candidates=${JSON.stringify(candidates)}`);

  let result;
  try {
    result = applyArgvPatch(EXTENSION_ID, candidates);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[argv] patch failed: ${msg}`);
    return false;
  }

  logger.info(
    `[argv] path=${result.path} changed=${result.changed} created=${result.created}`,
  );

  return result.changed;
}

/**
 * Check if argv.json needs patching and prompt the user to restart if so.
 * Returns true if a restart is needed.
 */
export async function checkArgvAndPromptRestart(
  platform: PlatformAdapter,
  logger: Logger,
): Promise<boolean> {
  const patched = await ensureArgvProposedApi(platform, logger);

  if (!patched) {
    return false;
  }

  logger.info("[argv] restart required - prompting user (modal)");
  const action = await vscode.window.showErrorMessage(
    `Zygos needs to restart ${platform.name} to enable the remote authority API. Please quit and reopen ${platform.name}.`,
    { modal: true },
    `Quit ${platform.name}`,
  );

  if (action === `Quit ${platform.name}`) {
    await vscode.commands.executeCommand("workbench.action.quit");
  }

  return true;
}
