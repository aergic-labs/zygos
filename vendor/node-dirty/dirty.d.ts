w/**
 * Type declarations for vendored node-dirty.
 * https://github.com/felixge/node-dirty
 * MIT License - Copyright (c) 2010 Debuggable Limited
 */

export interface DirtyEvents {
  load: (length: number) => void;
  drain: () => void;
  error: (err: Error) => void;
  read_close: () => void;
  write_close: () => void;
}

export class Dirty<T = any> extends EventEmitter {
  constructor(path?: string);

  path: string | undefined;

  get(key: string): T | undefined;
  set(key: string, val: T | undefined, cb?: (err?: Error) => void): void;
  rm(key: string, cb?: (err?: Error) => void): void;
  forEach(fn: (key: string, val: T) => boolean | void): void;
  update(key: string, updater: (val: T | undefined) => T, cb?: (err?: Error) => void): void;
  size(): number;
  close(): void;

  on<K extends keyof DirtyEvents>(event: K, listener: DirtyEvents[K]): this;
  once<K extends keyof DirtyEvents>(event: K, listener: DirtyEvents[K]): this;
  off<K extends keyof DirtyEvents>(event: K, listener: DirtyEvents[K]): this;
}

export default function Dirty(path?: string): Dirty;
