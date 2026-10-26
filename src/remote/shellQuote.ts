/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shell-quoting and token-comparison helpers shared by the extension
 * and the standalone local-server bundle.
 *
 * This module imports only node builtins so it can be bundled into
 * dist/localServer.js without pulling in a vscode dependency.
 */

import * as crypto from "node:crypto";

/**
 * Shell-quote a string for safe embedding inside single quotes.
 * Produces 'foo'\''bar' for a string containing foo'bar.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Timing-safe comparison of two hex-encoded tokens. Returns false if
 * either argument is missing or if the decoded lengths differ (so the
 * timingSafeEqual call is always between equal-length buffers).
 */
export function timingSafeTokenCompare(
  provided: string | undefined,
  expected: string,
): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
