/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type * as vscode from "vscode";

/** A disposable that unsubscribes a single listener. */
class ListenerDisposable implements vscode.Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}

/**
 * Minimal event emitter matching `vscode.Event<T>`:
 * `(listener) => Disposable`.
 *
 * Shared by `managedConnection` (SOCKS socket wrapper) and `execServer`
 * (process/stream wrappers), which previously each defined their own copy.
 * The `vscode` import is type-only, so this stays free of a runtime `vscode`
 * dependency.
 */
export class SimpleEvent<T> {
  private readonly listeners = new Set<(e: T) => void>();

  readonly event = (listener: (e: T) => void): vscode.Disposable => {
    this.listeners.add(listener);
    return new ListenerDisposable(() => this.listeners.delete(listener));
  };

  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
