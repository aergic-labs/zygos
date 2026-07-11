/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Tree data provider for the "SSH Targets" view in the Remote Explorer.
 *
 * Flat list of hosts from ~/.ssh/config. Per-host context menu:
 * Connect, Open Remote Terminal, Show Server Log.
 */

import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import { loadSshConfig, hostConfigToDestination } from "../ssh/sshConfig";

/** contextValue string - used in package.json when clauses. */
const CTX_HOST = "zygos.host";

export class SshHostTreeProvider implements vscode.TreeDataProvider<HostItem> {
  private _onDidChange = new vscode.EventEmitter<HostItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly logger: Logger,
    _globalState: vscode.Memento,
  ) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: HostItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: HostItem): Promise<HostItem[]> {
    if (element) return [];
    try {
      const { hosts } = await loadSshConfig();
      return hosts.map((alias) => new HostItem(alias));
    } catch (err) {
      this.logger.error(`[tree] failed to load ssh config: ${err}`);
      return [];
    }
  }
}

export class HostItem extends vscode.TreeItem {
  readonly destination: { host: string; user?: string; port?: number };

  constructor(public readonly alias: string) {
    super(alias, vscode.TreeItemCollapsibleState.None);
    this.contextValue = CTX_HOST;
    this.iconPath = new vscode.ThemeIcon("server");
    // Resolve the destination lazily from the alias - the config lookup
    // happens when commands fire, not here, to avoid a sync fs read per
    // tree render.
    this.destination = { host: alias };
    this.tooltip = `SSH: ${alias}`;
  }

  /** Resolve the full destination from ssh config (async, for commands). */
  async resolveDestination(): Promise<{
    host: string;
    user?: string;
    port?: number;
  }> {
    const { getConfig } = await loadSshConfig();
    const cfg = getConfig(this.alias);
    if (cfg) return hostConfigToDestination(cfg);
    return { host: this.alias };
  }
}
