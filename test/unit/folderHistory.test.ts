/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import {
  FolderDescriptor,
  FolderHistoryManager,
  captureCurrentWorkspace,
} from "../../src/remote/folderHistory";

// Self-contained vscode mock so this shared test runs in both repos:
// zygos aliases `vscode` to a hand-written mock, artizo mocks `vscode`
// per-test via vi.mock. Providing our own here (hoisted by vitest)
// makes the test independent of either repo's mock convention. Only
// the surface folderHistory.ts touches at runtime is implemented.
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
    static parse(value: string): Uri {
      const m = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
      if (!m) throw new Error(`mock Uri.parse: no scheme in ${value}`);
      const scheme = m[1];
      const rest = value.substring(m[0].length);
      if (rest.startsWith("//")) {
        const after = rest.substring(2);
        const idx = after.search(/[/?#]/);
        if (idx === -1) return new Uri(scheme, after, "");
        const authority = after.substring(0, idx);
        const path = after.substring(idx);
        return new Uri(scheme, authority, path.startsWith("?") || path.startsWith("#") ? "" : path);
      }
      return new Uri(scheme, "", rest);
    }
    static file(p: string): Uri {
      return new Uri("file", "", p);
    }
    toString(): string {
      if (this.authority || this.scheme === "vscode-remote" || this.scheme === "file") {
        return `${this.scheme}://${this.authority}${this.path}`;
      }
      return `${this.scheme}:${this.path}`;
    }
  }
  return {
    Uri,
    EventEmitter: class {
      private listeners: Array<(e: void) => void> = [];
      event = (l: (e: void) => void) => {
        this.listeners.push(l);
        return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l); } };
      };
      fire() { for (const l of [...this.listeners]) l(undefined); }
      dispose() { this.listeners = []; }
    },
    workspace: {
      // Mutable so capture tests can stub workspaceFolders.
      workspaceFolders: undefined as unknown,
    },
  };
});

/** Minimal fake Memento for globalState. */
function fakeMemento(): vscode.Memento & {
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};
  return {
    store,
    get<T>(key: string, defaultValue?: T): T | undefined {
      return key in store ? (store[key] as T) : defaultValue;
    },
    keys(): readonly string[] {
      return Object.keys(store);
    },
    update(key: string, value: unknown): Thenable<void> {
      store[key] = value;
      return Promise.resolve();
    },
  } as unknown as vscode.Memento & { store: Record<string, unknown> };
}

describe("FolderDescriptor", () => {
  it("fromUri stores the full authority + path", () => {
    const uri = vscode.Uri.parse(
      "vscode-remote://ssh-remote+7b22686f737422/home/user/project",
    );
    const d = FolderDescriptor.fromUri(uri);
    expect(d).not.toBeNull();
    expect(d!.remote).toBe("ssh-remote+7b22686f737422");
    expect(d!.folder).toBe("/home/user/project");
  });

  it("fromUri keeps the full authority when the payload contains +", () => {
    // A container authority whose hex payload decodes to a path with `+`
    // in it. The full authority (including the `+` in the payload) is
    // preserved so toUri() reopens the same window.
    const uri = vscode.Uri.parse("vscode-remote://artizo-container+abc+def/path");
    const d = FolderDescriptor.fromUri(uri);
    expect(d!.remote).toBe("artizo-container+abc+def");
    expect(d!.folder).toBe("/path");
  });

  it("fromUri rejects non-remote schemes", () => {
    expect(FolderDescriptor.fromUri(vscode.Uri.file("/local/path"))).toBeNull();
    expect(
      FolderDescriptor.fromUri(vscode.Uri.parse("untitled:Untitled-1")),
    ).toBeNull();
  });

  it("fromUri rejects authority with no + (bare, unreopenable)", () => {
    const uri = vscode.Uri.parse("vscode-remote://noplusslash/path");
    expect(FolderDescriptor.fromUri(uri)).toBeNull();
  });

  it("toUri round-trips a real authority", () => {
    const d = new FolderDescriptor("ssh-remote+7b22686f7374", "/home/user/proj");
    const uri = d.toUri();
    expect(uri.toString()).toBe(
      "vscode-remote://ssh-remote+7b22686f7374/home/user/proj",
    );
    const back = FolderDescriptor.fromUri(uri);
    expect(back).not.toBeNull();
    expect(back!.remote).toBe("ssh-remote+7b22686f7374");
    expect(back!.folder).toBe("/home/user/proj");
  });
});

describe("FolderHistoryManager", () => {
  it("addFolders inserts most-recent-first", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([
      new FolderDescriptor("hostA", "/path/one"),
      new FolderDescriptor("hostA", "/path/two"),
    ]);
    const folders = h.getFolders("hostA").map((f) => f.folder);
    expect(folders).toEqual(["/path/two", "/path/one"]);
  });

  it("addFolders dedupes (moves existing to front)", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([new FolderDescriptor("hostA", "/a")]);
    await h.addFolders([new FolderDescriptor("hostA", "/b")]);
    await h.addFolders([new FolderDescriptor("hostA", "/a")]);
    const folders = h.getFolders("hostA").map((f) => f.folder);
    expect(folders).toEqual(["/a", "/b"]);
  });

  it("addFolders caps at 20 per remote", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    const many = Array.from({ length: 25 }, (_, i) =>
      new FolderDescriptor("hostA", `/p${i}`),
    );
    await h.addFolders(many);
    expect(h.getFolders("hostA").length).toBe(20);
    // Most recent first: p24..p5 (the last 20 added)
    expect(h.getFolders("hostA")[0].folder).toBe("/p24");
    expect(h.getFolders("hostA")[19].folder).toBe("/p5");
  });

  it("addFolders does nothing for empty input", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([]);
    expect(h.getRemotes()).toEqual([]);
  });

  it("removeFolder deletes one and returns true", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([
      new FolderDescriptor("hostA", "/a"),
      new FolderDescriptor("hostA", "/b"),
    ]);
    const removed = await h.removeFolder(new FolderDescriptor("hostA", "/a"));
    expect(removed).toBe(true);
    expect(h.getFolders("hostA").map((f) => f.folder)).toEqual(["/b"]);
  });

  it("removeFolder prunes empty remotes", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([new FolderDescriptor("hostA", "/a")]);
    await h.removeFolder(new FolderDescriptor("hostA", "/a"));
    expect(h.getRemotes()).toEqual([]);
    expect(h.getFolders("hostA")).toEqual([]);
  });

  it("removeFolder returns false for missing folder", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([new FolderDescriptor("hostA", "/a")]);
    const removed = await h.removeFolder(new FolderDescriptor("hostA", "/x"));
    expect(removed).toBe(false);
  });

  it("removeFolder returns false for missing remote", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    const removed = await h.removeFolder(
      new FolderDescriptor("nope", "/a"),
    );
    expect(removed).toBe(false);
  });

  it("getRemotes lists all remotes with folders", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    await h.addFolders([
      new FolderDescriptor("hostA", "/a"),
      new FolderDescriptor("hostB", "/b"),
    ]);
    expect(h.getRemotes().sort()).toEqual(["hostA", "hostB"]);
  });

  it("keyPrefix namespaces the globalState key", async () => {
    const m = fakeMemento();
    const ha = new FolderHistoryManager({ state: m, keyPrefix: "artizo" });
    const hz = new FolderHistoryManager({ state: m, keyPrefix: "zygos" });
    await ha.addFolders([new FolderDescriptor("hostA", "/a")]);
    await hz.addFolders([new FolderDescriptor("hostA", "/z")]);
    expect(ha.getFolders("hostA").map((f) => f.folder)).toEqual(["/a"]);
    expect(hz.getFolders("hostA").map((f) => f.folder)).toEqual(["/z"]);
    // Both keys exist in the store
    expect(Object.keys(m.store).sort()).toEqual([
      "artizo.folderHistory.v1",
      "zygos.folderHistory.v1",
    ]);
  });

  it("survives corrupt data in globalState", async () => {
    const m = fakeMemento();
    m.store["test.folderHistory.v1"] = "not-an-object";
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    // Should not throw; treats as empty
    expect(h.getRemotes()).toEqual([]);
    // And accepts new writes
    await h.addFolders([new FolderDescriptor("hostA", "/a")]);
    expect(h.getFolders("hostA").map((f) => f.folder)).toEqual(["/a"]);
  });
});

describe("captureCurrentWorkspace", () => {
  it("captures vscode-remote folders matching the prefix", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    // Stub workspaceFolders
    const orig = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: vscode.Uri.parse(
          "vscode-remote://ssh-remote+7b22686f7374/home/user/proj",
        ),
        name: "proj",
        index: 0,
      },
      {
        uri: vscode.Uri.parse(
          "vscode-remote://artizo-container+abc/workspaces/app",
        ),
        name: "app",
        index: 1,
      },
      {
        uri: vscode.Uri.file("/local/folder"),
        name: "local",
        index: 2,
      },
    ];
    try {
      await captureCurrentWorkspace(h, "ssh-remote");
      expect(h.getRemotes()).toEqual(["ssh-remote+7b22686f7374"]);
      expect(h.getFolders("ssh-remote+7b22686f7374")[0].folder).toBe(
        "/home/user/proj",
      );
    } finally {
      (vscode.workspace as any).workspaceFolders = orig;
    }
  });

  it("ignores folders whose authority doesn't match the prefix", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    const orig = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: vscode.Uri.parse(
          "vscode-remote://ssh-remote+abc/home/user/proj",
        ),
        name: "proj",
        index: 0,
      },
    ];
    try {
      await captureCurrentWorkspace(h, "artizo-container");
      expect(h.getRemotes()).toEqual([]);
    } finally {
      (vscode.workspace as any).workspaceFolders = orig;
    }
  });

  it("does nothing for empty workspace", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    const orig = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = [];
    try {
      await captureCurrentWorkspace(h, "ssh-remote");
      expect(h.getRemotes()).toEqual([]);
    } finally {
      (vscode.workspace as any).workspaceFolders = orig;
    }
  });

  it("does nothing for undefined workspace", async () => {
    const m = fakeMemento();
    const h = new FolderHistoryManager({ state: m, keyPrefix: "test" });
    const orig = vscode.workspace.workspaceFolders;
    (vscode.workspace as any).workspaceFolders = undefined;
    try {
      await captureCurrentWorkspace(h, "ssh-remote");
      expect(h.getRemotes()).toEqual([]);
    } finally {
      (vscode.workspace as any).workspaceFolders = orig;
    }
  });
});
