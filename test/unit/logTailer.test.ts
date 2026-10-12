/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LogTailer } from "../../src/ssh/sshSession/logTailer";

describe("LogTailer", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logtailer-"));
    logPath = path.join(tmpDir, "server.log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the last N lines on start (seek-back)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(`line ${i}`);
    fs.writeFileSync(logPath, lines.join("\n") + "\n");

    const emitted: string[] = [];
    const tailer = new LogTailer(logPath, (l) => emitted.push(l));
    await tailer.start();
    tailer.dispose();

    // Should emit the last 200 of the 300 lines.
    expect(emitted.length).toBe(200);
    expect(emitted[0]).toBe("line 100");
    expect(emitted[199]).toBe("line 299");
  });

  it("emits all lines if fewer than seek-back limit", async () => {
    fs.writeFileSync(logPath, "a\nb\nc\n");

    const emitted: string[] = [];
    const tailer = new LogTailer(logPath, (l) => emitted.push(l));
    await tailer.start();
    tailer.dispose();

    expect(emitted).toEqual(["a", "b", "c"]);
  });

  it("emits new lines appended after start", async () => {
    fs.writeFileSync(logPath, "existing\n");

    const emitted: string[] = [];
    const tailer = new LogTailer(logPath, (l) => emitted.push(l));
    await tailer.start();

    // Wait a tick for the watcher to settle.
    await new Promise((r) => setTimeout(r, 50));

    fs.appendFileSync(logPath, "new line\n");
    // Give the watcher time to fire.
    await new Promise((r) => setTimeout(r, 200));

    tailer.dispose();

    expect(emitted).toContain("existing");
    expect(emitted).toContain("new line");
  });

  it("handles missing file gracefully", async () => {
    const emitted: string[] = [];
    const tailer = new LogTailer(logPath, (l) => emitted.push(l));
    await tailer.start();
    tailer.dispose();
    // No file, no lines, no crash.
    expect(emitted).toEqual([]);
  });

  it("does not emit partial lines without a newline", async () => {
    fs.writeFileSync(logPath, "complete\n");

    const emitted: string[] = [];
    const tailer = new LogTailer(logPath, (l) => emitted.push(l));
    await tailer.start();

    await new Promise((r) => setTimeout(r, 50));

    // Append a partial line (no newline).
    fs.appendFileSync(logPath, "partial without newline");
    await new Promise((r) => setTimeout(r, 200));

    tailer.dispose();

    expect(emitted).toContain("complete");
    expect(emitted).not.toContain("partial without newline");
  });
});
