/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import { detectPlatform, getProductInfo, readProductJson } from "./platform";
import { Logger } from "./common/logger";
import { checkForConflicts, showConflictInfo, findConflictingExtensions } from "./builtin-disable";
import { checkArgvAndPromptRestart } from "./platform/argv";
import { registerHostCommands } from "./host";
import { registerResolver } from "./resolver";
import {
  FolderHistoryManager,
  captureCurrentWorkspace,
} from "./remote/folderHistory";
import { registerServerDownloadPanel } from "./webviews/serverDownloadPanel";
import { FORK_TEMPLATES } from "./platform/forkTemplates";
import { initCache, disposeCache } from "./ssh/askpassCache";
import { initSshSessionSecret, disposeSshSessionSecret, sshSessionSecretReady } from "./ssh/sshSessionSecret";
import { sshSettings } from "./ssh/sshConfig";
import { initVscodiumFeed } from "./remote/vscodiumFeed";
import { configureDownloadCache, maybePruneCache } from "./remote/download";

// Build-time flag determines the published extension name.
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_VSCODIUM_ADAPTER: boolean;
declare const __BUILD_ID__: string;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logger = new Logger("Zygos");
  context.subscriptions.push(logger);
  const platform = detectPlatform();

  // Bail if this extension was loaded into the wrong editor.
  // Only the kiro build restricts its runtime; vscodium allows any.
  if (!platform.isValidRuntime()) {
    const message = HAS_KIRO_ADAPTER
      ? "Zygos: this build runs in Kiro only. Install the zygos build matching your editor."
      : "Zygos: this extension is not compatible with your editor. Install the build matching your editor.";
    logger.error(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  // Register the host tree view synchronously before any async work.
  // VS Code restores view state early in window init; if createTreeView
  // hasn't run yet when it tries, it shows "No view is registered with
  // id: zygos.hosts". The view is declared with remoteName: "ssh-remote"
  // so VS Code only shows it on the apex or in an ssh-remote window; we
  // register unconditionally so the early probe always finds the provider.
  //
  // Recent-folder history for the SSH Targets tree. Namespaced per
  // extension so it never collides with artizo's container history when
  // both are installed in the same IDE. zygos is extensionKind ["ui"], so
  // it only runs on the apex, even inside an SSH remote window. There,
  // workspaceFolders are `vscode-remote://ssh-remote+<hex>/path` URIs,
  // exactly what the shared `captureCurrentWorkspace` helper filters for.
  // It writes to the APEX globalState, the same store the tree reads, so
  // recent folders appear on the client where the SSH Targets tree lives,
  // not stranded on the remote host.
  const folderHistory = new FolderHistoryManager({
    state: context.globalState,
    keyPrefix: "zygos",
  });
  registerHostCommands(context, logger, folderHistory);

  logger.info(`Activating on ${platform.name} (build ${__BUILD_ID__})`);

  // Capture on activation when connected to an SSH remote (a folder is
  // already open), and whenever the workspace folders change. Fire-and-
  // forget: never fail activation.
  const capture = (): void => {
    if (vscode.env.remoteName !== "ssh-remote") return;
    void captureCurrentWorkspace(folderHistory, "ssh-remote").catch((err) =>
      logger.info(
        `[history] capture failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(capture),
  );

  // On activation inside an SSH remote window, capture the open folder(s).
  capture();

  // Config webview - available in all builds.
  registerServerDownloadPanel(context, {
    configNamespace: "zygos",
    commandId: "zygos.configureServerDownload",
    panelTitle: "Zygos Server Download",
    productName: "Zygos",
    webviewSubdir: "resources/serverDownload",
    logger,
    getDownloadInfo: () => {
      const adapter = detectPlatform();
      return { adapter, info: getProductInfo(adapter) };
    },
    readProductJson,
    forkTemplates: FORK_TEMPLATES,
  });

  // Check for conflicting SSH-remote extensions before anything else.
  // Only on apex; remote/ssh/devcontainer contexts have no resolver
  // conflict. Kiro does not have conflicting extensions.
  let conflictIds: string[] = [];
  if (HAS_VSCODIUM_ADAPTER && !vscode.env.remoteName) {
    conflictIds = await checkForConflicts(platform, logger);
    if (conflictIds.length > 0) {
      // Register the conflict info command so the user has one
      // visible command explaining why zygos is inactive.
      context.subscriptions.push(
        vscode.commands.registerCommand(
          "zygos.showConflictInfo",
          () => showConflictInfo(conflictIds, logger),
        ),
      );
      // Watch for extension changes - conflict may resolve if user
      // disables the conflicting extension.
      context.subscriptions.push(
        vscode.extensions.onDidChange(async () => {
          const ids = findConflictingExtensions(platform, logger);
          if (ids.length === 0) {
            logger.info("[conflict] resolved, reloading...");
            void vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        }),
      );
      logger.info("[activate] resolver not registered due to conflict");
      return;
    }
  }

  // Patch argv.json to enable proposed APIs (resolvers, contribViewsRemote).
  const needsRestart = await checkArgvAndPromptRestart(platform, logger);
  if (needsRestart) {
    logger.info("[activate] awaiting restart after argv.json patch");
    return;
  }

  // Ensure askpass.sh is executable on Unix. VSIX packed on
  // Windows does not preserve permission bits.
  if (process.platform !== "win32") {
    const askpassSh = path.join(context.extensionPath, "scripts", "askpass", "askpass.sh");
    try {
      fs.chmodSync(askpassSh, 0o755);
    } catch {
      // best-effort; file may not exist in some builds
    }
  }

  // Initialize the persistent askpass cache before any resolve attempt.
  const storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });
  const ttlHours = vscode.workspace
    .getConfiguration("zygos")
    .get<number>("askpassCacheTtl", 8);
  const rotationDays = vscode.workspace
    .getConfiguration("zygos")
    .get<number>("askpassKeyRotationDays", 7);
  logger.info(`[activate] askpass cache TTL: ${ttlHours}h, key rotation: ${rotationDays}d`);
  await initCache(
    context.secrets,
    path.join(storageDir, "askpass.db"),
    logger,
    "zygos.askpass.masterkey",
    ttlHours,
    rotationDays,
  );

  // Initialize the ssh session secret when persistent connection is enabled.
  const { usePersistentConnection } = sshSettings();
  if (usePersistentConnection) {
    const sessionKeyRotationDays = vscode.workspace
      .getConfiguration("zygos")
      .get<number>("sessionKeyRotationDays", 7);
    await initSshSessionSecret(
      context.secrets,
      logger,
      "zygos.sshSession.masterkey",
      sessionKeyRotationDays,
    );
    logger.info("[activate] persistent connection enabled");
  }

  // Initialize the VSCodium release feed used by the vscode-oss fork.
  // Bundled list ships in the VSIX; per-user cache is append-only.
  initVscodiumFeed({
    bundledPath: path.join(context.extensionPath, "tools", "vscodium", "versions.json"),
    cachePath: path.join(os.homedir(), ".zygos", "vscodium-versions.json"),
  });

  // On-disk cache for REH tarball downloads. Keyed on the original
  // (pre-redirect) URL, which encodes commit+arch+binaryName. Permanent
  // until the 2GB cap prunes oldest entries or the user clears it.
  const rehCacheDir = path.join(storageDir, "reh-cache");
  fs.mkdirSync(rehCacheDir, { recursive: true });
  configureDownloadCache(rehCacheDir, {
    onCacheStatus: (status, u) =>
      logger.info(`[download] cache=${status} url=${u}`),
    onRetry: (cause, u) =>
      logger.info(`[download] retrying ${u}: ${cause instanceof Error ? cause.message : String(cause)}`),
  });
  void maybePruneCache();

  // Register the authority resolver.
  try {
    registerResolver(context, logger);
    logger.info("[activate] resolver registered for ssh-remote");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[activate] failed to register resolver: ${msg}`);
    return;
  }

  logger.info(`Activated on ${platform.name}`);
}

export async function deactivate(): Promise<void> {
  await disposeCache();
  if (sshSessionSecretReady()) disposeSshSessionSecret();
}
