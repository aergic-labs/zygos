/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ~/.ssh/config reader.
 *
 * Uses the `ssh-config` package (MIT) for correct parsing - it handles
 * Include directives (glob-expanded), Match blocks, and host patterns,
 * all of which are painful to reimplement and a common open-remote-ssh
 * bug source.
 *
 * Exposes a small typed surface: list configured host aliases, and look up
 * the merged configuration for a given alias (or a raw user@host:port).
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import SSHConfig, { LineType, type Directive } from "ssh-config";
import { parseSshDestination, type SshDestination } from "./destination";

export interface HostConfig {
  /** The alias as written in the Host directive, or the literal host. */
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string[];
  proxyJump?: string;
  proxyCommand?: string;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".ssh", "config");

/** Resolve the config file path, honoring the zygos.configFile setting. */
export function getConfigPath(): string {
  const configured = vscode.workspace
    .getConfiguration("zygos")
    .get<string>("configFile");
  if (configured) {
    return configured.startsWith("~/")
      ? path.join(os.homedir(), configured.slice(2))
      : configured;
  }
  return DEFAULT_CONFIG_PATH;
}

async function fileExists(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readConfigFile(filePath: string): Promise<SSHConfig> {
  const fs = await import("node:fs/promises");
  let content = "";
  if (await fileExists(filePath)) {
    content = (await fs.readFile(filePath, "utf-8")).trim();
  }
  return SSHConfig.parse(content);
}

/** Normalize a parsed ssh-config value to a string or string[]. */
function valueToString(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return "";
  return String(value);
}

function pickString(value: unknown): string | undefined {
  const s = valueToString(value);
  if (typeof s === "string" && s) return s;
  return undefined;
}

/**
 * Load and merge the user + system ssh configs.
 * Returns a parsed structure queryable for hosts and per-host config.
 */
export async function loadSshConfig(): Promise<{
  hosts: string[];
  getConfig: (alias: string) => HostConfig | null;
}> {
  const userConfig = await readConfigFile(getConfigPath());

  // System config (best-effort - may not exist / may be elsewhere on Windows).
  const systemPath =
    process.platform === "win32"
      ? path.resolve(
          process.env.ALLUSERSPROFILE ?? "C:\\ProgramData",
          "ssh",
          "ssh_config",
        )
      : "/etc/ssh/ssh_config";
  const systemConfig = await readConfigFile(systemPath);

  // Merge: user config first (first-match-wins in OpenSSH), then system.
  // SSHConfig extends Array, so both can be spread into a new instance.
  const merged = SSHConfig.parse("");
  merged.push(...userConfig, ...systemConfig);

  const hosts: string[] = [];
  for (const line of merged) {
    if (line.type !== LineType.DIRECTIVE) continue;
    const directive = line as Directive;
    if (directive.param.toLowerCase() !== "host" || !directive.value) continue;
    const value = Array.isArray(directive.value)
      ? directive.value[0]
      : directive.value;
    const v = typeof value === "string" ? value : value?.val;
    if (v && !/^[!*?]/.test(v) && !/[*?]/.test(v)) {
      hosts.push(v);
    }
  }

  const getConfig = (alias: string): HostConfig | null => {
    // ssh-config's compute() merges all matching Host/Match directives for a
    // given host name, in OpenSSH's first-match-wins order.
    const computed = merged.compute(alias);
    if (!computed || !Object.keys(computed).length) return null;

    const hostName = pickString(computed.HostName);
    const user = pickString(computed.User);
    const portStr = pickString(computed.Port);
    const identityFile = valueToString(computed.IdentityFile);
    const proxyJump = pickString(computed.ProxyJump);
    const proxyCommand = pickString(computed.ProxyCommand);

    const port = portStr ? parseInt(portStr, 10) : undefined;

    return {
      alias,
      hostName: hostName ?? alias,
      user,
      port: !isNaN(port ?? NaN) ? port : undefined,
      identityFile: Array.isArray(identityFile)
        ? identityFile.filter(Boolean)
        : identityFile
          ? [identityFile]
          : undefined,
      proxyJump,
      proxyCommand,
    };
  };

  return { hosts: [...new Set(hosts)], getConfig };
}

/**
 * Resolve a user input (alias or user@host:port) into a full HostConfig.
 * If the input matches a config alias, use the merged config. Otherwise
 * parse it as a literal destination.
 */
export async function resolveHostInput(input: string): Promise<HostConfig> {
  const { getConfig } = await loadSshConfig();
  const trimmed = input.trim();

  // Try as a configured alias first.
  const fromConfig = getConfig(trimmed);
  if (fromConfig) return fromConfig;

  // Fall back to parsing as a literal user@host:port.
  const dest = parseSshDestination(trimmed);
  const cfg: HostConfig = {
    alias: trimmed,
    hostName: dest.host,
    user: dest.user,
    port: dest.port,
  };
  return cfg;
}

/** Convert a HostConfig to an SshDestination. */
export function hostConfigToDestination(cfg: HostConfig): SshDestination {
  return { host: cfg.hostName, user: cfg.user, port: cfg.port };
}
