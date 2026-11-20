/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkForConflicts,
  findConflictingExtensions,
  showConflictInfo,
  CONFLICT_CONTEXT_KEY,
} from "../../src/builtin-disable";
import {
  executedCommands,
  installedExtensions,
  resetExecutedCommands,
  resetInstalledExtensions,
  resetOutputChannels,
  setNextErrorMessageChoice,
  getOutputChannels,
} from "../__mocks__/vscode";
import type { PlatformAdapter } from "../../src/platform/types";
import { Logger } from "../../src/common/logger";

function makePlatform(ids: string[]): PlatformAdapter {
  return {
    name: "TestIDE",
    dataFolderName: ".test-ide",
    serverDataFolderName: ".test-server",
    serverApplicationName: "test-server",
    getServerDownloadUrl: () => ({ url: "https://example.com", type: "auto" }),
    getConflictingSshExtensionIds: () => ids,
  } as unknown as PlatformAdapter;
}

describe("builtin-disable", () => {
  let logger: Logger;

  beforeEach(() => {
    resetExecutedCommands();
    resetInstalledExtensions();
    resetOutputChannels();
    setNextErrorMessageChoice(undefined);
    logger = new Logger("Zygos");
  });

  it("findConflictingExtensions returns only installed candidates", () => {
    installedExtensions.push({ id: "ms-vscode.remote-ssh", extensionPath: "/x" });
    const found = findConflictingExtensions(
      makePlatform(["ms-vscode.remote-ssh", "other.ssh"]),
      logger,
    );
    expect(found).toEqual(["ms-vscode.remote-ssh"]);
  });

  it("findConflictingExtensions is empty when the platform lists none", () => {
    expect(findConflictingExtensions(makePlatform([]), logger)).toEqual([]);
  });

  it("sets the context key false when there is no conflict", async () => {
    const ids = await checkForConflicts(makePlatform([]), logger);
    expect(ids).toEqual([]);
    expect(executedCommands).toContainEqual({
      command: "setContext",
      args: [CONFLICT_CONTEXT_KEY, false],
    });
  });

  it("sets the context key true and shows the popup on conflict", async () => {
    installedExtensions.push({ id: "ms-vscode.remote-ssh", extensionPath: "/x" });
    const ids = await checkForConflicts(
      makePlatform(["ms-vscode.remote-ssh"]),
      logger,
    );
    expect(ids).toEqual(["ms-vscode.remote-ssh"]);
    expect(executedCommands).toContainEqual({
      command: "setContext",
      args: [CONFLICT_CONTEXT_KEY, true],
    });
  });

  it("writes details to the log when the user asks", async () => {
    installedExtensions.push({
      id: "ms-vscode.remote-ssh",
      extensionPath: "/ext/remote-ssh",
      packageJSON: {
        displayName: "Remote - SSH",
        version: "0.1.0",
        publisher: "ms-vscode",
      },
    });
    setNextErrorMessageChoice("Show Details");

    showConflictInfo(["ms-vscode.remote-ssh"], logger);
    await Promise.resolve();
    await Promise.resolve();

    const lines = getOutputChannels()[0].lines;
    const text = lines.join("\n");
    expect(text).toContain("SSH Resolver Conflict");
    expect(text).toContain("Name: Remote - SSH");
    expect(text).toContain("Version: 0.1.0");
    expect(text).toContain("Path: /ext/remote-ssh");
  });

  it("notes an extension missing from the API", async () => {
    setNextErrorMessageChoice("Show Details");
    showConflictInfo(["ghost.ext"], logger);
    await Promise.resolve();
    await Promise.resolve();
    expect(getOutputChannels()[0].lines.join("\n")).toContain(
      "ghost.ext (not found in extension API)",
    );
  });
});