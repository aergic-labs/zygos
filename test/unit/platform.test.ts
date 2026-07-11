/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { KiroAdapter } from "../../src/platform/kiro";
import { VscodiumAdapter } from "../../src/platform/vscodium";
import { getProductInfo, readProductJson } from "../../src/platform/index";
import { setConfig, resetConfig, env as vscodeEnv } from "../__mocks__/vscode";

// --- Helpers ---

let tmpDir: string;

function writeProductJson(obj: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmpDir, "product.json"), JSON.stringify(obj));
}

/**
 * Run `fn` with `os.homedir()` pointed at a throwaway temp dir, then restore.
 *
 * `os.homedir()` reads $HOME on POSIX and %USERPROFILE% on Windows, so
 * overriding both env vars redirects it without spying on the frozen ESM
 * `node:os` namespace. This keeps auth-token tests from ever touching the
 * developer's real ~/.aws/sso/cache/kiro-auth-token.json.
 */
function withSandboxHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-home-"));
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- KiroAdapter ---

describe("KiroAdapter", () => {
  let adapter: KiroAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-test-"));
    (vscodeEnv as any).appRoot = tmpDir;
    adapter = new KiroAdapter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
  });

  it("has correct static properties", () => {
    expect(adapter.name).toBe("Kiro");
    expect(adapter.dataFolderName).toBe(".kiro");
    expect(adapter.serverDataFolderName).toBe(".kiro-server");
    expect(adapter.serverApplicationName).toBe("kiro-server");
  });

  it("getServerDownloadUrl builds the expected URL", () => {
    const url = adapter.getServerDownloadUrl(
      "abc123",
      "stable",
      "linux",
      "x64",
    );
    expect(url).toBe(
      "https://prod.download.desktop.kiro.dev/releases/remotes/abc123/kiro-reh-linux-x64.tar.gz",
    );
  });

  it("needsArgvPatch returns true", () => {
    expect(adapter.needsArgvPatch()).toBe(true);
  });

  it("getAuthTokenPath returns the kiro SSO path", () => {
    expect(adapter.getAuthTokenPath()).toBe(
      ".aws/sso/cache/kiro-auth-token.json",
    );
  });

  it("readAuthToken returns undefined when file doesn't exist", () => {
    // Sandbox the home dir so this never reads (or depends on) the
    // developer's real ~/.aws/sso/cache/kiro-auth-token.json.
    withSandboxHome((home) => {
      void home;
      expect(adapter.readAuthToken!()).toBeUndefined();
    });
  });

  it("readAuthToken returns file contents when present", () => {
    // Sandbox the home dir. Writing/removing the token under the real home
    // dir would clobber and DELETE the developer's live Kiro SSO token,
    // signing them out of Kiro on every test run.
    withSandboxHome((home) => {
      const tokenPath = path.join(home, ".aws/sso/cache/kiro-auth-token.json");
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, '{"token":"secret"}');
      expect(adapter.readAuthToken!()).toBe('{"token":"secret"}');
    });
  });

  it("isValidRuntime returns true when applicationName includes kiro", () => {
    writeProductJson({ applicationName: "kiro" });
    expect(adapter.isValidRuntime()).toBe(true);
  });

  it("isValidRuntime returns false when applicationName doesn't match", () => {
    writeProductJson({ applicationName: "vscode" });
    expect(adapter.isValidRuntime()).toBe(false);
  });

  it("isValidRuntime returns false when product.json is missing", () => {
    (vscodeEnv as any).appRoot = "/nonexistent";
    expect(adapter.isValidRuntime()).toBe(false);
  });
});

// --- VscodiumAdapter ---

describe("VscodiumAdapter", () => {
  let adapter: VscodiumAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-test-"));
    (vscodeEnv as any).appRoot = tmpDir;
    adapter = new VscodiumAdapter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
  });

  it("has correct static properties", () => {
    expect(adapter.name).toBe("VSCodium");
    expect(adapter.dataFolderName).toBe(".vscode-oss");
    expect(adapter.serverDataFolderName).toBe(".vscodium-server");
    expect(adapter.serverApplicationName).toBe("codium-server");
  });

  it("getServerDownloadUrl uses version from product.json", () => {
    writeProductJson({ version: "1.92.2" });
    const url = adapter.getServerDownloadUrl(
      "commit",
      "stable",
      "linux",
      "x64",
    );
    expect(url).toBe(
      "https://github.com/VSCodium/vscodium/releases/download/1.92.2/vscodium-reh-linux-x64-1.92.2.tar.gz",
    );
  });

  it("getServerDownloadUrl falls back to 0.0.0 when no version", () => {
    writeProductJson({});
    const url = adapter.getServerDownloadUrl("c", "q", "linux", "arm64");
    expect(url).toContain("0.0.0");
    expect(url).toContain("arm64");
  });

  it("needsArgvPatch returns true", () => {
    expect(adapter.needsArgvPatch()).toBe(true);
  });

  it("getArgvDataFolderNames uses product.json dataFolderName as primary", () => {
    writeProductJson({ dataFolderName: ".vscodium" });
    const dirs = adapter.getArgvDataFolderNames!();
    expect(dirs).toEqual([".vscodium", ".vscode-oss", ".code-oss", ".vscode"]);
  });

  it("getArgvDataFolderNames falls back to adapter dataFolderName", () => {
    // No product.json written -> readProductField returns undefined.
    const dirs = adapter.getArgvDataFolderNames!();
    expect(dirs).toEqual([
      ".vscode-oss",
      ".vscodium",
      ".code-oss",
      ".vscode",
    ]);
  });

  it("getRemoteExtensionsDirCandidates returns both candidates", () => {
    const dirs = adapter.getRemoteExtensionsDirCandidates!();
    expect(dirs).toEqual([
      ".vscodium-server/extensions",
      ".vscode-oss-server/extensions",
    ]);
  });

  it("isValidRuntime returns true for any runtime", () => {
    // VSCodium build allows any runtime; detection happens for download
    // URL selection, not activation gating.
    writeProductJson({ applicationName: "vscodium" });
    const a = new VscodiumAdapter();
    expect(a.isValidRuntime()).toBe(true);
    writeProductJson({ applicationName: "trae" });
    expect(new VscodiumAdapter().isValidRuntime()).toBe(true);
    (vscodeEnv as any).appRoot = "/nonexistent";
    expect(new VscodiumAdapter().isValidRuntime()).toBe(true);
  });

  it("qoder auto-path uses productVersion", () => {
    writeProductJson({
      applicationName: "qoder",
      version: "1.106.3",
      productVersion: "1.12.0",
      commit: "deadbeef",
    });
    const a = new VscodiumAdapter();
    const url = a.getServerDownloadUrl("deadbeef", "stable", "linux", "x64");
    expect(url).toBe(
      "https://download.qoder.com/server/1.12.0/deadbeef/qoder-reh-linux-x64-1.12.0.tar.gz",
    );
  });

  it("devin auto-path uses windsurfVersion", () => {
    writeProductJson({
      applicationName: "devin-desktop",
      version: "1.110.1",
      windsurfVersion: "3.3.18",
      commit: "cafef00d",
    });
    const a = new VscodiumAdapter();
    const url = a.getServerDownloadUrl("cafef00d", "stable", "linux", "arm64");
    expect(url).toBe(
      "https://windsurf-stable.codeiumdata.com/linux-reh-arm64/stable/cafef00d/devin-reh-linux-arm64-3.3.18.tar.gz",
    );
  });

  it("antigravity auto-path uses ideVersion and the google CDN", () => {
    writeProductJson({
      applicationName: "antigravity-ide",
      version: "1.107.0",
      ideVersion: "2.1.1",
      commit: "abc123",
    });
    const a = new VscodiumAdapter();
    const url = a.getServerDownloadUrl("abc123", "stable", "linux", "x64");
    expect(url).toBe(
      "https://dl.google.com/edgedl/release2/j0qc3/antigravity/stable/2.1.1-abc123/linux-x64/Antigravity%20IDE-reh.tar.gz",
    );
  });

  it("trae auto-path detects region and fetches the CDN version", async () => {
    writeProductJson({
      applicationName: "trae",
      commit: "c0ffee",
      bootConfig: {
        cdn: {
          US: "https://lf-cdn.trae.ai/obj/trae-ai-us",
          USTTP: "https://lf-static.traecdn.us/obj/trae-ai-tx",
          SG: "https://lf-cdn.trae.ai/obj/trae-ai-sg",
          CN: "https://lf-cdn.trae.com.cn/obj/trae-com-cn",
        },
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("GetLoginGuidanceForBytedance")) {
          return new Response(JSON.stringify({ Result: { Region: "CN" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/version")) {
          return new Response("1168870458626_15", { status: 200 });
        }
        return new Response("", { status: 404 });
      });
    try {
      const a = new VscodiumAdapter();
      const url = await a.getServerDownloadUrl(
        "c0ffee",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toBe(
        "https://lf-cdn.trae.com.cn/obj/trae-com-cn/pkg/server/releases/stable/c0ffee/linux-debian10/Trae-linux-x64-1168870458626_15.tar.gz",
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});

// --- readProductJson ---

describe("readProductJson", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-test-"));
    (vscodeEnv as any).appRoot = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and parses product.json", () => {
    writeProductJson({ version: "1.0.0", name: "test" });
    const product = readProductJson();
    expect(product.version).toBe("1.0.0");
    expect(product.name).toBe("test");
  });

  it("throws when product.json doesn't exist", () => {
    (vscodeEnv as any).appRoot = "/nonexistent";
    expect(() => readProductJson()).toThrow();
  });
});

// --- getProductInfo ---

describe("getProductInfo", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-test-"));
    (vscodeEnv as any).appRoot = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
  });

  it("reads commit, quality, version from product.json", () => {
    writeProductJson({
      commit: "abc",
      quality: "insider",
      version: "1.5.0",
    });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.commit).toBe("abc");
    expect(info.quality).toBe("insider");
    expect(info.version).toBe("1.5.0");
    expect(info.release).toBe("1.5.0");
  });

  it("falls back to adapter defaults when product.json lacks fields", () => {
    writeProductJson({});
    const adapter = new VscodiumAdapter();
    const info = getProductInfo(adapter);
    expect(info.serverApplicationName).toBe("codium-server");
    expect(info.serverDataFolderName).toBe(".vscodium-server");
  });

  it("uses product.json serverApplicationName when present", () => {
    writeProductJson({ serverApplicationName: "custom-server" });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.serverApplicationName).toBe("custom-server");
  });

  it("zygos.serverDownload.binaryName overrides serverApplicationName", () => {
    writeProductJson({ serverApplicationName: "codium-server" });
    setConfig("zygos.serverDownload", { mode: "auto", binaryName: "my-server" });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.serverApplicationName).toBe("my-server");
  });

  it("mode=custom uses zygos.serverDownload.template", () => {
    writeProductJson({});
    setConfig("zygos.serverDownload", {
      mode: "custom",
      template: "https://example.com/${commit}/${os}/${arch}",
    });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.serverDownloadUrlTemplate).toBe(
      "https://example.com/${commit}/${os}/${arch}",
    );
  });

  it("mode=auto ignores zygos.serverDownload.template", () => {
    writeProductJson({});
    setConfig("zygos.serverDownload", {
      mode: "auto",
      template: "https://ignored.example.com",
    });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.serverDownloadUrlTemplate).toBeUndefined();
  });

  it("release falls back to commit when version is empty", () => {
    writeProductJson({ commit: "deadbeef", version: "" });
    const info = getProductInfo(new VscodiumAdapter());
    expect(info.release).toBe("deadbeef");
  });
});
