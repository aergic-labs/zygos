/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Recent-folder history for the Remote Explorer.
 *
 * Shared between zygos (SSH Targets) and artizo (Dev Containers). Stores
 * `(remote, folder)` pairs in `globalState`, namespaced per extension so the
 * two histories don't cross-pollute when both extensions are installed in the
 * same IDE. Pure storage + capture logic — no `TreeItem`, no command
 * registration, no `ExecutionTier` knowledge. The tier check (which tier am
 * I at, should I capture here) is the caller's responsibility.
 *
 * Pattern follows MS Remote-SSH's `FolderHistoryManager`
 * (`extension-beautified.js` L21843-21934): `{ [remote]: string[] (folders) }`
 * in a single globalState key, most-recent-first, dedup on add.
 */

import * as vscode from "vscode";

/**
 * A (remote authority, folder path) pair — one entry in the history.
 *
 * `remote` is the FULL `vscode-remote://` authority string
 * (e.g. `ssh-remote+7b22...`, `artizo-container+6f72...`). Storing the
 * full authority (not just the post-`+` payload) keeps `toUri()` lossless:
 * the payload half can itself contain `+` (a container authority whose hex
 * decodes to a path with `+`), so splitting would lose the scheme and make
 * the URI unreopenable. Grouping by the full authority also keeps distinct
 * resolver types (`ssh-remote` vs `artizo-container`) in separate groups
 * even before the per-extension `keyPrefix` namespace is applied.
 */
export class FolderDescriptor {
  constructor(readonly remote: string, readonly folder: string) {}

  /**
   * Build a descriptor from a workspace URI. Returns null for URIs that
   * aren't `vscode-remote://` (local folders, untitled, etc.) or that
   * have no authority, or whose authority has no `scheme+` separator
   * (a bare authority can't be reopened, so don't history it).
   */
  static fromUri(uri: vscode.Uri): FolderDescriptor | null {
    if (uri.scheme !== "vscode-remote") return null;
    const authority = uri.authority;
    if (!authority || !authority.includes("+")) return null;
    return new FolderDescriptor(authority, uri.path);
  }

  /** Render back to a `vscode-remote://` URI. */
  toUri(): vscode.Uri {
    return vscode.Uri.parse(`vscode-remote://${this.remote}${this.folder}`);
  }
}

/** Options for {@link FolderHistoryManager}. */
export interface FolderHistoryOptions {
  /** globalState from ExtensionContext. */
  state: vscode.Memento;
  /**
   * Namespace for the globalState key so artizo and zygos don't collide
   * when both are installed in the same IDE. The full key is
   * `${keyPrefix}.folderHistory.v1`.
   */
  keyPrefix: string;
}

/**
 * Persists recent-folder history in `globalState`. Read/add/remove/list —
 * no tree, no commands. The caller wires this into its own tree view and
 * command registrations.
 */
export class FolderHistoryManager {
  private readonly state: vscode.Memento;
  private readonly key: string;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after `addFolders` or `removeFolder` mutates the store. */
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  constructor(options: FolderHistoryOptions) {
    this.state = options.state;
    this.key = `${options.keyPrefix}.folderHistory.v1`;
  }

  /**
   * Add folders to the history. Dedupes (moves existing to front) and
   * caps at 20 entries per remote. Fire-and-forget safe: errors are
   * swallowed by globalState.update's promise.
   */
  async addFolders(folders: readonly FolderDescriptor[]): Promise<void> {
    if (folders.length === 0) return;
    const data = this.read();
    for (const f of folders) {
      let list = data[f.remote] ?? [];
      list = list.filter((p) => p !== f.folder);
      list.unshift(f.folder);
      data[f.remote] = list.slice(0, 20);
    }
    await this.state.update(this.key, data);
    this._onDidChange.fire();
  }

  /**
   * Remove one folder from the history. Returns true if anything was
   * deleted. Prunes the remote key when its list becomes empty so the
   * tree doesn't show empty groups.
   */
  async removeFolder(folder: FolderDescriptor): Promise<boolean> {
    const data = this.read();
    const list = data[folder.remote];
    if (!list) return false;
    const next = list.filter((p) => p !== folder.folder);
    if (next.length === list.length) return false;
    if (next.length === 0) {
      delete data[folder.remote];
    } else {
      data[folder.remote] = next;
    }
    await this.state.update(this.key, data);
    this._onDidChange.fire();
    return true;
  }

  /** All folders for a given remote authority, most-recent-first. */
  getFolders(remote: string): FolderDescriptor[] {
    const data = this.read();
    return (data[remote] ?? []).map((folder) => new FolderDescriptor(remote, folder));
  }

  /** All remote authorities that have at least one folder — for tree grouping. */
  getRemotes(): string[] {
    return Object.keys(this.read());
  }

  private read(): Record<string, string[]> {
    const raw = this.state.get<Record<string, string[]>>(this.key, {});
    return raw && typeof raw === "object" ? raw : {};
  }
}

/**
 * Capture the current workspace folders into history. Walks
 * `vscode.workspace.workspaceFolders`, filters to `vscode-remote` URIs
 * whose authority starts with `remoteNamePrefix` (e.g. `"ssh-remote"`,
 * `"artizo-container"`), and adds them. Idempotent and fire-and-forget:
 * errors are swallowed so a failed capture never fails activation or
 * the open path.
 *
 * The tier check (which tier am I at, should I capture here) is the
 * caller's responsibility — this helper doesn't look at `vscode.env.remoteName`
 * or `ExecutionTier`. It just filters by URI authority prefix.
 */
export async function captureCurrentWorkspace(
  history: FolderHistoryManager,
  remoteNamePrefix: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  const descriptors: FolderDescriptor[] = [];
  for (const f of folders) {
    const d = FolderDescriptor.fromUri(f.uri);
    if (d && d.remote.startsWith(remoteNamePrefix)) {
      descriptors.push(d);
    }
  }
  if (descriptors.length === 0) return;
  try {
    await history.addFolders(descriptors);
  } catch {
    // best effort — never fail the caller
  }
}
