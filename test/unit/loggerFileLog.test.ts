/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMock };
});

import { Logger } from "../../src/common/logger";
import { resetConfig, resetOutputChannels, setConfig } from "../__mocks__/vscode";

const LOCAL = path.join(path.sep, "Users", "u", "AppData", "Local");
const savedLocalAppData = process.env.LOCALAPPDATA;

beforeEach(() => {
  fsMock.mkdirSync.mockReset();
  fsMock.appendFileSync.mockReset();
  resetConfig();
  resetOutputChannels();
  process.env.LOCALAPPDATA = LOCAL;
});

afterEach(() => {
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = savedLocalAppData;
});

describe("Logger file logging", () => {
  it("creates nothing when file logging is off", () => {
    const logger = new Logger("Zygos");
    logger.info("hello");
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.appendFileSync).not.toHaveBeenCalled();
  });

  it("creates the directory on the first write, not at construction", () => {
    setConfig("zygos.fileLog", true);
    const logger = new Logger("Zygos");
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();

    logger.info("first");
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      path.join(LOCAL, "zygos"),
      { recursive: true },
    );

    logger.info("second");
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fsMock.appendFileSync).toHaveBeenCalledTimes(2);
  });
});