/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tree data provider for the "SSH Targets" view in the Remote Explorer.
 *
 * Two-level tree:
 *   - Config hosts from ~/.ssh/config (collapsible, fold recent folders
 *     under each host). Per-host context menu: Connect, Open Terminal,
 *     Show Server Log.
 *   - "Orphan" recent authorities (folders opened for hosts not in
 *     ~/.ssh/config, e.g. a one-off `user@host:port`) shown as their own
 *     collapsible group, so every recent folder is reachable.
 *
 * Recent folders come from the shared `FolderHistoryManager`, namespaced
 * per-extension so they don't collide with artizo's container history.
 */

import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import { loadSshConfig, hostConfigToDestination } from "../ssh/sshConfig";
import {
  encodeAuthority,
  decodeAuthority,
  formatSshDestination,
} from "../ssh/destination";
import { FolderDescriptor, type FolderHistoryManager } from "../remote/folderHistory";

/** contextValue string - used in package.json when clauses. */
const CTX_HOST = "zygos.host";
const CTX_RECENT = "zygos.recentFolder";
const CTX_ORPHAN_GROUP = "zygos.recentGroup";

/**
 * Common interface for anything that carries a `remote` authority and can
 * parent recent-folder children. Both `HostItem` (config host) and
 * `RecentGroupItem` (orphan authority) implement it so `getChildren` can
 * fetch folders uniformly.
 */
interface RemoteParentItem {
  readonly remote: string;
}

export class SshHostTreeProvider
  implements vscode.TreeDataProvider<HostItem | RecentGroupItem | RecentFolderItem>
{
  private _onDidChange = new vscode.EventEmitter<
    HostItem | RecentGroupItem | RecentFolderItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly logger: Logger,
    private readonly history: FolderHistoryManager,
  ) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(
    element: HostItem | RecentGroupItem | RecentFolderItem,
  ): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: HostItem | RecentGroupItem | RecentFolderItem,
  ): Promise<(HostItem | RecentGroupItem | RecentFolderItem)[]> {
    if (element instanceof RecentFolderItem) return [];
    if (element instanceof HostItem || element instanceof RecentGroupItem) {
      return this.history
        .getFolders(element.remote)
        .map((d) => new RecentFolderItem(d));
    }
    // Root: config hosts (with folders nested under them) + orphan groups.
    try {
      const { hosts, getConfig } = await loadSshConfig();
      const hostItems: HostItem[] = [];
      const knownRemotes = new Set<string>();
      for (const alias of hosts) {
        const cfg = getConfig(alias);
        const resolved = cfg ? hostConfigToDestination(cfg) : { host: alias };
        // Key on the alias so ssh matches the Host block. Migrate any
        // history keyed on the old resolved authority (idempotent).
        const remote = `ssh-remote+${encodeAuthority({ host: alias })}`;
        if (cfg) await this.migrateHistory(remote, resolved);
        knownRemotes.add(remote);
        const hasFolders = this.history.getFolders(remote).length > 0;
        hostItems.push(
          new HostItem(alias, remote, hasFolders, resolved),
        );
      }
      // Orphans: authorities in history that don't match any config host.
      const orphans = this.history
        .getRemotes()
        .filter((r) => r.startsWith("ssh-remote+") && !knownRemotes.has(r));
      const orphanItems = orphans.map((r) => {
        const label = decodeLabel(r);
        return new RecentGroupItem(r, label);
      });
      return [...hostItems, ...orphanItems];
    } catch (err) {
      this.logger.error(`[tree] failed to load ssh config: ${err}`);
      return [];
    }
  }

  /** Move folder history from the old resolved authority to the alias. */
  private async migrateHistory(
    newRemote: string,
    resolved: { host: string; user?: string; port?: number },
  ): Promise<void> {
    const oldRemote = `ssh-remote+${encodeAuthority(resolved)}`;
    if (oldRemote === newRemote) return;
    const oldFolders = this.history.getFolders(oldRemote);
    if (oldFolders.length === 0) return;
    await this.history.addFolders(
      oldFolders.map((f) => new FolderDescriptor(newRemote, f.folder)),
    );
    for (const f of oldFolders) await this.history.removeFolder(f);
  }
}

/** Decode an `ssh-remote+<hex>` authority to `user@host:port` for labels. */
function decodeLabel(remote: string): string {
  const hex = remote.substring("ssh-remote+".length);
  try {
    return formatSshDestination(decodeAuthority(hex));
  } catch {
    return remote;
  }
}

/** A configured SSH host. Collapsible when it has recent folders. */
export class HostItem extends vscode.TreeItem implements RemoteParentItem {
  readonly destination: { host: string; user?: string; port?: number };

  constructor(
    public readonly alias: string,
    readonly remote: string,
    hasFolders: boolean,
    resolvedDestination: { host: string; user?: string; port?: number },
  ) {
    // Label is the alias (unambiguous per Host block); the resolved
    // user@host is the dimmed description so the row is identifiable.
    super(
      alias,
      hasFolders
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const desc = resolvedDestination.user
      ? `${resolvedDestination.user}@${resolvedDestination.host}`
      : resolvedDestination.host;
    this.description = desc !== alias ? desc : undefined;
    this.contextValue = CTX_HOST;
    this.iconPath = new vscode.ThemeIcon("server");
    this.destination = resolvedDestination;
    this.tooltip = `SSH: ${alias} (${desc})`;
  }

  /** Pass the alias straight to ssh so it matches the Host block. */
  async resolveDestination(): Promise<{
    host: string;
    user?: string;
    port?: number;
  }> {
    return { host: this.alias };
  }
}

/**
 * A collapsible group of recent folders for a host NOT in ~/.ssh/config
 * (e.g. a one-off `user@host:port`). Label is the decoded destination.
 */
export class RecentGroupItem extends vscode.TreeItem implements RemoteParentItem {
  constructor(readonly remote: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = CTX_ORPHAN_GROUP;
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = `Recent folders: ${label}`;
  }
}

/** A recently opened remote folder. Leaf node under HostItem / RecentGroupItem. */
export class RecentFolderItem extends vscode.TreeItem {
  constructor(readonly descriptor: FolderDescriptor) {
    const name = descriptor.folder.split("/").filter(Boolean).pop() ?? descriptor.folder;
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = descriptor.folder;
    this.contextValue = CTX_RECENT;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip =
      `Forget this folder from the Recent list. ` +
      `The folder on the remote host is not affected.\n` +
      `Path: ${descriptor.folder}`;
    this.command = {
      command: "zygos.explorer.openFolderCurrentWindow",
      title: "Open in Current Window",
      arguments: [this],
    };
  }
}
