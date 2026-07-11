/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Logger } from "../../src/common/logger";
import {
  getOutputChannels,
  resetOutputChannels,
  setConfig,
  resetConfig,
} from "../__mocks__/vscode";

describe("Logger", () => {
  let logger: Logger;

  beforeEach(() => {
    resetOutputChannels();
    resetConfig();
    logger = new Logger("Zygos");
  });

  it("creates an output channel with the given name", () => {
    const channels = getOutputChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("Zygos");
  });

  it("info writes a line with [info] prefix", () => {
    logger.info("hello world");
    const lines = getOutputChannels()[0].lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[info] hello world");
    expect(lines[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it("suppresses debug at the default (info) level", () => {
    logger.debug("debug msg");
    expect(getOutputChannels()[0].lines).toHaveLength(0);
  });

  it("writes debug when zygos.logLevel is debug", () => {
    setConfig("zygos.logLevel", "debug");
    resetOutputChannels(); // isolate the channel of the logger under test
    const l = new Logger("Zygos");
    l.debug("debug msg");
    expect(getOutputChannels()[0].lines[0]).toContain("[debug] debug msg");
  });

  it("suppresses trace at the debug level but writes it at trace", () => {
    setConfig("zygos.logLevel", "debug");
    resetOutputChannels();
    const atDebug = new Logger("Zygos");
    atDebug.trace("trace msg");
    expect(getOutputChannels()[0].lines).toHaveLength(0);

    setConfig("zygos.logLevel", "trace");
    resetOutputChannels();
    const atTrace = new Logger("Zygos");
    atTrace.trace("trace msg");
    expect(getOutputChannels()[0].lines[0]).toContain("[trace] trace msg");
  });

  it("always writes info and error regardless of level", () => {
    logger.info("i");
    logger.error("e");
    const lines = getOutputChannels()[0].lines;
    expect(lines[0]).toContain("[info] i");
    expect(lines[1]).toContain("[error] e");
  });

  it("error writes a line with [error] prefix", () => {
    logger.error("something broke");
    expect(getOutputChannels()[0].lines[0]).toContain(
      "[error] something broke",
    );
  });

  it("show calls channel.show()", () => {
    logger.show();
    expect(getOutputChannels()[0].shown).toBe(true);
  });

  it("dispose calls channel.dispose()", () => {
    logger.dispose();
    expect(getOutputChannels()[0].disposed).toBe(true);
  });
});
