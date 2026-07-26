/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Self-contained vscode mock so this test syncs verbatim across repos
// regardless of each repo's test/__mocks__/vscode.ts. Only the config store
// is needed; mergeConfig reads nothing else from vscode at runtime.
const configStore: Record<string, unknown> = {
  __isMock: true,
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration(section: string) {
      return {
        get<T>(key: string, defaultValue: T): T {
          const full = section + "." + key;
          return (configStore[full] as T) ?? defaultValue;
        },
      };
    },
  },
}));

import { mergeServerDownloadConfig } from "../../src/platform/mergeConfig";

/** Set the `<ns>.serverDownload` object for a test. */
function setServerDownload(ns: string, value: unknown): void {
  configStore[ns + ".serverDownload"] = value;
}

const NS = "testprod";

function raw(overrides: Partial<Record<string, string>> = {}) {
  return {
    commit: "c0mm1t",
    quality: "stable",
    version: "1.2.3",
    productVersion: undefined,
    windsurfVersion: undefined,
    ideVersion: undefined,
    serverApplicationName: "test-server",
    serverDataFolderName: "test-data",
    ...overrides,
  };
}

const checksumDefaults = {
  checksumMethod: "sidecar" as const,
  checksumAlgo: "sha256" as const,
  manifestTemplate: "https://default/manifest-${commit}.json",
  manifestField: "sha256hash",
};

beforeEach(() => {
  for (const k of Object.keys(configStore)) delete configStore[k];
});

describe("mergeServerDownloadConfig", () => {
  it("applies defaults when no serverDownload config is set", () => {
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.serverDownloadUrlTemplate).toBeUndefined();
    expect(r.serverApplicationName).toBe("test-server");
    expect(r.serverDataFolderName).toBe("test-data");
    expect(r.checksumMethod).toBe("sidecar");
    expect(r.checksumAlgo).toBe("sha256");
    expect(r.manifestTemplate).toBe(checksumDefaults.manifestTemplate);
    expect(r.manifestField).toBe(checksumDefaults.manifestField);
    expect(r.verifyChecksum).toBe(true);
    expect(r.onNoChecksum).toBe("warn");
  });

  it("falls back to undefined when checksumDefaults is undefined", () => {
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.checksumMethod).toBeUndefined();
    expect(r.checksumAlgo).toBeUndefined();
    expect(r.manifestTemplate).toBeUndefined();
    expect(r.manifestField).toBeUndefined();
  });

  it("uses release = version when version is set", () => {
    const r = mergeServerDownloadConfig(raw({ version: "9.9.9" }), undefined, NS);
    expect(r.release).toBe("9.9.9");
  });

  it("falls back to commit when version is empty", () => {
    const r = mergeServerDownloadConfig(raw({ version: "" }), undefined, NS);
    expect(r.release).toBe("c0mm1t");
  });

  it("passes through productVersion/windsurfVersion/ideVersion", () => {
    const r = mergeServerDownloadConfig(
      raw({
        productVersion: "pv",
        windsurfVersion: "wv",
        ideVersion: "iv",
      }),
      undefined,
      NS,
    );
    expect(r.productVersion).toBe("pv");
    expect(r.windsurfVersion).toBe("wv");
    expect(r.ideVersion).toBe("iv");
  });

  // --- mode + custom template (L54-59) ---

  it("custom mode with a non-empty template sets serverDownloadUrlTemplate", () => {
    setServerDownload(NS, {
      mode: "custom",
      template: "https://example/${commit}/srv.tar.gz",
    });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverDownloadUrlTemplate).toBe(
      "https://example/${commit}/srv.tar.gz",
    );
  });

  it("custom mode with a whitespace-only template yields no template", () => {
    setServerDownload(NS, { mode: "custom", template: "   " });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverDownloadUrlTemplate).toBeUndefined();
  });

  it("custom mode with a non-string template yields no template", () => {
    setServerDownload(NS, { mode: "custom", template: 123 });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverDownloadUrlTemplate).toBeUndefined();
  });

  it("auto mode ignores a configured template", () => {
    setServerDownload(NS, {
      mode: "auto",
      template: "https://example/${commit}/srv.tar.gz",
    });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverDownloadUrlTemplate).toBeUndefined();
  });

  it("non-string mode falls back to auto", () => {
    setServerDownload(NS, { mode: 42, template: "ignored" });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverDownloadUrlTemplate).toBeUndefined();
  });

  // --- binaryName (L62-64) ---

  it("binaryName override applies when non-empty", () => {
    setServerDownload(NS, { binaryName: "  my-bin  " });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverApplicationName).toBe("my-bin");
  });

  it("binaryName falls back to raw.serverApplicationName when empty", () => {
    setServerDownload(NS, { binaryName: "   " });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverApplicationName).toBe("test-server");
  });

  it("non-string binaryName falls back to raw.serverApplicationName", () => {
    setServerDownload(NS, { binaryName: 5 });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.serverApplicationName).toBe("test-server");
  });

  // --- checksumMethod override (L66-78) ---

  it("checksumMethod=sidecar overrides defaults", () => {
    setServerDownload(NS, { checksumMethod: "sidecar" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumMethod).toBe("sidecar");
  });

  it("checksumMethod=manifest overrides defaults", () => {
    setServerDownload(NS, { checksumMethod: "manifest" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumMethod).toBe("manifest");
  });

  it("invalid checksumMethod falls back to default", () => {
    setServerDownload(NS, { checksumMethod: "bogus" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumMethod).toBe("sidecar");
  });

  it("non-string checksumMethod falls back to default", () => {
    setServerDownload(NS, { checksumMethod: 99 });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumMethod).toBe("sidecar");
  });

  // --- checksumAlgo override (L66-67, 79-82) ---

  it("checksumAlgo=sha256 overrides defaults", () => {
    setServerDownload(NS, { checksumAlgo: "sha256" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumAlgo).toBe("sha256");
  });

  it("checksumAlgo=md5 overrides defaults", () => {
    setServerDownload(NS, { checksumAlgo: "md5" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumAlgo).toBe("md5");
  });

  it("invalid checksumAlgo falls back to default", () => {
    setServerDownload(NS, { checksumAlgo: "crc32" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumAlgo).toBe("sha256");
  });

  it("non-string checksumAlgo falls back to empty-string branch then default", () => {
    setServerDownload(NS, { checksumAlgo: false });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.checksumAlgo).toBe("sha256");
  });

  // --- manifestTemplate / manifestField (L68-71, 83-85) ---

  it("manifestTemplate override applies (trimmed)", () => {
    setServerDownload(NS, {
      manifestTemplate: "  https://user/m-${commit}.json  ",
    });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.manifestTemplate).toBe("https://user/m-${commit}.json");
  });

  it("non-string manifestTemplate falls back to default", () => {
    setServerDownload(NS, { manifestTemplate: 7 });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.manifestTemplate).toBe(checksumDefaults.manifestTemplate);
  });

  it("manifestField override applies (trimmed)", () => {
    setServerDownload(NS, { manifestField: "  hash  " });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.manifestField).toBe("hash");
  });

  it("non-string manifestField falls back to default", () => {
    setServerDownload(NS, { manifestField: {} });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.manifestField).toBe(checksumDefaults.manifestField);
  });

  it("empty manifestTemplate and manifestField fall back to defaults", () => {
    setServerDownload(NS, { manifestTemplate: "", manifestField: "" });
    const r = mergeServerDownloadConfig(raw(), checksumDefaults, NS);
    expect(r.manifestTemplate).toBe(checksumDefaults.manifestTemplate);
    expect(r.manifestField).toBe(checksumDefaults.manifestField);
  });

  // --- verifyChecksum + onNoChecksum (L87-93) ---

  it("verifyChecksum defaults to true", () => {
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.verifyChecksum).toBe(true);
  });

  it("verifyChecksum=false is respected", () => {
    setServerDownload(NS, { verifyChecksum: false });
    const r = mergeServerDownloadConfig(raw(), undefined, NS);
    expect(r.verifyChecksum).toBe(false);
  });

  it("onNoChecksum=allow is respected", () => {
    setServerDownload(NS, { onNoChecksum: "allow" });
    expect(mergeServerDownloadConfig(raw(), undefined, NS).onNoChecksum).toBe(
      "allow",
    );
  });

  it("onNoChecksum=abort is respected", () => {
    setServerDownload(NS, { onNoChecksum: "abort" });
    expect(mergeServerDownloadConfig(raw(), undefined, NS).onNoChecksum).toBe(
      "abort",
    );
  });

  it("onNoChecksum=warn is respected", () => {
    setServerDownload(NS, { onNoChecksum: "warn" });
    expect(mergeServerDownloadConfig(raw(), undefined, NS).onNoChecksum).toBe(
      "warn",
    );
  });

  it("invalid onNoChecksum falls back to warn", () => {
    setServerDownload(NS, { onNoChecksum: "nope" });
    expect(mergeServerDownloadConfig(raw(), undefined, NS).onNoChecksum).toBe(
      "warn",
    );
  });

  it("non-string onNoChecksum falls back to warn", () => {
    setServerDownload(NS, { onNoChecksum: null });
    expect(mergeServerDownloadConfig(raw(), undefined, NS).onNoChecksum).toBe(
      "warn",
    );
  });

  it("uses the namespace passed in, not a hardcoded one", () => {
    setServerDownload("otherns", { mode: "custom", template: "t" });
    const r = mergeServerDownloadConfig(raw(), undefined, "otherns");
    expect(r.serverDownloadUrlTemplate).toBe("t");
    // And the NS-named section is untouched.
    setServerDownload(NS, { mode: "custom", template: "nope" });
    const r2 = mergeServerDownloadConfig(raw(), undefined, "otherns");
    expect(r2.serverDownloadUrlTemplate).toBe("t");
  });
});
