/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  hostConfigToDestination,
  resolveHostInput,
  getConfigPath,
  loadSshConfig,
  type HostConfig,
} from "../../src/ssh/sshConfig";
import { setConfig, resetConfig } from "../__mocks__/vscode";

// --- hostConfigToDestination ---

describe("hostConfigToDestination", () => {
  it("converts a full HostConfig", () => {
    const cfg: HostConfig = {
      alias: "myhost",
      hostName: "10.0.0.5",
      user: "root",
      port: 2222,
    };
    expect(hostConfigToDestination(cfg)).toEqual({
      host: "10.0.0.5",
      user: "root",
      port: 2222,
    });
  });

  it("works with only hostName", () => {
    const cfg: HostConfig = {
      alias: "simple",
      hostName: "example.com",
    };
    expect(hostConfigToDestination(cfg)).toEqual({
      host: "example.com",
      user: undefined,
      port: undefined,
    });
  });

  it("uses alias as hostName when hostName is empty", () => {
    const cfg: HostConfig = {
      alias: "barehost",
      hostName: "barehost",
    };
    expect(hostConfigToDestination(cfg).host).toBe("barehost");
  });
});

// --- getConfigPath ---

describe("getConfigPath", () => {
  afterEach(() => resetConfig());

  it("returns default path when no config set", () => {
    resetConfig();
    const p = getConfigPath();
    expect(p).toBe(path.join(os.homedir(), ".ssh", "config"));
  });

  it("returns configured path when set", () => {
    setConfig("zygos.configFile", "/custom/path/config");
    expect(getConfigPath()).toBe("/custom/path/config");
  });

  it("expands ~ to home directory", () => {
    setConfig("zygos.configFile", "~/myconfig");
    const p = getConfigPath();
    expect(p).toBe(path.join(os.homedir(), "myconfig"));
  });
});

// --- loadSshConfig + resolveHostInput ---

describe("loadSshConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-ssh-"));
    configPath = path.join(tmpDir, "config");
    setConfig("zygos.configFile", configPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
  });

  it("returns empty hosts when config doesn't exist", async () => {
    const { hosts } = await loadSshConfig();
    expect(hosts).toEqual([]);
  });

  it("lists configured hosts (excluding wildcards)", async () => {
    fs.writeFileSync(
      configPath,
      [
        "Host prod",
        "  HostName 10.0.0.1",
        "  User admin",
        "  Port 2222",
        "",
        "Host dev-*",
        "  User dev",
        "",
        "Host staging",
        "  HostName staging.example.com",
        "",
        "Host *",
        "  User default",
        "",
      ].join("\n"),
    );
    const { hosts } = await loadSshConfig();
    expect(hosts).toContain("prod");
    expect(hosts).toContain("staging");
    // Wildcard hosts should be excluded.
    expect(hosts).not.toContain("dev-*");
    expect(hosts).not.toContain("*");
  });

  it("getConfig returns merged config for an alias", async () => {
    fs.writeFileSync(
      configPath,
      [
        "Host myserver",
        "  HostName 192.168.1.100",
        "  User deploy",
        "  Port 2200",
        "  IdentityFile ~/.ssh/id_deploy",
        "  ProxyJump jumpbox",
        "",
      ].join("\n"),
    );
    const { getConfig } = await loadSshConfig();
    const cfg = getConfig("myserver");
    expect(cfg).not.toBeNull();
    expect(cfg!.hostName).toBe("192.168.1.100");
    expect(cfg!.user).toBe("deploy");
    expect(cfg!.port).toBe(2200);
    expect(cfg!.proxyJump).toBe("jumpbox");
    expect(cfg!.identityFile).toEqual(["~/.ssh/id_deploy"]);
  });

  it("getConfig returns null for unknown alias", async () => {
    fs.writeFileSync(configPath, "Host known\n  HostName 1.2.3.4\n");
    const { getConfig } = await loadSshConfig();
    expect(getConfig("unknown")).toBeNull();
  });

  it("getConfig applies global defaults from wildcard Host *", async () => {
    fs.writeFileSync(
      configPath,
      [
        "Host *",
        "  User globaluser",
        "",
        "Host specific",
        "  HostName 10.0.0.1",
        "",
      ].join("\n"),
    );
    const { getConfig } = await loadSshConfig();
    const cfg = getConfig("specific");
    expect(cfg!.user).toBe("globaluser");
    expect(cfg!.hostName).toBe("10.0.0.1");
  });
});

describe("resolveHostInput", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zygos-ssh-"));
    configPath = path.join(tmpDir, "config");
    setConfig("zygos.configFile", configPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetConfig();
  });

  it("resolves a configured alias", async () => {
    fs.writeFileSync(
      configPath,
      "Host prod\n  HostName 10.0.0.1\n  User admin\n  Port 2222\n",
    );
    const cfg = await resolveHostInput("prod");
    expect(cfg.hostName).toBe("10.0.0.1");
    expect(cfg.user).toBe("admin");
    expect(cfg.port).toBe(2222);
    expect(cfg.alias).toBe("prod");
  });

  it("falls back to parsing a literal user@host:port", async () => {
    fs.writeFileSync(configPath, "");
    const cfg = await resolveHostInput("root@192.168.1.50:2222");
    expect(cfg.hostName).toBe("192.168.1.50");
    expect(cfg.user).toBe("root");
    expect(cfg.port).toBe(2222);
    expect(cfg.alias).toBe("root@192.168.1.50:2222");
  });

  it("falls back to parsing a bare hostname", async () => {
    fs.writeFileSync(configPath, "");
    const cfg = await resolveHostInput("example.com");
    expect(cfg.hostName).toBe("example.com");
    expect(cfg.user).toBeUndefined();
    expect(cfg.port).toBeUndefined();
  });

  it("trims input before resolving", async () => {
    fs.writeFileSync(configPath, "");
    const cfg = await resolveHostInput("  user@host  ");
    expect(cfg.hostName).toBe("host");
    expect(cfg.user).toBe("user");
  });
});
