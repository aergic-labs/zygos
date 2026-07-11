/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Verbosity gate for the logger, from the `zygos.logLevel` setting. `info`
 * and `error` always write; `debug`/`trace` are gated. Mirrors the artizo
 * scheme (`info` | `debug` | `trace`, default `info`).
 */
enum LogLevel {
  Info = 0,
  Debug = 1,
  Trace = 2,
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    default:
      return LogLevel.Info;
  }
}

/**
 * Shared file path for cross-window logging. Both the apex window and
 * remote windows append to the same file so the full sequence of
 * askpass prompts, cache hits/misses, and resolve calls can be traced
 * in one place. Path: ~/.zygos/zygos.log
 */
function sharedLogPath(): string {
  const dir = path.join(os.homedir(), ".zygos");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return path.join(dir, "zygos.log");
}

/**
 * Output-channel-backed logger. Created once per extension activation.
 *
 * The level is read from `zygos.logLevel` at construction; changing the
 * setting takes effect on the next window reload.
 *
 * Also appends every line to ~/.zygos/zygos.log so logs from multiple
 * windows (apex + remote) appear in one tailable file.
 */
export class Logger {
  private readonly channel: vscode.OutputChannel;
  private readonly level: LogLevel;
  private readonly logPath: string;
  private readonly fileLogging: boolean;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
    this.level = parseLogLevel(
      vscode.workspace
        .getConfiguration("zygos")
        .get<string>("logLevel", "info"),
    );
    this.logPath = sharedLogPath();
    this.fileLogging = vscode.workspace
      .getConfiguration("zygos")
      .get<boolean>("fileLog", false);
  }

  private append(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    this.channel.appendLine(line);
    if (this.fileLogging) {
      try { fs.appendFileSync(this.logPath, line + "\n"); } catch { /* best effort */ }
    }
  }

  info(msg: string): void {
    this.append("info", msg);
  }

  debug(msg: string): void {
    if (this.level >= LogLevel.Debug) this.append("debug", msg);
  }

  trace(msg: string): void {
    if (this.level >= LogLevel.Trace) this.append("trace", msg);
  }

  error(msg: string): void {
    this.append("error", msg);
  }

  show(): void {
    this.channel.show();
  }

  /** Write a line without timestamp/level prefix. */
  raw(line: string): void {
    this.channel.appendLine(line);
    if (this.fileLogging) {
      try { fs.appendFileSync(this.logPath, line + "\n"); } catch { /* best effort */ }
    }
  }

  /** Write multiple raw lines, then show the channel. */
  showLines(lines: string[]): void {
    for (const line of lines) {
      this.channel.appendLine(line);
      if (this.fileLogging) {
        try { fs.appendFileSync(this.logPath, line + "\n"); } catch { /* best effort */ }
      }
    }
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
