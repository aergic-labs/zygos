/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** In-memory remote file system used by the vscode mock. */
const fsState = {
  files: new Map<string, string>(),
  dirs: new Set<string>(),
};

function resetFs(): void {
  fsState.files.clear();
  fsState.dirs.clear();
}

function addDir(p: string): void {
  const parts = p.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    fsState.dirs.add("/" + parts.slice(0, i).join("/"));
  }
}

function addFile(p: string, content: string): void {
  const idx = p.lastIndexOf("/");
  addDir(p.substring(0, idx) || "/");
  fsState.files.set(p, content);
}

vi.mock("vscode", () => {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly authority: string,
      readonly path: string,
    ) {}
    get fsPath(): string {
      return this.path;
    }
    toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
    static parse(value: string): Uri {
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(value);
      if (!m) throw new Error(`mock Uri.parse: ${value}`);
      return new Uri(m[1], m[2], m[3] || "");
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      const joined = [base.path.replace(/\/+$/, ""), ...parts].join("/");
      return new Uri(base.scheme, base.authority, joined);
    }
    static file(p: string): Uri {
      return new Uri("file", "", p);
    }
  }

  const workspaceFs = {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const content = fsState.files.get(uri.path);
      if (content === undefined) throw new Error("ENOENT");
      return new TextEncoder().encode(content);
    },
    async writeFile(uri: Uri, data: Uint8Array): Promise<void> {
      addFile(uri.path, new TextDecoder().decode(data));
    },
    async stat(uri: Uri): Promise<{ type: number }> {
      if (fsState.files.has(uri.path)) return { type: 1 };
      if (fsState.dirs.has(uri.path)) return { type: 2 };
      throw new Error("ENOENT");
    },
    async readDirectory(uri: Uri): Promise<Array<[string, number]>> {
      if (!fsState.dirs.has(uri.path)) throw new Error("ENOENT");
      const prefix = uri.path.replace(/\/+$/, "") + "/";
      const out = new Map<string, number>();
      for (const dir of fsState.dirs) {
        if (dir.startsWith(prefix) && dir.length > prefix.length) {
          const name = dir.substring(prefix.length).split("/")[0];
          out.set(name, 2);
        }
      }
      for (const file of fsState.files.keys()) {
        if (file.startsWith(prefix)) {
          const rest = file.substring(prefix.length);
          if (!rest.includes("/")) out.set(rest, 1);
        }
      }
      return [...out.entries()];
    },
    async delete(uri: Uri, _options?: unknown): Promise<void> {
      const prefix = uri.path.replace(/\/+$/, "");
      for (const file of [...fsState.files.keys()]) {
        if (file === prefix || file.startsWith(prefix + "/")) fsState.files.delete(file);
      }
      for (const dir of [...fsState.dirs]) {
        if (dir === prefix || dir.startsWith(prefix + "/")) fsState.dirs.delete(dir);
      }
    },
  };

  return {
    Uri,
    FileType: { File: 1, Directory: 2 },
    workspace: { fs: workspaceFs },
    env: { remoteName: undefined as string | undefined, remoteAuthority: undefined as string | undefined },
    extensions: { all: [] as Array<{ id: string; packageJSON: unknown }> },
    commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
    window: { showInformationMessage: vi.fn().mockResolvedValue(undefined) },
  };
});

import * as vscode from "vscode";
import {
  currentSshAuthority,
  localArtizoIsUiOnly,
  removeSideloadedArtizo,
} from "../../src/remote/legacyArtizo";

const EXT_DIR = "/home/u/.kiro-server/extensions";
const ARTIZO_DIR = `${EXT_DIR}/aergic.artizo-kiro-0.11.6`;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

function makeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key: string) => data.get(key),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    },
  } as any;
}

function makePlatform() {
  return {
    getRemoteExtensionsDirCandidates: () => [".kiro-server/extensions"],
  } as any;
}

function uiOnlyArtizo() {
  return {
    id: "aergic.artizo-kiro",
    packageJSON: { extensionKind: ["ui"] },
  };
}

beforeEach(() => {
  resetFs();
  (vscode.commands.executeCommand as any).mockClear();
  (vscode.window.showInformationMessage as any).mockClear();
  (vscode.env as any).remoteName = "ssh-remote";
  (vscode.env as any).remoteAuthority = "ssh-remote+abc123";
  (vscode.extensions as any).all = [];
});

describe("localArtizoIsUiOnly", () => {
  it("is true for an artizo declaring only ui", () => {
    (vscode.extensions as any).all = [uiOnlyArtizo()];
    expect(localArtizoIsUiOnly()).toBe(true);
  });

  it("is false for the old workspace+ui manifest", () => {
    (vscode.extensions as any).all = [
      { id: "aergic.artizo-kiro", packageJSON: { extensionKind: ["workspace", "ui"] } },
    ];
    expect(localArtizoIsUiOnly()).toBe(false);
  });

  it("is false when artizo is absent", () => {
    (vscode.extensions as any).all = [
      { id: "someone.else", packageJSON: { extensionKind: ["ui"] } },
    ];
    expect(localArtizoIsUiOnly()).toBe(false);
  });
});

describe("currentSshAuthority", () => {
  it("returns the ssh authority", () => {
    expect(currentSshAuthority()).toBe("ssh-remote+abc123");
  });

  it("returns undefined outside an ssh window", () => {
    (vscode.env as any).remoteAuthority = undefined;
    expect(currentSshAuthority()).toBeUndefined();
  });
});

// Gated: the cleanup returns 0 immediately in production (ENABLED=false).
describe.skip("removeSideloadedArtizo", () => {
  function seedSideloaded() {
    addFile(`${ARTIZO_DIR}/.artizo-sideloaded`, "");
    addFile(`${ARTIZO_DIR}/package.json`, "{}");
    addFile(
      `${EXT_DIR}/extensions.json`,
      JSON.stringify([
        {
          identifier: { id: "aergic.artizo-kiro" },
          relativeLocation: "aergic.artizo-kiro-0.11.6",
        },
        {
          identifier: { id: "other.extension" },
          relativeLocation: "other.extension-1.0.0",
        },
      ]),
    );
  }

  it("removes a marked artizo folder and drops its ledger entry", async () => {
    seedSideloaded();
    (vscode.extensions as any).all = [uiOnlyArtizo()];
    const state = makeState();
    const logger = makeLogger();

    const removed = await removeSideloadedArtizo({
      context: { globalState: state } as any,
      logger,
      platform: makePlatform(),
      execOnHost: async () => ({ stdout: "/home/u\n", exitCode: 0 }),
    });

    expect(removed).toBe(1);
    expect(fsState.dirs.has(ARTIZO_DIR)).toBe(false);
    expect(fsState.files.has(`${ARTIZO_DIR}/.artizo-sideloaded`)).toBe(false);

    const ledger = JSON.parse(fsState.files.get(`${EXT_DIR}/extensions.json`)!);
    expect(ledger).toEqual([
      {
        identifier: { id: "other.extension" },
        relativeLocation: "other.extension-1.0.0",
      },
    ]);
    expect(state.get("zygos.legacyArtizoCleanup.ssh-remote+abc123")).toBe(true);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.action.reloadWindow",
    );
  });

  it("leaves an unmarked artizo folder alone", async () => {
    addFile(`${ARTIZO_DIR}/package.json`, "{}");
    addDir(EXT_DIR);
    (vscode.extensions as any).all = [uiOnlyArtizo()];

    const removed = await removeSideloadedArtizo({
      context: { globalState: makeState() } as any,
      logger: makeLogger(),
      platform: makePlatform(),
      execOnHost: async () => ({ stdout: "/home/u\n", exitCode: 0 }),
    });

    expect(removed).toBe(0);
    expect(fsState.files.has(`${ARTIZO_DIR}/package.json`)).toBe(true);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("does nothing when local artizo is not UI-only yet", async () => {
    seedSideloaded();
    (vscode.extensions as any).all = [
      { id: "aergic.artizo-kiro", packageJSON: { extensionKind: ["workspace", "ui"] } },
    ];
    const state = makeState();

    const removed = await removeSideloadedArtizo({
      context: { globalState: state } as any,
      logger: makeLogger(),
      platform: makePlatform(),
      execOnHost: async () => ({ stdout: "/home/u\n", exitCode: 0 }),
    });

    expect(removed).toBe(0);
    expect(fsState.dirs.has(ARTIZO_DIR)).toBe(true);
    expect(state.get("zygos.legacyArtizoCleanup.ssh-remote+abc123")).toBeUndefined();
  });

  it("retries on a later window when there is no live connection", async () => {
    seedSideloaded();
    (vscode.extensions as any).all = [uiOnlyArtizo()];
    const state = makeState();

    const removed = await removeSideloadedArtizo({
      context: { globalState: state } as any,
      logger: makeLogger(),
      platform: makePlatform(),
      execOnHost: async () => undefined,
    });

    expect(removed).toBe(0);
    expect(fsState.dirs.has(ARTIZO_DIR)).toBe(true);
    expect(state.get("zygos.legacyArtizoCleanup.ssh-remote+abc123")).toBeUndefined();
  });

  it("is a no-op once the flag is set", async () => {
    seedSideloaded();
    (vscode.extensions as any).all = [uiOnlyArtizo()];
    const state = makeState();
    await state.update("zygos.legacyArtizoCleanup.ssh-remote+abc123", true);
    const execOnHost = vi.fn();

    const removed = await removeSideloadedArtizo({
      context: { globalState: state } as any,
      logger: makeLogger(),
      platform: makePlatform(),
      execOnHost,
    });

    expect(removed).toBe(0);
    expect(execOnHost).not.toHaveBeenCalled();
    expect(fsState.dirs.has(ARTIZO_DIR)).toBe(true);
  });

  it("does nothing outside an ssh window", async () => {
    (vscode.env as any).remoteAuthority = undefined;
    const execOnHost = vi.fn();

    const removed = await removeSideloadedArtizo({
      context: { globalState: makeState() } as any,
      logger: makeLogger(),
      platform: makePlatform(),
      execOnHost,
    });

    expect(removed).toBe(0);
    expect(execOnHost).not.toHaveBeenCalled();
  });
});