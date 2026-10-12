/*
 * Mock ssh child process for in-process server tests.
 * Simulates a remote interactive shell: captures stdin writes,
 * emits scripted stdout (command output + exit marker).
 */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

export interface MockSshChild extends ChildProcess {
  /** Emit a chunk on stdout (simulates remote shell output). */
  emitStdout(chunk: string): void;
  /** Emit a chunk on stderr. */
  emitStderr(chunk: string): void;
  /** Emit the close event (simulates ssh disconnect). */
  emitClose(code: number | null, signal: NodeJS.Signals | null): void;
  /** All stdin writes captured so far. */
  stdinWrites: string[];
}

export function createMockSshChild(): MockSshChild {
  const stdinEmitter = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const procEmitter = new EventEmitter();

  const stdinWrites: string[] = [];

  const stdin = {
    write: (data: string | Buffer): boolean => {
      stdinWrites.push(typeof data === "string" ? data : data.toString("utf-8"));
      return true;
    },
    end: () => {},
    on: (ev: string, fn: (...a: unknown[]) => void) => { stdinEmitter.on(ev, fn); return stdin; },
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => { stdinEmitter.removeListener(ev, fn); return stdin; },
  };

  const stdout = {
    on: (ev: string, fn: (...a: unknown[]) => void) => { stdoutEmitter.on(ev, fn); return stdout; },
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => { stdoutEmitter.removeListener(ev, fn); return stdout; },
    pipe: () => stdout,
  };

  const stderr = {
    on: (ev: string, fn: (...a: unknown[]) => void) => { stderrEmitter.on(ev, fn); return stderr; },
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => { stderrEmitter.removeListener(ev, fn); return stderr; },
  };

  const child = {
    pid: 99999,
    stdin,
    stdout,
    stderr,
    on: (ev: string, fn: (...a: unknown[]) => void) => { procEmitter.on(ev, fn); return child; },
    removeListener: (ev: string, fn: (...a: unknown[]) => void) => { procEmitter.removeListener(ev, fn); return child; },
    kill: () => true,
    once: (ev: string, fn: (...a: unknown[]) => void) => { procEmitter.once(ev, fn); return child; },
  } as unknown as MockSshChild;

  child.stdinWrites = stdinWrites;
  child.emitStdout = (chunk: string) => stdoutEmitter.emit("data", Buffer.from(chunk, "utf-8"));
  child.emitStderr = (chunk: string) => stderrEmitter.emit("data", Buffer.from(chunk, "utf-8"));
  child.emitClose = (code, signal) => procEmitter.emit("close", code, signal);

  return child;
}
