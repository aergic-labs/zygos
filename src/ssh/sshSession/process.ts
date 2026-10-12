/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Virtual ChildProcess for the ssh session path. Starts a command in
 * the background on the remote via the control shell, polls for
 * output, and emits data/close events like a real ChildProcess.
 *
 * Stdin is a no-op: the control shell's stdin is shared, so we can't
 * pipe to a specific backgrounded command. Works for Docker commands
 * and file reads that don't need interactive stdin.
 */

import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type { Logger } from "../../common/logger";
import type { SshSessionClient } from "./client";
import { shellQuote } from "../../remote/shellQuote";

const POLL_INTERVAL_MS = 500;
const SPAWN_TIMEOUT_MS = 120_000;

export class SshSessionProcess extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly stdin: { write: () => void; end: () => void };
  pid = 0;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;

  private readonly id: string;
  private readonly tmpBase: string;
  private pollTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private stdoutOffset = 0;

  constructor(
    private readonly client: SshSessionClient,
    command: string,
    private readonly logger: Logger,
  ) {
    super();
    this.id = cryptoRandomHex(8);
    this.tmpBase = `/tmp/zygos-spawn-${this.id}`;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write: (): void => {
        // No-op: control shell stdin is shared.
      },
      end: (): void => {
        // No-op.
      },
    };
    void this.start(command).catch((err) => {
      this.emit("error", err);
    });
  }

  kill(signal?: string): boolean {
    if (this.pid) {
      void this.client.exec(`kill -${signal ?? "TERM"} ${this.pid} 2>/dev/null`).catch(() => {});
    }
    this.killed = true;
    return true;
  }

  private async start(command: string): Promise<void> {
    const outFile = `${this.tmpBase}.out`;
    const exitFile = `${this.tmpBase}.exit`;
    const wrapped =
      `( ${command} ) > ${shellQuote(outFile)} 2>&1; ` +
      `printf '%s' "$?" > ${shellQuote(exitFile)} & ` +
      `printf '%s' "$!"`;

    const result = await this.client.exec(wrapped, SPAWN_TIMEOUT_MS);
    this.pid = parseInt(result.stdout.trim(), 10) || 0;
    this.logger.info(`[ssh-session-spawn] started pid=${this.pid} cmd=${command.slice(0, 80)}`);

    this.pollTimer = setInterval(() => {
      void this.poll().catch(() => {});
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private polling = false;

  private async poll(): Promise<void> {
    if (this.settled) return;
    if (this.polling) return;
    this.polling = true;
    try {
      const outFile = `${this.tmpBase}.out`;
      const exitFile = `${this.tmpBase}.exit`;

      // Read new stdout.
      const outResult = await this.client.exec(
        `dd if=${shellQuote(outFile)} bs=4096 skip=${Math.floor(this.stdoutOffset / 4096)} 2>/dev/null | tail -c +${(this.stdoutOffset % 4096) + 1}`,
      );
      if (outResult.stdout) {
        const buf = Buffer.from(outResult.stdout, "utf-8");
        if (buf.length > 0) {
          this.stdoutOffset += buf.length;
          this.stdout.emit("data", buf);
        }
      }

      // Check exit.
      const exitResult = await this.client.exec(`cat ${shellQuote(exitFile)} 2>/dev/null`);
      if (exitResult.stdout.trim()) {
        this.exitCode = parseInt(exitResult.stdout.trim(), 10) || 0;
        this.settle();
      }
    } finally {
      this.polling = false;
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    // Final stdout flush.
    void this.client
      .exec(`cat ${shellQuote(`${this.tmpBase}.out`)} 2>/dev/null`)
      .then((result) => {
        if (result.stdout) {
          const full = Buffer.from(result.stdout, "utf-8");
          if (full.length > this.stdoutOffset) {
            this.stdout.emit("data", full.subarray(this.stdoutOffset));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        this.emit("close", this.exitCode, this.signalCode);
        // Clean up temp files.
        void this.client
          .exec(`rm -f ${shellQuote(this.tmpBase)}.out ${shellQuote(this.tmpBase)}.exit`)
          .catch(() => {});
      });
  }
}

function cryptoRandomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}
