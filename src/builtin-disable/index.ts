/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { PlatformAdapter } from "../platform/types";
import type { Logger } from "../common/logger";

/**
 * Detect conflicting SSH-remote extensions and set a context key
 * that gates zygos commands in the palette.
 *
 * No globalState, no settings.json writing, no auto-disable.
 * The source of truth is always "is there an extension declaring
 * onResolveRemoteAuthority:ssh-remote right now?".
 *
 * When a conflict is found:
 *   - Sets `zygos.conflict = true` context key (hides all zygos
 *     commands except zygos.showConflictInfo)
 *   - Shows a popup naming the conflicting extension(s) with a
 *     "Show Details" button that writes a full explanation to the
 *     output channel
 *   - Does NOT register the resolver
 *
 * The user must disable/uninstall the conflicting extension manually.
 */

/** Context key set when a conflict is detected. */
export const CONFLICT_CONTEXT_KEY = "zygos.conflict";

/**
 * Check for conflicts at activation. Returns the list of conflicting
 * extension IDs (empty if none). Also sets the context key and shows
 * a popup if conflicts are found.
 */
export async function checkForConflicts(
  platform: PlatformAdapter,
  logger: Logger,
): Promise<string[]> {
  const ids = findConflictingExtensions(platform, logger);
  if (ids.length === 0) {
    logger.info("[conflict] no conflicting SSH extensions found");
    await vscode.commands.executeCommand(
      "setContext",
      CONFLICT_CONTEXT_KEY,
      false,
    );
    return [];
  }

  const list = ids.join(", ");
  logger.info(`[conflict] conflicting SSH extensions: ${list}`);
  await vscode.commands.executeCommand(
    "setContext",
    CONFLICT_CONTEXT_KEY,
    true,
  );

  showConflictPopup(ids, logger);

  return ids;
}

/**
 * Command handler: shows the conflict info popup again.
 * Used when the user runs the one visible command during a conflict.
 */
export function showConflictInfo(conflictIds: string[], logger: Logger): void {
  showConflictPopup(conflictIds, logger);
}

function showConflictPopup(ids: string[], logger: Logger): void {
  const list = ids.join(", ");
  const btn = "Show Details";
  void vscode.window
    .showErrorMessage(
      `Zygos cannot run while ${list} is active. Disable or uninstall it, then reload.`,
      btn,
    )
    .then((choice) => {
      if (choice === btn) {
        writeConflictDetails(ids, logger);
      }
    });
}

function writeConflictDetails(ids: string[], logger: Logger): void {
  const list = ids.join(", ");
  const lines = [
    "Zygos Remote SSH - SSH Resolver Conflict",
    "========================================",
    "",
    `Conflicting extension(s): ${list}`,
    "",
    "Zygos and the extension(s) above both register a resolver for the",
    "'ssh-remote' authority. VS Code only allows one - the first to activate",
    "wins, the rest are silently ignored.",
    "",
    "On some forks (e.g. Trae), the built-in SSH extension activates first",
    "and is protected - it cannot be disabled via settings or the UI.",
    "",
    "To resolve:",
    "  1. Extensions panel (Ctrl+Shift+X)",
    `  2. Search for: ${ids[0]}`,
    "     If not found, try: @builtin ${ids[0]}",
    "  3. Right-click -> Disable (or Uninstall)",
    "  4. Reload (Ctrl+Shift+P -> Developer: Reload Window)",
    "",
    "If the conflicting extension is a protected built-in (e.g. Trae),",
    "Zygos cannot function on this IDE. Use a different fork, or wait for",
    "the IDE to remove the protected status.",
    "",
    "Details:",
  ];

  for (const id of ids) {
    const ext = vscode.extensions.getExtension(id);
    if (ext) {
      const pj = ext.packageJSON as Record<string, unknown> | undefined;
      const name = (pj?.displayName as string) ?? (pj?.name as string) ?? id;
      const version = (pj?.version as string) ?? "unknown";
      const publisher = (pj?.publisher as string) ?? "unknown";
      lines.push(
        `  - ${id}`,
        `    Name: ${name}`,
        `    Publisher: ${publisher}`,
        `    Version: ${version}`,
        `    Path: ${ext.extensionPath}`,
      );
    } else {
      lines.push(`  - ${id} (not found in extension API)`);
    }
  }

  logger.showLines(lines);
}

/**
 * Find extensions that declare onResolveRemoteAuthority:ssh-remote
 * in their activationEvents and are currently installed.
 */
function findConflictingExtensions(
  platform: PlatformAdapter,
  logger: Logger,
): string[] {
  const ids = platform.getConflictingSshExtensionIds?.() ?? [];
  if (ids.length === 0) {
    logger.info("[conflict] getConflictingSshExtensionIds returned none");
    return [];
  }

  const present = ids.filter((id) => !!vscode.extensions.getExtension(id));
  logger.info(
    `[conflict] candidates=${ids.join(",")} present=${present.join(",")}`,
  );
  return present;
}
