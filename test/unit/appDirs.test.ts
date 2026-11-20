/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { cacheDir, stateDir } from "../../src/common/appDirs";

const HOME = path.join(path.sep, "home", "u");

describe("stateDir", () => {
  it("honors XDG_STATE_HOME on linux", () => {
    const xdg = path.join(path.sep, "x", "state");
    expect(stateDir("linux", { XDG_STATE_HOME: xdg }, HOME)).toBe(
      path.join(xdg, "zygos"),
    );
  });

  it("defaults to ~/.local/state on linux", () => {
    expect(stateDir("linux", {}, HOME)).toBe(
      path.join(HOME, ".local", "state", "zygos"),
    );
  });

  it("ignores a relative XDG_STATE_HOME", () => {
    expect(stateDir("linux", { XDG_STATE_HOME: "relative" }, HOME)).toBe(
      path.join(HOME, ".local", "state", "zygos"),
    );
  });

  it("uses LOCALAPPDATA on win32", () => {
    const local = path.join(path.sep, "Users", "u", "AppData", "Local");
    expect(stateDir("win32", { LOCALAPPDATA: local }, HOME)).toBe(
      path.join(local, "zygos"),
    );
  });

  it("falls back to AppData/Local on win32", () => {
    expect(stateDir("win32", {}, HOME)).toBe(
      path.join(HOME, "AppData", "Local", "zygos"),
    );
  });

  it("uses Application Support on darwin", () => {
    expect(stateDir("darwin", {}, HOME)).toBe(
      path.join(HOME, "Library", "Application Support", "zygos"),
    );
  });
});

describe("cacheDir", () => {
  it("honors XDG_CACHE_HOME on linux", () => {
    const xdg = path.join(path.sep, "x", "cache");
    expect(cacheDir("linux", { XDG_CACHE_HOME: xdg }, HOME)).toBe(
      path.join(xdg, "zygos"),
    );
  });

  it("defaults to ~/.cache on linux", () => {
    expect(cacheDir("linux", {}, HOME)).toBe(
      path.join(HOME, ".cache", "zygos"),
    );
  });

  it("uses LOCALAPPDATA/Cache on win32", () => {
    const local = path.join(path.sep, "Users", "u", "AppData", "Local");
    expect(cacheDir("win32", { LOCALAPPDATA: local }, HOME)).toBe(
      path.join(local, "zygos", "Cache"),
    );
  });

  it("uses Library/Caches on darwin", () => {
    expect(cacheDir("darwin", {}, HOME)).toBe(
      path.join(HOME, "Library", "Caches", "zygos"),
    );
  });
});