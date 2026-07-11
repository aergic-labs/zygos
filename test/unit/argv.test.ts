/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { ensureArgvProposedApi } from "../../src/platform/argv";
import type { PlatformAdapter } from "../../src/platform/types";
import { noopLogger } from "../__mocks__/fakeSshConnection";

// --- Helpers ---

let tmpHome: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

function makeAdapter(
  overrides: Partial<PlatformAdapter> = {},
): PlatformAdapter {
  return {
    name: "TestIDE",
    dataFolderName: ".test-ide",
    serverDataFolderName: ".test-server",
    serverApplicationName: "test-server",
    getServerDownloadUrl: () => "https://example.com",
    needsArgvPatch: () => true,
    isValidRuntime: () => true,
    ...overrides,
  } as PlatformAdapter;
}

function readArgv(folder: string): string {
  return fs.readFileSync(path.join(tmpHome, folder, "argv.json"), "utf-8");
}

function writeArgv(folder: string, content: string): void {
  const dir = path.join(tmpHome, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "argv.json"), content);
}

// --- ensureArgvProposedApi ---

describe("ensureArgvProposedApi", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-argv-"));
    // os.homedir() reads USERPROFILE on Windows, HOME on POSIX.
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns false when adapter says no patch needed", async () => {
    const adapter = makeAdapter({ needsArgvPatch: () => false });
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(false);
  });

  it("creates argv.json when none exists", async () => {
    const adapter = makeAdapter();
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    const content = readArgv(".test-ide");
    expect(content).toContain("enable-proposed-api");
    expect(content).toContain("zygos-vscodium");
  });

  it("patches an existing argv.json without the extension", async () => {
    writeArgv(".test-ide", '{\n  "disable-hardware-acceleration": true\n}\n');
    const adapter = makeAdapter();
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    const content = readArgv(".test-ide");
    expect(content).toContain("disable-hardware-acceleration");
    expect(content).toContain("enable-proposed-api");
    expect(content).toContain("zygos-vscodium");
  });

  it("returns false when extension is already in argv.json", async () => {
    writeArgv(
      ".test-ide",
      '{\n  "enable-proposed-api": ["aergic.zygos-vscodium"]\n}\n',
    );
    const adapter = makeAdapter();
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(false);
  });

  it("preserves JSONC comments when patching", async () => {
    writeArgv(".test-ide", '{\n  // comment\n  "foo": 1\n}\n');
    const adapter = makeAdapter();
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    const content = readArgv(".test-ide");
    expect(content).toContain("// comment");
    expect(content).toContain('"foo": 1');
    expect(content).toContain("enable-proposed-api");
  });

  it("appends to an existing enable-proposed-api array", async () => {
    writeArgv(".test-ide", '{\n  "enable-proposed-api": ["other.ext"]\n}\n');
    const adapter = makeAdapter();
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    const content = readArgv(".test-ide");
    expect(content).toContain("other.ext");
    expect(content).toContain("zygos-vscodium");
  });

  it("probes multiple folder names and uses the first existing", async () => {
    // Create argv.json in the second candidate folder.
    writeArgv(".code-oss", '{\n  "from-second": true\n}\n');
    const adapter = makeAdapter({
      dataFolderName: ".vscodium",
      getArgvDataFolderNames: () => [".vscodium", ".code-oss", ".vscode"],
    });
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    // Should have patched the second candidate.
    const content = readArgv(".code-oss");
    expect(content).toContain("from-second");
    expect(content).toContain("enable-proposed-api");
    // First candidate should not exist.
    expect(fs.existsSync(path.join(tmpHome, ".vscodium", "argv.json"))).toBe(
      false,
    );
  });

  it("creates at the first candidate when none exist", async () => {
    const adapter = makeAdapter({
      getArgvDataFolderNames: () => [".vscodium", ".code-oss"],
    });
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, ".vscodium", "argv.json"))).toBe(
      true,
    );
  });

  it("returns false on applyArgvPatch error", async () => {
    // Pass empty candidates by using an adapter with empty folder list.
    const adapter = makeAdapter({
      getArgvDataFolderNames: () => [],
    });
    const result = await ensureArgvProposedApi(adapter, noopLogger as any);
    expect(result).toBe(false);
  });
});
