/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs so we can force mkdirSync to fail on demand. importActual
// keeps every other fs call real so secureTempDir's tempBase()/chmod path
// still works. The EEXIST retry loop is security-critical and otherwise
// untestable without colliding on a 128-bit random name.
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

import * as fs from "node:fs";
import { secureTempDir } from "../../src/common/temp";

describe("secureTempDir EEXIST retry", () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear();
  });
  it("retries on EEXIST and throws after MAX_RETRIES", () => {
    const err = new Error("EEXIST");
    (err as NodeJS.ErrnoException).code = "EEXIST";
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      throw err;
    });
    expect(() => secureTempDir()).toThrow(/Failed to create secure temp dir/);
    // MAX_RETRIES = 3.
    expect(fs.mkdirSync).toHaveBeenCalledTimes(3);
  });

  it("stops retrying on a non-EEXIST error and surfaces it", () => {
    const err = new Error("ENOSPC");
    (err as NodeJS.ErrnoException).code = "ENOSPC";
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      throw err;
    });
    expect(() => secureTempDir()).toThrow(/Failed to create secure temp dir/);
    // Non-EEXIST breaks out of the loop on the first attempt.
    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
  });
});
