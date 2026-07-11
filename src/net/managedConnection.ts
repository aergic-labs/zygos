/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Adapts a `net.Socket` into VS Code's `ManagedMessagePassing` interface.
 * Used to wrap the SOCKS5-tunneled socket from `socks5Connect()`.
 */

import * as net from "node:net";
import type * as vscode from "vscode";
import { SimpleEvent } from "../common/event";

export interface ManagedMessagePassing {
  readonly onDidReceiveMessage: (
    listener: (e: Uint8Array) => void,
  ) => vscode.Disposable;
  readonly onDidClose: (
    listener: (e: Error | undefined) => void,
  ) => vscode.Disposable;
  readonly onDidEnd: (listener: () => void) => vscode.Disposable;
  send: (data: Uint8Array) => void;
  end: () => void;
  drain?: () => Thenable<void>;
}

/** Wrap a connected TCP socket as a `ManagedMessagePassing`. */
export function wrapSocket(socket: net.Socket): ManagedMessagePassing {
  const onReceive = new SimpleEvent<Uint8Array>();
  const onClose = new SimpleEvent<Error | undefined>();
  const onEnd = new SimpleEvent<void>();

  let closed = false;

  socket.on("data", (chunk: Buffer) => {
    // Copy into a standalone buffer. `chunk.buffer` is Node's pooled read
    // buffer, which is reused on the next read; a zero-copy view would be
    // silently overwritten if the consumer retains the message past this
    // callback. `new Uint8Array(chunk)` copies the bytes.
    onReceive.fire(new Uint8Array(chunk));
  });

  socket.on("error", (err: Error) => {
    if (!closed) {
      closed = true;
      onClose.fire(err);
    }
  });

  socket.on("close", (hadError: boolean) => {
    if (!closed) {
      closed = true;
      onClose.fire(
        hadError ? new Error("Socket closed with error") : undefined,
      );
    }
  });

  socket.on("end", () => {
    onEnd.fire();
  });

  return {
    onDidReceiveMessage: onReceive.event,
    onDidClose: onClose.event,
    onDidEnd: onEnd.event,
    send: (data: Uint8Array) => {
      // Copy: `socket.write` may buffer the chunk by reference until flushed,
      // so a zero-copy view over the caller's buffer could be mutated (by the
      // caller reusing it) before it's actually written. `Buffer.from(data)`
      // copies the bytes.
      socket.write(Buffer.from(data));
    },
    end: () => {
      socket.end();
    },
  };
}
