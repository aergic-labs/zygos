/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Fake SshConnection for unit tests. Implements the same interface as
 * SshConnection but never spawns a real ssh process. Commands are matched
 * by substring against a configurable response map.
 *
 * Shared across test files to avoid duplicating mock boilerplate.
 */

import { EventEmitter } from "node:events";
import * as net from "node:net";
import type { ExecResult, SshConnectOptions } from "../../src/ssh/connection";

export class FakeSshConnection {
  connected = false;
  calls: string[] = [];
  stdinData: Map<string, Buffer> = new Map();
  private responses: Map<string, ExecResult> = new Map();
  private defaultResponse: ExecResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
  };
  socksServers: net.Server[] = [];
  private spawnStdout: string | undefined;

  constructor(
    private readonly options: SshConnectOptions = { host: "test@fake" },
  ) {}

  /**
   * Set stdout data to emit from the next spawnProcess call that has a
   * command (i.e. startServer). Use to simulate the server's
   * "Extension host agent listening on <port>" message.
   */
  setSpawnStdout(data: string): this {
    this.spawnStdout = data;
    return this;
  }

  /** Set a response for commands containing `substring`. */
  setResponse(substring: string, result: ExecResult): this {
    this.responses.set(substring, result);
    return this;
  }

  /** Set the default response for unmatched commands. */
  setDefault(result: ExecResult): this {
    this.defaultResponse = result;
    return this;
  }

  private match(command: string): ExecResult {
    for (const [key, result] of this.responses) {
      if (command.includes(key)) return result;
    }
    return this.defaultResponse;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const result = this.match("true");
    if (result.exitCode !== 0) {
      throw new Error(`SSH connect failed: ${result.stderr}`);
    }
    this.connected = true;
  }

  async exec(command: string, _timeoutMs?: number): Promise<ExecResult> {
    this.calls.push(command);
    return this.match(command);
  }

  async execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult> {
    this.calls.push(command);
    this.stdinData.set(command, stdinData);
    return this.match(command);
  }

  spawnProcess(_command?: string, _extraArgs: string[] = []): any {
    // If called with -D <port> (SOCKS forward), create a real TCP listener
    // on that port so waitForPort() succeeds. The listener is tracked for
    // cleanup via stopSocksListeners().
    const dIdx = _extraArgs.indexOf("-D");
    if (dIdx !== -1 && _extraArgs[dIdx + 1]) {
      const port = parseInt(_extraArgs[dIdx + 1], 10);
      const srv = net.createServer();
      srv.unref();
      srv.listen(port, "127.0.0.1");
      this.socksServers.push(srv);
    }

    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.stdin = { write: () => true, end: () => {} };
    ee.pid = 12345;
    ee.kill = () => {};
    // Emit configured stdout data for server start commands (spawnProcess
    // called with a command string, not just -D args).
    if (_command && this.spawnStdout) {
      const data = this.spawnStdout;
      setImmediate(() => ee.stdout.emit("data", Buffer.from(data, "utf-8")));
    }

    return ee;
  }

  /** Stop all SOCKS listeners created by spawnProcess("-D"). */
  stopSocksListeners(): void {
    for (const srv of this.socksServers) srv.close();
    this.socksServers.length = 0;
  }

  buildExecArgs(command: string): string[] {
    return [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      this.options.host,
      command,
    ];
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get remoteLabel(): string {
    return this.options.host;
  }
}

/** Shorthand for a successful ExecResult. */
export function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

/** Shorthand for a failed ExecResult. */
export function fail(stderr = "error"): ExecResult {
  return { stdout: "", stderr, exitCode: 1, signal: null };
}

/** No-op logger for tests. */
export const noopLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
};
