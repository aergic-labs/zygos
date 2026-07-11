/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Host commands + the SSH Targets tree view.
 *
 *  - zygos.connect: pick a host + open a remote window.
 *  - zygos.connectToHost: same, in current window.
 *  - zygos.openConfigFile: open ~/.ssh/config in the editor.
 *  - zygos.addHost: open ~/.ssh/config at top for adding a host.
 *  - zygos.refresh: refresh the tree view.
 *  - zygos.openTerminal: open a remote terminal on a host.
 *  - zygos.showServerLog: tail the server log on a host.
 *  - zygos.openFolderInNewWindow: open a folder on a host in a new window.
 *  - zygos.testDownloadUrl: (VSCodium only) verify download URL.
 */

import * as vscode from "vscode";
import type { Logger } from "../common/logger";
import { getConfigPath } from "../ssh/sshConfig";
import { encodeAuthority, parseSshDestination } from "../ssh/destination";
import { detectPlatform, getProductInfo } from "../platform";
import { buildServerDownloadUrl } from "../server/url";
import { SshHostTreeProvider, HostItem } from "./treeView";

// Build-time flag gates the testDownloadUrl command to VSCodium builds only
// (Kiro is hardcoded - there's nothing to test).
declare const HAS_VSCODIUM_ADAPTER: boolean;

export function registerHostCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
): void {
  // --- Tree view ---
  const treeProvider = new SshHostTreeProvider(logger, context.globalState);
  const treeView = vscode.window.createTreeView("zygos.hosts", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("zygos.connect", () =>
      runConnect(logger, false),
    ),

    vscode.commands.registerCommand("zygos.connectToHost", () =>
      runConnect(logger, true),
    ),

    vscode.commands.registerCommand("zygos.openConfigFile", async () => {
      const cfgPath = getConfigPath();
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(cfgPath),
      );
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("zygos.addHost", async () => {
      const cfgPath = getConfigPath();
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(cfgPath),
      );
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(0, 0, 0, 0),
      });
    }),

    vscode.commands.registerCommand("zygos.refresh", () => {
      logger.info("refresh requested");
      treeProvider.refresh();
    }),

    // Open a remote terminal on the host.
    vscode.commands.registerCommand(
      "zygos.openTerminal",
      async (item: HostItem) => {
        if (!item) return;
        const dest = await item.resolveDestination();
        const label = dest.user
          ? `${dest.user}@${dest.host}${dest.port ? `:${dest.port}` : ""}`
          : dest.host;
        logger.info(`[terminal] opening on ${label}`);
        const terminal = vscode.window.createTerminal({
          name: `SSH: ${label}`,
          shellPath: "ssh",
          shellArgs: [label],
        });
        terminal.show();
      },
    ),

    // Tail the server log on the host.
    vscode.commands.registerCommand(
      "zygos.showServerLog",
      async (item: HostItem) => {
        if (!item) return;
        const dest = await item.resolveDestination();
        const label = dest.user
          ? `${dest.user}@${dest.host}${dest.port ? `:${dest.port}` : ""}`
          : dest.host;
        const platform = detectPlatform();
        const info = getProductInfo(platform);
        const logPath = `~/.${info.serverDataFolderName}/.${info.commit}.log`;
        logger.info(`[server-log] tailing ${logPath} on ${label}`);
        const terminal = vscode.window.createTerminal({
          name: `Server Log: ${label}`,
          shellPath: "ssh",
          shellArgs: [label, `tail -f ${logPath}`],
        });
        terminal.show();
      },
    ),

    // Connect to a host from the tree view. Opens a new window - VS Code
    // shows its own native remote folder picker after connecting.
    vscode.commands.registerCommand(
      "zygos.connectFromTree",
      async (item: HostItem) => {
        if (!item) return;
        const dest = await item.resolveDestination();
        const authority = `ssh-remote+${encodeAuthority(dest)}`;
        await vscode.commands.executeCommand("vscode.newWindow", {
          remoteAuthority: authority,
          reuseWindow: false,
        });
      },
    ),
  );

  // VSCodium-only: test a custom server download template via HEAD request.
  if (HAS_VSCODIUM_ADAPTER) {
    context.subscriptions.push(
      vscode.commands.registerCommand("zygos.testDownloadUrl", () =>
        runTestDownloadUrl(logger),
      ),
    );
  }
}

/**
 * Prompt the user to pick a host. Accepts a config alias or user@host:port.
 * The input is passed directly to ssh - ssh handles config resolution,
 * auth, keys, agent, ProxyJump, etc.
 */
async function pickHost(): Promise<string | null> {
  const input = await vscode.window.showInputBox({
    prompt: "Enter host (user@host:port or ~/.ssh/config alias)",
    placeHolder: "user@example.com",
    ignoreFocusOut: true,
  });
  return input?.trim() || null;
}

async function runConnect(
  logger: Logger,
  reuseWindow: boolean,
): Promise<void> {
  logger.show();
  const hostInput = await pickHost();
  if (!hostInput) return;

  const dest = parseSshDestination(hostInput);
  const authority = `ssh-remote+${encodeAuthority(dest)}`;

  logger.info(`Connecting to ${hostInput} -> ${authority}`);
  // Use vscode.newWindow with remoteAuthority (like the official Remote-SSH
  // extension). VS Code opens the remote window and shows the folder picker,
  // defaulting to the remote user's HOME. No hardcoded path.
  await vscode.commands.executeCommand("vscode.newWindow", {
    remoteAuthority: authority,
    reuseWindow,
  });
}

/**
 * Resolve the configured (or default) server download URL with current
 * product.json values and HEAD-request it to verify reachability.
 * VSCodium-only command to validate a custom template before connecting.
 */
async function runTestDownloadUrl(logger: Logger): Promise<void> {
  const platform = detectPlatform();
  const info = getProductInfo(platform);
  const os = "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";

  let url: string;
  try {
    url = await buildServerDownloadUrl(info, platform, os, arch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to resolve URL: ${msg}`);
    return;
  }

  // If the template still has an unsubstituted ${...}, report it.
  if (/\$\{[^}]+\}/.test(url)) {
    const unresolved = url.match(/\$\{[^}]+\}/g) ?? [];
    void vscode.window.showWarningMessage(
      `Resolved URL has unsubstituted variables: ${unresolved.join(", ")}\nURL: ${url}`,
    );
    return;
  }

  logger.info(`[testDownloadUrl] HEAD ${url}`);
  try {
    // 15s timeout; a server that accepts the connection but never
    // responds would otherwise hang forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const len = res.headers.get("content-length");
      const mb = len
        ? `${(Number(len) / 1024 / 1024).toFixed(1)} MB`
        : "size unknown";
      void vscode.window.showInformationMessage(
        `Reachable (HTTP ${res.status}, ${mb}).\nURL: ${url}`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `HTTP ${res.status} ${res.statusText}.\nURL: ${url}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Unreachable: ${msg}\nURL: ${url}`);
  }
}
