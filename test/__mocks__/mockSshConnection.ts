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
import type { ExecResult, ISshConnection, SshConnectOptions } from "../../src/ssh/connection";

export class MockSshConnection implements ISshConnection {
  connected = false;
  calls: string[] = [];
  stdinData: Map<string, Buffer> = new Map();
  putFileCalls: { path: string; content: Buffer; mode?: string }[] = [];
  private putFileResponses: Map<string, ExecResult> = new Map();
  private responses: Map<string, ExecResult> = new Map();
  private probeResponse:
    | { home: string; arch: string; busybox: string; installed: string; rcNoise: string }
    | undefined;
  private defaultResponse: ExecResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
  };
  socksServers: net.Server[] = [];
  spawns: { command: string | undefined; args: string[] }[] = [];
  private spawnStdout: string | undefined;
  private agentReport = "yes";
  private socksPortFromOpts: number | undefined;
  private transportClient: unknown;

  /**
   * Value the SOCKS forward's agent command reports after its ZYAGENT
   * marker: "yes" (forwarded agent linked) or "" (no forwarded agent).
   */
  setAgentReport(value: "yes" | ""): this {
    this.agentReport = value;
    return this;
  }

  constructor(
    private readonly options: SshConnectOptions = { host: "test@fake" },
  ) {
    this.socksPortFromOpts = options.socksPort;
  }

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

  /**
   * Set the probeRemote response (nonce-marker format). Intercepts any
   * command containing a ZYPROBE nonce; all other commands fall through
   * to substring matching. `rcNoise` is prepended before the marker to
   * simulate shell-init output (e.g. zsh .zshenv echo lines).
   */
  setProbeResponse(
    home: string,
    arch: string,
    busybox: string,
    installed: string,
    rcNoise = "",
  ): this {
    this.probeResponse = { home, arch, busybox, installed, rcNoise };
    return this;
  }

  /** Set the default response for unmatched commands. */
  setDefault(result: ExecResult): this {
    this.defaultResponse = result;
    return this;
  }

  private match(command: string): ExecResult {
    if (this.probeResponse && command.includes("ZYPROBE-")) {
      const m = command.match(/ZYPROBE-[0-9a-f]+/);
      const p = this.probeResponse;
      return ok(
        `${p.rcNoise}${m?.[0] ?? "ZYPROBE-unknown"}\n${p.home}\n${p.arch}\n${p.busybox}\n${p.installed}`,
      );
    }
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
    // Session path: open a real TCP listener on opts.socksPort so
    // waitForPort() succeeds.
    if (this.socksPortFromOpts) {
      const srv = net.createServer();
      srv.unref();
      srv.listen(this.socksPortFromOpts, "127.0.0.1");
      this.socksServers.push(srv);
    }
  }

  async exec(command: string, _timeoutMs?: number): Promise<ExecResult> {
    // Mirror SshSession.exec's transport routing: when a transport client has
    // been injected, route through it (`sh -c <command>`) so tests can assert
    // that session-path bookkeeping execs ride the transport. Callers that
    // pass a timeout stay on the control-shell path (the health monitor's
    // ssh-alive ping).
    if (this.transportClient && !_timeoutMs) {
      const tc = this.transportClient as {
        exec: (
          cmd: string,
          args: string[],
        ) => Promise<{
          stdout: Buffer;
          stderr: Buffer;
          exitCode: number;
          signal: string | null;
        }>;
      };
      const r = await tc.exec("sh", ["-c", command]);
      return {
        stdout: r.stdout.toString("utf-8"),
        stderr: r.stderr.toString("utf-8"),
        exitCode: r.exitCode,
        signal: r.signal,
      };
    }
    this.calls.push(command);
    return this.match(command);
  }

  async execWithStdin(command: string, stdinData: Buffer): Promise<ExecResult> {
    // Mirror SshSession.execWithStdin: route through the transport client
    // when one is injected. The session path uses this for copyAuthFiles and
    // writeConnectionTokenFile.
    if (this.transportClient) {
      const tc = this.transportClient as {
        execWithStdin: (
          cmd: string,
          stdin: Buffer,
        ) => Promise<{
          stdout: Buffer;
          stderr: Buffer;
          exitCode: number;
          signal: string | null;
        }>;
      };
      const r = await tc.execWithStdin(command, stdinData);
      return {
        stdout: r.stdout.toString("utf-8"),
        stderr: r.stderr.toString("utf-8"),
        exitCode: r.exitCode,
        signal: r.signal,
      };
    }
    this.calls.push(command);
    this.stdinData.set(command, stdinData);
    return this.match(command);
  }

  async putFile(
    remotePath: string,
    content: Buffer,
    mode?: string,
  ): Promise<ExecResult> {
    this.putFileCalls.push({ path: remotePath, content, mode });
    // Allow tests to simulate a putFile failure (e.g. remote dir doesn't
    // exist, disk full, permission denied) by registering a failing
    // response for a path substring. Returns ok() by default to preserve
    // existing happy-path tests.
    for (const [substr, result] of this.putFileResponses) {
      if (remotePath.includes(substr)) return result;
    }
    return ok();
  }

  /** Make the next putFile calls matching `substr` return `result` instead
   *  of the default ok(). Used to exercise transport-start failure paths
   *  (e.g. the binary ship failing because the remote dir doesn't exist). */
  setPutFileResponse(substr: string, result: ExecResult): this {
    this.putFileResponses.set(substr, result);
    return this;
  }

  getSocksPort(): number {
    return this.socksPortFromOpts ?? 0;
  }

  setTransportClient(client: unknown): void {
    this.transportClient = client;
  }

  spawnProcess(_command?: string, _extraArgs: string[] = []): any {
    this.spawns.push({ command: _command, args: _extraArgs });
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
    // called with a command string, not only -D args).
    if (_command && this.spawnStdout) {
      const data = this.spawnStdout;
      setImmediate(() => ee.stdout.emit("data", Buffer.from(data, "utf-8")));
    }
    // SOCKS forward agent command: simulate shell-init noise, then the
    // marker and the agent report.
    const agentMarker = _command?.match(/ZYAGENT-[0-9a-f]+/)?.[0];
    if (agentMarker) {
      const data = `rc noise\n${agentMarker}\n${this.agentReport}\n`;
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
