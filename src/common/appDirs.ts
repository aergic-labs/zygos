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
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && path.isAbsolute(local) ? local : path.join(home, "AppData", "Local");
    return path.join(base, "zygos");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "zygos");
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "state");
  return path.join(base, "zygos");
}

export function cacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && path.isAbsolute(local) ? local : path.join(home, "AppData", "Local");
    return path.join(base, "zygos", "Cache");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "zygos");
  }
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
  return path.join(base, "zygos");
}