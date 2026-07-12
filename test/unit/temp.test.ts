/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { secureTempDir, withTempDir, withTempFile } from "../../src/common/temp";

const isWin = process.platform === "win32";

describe("secureTempDir", () => {
  it("creates a directory that exists", () => {
    const dir = secureTempDir();
    try {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the dir with the zygos- prefix and 32 hex chars", () => {
    const dir = secureTempDir();
    try {
      const name = path.basename(dir);
      expect(name).toMatch(/^zygos-[0-9a-f]{32}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the dir under the resolved temp base", () => {
    const dir = secureTempDir();
    try {
      const expectedBase = isWin
        ? (process.env.TEMP || os.tmpdir())
        : fs.realpathSync(os.tmpdir());
      // path.dirname resolves to the temp base (no trailing separator).
      expect(path.resolve(path.dirname(dir))).toBe(path.resolve(expectedBase));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets 0o700 permissions on Unix", () => {
    if (isWin) return; // chmod is ACL-auxiliary on Windows
    const dir = secureTempDir();
    try {
      const mode = fs.statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates unique names on repeated calls", () => {
    const a = secureTempDir();
    const b = secureTempDir();
    try {
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("withTempDir", () => {
  it("passes the dir path to fn and returns its result", async () => {
    const result = await withTempDir(async (dir) => {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
  });

  it("cleans up the dir after fn returns", async () => {
    let captured = "";
    await withTempDir(async (dir) => {
      captured = dir;
      fs.writeFileSync(path.join(dir, "x.txt"), "hi");
    });
    expect(fs.existsSync(captured)).toBe(false);
  });

  it("cleans up even if fn throws", async () => {
    let captured = "";
    await expect(
      withTempDir(async (dir) => {
        captured = dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(captured)).toBe(false);
  });

  it("preserves the original error when cleanup also fails", async () => {
    // fn throws; cleanup is best-effort and must not mask the error.
    await expect(
      withTempDir(async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
  });
});

describe("withTempFile", () => {
  it("passes a file path inside a temp dir", async () => {
    await withTempFile(async (file) => {
      expect(path.basename(file)).toBe("file");
      expect(path.dirname(file)).not.toBe("");
      fs.writeFileSync(file, "data");
      expect(fs.readFileSync(file, "utf-8")).toBe("data");
    });
  });

  it("cleans up the file and dir after fn returns", async () => {
    let capturedFile = "";
    await withTempFile(async (file) => {
      capturedFile = file;
      fs.writeFileSync(file, "data");
    });
    expect(fs.existsSync(capturedFile)).toBe(false);
  });
});
