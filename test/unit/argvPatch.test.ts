/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { patchArgvContent, applyArgvPatch } from "../../src/host/argvPatch";

const tmpFiles: string[] = [];

function tmpFile(content?: string): string {
  const p = path.join(
    os.tmpdir(),
    `zygos-test-${process.pid}-${tmpFiles.length}.json`,
  );
  if (content !== undefined) fs.writeFileSync(p, content, "utf-8");
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // best effort
    }
  }
  tmpFiles.length = 0;
});

describe("patchArgvContent", () => {
  it("adds extension ID to empty object", () => {
    const result = patchArgvContent("{}", "aergic.zygos-kiro");
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    const parsed = JSON.parse(result!.patched);
    expect(parsed["enable-proposed-api"]).toEqual(["aergic.zygos-kiro"]);
  });

  it("appends to existing enable-proposed-api array", () => {
    const content = JSON.stringify({
      "enable-proposed-api": ["other.ext"],
    });
    const result = patchArgvContent(content, "aergic.zygos-kiro");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.patched);
    expect(parsed["enable-proposed-api"]).toEqual([
      "other.ext",
      "aergic.zygos-kiro",
    ]);
  });

  it("returns null when already patched", () => {
    const content = JSON.stringify({
      "enable-proposed-api": ["aergic.zygos-kiro"],
    });
    const result = patchArgvContent(content, "aergic.zygos-kiro");
    expect(result).toBeNull();
  });

  it("returns null when already in a multi-entry array", () => {
    const content = JSON.stringify({
      "enable-proposed-api": ["other.ext", "aergic.zygos-kiro"],
    });
    const result = patchArgvContent(content, "aergic.zygos-kiro");
    expect(result).toBeNull();
  });

  it("preserves other keys", () => {
    const content = JSON.stringify({
      "enable-proposed-api": ["other.ext"],
      "some-other-key": true,
    });
    const result = patchArgvContent(content, "aergic.zygos-kiro");
    const parsed = JSON.parse(result!.patched);
    expect(parsed["some-other-key"]).toBe(true);
  });

  it("preserves JSONC comments", () => {
    const content = `{
  // This is a comment
  "enable-proposed-api": []
}`;
    const result = patchArgvContent(content, "aergic.zygos-kiro");
    expect(result).not.toBeNull();
    expect(result!.patched).toContain("// This is a comment");
  });
});

describe("applyArgvPatch", () => {
  it("patches existing file", () => {
    const f = tmpFile(JSON.stringify({}));
    const result = applyArgvPatch("aergic.zygos-kiro", [f]);
    expect(result.changed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.path).toBe(f);

    const content = fs.readFileSync(f, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed["enable-proposed-api"]).toEqual(["aergic.zygos-kiro"]);
  });

  it("creates file when none exists", () => {
    const f = path.join(
      os.tmpdir(),
      `zygos-test-create-${process.pid}-${Date.now()}.json`,
    );
    tmpFiles.push(f);
    // Ensure it doesn't exist
    try {
      fs.unlinkSync(f);
    } catch {
      // expected
    }
    const result = applyArgvPatch("aergic.zygos-kiro", [f]);
    expect(result.changed).toBe(true);
    expect(result.created).toBe(true);
    expect(fs.existsSync(f)).toBe(true);

    const content = fs.readFileSync(f, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed["enable-proposed-api"]).toEqual(["aergic.zygos-kiro"]);
  });

  it("returns changed=false when already patched", () => {
    const f = tmpFile(
      JSON.stringify({ "enable-proposed-api": ["aergic.zygos-kiro"] }),
    );
    const result = applyArgvPatch("aergic.zygos-kiro", [f]);
    expect(result.changed).toBe(false);
  });

  it("picks first existing candidate", () => {
    const f1 = path.join(os.tmpdir(), `zygos-nonexist-1-${Date.now()}.json`);
    const f2 = tmpFile(JSON.stringify({}));
    const result = applyArgvPatch("aergic.zygos-kiro", [f1, f2]);
    expect(result.path).toBe(f2);
    expect(result.changed).toBe(true);
  });

  it("creates at first candidate when none exist", () => {
    const f1 = path.join(
      os.tmpdir(),
      `zygos-nonexist-2-${process.pid}-${Date.now()}.json`,
    );
    tmpFiles.push(f1);
    const result = applyArgvPatch("aergic.zygos-kiro", [f1]);
    expect(result.path).toBe(f1);
    expect(result.created).toBe(true);
  });

  it("throws on empty candidates array", () => {
    expect(() => applyArgvPatch("aergic.zygos-kiro", [])).toThrow(
      "no candidate paths",
    );
  });
});
