/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import { detectPlatform } from "./platform";
import { Logger } from "./common/logger";
import { checkForConflicts, showConflictInfo } from "./builtin-disable";
import { checkArgvAndPromptRestart } from "./platform/argv";
import { registerHostCommands } from "./host";
import { registerResolver } from "./resolver";
import { registerConfigPanel } from "./webview/configPanel";
import { initCache, disposeCache } from "./ssh/askpassCache";
import { initVscodiumFeed } from "./server/vscodiumFeed";

// Build-time flag determines the published extension name.
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_VSCODIUM_ADAPTER: boolean;
declare const __BUILD_ID__: string;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const logger = new Logger("Zygos");
  const platform = detectPlatform();

  // Bail if this extension was loaded into the wrong editor.
  // Only the kiro build restricts its runtime; vscodium allows any.
  if (!platform.isValidRuntime()) {
    const message = HAS_KIRO_ADAPTER
      ? "Zygos: this build runs in Kiro only. Install the zygos build matching your editor."
      : "";
    logger.error(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  logger.info(`Activating on ${platform.name} (build ${__BUILD_ID__})`);

  // Config webview - available in all builds.
  registerConfigPanel(context, logger);

  // Check for conflicting SSH-remote extensions before anything else.
  // Only on apex - in remote/ssh/devcontainer contexts there is no
  // resolver conflict. Kiro does not have conflicting extensions.
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
          const ids = await checkForConflicts(platform, logger);
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
    ttlHours,
    rotationDays,
  );

  // Initialize the VSCodium release feed used by the vscode-oss fork.
  // Bundled list ships in the VSIX; per-user cache is append-only.
  initVscodiumFeed({
    bundledPath: path.join(context.extensionPath, "tools", "vscodium", "versions.json"),
    cachePath: path.join(os.homedir(), ".zygos", "vscodium-versions.json"),
  });

  // Register the authority resolver.
  try {
    registerResolver(context, logger);
    logger.info("[activate] resolver registered for ssh-remote");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[activate] failed to register resolver: ${msg}`);
    return;
  }

  // The host tree view and connect commands only make sense on the apex
  // host (no remote) or when connected via ssh-remote. Skip them when
  // running inside a devcontainer or other remote context - the view is
  // declared with remoteName: "ssh-remote" and VS Code throws if we try
  // to create it under a different remote.
  if (
    vscode.env.remoteName &&
    vscode.env.remoteName !== "ssh-remote"
  ) {
    logger.info(
      `[activate] skipping host commands (remote=${vscode.env.remoteName})`,
    );
    return;
  }

  registerHostCommands(context, logger);
  logger.info(`Activated on ${platform.name}`);
}

export async function deactivate(): Promise<void> {
  await disposeCache();
}
