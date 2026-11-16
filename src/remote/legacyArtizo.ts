/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Remove the artizo copy that older versions side-loaded onto the SSH host.
 *
 * artizo used to declare `["workspace", "ui"]` and copy itself into the
 * remote's extensions directory so it could drive Docker there. It is now
 * UI-only and drives everything through the ExecServer, so that remote copy
 * is dead weight: its manifest still claims `workspace`, so the remote
 * extension host keeps loading it.
 *
 * zygos owns the cleanup because it is the only extension guaranteed to run
 * UI-side in an SSH window. The contract with artizo:
 *
 * - Only act when a local artizo is installed *and* declares
 *   `extensionKind: ["ui"]` - i.e. the upgrade has happened. An old local
 *   artizo still needs its remote half.
 * - Only delete folders that carry the `.artizo-sideloaded` marker. Manual
 *   VSIX installs on the host have `source: "vsix"` too but no marker, so the
 *   marker is the tell, not the metadata.
 * - Do it once per authority, then reload so the remote host stops starting
 *   the removed extension.
 */

import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import type { PlatformAdapter } from "../platform";

/** Marker artizo's old side-load wrote into the copied folder. */
const SIDELOAD_MARKER = ".artizo-sideloaded";
/** Global-state key prefix: cleanup already attempted for this authority. */
const FLAG_PREFIX = "zygos.legacyArtizoCleanup.";

/** True when the installed artizo is the UI-only build. */
export function localArtizoIsUiOnly(): boolean {
  return vscode.extensions.all.some((ext) => {
    if (!(ext.id ?? "").toLowerCase().startsWith("aergic.artizo")) return false;
    const declared = (ext.packageJSON as { extensionKind?: unknown })
      .extensionKind;
    const kinds = Array.isArray(declared)
      ? declared
      : typeof declared === "string"
        ? [declared]
        : [];
    return kinds.length === 1 && kinds[0] === "ui";
  });
}

/** The SSH authority of this window, if any. */
export function currentSshAuthority(): string | undefined {
  let authority: string | undefined;
  try {
    authority = (vscode.env as { remoteAuthority?: string }).remoteAuthority;
  } catch {
    // Gated behind the resolvers proposal before argv.json is patched.
    return undefined;
  }
  return authority?.startsWith("ssh-remote") ? authority : undefined;
}

async function hasMarker(folder: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, SIDELOAD_MARKER));
    return true;
  } catch {
    return false;
  }
}

/** Drop ledger entries that point at the removed folder. */
async function dropFromExtensionsJson(
  dirUri: vscode.Uri,
  folderName: string,
  logger: Logger,
): Promise<void> {
  const jsonUri = vscode.Uri.joinPath(dirUri, "extensions.json");
  let entries: unknown[];
  try {
    const raw = await vscode.workspace.fs.readFile(jsonUri);
    const parsed = JSON.parse(Buffer.from(raw).toString("utf-8")) as unknown;
    if (!Array.isArray(parsed)) return;
    entries = parsed;
  } catch {
    // Missing or unparseable ledger: the folder is gone, which is what
    // matters. The scanner ignores unknown folders.
    return;
  }

  const kept = entries.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const record = entry as {
      relativeLocation?: unknown;
      identifier?: { id?: unknown };
    };
    if (record.relativeLocation === folderName) return false;
    const id = record.identifier?.id;
    return !(typeof id === "string" && id.toLowerCase().startsWith("aergic.artizo"));
  });

  if (kept.length === entries.length) return;
  try {
    await vscode.workspace.fs.writeFile(
      jsonUri,
      Buffer.from(JSON.stringify(kept, null, 2)),
    );
    logger.info(
      `[legacy] dropped ${entries.length - kept.length} artizo entr(ies) from ${jsonUri.path}`,
    );
  } catch (err) {
    logger.info(
      `[legacy] could not rewrite ${jsonUri.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface LegacyArtizoCleanupDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  platform: PlatformAdapter;
  /** Run a command on the host over the window's existing connection. */
  execOnHost: (command: string) => Promise<{ stdout: string; exitCode: number | null } | undefined>;
}

/**
 * Best-effort, idempotent: returns the number of folders removed.
 */
/** Off in production: the cleanup ships in the tree and never runs. */
const ENABLED = false;

export async function removeSideloadedArtizo(
  deps: LegacyArtizoCleanupDeps,
): Promise<number> {
  if (!ENABLED) return 0;
  const { context, logger, platform } = deps;
  const authority = currentSshAuthority();
  if (!authority) return 0;

  const flagKey = FLAG_PREFIX + authority;
  if (context.globalState.get<boolean>(flagKey)) return 0;

  if (!localArtizoIsUiOnly()) {
    logger.info("[legacy] local artizo is absent or not UI-only; leaving remote install");
    return 0;
  }

  const homeResult = await deps.execOnHost("printenv HOME");
  const home = homeResult?.stdout.trim();
  if (!homeResult || homeResult.exitCode !== 0 || !home) {
    // No live connection yet. Leave the flag unset so a later window retries.
    logger.info("[legacy] no live host connection; skipping cleanup this window");
    return 0;
  }

  const candidates = platform.getRemoteExtensionsDirCandidates?.() ?? [];
  let removed = 0;

  for (const relative of candidates) {
    const dirPath = `${home}/${relative}`.replace(/\/{2,}/g, "/");
    const dirUri = vscode.Uri.parse(`vscode-remote://${authority}${dirPath}`);

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch (err) {
      logger.info(
        `[legacy] cannot read ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      if (!/^aergic\.artizo/i.test(name)) continue;

      const folderUri = vscode.Uri.joinPath(dirUri, name);
      if (!(await hasMarker(folderUri))) {
        logger.info(`[legacy] ${dirPath}/${name} has no marker; leaving it`);
        continue;
      }

      try {
        await vscode.workspace.fs.delete(folderUri, {
          recursive: true,
          useTrash: false,
        });
        removed++;
        logger.info(`[legacy] removed ${dirPath}/${name}`);
      } catch (err) {
        logger.info(
          `[legacy] could not remove ${dirPath}/${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      await dropFromExtensionsJson(dirUri, name, logger);
    }
  }

  if (removed === 0) {
    // Nothing to remove on this host. Remember it so we stop probing.
    await context.globalState.update(flagKey, true);
    return 0;
  }

  // Record before reloading so a re-entrant activation cannot loop.
  await context.globalState.update(flagKey, true);
  logger.info(`[legacy] removed ${removed} side-loaded artizo folder(s); reloading`);
  void vscode.window
    .showInformationMessage(
      `Zygos removed an outdated Artizo copy from the remote host. The window will reload.`,
    )
    .then(() => vscode.commands.executeCommand("workbench.action.reloadWindow"));
  return removed;
}