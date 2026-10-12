/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * LogTailer: tails a log file into a callback (e.g., an output channel).
 *
 * On start, emits the last N lines (seek-back) so a reload shows recent
 * history (where transition bugs live), then watches for new lines and
 * emits them live. The file is the source of truth; this is a view.
 */

import * as fs from "node:fs";

const SEEK_BACK_LINES = 200;
const SEEK_BACK_BYTES = 16 * 1024;
const OPEN_RETRY_MS = 100;
const OPEN_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 500;

export class LogTailer {
  private fd: number | undefined;
  private offset = 0;
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lineBuf = "";
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly emit: (line: string) => void,
  ) {}

  async start(): Promise<void> {
    // Wait for the file to exist (race with the local server creating it).
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        this.fd = fs.openSync(this.filePath, "r");
        break;
      } catch {
        await sleep(OPEN_RETRY_MS);
      }
    }
    if (this.fd === undefined) return; // file never appeared; nothing to tail

    // Seek-back: emit the last N lines for context on reconnect.
    const stat = fs.fstatSync(this.fd);
    const readSize = Math.min(stat.size, SEEK_BACK_BYTES);
    if (readSize > 0) {
      const buf = Buffer.alloc(readSize);
      fs.readSync(this.fd, buf, 0, readSize, stat.size - readSize);
      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      // If we read from the middle of the file, the first element is a
      // partial line from the seek offset; drop it. If we read the whole
      // file, keep everything.
      if (readSize < stat.size && lines.length > 1) lines.shift();
      // Drop trailing empty (from trailing newline).
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const tail = lines.slice(-SEEK_BACK_LINES);
      for (const line of tail) {
        if (line) this.emit(line);
      }
    }

    // Seek to end for live tailing.
    this.offset = stat.size;

    // Watch for changes. fs.watch is unreliable on some platforms; fall
    // back to polling if it errors.
    try {
      this.watcher = fs.watch(this.filePath, () => {
        void this.readNew();
      });
      this.watcher.on("error", () => {
        this.startPolling();
      });
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.readNew();
    }, POLL_INTERVAL_MS);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private readNew(): void {
    if (this.stopped || this.fd === undefined) return;
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= this.offset) return;
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(this.fd, buf, 0, len, this.offset);
      this.offset = stat.size;
      this.lineBuf += buf.toString("utf-8");
      const lines = this.lineBuf.split("\n");
      this.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line) this.emit(line);
      }
    } catch {
      // File may have been removed or rotated; stop reading.
    }
  }

  dispose(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch { /* best effort */ }
      this.fd = undefined;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
