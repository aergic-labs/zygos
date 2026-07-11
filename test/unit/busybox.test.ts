/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  REMOTE_DIR_NAME,
  remoteToolsDir,
  remoteBusyboxPath,
  remoteShPath,
  localBusyboxPath,
  shellQuote,
  normalizeArch,
} from "../../src/server/busybox";

describe("remoteToolsDir", () => {
  it("returns $HOME/.ssh-remote/bin", () => {
    expect(remoteToolsDir("/home/user")).toBe("/home/user/.ssh-remote/bin");
  });

  it("handles paths with trailing slash", () => {
    expect(remoteToolsDir("/home/user/")).toBe("/home/user//.ssh-remote/bin");
  });
});

describe("remoteBusyboxPath", () => {
  it("appends busybox to tools dir", () => {
    expect(remoteBusyboxPath("/home/user")).toBe(
      "/home/user/.ssh-remote/bin/busybox",
    );
  });
});

describe("remoteShPath", () => {
  it("appends sh to tools dir", () => {
    expect(remoteShPath("/home/user")).toBe("/home/user/.ssh-remote/bin/sh");
  });
});

describe("localBusyboxPath", () => {
  it("builds path from extensionPath and arch", () => {
    const p = localBusyboxPath("/ext/path", "x64");
    expect(p).toBe(path.join("/ext/path", "tools", "busybox", "bb-x64"));
  });

  it("handles arm64", () => {
    const p = localBusyboxPath("/ext", "arm64");
    expect(p).toBe(path.join("/ext", "tools", "busybox", "bb-arm64"));
  });
});

describe("REMOTE_DIR_NAME", () => {
  it("is .ssh-remote", () => {
    expect(REMOTE_DIR_NAME).toBe(".ssh-remote");
  });
});

describe("shellQuote", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("wraps empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("escapes single quote as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("handles path with spaces", () => {
    expect(shellQuote("/home/my dir/file")).toBe("'/home/my dir/file'");
  });

  it("handles string with special chars", () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});

describe("normalizeArch", () => {
  it("maps x86_64 to x64", () => {
    expect(normalizeArch("x86_64")).toBe("x64");
  });

  it("maps aarch64 to arm64", () => {
    expect(normalizeArch("aarch64")).toBe("arm64");
  });

  it("maps arm64 to arm64", () => {
    expect(normalizeArch("arm64")).toBe("arm64");
  });

  it("trims whitespace", () => {
    expect(normalizeArch("  x86_64  ")).toBe("x64");
  });

  it("throws on unsupported arch", () => {
    expect(() => normalizeArch("mips")).toThrow("Unsupported remote architecture");
  });

  it("throws on empty string", () => {
    expect(() => normalizeArch("")).toThrow("Unsupported remote architecture");
  });
});
