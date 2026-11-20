/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";

const fsMock = vi.hoisted(() => ({
  mkdtempSync: vi.fn(),
  chmodSync: vi.fn(),
  lstatSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMock };
});

beforeEach(() => {
  fsMock.mkdtempSync.mockReset();
  fsMock.chmodSync.mockReset();
  fsMock.lstatSync.mockReset();
  fsMock.rmSync.mockReset();
  fsMock.lstatSync.mockReturnValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  });
  vi.resetModules();
});

async function load() {
  return import("../../src/common/temp.js");
}

describe("socketDirPrefix", () => {
  it("is the OS temp dir on win32 (named pipes)", async () => {
    const { socketDirPrefix } = await load();
    expect(socketDirPrefix("win32")).toBe(os.tmpdir());
  });

  it("is a short literal /tmp prefix on POSIX", async () => {
    const { socketDirPrefix } = await load();
    expect(socketDirPrefix("linux")).toBe("/tmp/zygos-");
    expect(socketDirPrefix("darwin")).toBe("/tmp/zygos-");
  });
});

describe("socketDir", () => {
  it("creates one random directory per process and reuses it", async () => {
    fsMock.mkdtempSync.mockReturnValue("/tmp/zygos-a1b2c3");
    const { socketDir } = await load();

    expect(socketDir("linux")).toBe("/tmp/zygos-a1b2c3");
    expect(socketDir("linux")).toBe("/tmp/zygos-a1b2c3");
    expect(fsMock.mkdtempSync).toHaveBeenCalledTimes(1);
    expect(fsMock.mkdtempSync).toHaveBeenCalledWith("/tmp/zygos-");
    expect(fsMock.chmodSync).toHaveBeenCalledWith("/tmp/zygos-a1b2c3", 0o700);
  });

  it("does not create anything on win32", async () => {
    const { socketDir } = await load();
    expect(socketDir("win32")).toBe(os.tmpdir());
    expect(fsMock.mkdtempSync).not.toHaveBeenCalled();
  });

  it("keeps the full socket path under the sun_path limit", async () => {
    fsMock.mkdtempSync.mockReturnValue("/tmp/zygos-a1b2c3");
    const { socketDir } = await load();
    const sock = `${socketDir("darwin")}/aergic-ssh-session-${"a".repeat(32)}.sock`;
    expect(sock.length).toBeLessThan(104);
  });
});

describe("disposeSocketDir", () => {
  it("removes the directory it created", async () => {
    fsMock.mkdtempSync.mockReturnValue("/tmp/zygos-a1b2c3");
    const { socketDir, disposeSocketDir } = await load();
    socketDir("linux");
    disposeSocketDir();
    expect(fsMock.rmSync).toHaveBeenCalledWith("/tmp/zygos-a1b2c3", {
      recursive: true,
      force: true,
    });
  });

  it("refuses a path outside the /tmp/zygos- prefix", async () => {
    fsMock.mkdtempSync.mockReturnValue("/var/tmp/zygos-a1b2c3");
    const { socketDir, disposeSocketDir } = await load();
    socketDir("linux");
    disposeSocketDir();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it("refuses a symlink", async () => {
    fsMock.mkdtempSync.mockReturnValue("/tmp/zygos-a1b2c3");
    fsMock.lstatSync.mockReturnValue({
      isDirectory: () => false,
      isSymbolicLink: () => true,
    });
    const { socketDir, disposeSocketDir } = await load();
    socketDir("linux");
    disposeSocketDir();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing was created", async () => {
    const { disposeSocketDir } = await load();
    disposeSocketDir();
    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });
});