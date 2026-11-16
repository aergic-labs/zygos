/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  lstatSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMock };
});

import { ensureSocketDir, socketDirFor } from "../../src/common/temp";

function stat(overrides: Record<string, unknown> = {}) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 501,
    mode: 0o40700,
    ...overrides,
  };
}

beforeEach(() => {
  fsMock.mkdirSync.mockReset();
  fsMock.lstatSync.mockReset();
  fsMock.chmodSync.mockReset();
});

describe("socketDirFor", () => {
  it("uses a short /tmp path on darwin", () => {
    expect(socketDirFor("darwin", 501)).toMatch(/^\/tmp\/zygos-[0-9a-f]{8}$/);
  });

  it("uses the short path on linux too", () => {
    expect(socketDirFor("linux", 501)).toMatch(/^\/tmp\/zygos-[0-9a-f]{8}$/);
  });

  it("is stable for the same uid and distinct across uids", () => {
    expect(socketDirFor("darwin", 501)).toBe(socketDirFor("darwin", 501));
    expect(socketDirFor("darwin", 501)).not.toBe(socketDirFor("darwin", 502));
  });

  it("keeps the full socket path under the sun_path limit", () => {
    const dir = socketDirFor("darwin", 501);
    const sock = `${dir}/aergic-ssh-session-${"a".repeat(32)}.sock`;
    expect(sock.length).toBeLessThan(104);
  });

  it("is the OS temp dir on win32 (named pipes)", () => {
    expect(socketDirFor("win32", 0)).toBe(os.tmpdir());
  });
});

describe("ensureSocketDir", () => {
  it("creates the directory 0700 and accepts it", () => {
    fsMock.lstatSync.mockReturnValue(stat());

    ensureSocketDir("/tmp/zygos-abc", 501);

    expect(fsMock.mkdirSync).toHaveBeenCalledWith("/tmp/zygos-abc", {
      mode: 0o700,
    });
    expect(fsMock.lstatSync).toHaveBeenCalledWith("/tmp/zygos-abc");
    // Already 0700: nothing to tighten.
    expect(fsMock.chmodSync).not.toHaveBeenCalled();
  });

  it("tolerates EEXIST", () => {
    fsMock.mkdirSync.mockImplementation(() => {
      const err = new Error("exists") as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    });
    fsMock.lstatSync.mockReturnValue(stat());

    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).not.toThrow();
  });

  it("propagates other mkdir errors", () => {
    fsMock.mkdirSync.mockImplementation(() => {
      const err = new Error("denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).toThrow("denied");
  });

  it("tightens a directory we own that is not 0700", () => {
    fsMock.lstatSync.mockReturnValue(stat({ mode: 0o40755 }));

    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).not.toThrow();
    expect(fsMock.chmodSync).toHaveBeenCalledWith("/tmp/zygos-abc", 0o700);
  });

  it("clears a setgid bit", () => {
    fsMock.lstatSync.mockReturnValue(stat({ mode: 0o42700 }));

    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).not.toThrow();
    expect(fsMock.chmodSync).toHaveBeenCalledWith("/tmp/zygos-abc", 0o700);
  });

  it("reports a chmod failure", () => {
    fsMock.lstatSync.mockReturnValue(stat({ mode: 0o40755 }));
    fsMock.chmodSync.mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).toThrow(/cannot set mode 0700/);
  });

  it("refuses a directory owned by another uid", () => {
    fsMock.lstatSync.mockReturnValue(stat({ uid: 0 }));
    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).toThrow(/owned by/);
    expect(fsMock.chmodSync).not.toHaveBeenCalled();
  });

  it("refuses a symlink", () => {
    fsMock.lstatSync.mockReturnValue(
      stat({ isDirectory: () => false, isSymbolicLink: () => true }),
    );
    expect(() => ensureSocketDir("/tmp/zygos-abc", 501)).toThrow(
      /not a directory owned by/,
    );
  });
});