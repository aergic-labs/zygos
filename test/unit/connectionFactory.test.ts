/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockAdapter = {
  serverApplicationName: "code-server-oss",
  serverDataFolderName: ".zygos-server",
  getServerDownloadUrl: () => "https://example.com/server",
  readAuthFiles: undefined,
};
const mockProductInfo = {
  commit: "abc123",
  quality: "stable",
  version: "0.0.1",
  release: "0.0.1",
  serverApplicationName: "code-server-oss",
  serverDataFolderName: ".zygos-server",
  serverDownloadUrlTemplate: undefined,
};

vi.mock("../../src/platform", () => ({
  detectPlatform: () => mockAdapter,
  getProductInfo: () => mockProductInfo,
  readProductJson: () => ({}),
}));

import { SshRemoteResolver } from "../../src/resolver/index";
import { SshConnection } from "../../src/ssh/connection";
import { SshSession } from "../../src/ssh/sshSession/connection";
import {
  initSshSessionSecret,
  disposeSshSessionSecret,
} from "../../src/ssh/sshSessionSecret";
import {
  setConfig,
  resetConfig,
} from "../__mocks__/vscode";

const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};

const sshSessionDeps = {
  serverScriptPath: "/fake/localServer.js",
  wrapperScriptPath: "/fake/start-server.sh",
  nodePath: "/fake/node",
  dataDir: "/fake/sshSession",
};

describe("defaultConnectionFactory", () => {
  beforeEach(async () => {
    resetConfig();
    await initSshSessionSecret(
      { get: async () => undefined, store: async () => {}, delete: async () => {} } as any,
      noopLogger as any,
      "test.sshSession.key",
    );
  });

  afterEach(() => {
    disposeSshSessionSecret();
    resetConfig();
  });

  it("returns SshConnection when the setting is off", () => {
    const resolver = new SshRemoteResolver(
      noopLogger as any,
      "/ext",
      undefined,
      undefined,
      sshSessionDeps,
    );
    const factory = (resolver as any).connectionFactory;
    const conn = factory({ host: "example.com" }, {});
    expect(conn).toBeInstanceOf(SshConnection);
    expect(conn).not.toBeInstanceOf(SshSession);
  });

  it("returns SshSession when the setting is on and secret is ready", () => {
    setConfig("zygos.usePersistentConnection", true);
    const resolver = new SshRemoteResolver(
      noopLogger as any,
      "/ext",
      undefined,
      undefined,
      sshSessionDeps,
    );
    const factory = (resolver as any).connectionFactory;
    const conn = factory({ host: "example.com" }, {});
    expect(conn).toBeInstanceOf(SshSession);
  });

  it("falls back to SshConnection when the setting is on but sshSessionDeps is missing", () => {
    setConfig("zygos.usePersistentConnection", true);
    const resolver = new SshRemoteResolver(
      noopLogger as any,
      "/ext",
      undefined,
      undefined,
      undefined,
    );
    const factory = (resolver as any).connectionFactory;
    const conn = factory({ host: "example.com" }, {});
    expect(conn).toBeInstanceOf(SshConnection);
    expect(conn).not.toBeInstanceOf(SshSession);
  });

  it("falls back to SshConnection when the setting is on but secret is not initialized", () => {
    disposeSshSessionSecret();
    setConfig("zygos.usePersistentConnection", true);
    const resolver = new SshRemoteResolver(
      noopLogger as any,
      "/ext",
      undefined,
      undefined,
      sshSessionDeps,
    );
    const factory = (resolver as any).connectionFactory;
    const conn = factory({ host: "example.com" }, {});
    expect(conn).toBeInstanceOf(SshConnection);
    expect(conn).not.toBeInstanceOf(SshSession);
  });
});