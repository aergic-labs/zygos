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
import * as path from "node:path";
import type { Logger } from "../common/logger";
import { getConfigPath, sshSettings } from "../ssh/sshConfig";
import { encodeAuthority, parseSshDestination } from "../ssh/destination";
import { detectPlatform, getProductInfo } from "../platform";
import { buildServerDownloadUrl, downloadUrlLogMessage } from "../remote/url";
import { REMOTE_DIR_NAME } from "../remote/busybox";
import { AskpassServer } from "../ssh/askpassServer";
import type {
  FolderDescriptor,
  FolderHistoryManager,
} from "../remote/folderHistory";
import { SshHostTreeProvider, HostItem, RecentFolderItem } from "./treeView";

// Build-time flag gates the testDownloadUrl command to VSCodium builds only
// (Kiro is hardcoded - there's nothing to test).
declare const HAS_VSCODIUM_ADAPTER: boolean;

export function registerHostCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  folderHistory: FolderHistoryManager,
): void {
  // --- Tree view ---
  const treeProvider = new SshHostTreeProvider(logger, folderHistory);
  // The SSH Targets view is contributed with remoteName: "ssh-remote", so it
  // only has a view descriptor in local windows and ssh-remote windows.
  // In a devcontainer child window the view is not contributed, and
  // createTreeView would toast "No view is registered with id: zygos.hosts".
  // zygos can still activate there because artizo's resolver chains through
  // resolveAuthority('ssh-remote+...'), firing onResolveRemoteAuthority:ssh-remote
  // in the devcontainer exthost. Gate the view registration on the window's
  // own remote authority to avoid the toast.
  const remoteName = vscode.env.remoteName;
  const viewContributedHere =
    remoteName === undefined || remoteName === "ssh-remote";
  if (viewContributedHere) {
    const treeView = vscode.window.createTreeView("zygos.hosts", {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(treeView);
  } else {
    logger.info(
      `[host] skipping zygos.hosts tree view registration (remoteName=${remoteName || "none"})`,
    );
  }

  // Auto-refresh the tree when the history changes (capture after connect,
  // addFolders after explicit open, removeFolder after forget). Matches
  // the artizo explorer's onDidChange subscription.
  context.subscriptions.push(folderHistory.onDidChange(() => treeProvider.refresh()));

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
        logger.info(`[terminal] opening on ${item.alias}`);
        const opts = await buildSshTerminalOptions(context, logger, item.alias);
        const terminal = vscode.window.createTerminal({
          name: `SSH: ${item.alias}`,
          shellPath: opts.sshPath,
          shellArgs: opts.sshArgs,
          env: opts.env,
        });
        if (opts.onClose) {
          const disp = vscode.window.onDidCloseTerminal((t) => {
            if (t !== terminal) return;
            void opts.onClose?.();
            disp.dispose();
          });
          context.subscriptions.push(disp);
        }
        terminal.show();
      },
    ),

    // Tail the server log on the host. The session-path server start
    // wrapper (`scripts/sshSession/start-server.sh`) redirects the REH
    // server's stdout+stderr to ~/.ssh-remote/server-start.log (see
    // `startServerSession` in `src/resolver/index.ts`).
    vscode.commands.registerCommand(
      "zygos.showServerLog",
      async (item: HostItem) => {
        if (!item) return;
        const logPath = `~/${REMOTE_DIR_NAME}/server-start.log`;
        logger.info(`[server-log] tailing ${logPath} on ${item.alias}`);
        const opts = await buildSshTerminalOptions(context, logger, item.alias);
        const terminal = vscode.window.createTerminal({
          name: `Server Log: ${item.alias}`,
          shellPath: opts.sshPath,
          shellArgs: [...opts.sshArgs, `tail -f ${logPath}`],
          env: opts.env,
        });
        if (opts.onClose) {
          const disp = vscode.window.onDidCloseTerminal((t) => {
            if (t !== terminal) return;
            void opts.onClose?.();
            disp.dispose();
          });
          context.subscriptions.push(disp);
        }
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

    // --- Recent folder actions (children of host items) ---
    // Open a recently used remote folder. Reopening also re-captures, which
    // dedupes + moves the entry to the front (most-recent-first).
    vscode.commands.registerCommand(
      "zygos.explorer.openFolderCurrentWindow",
      async (item: RecentFolderItem) => {
        if (!item) return;
        await folderHistory.addFolders([item.descriptor]);
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          item.descriptor.toUri(),
          { forceReuseWindow: true },
        );
      },
    ),

    vscode.commands.registerCommand(
      "zygos.explorer.openFolderNewWindow",
      async (item: RecentFolderItem) => {
        if (!item) return;
        await folderHistory.addFolders([item.descriptor]);
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          item.descriptor.toUri(),
          { forceNewWindow: true },
        );
      },
    ),

    // Forget: remove the visual link only. The folder on the remote host
    // is not touched. No confirmation dialog - the label + tooltip make
    // the scope clear (matches MS Remote-SSH).
    vscode.commands.registerCommand(
      "zygos.explorer.forgetFolder",
      async (item: RecentFolderItem) => {
        if (!item) return;
        const descriptor: FolderDescriptor = item.descriptor;
        await folderHistory.removeFolder(descriptor);
        treeProvider.refresh();
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
 * Build ssh args + env for a terminal ssh invocation (zygos.openTerminal,
 * zygos.showServerLog). Mirrors SshSession.buildSshConfig so the terminal
 * ssh gets the same host-key handling, connect timeout, and askpass wiring
 * as the persistent session:
 *   - ConnectTimeout: from zygos.tcpTimeout (default 15s).
 *   - askpass (when zygos.askpass, default true): route password/passphrase
 *     prompts through a VS Code input box instead of the terminal. The
 *     AskpassServer is started here and disposed when the terminal closes
 *     (onClose). Matches SshSession.buildSshConfig, which also leaves
 *     StrictHostKeyChecking at ssh's default and routes the host-key
 *     confirmation through askpass so a user's `~/.ssh/config`
 *     StrictHostKeyChecking setting is respected (not overridden by -o).
 */
async function buildSshTerminalOptions(
  context: vscode.ExtensionContext,
  logger: Logger,
  alias: string,
): Promise<{
  sshPath: string;
  sshArgs: string[];
  env?: Record<string, string>;
  onClose?: () => Promise<void>;
}> {
  const { sshPath, configFile, tcpTimeoutSeconds } = sshSettings();
  const sshArgs: string[] = [];
  if (tcpTimeoutSeconds && tcpTimeoutSeconds > 0) {
    sshArgs.push("-o", `ConnectTimeout=${tcpTimeoutSeconds}`);
  }
  if (configFile) sshArgs.push("-F", configFile);
  sshArgs.push(alias);

  const askpassEnabled = vscode.workspace
    .getConfiguration("zygos")
    .get<boolean>("askpass", true);
  if (!askpassEnabled) {
    return { sshPath: sshPath ?? "ssh", sshArgs };
  }

  // Best-effort askpass: if the server fails to start, fall back to
  // terminal prompts rather than blocking the command.
  let server: AskpassServer | undefined;
  try {
    server = new AskpassServer(logger, {
      showPrompt: (prompt, errorMessage) =>
        vscode.window.showInputBox({
          password: true,
          prompt: errorMessage ? `${prompt} (${errorMessage})` : prompt,
          title: "Zygos SSH Authentication",
          ignoreFocusOut: true,
        }),
    });
    await server.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(`[host] askpass server start failed, falling back to terminal prompts: ${msg}`);
    return { sshPath: sshPath ?? "ssh", sshArgs };
  }

  const scriptsDir = path.join(context.extensionPath, "scripts", "askpass");
  const script =
    process.platform === "win32"
      ? path.join(scriptsDir, "askpass.cmd")
      : path.join(scriptsDir, "askpass.sh");
  const main = path.join(scriptsDir, "askpass-main.js");
  const nodePath = process.execPath;
  const env: Record<string, string> = {
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "zygos",
    AERGIC_SSH_ASKPASS_HANDLE: server.handle,
    AERGIC_SSH_ASKPASS_TOKEN: server.token,
    AERGIC_SSH_ASKPASS_NODE: nodePath,
    AERGIC_SSH_ASKPASS_MAIN: main,
  };
  return {
    sshPath: sshPath ?? "ssh",
    sshArgs,
    env,
    onClose: () => server!.stop(),
  };
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
    const result = await buildServerDownloadUrl(info, platform, os, arch);
    logger.info(downloadUrlLogMessage(platform, result.type));
    url = result.url;
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
