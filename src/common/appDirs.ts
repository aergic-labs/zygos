/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Per-user directories for zygos, following each platform's convention.
 *
 * State (logs, history):
 * - Linux: `$XDG_STATE_HOME/zygos`, default `~/.local/state/zygos`
 * - Windows: `%LOCALAPPDATA%\zygos`
 * - macOS: `~/Library/Application Support/zygos`
 *
 * Cache (regenerable):
 * - Linux: `$XDG_CACHE_HOME/zygos`, default `~/.cache/zygos`
 * - Windows: `%LOCALAPPDATA%\zygos\Cache`
 * - macOS: `~/Library/Caches/zygos`
 *
 * Nothing here creates the directories. Writers create their own parent just
 * before writing, so the tree only exists once something is actually stored.
 */

import * as os from "node:os";
import * as path from "node:path";

export function stateDir(
  app: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && path.isAbsolute(local) ? local : path.join(home, "AppData", "Local");
    return path.join(base, app);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", app);
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "state");
  return path.join(base, app);
}

export function cacheDir(
  app: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && path.isAbsolute(local) ? local : path.join(home, "AppData", "Local");
    return path.join(base, app, "Cache");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", app);
  }
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
  return path.join(base, app);
}