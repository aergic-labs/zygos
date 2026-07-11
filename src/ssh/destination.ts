/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SSH destination parsing and authority encoding.
 *
 * A "destination" is the user@host:port form a user types or that lives in
 * ~/.ssh/config. An "authority" is the `ssh-remote+<token>` string VS Code
 * uses as the remote authority - it must survive lowercasing (VS Code
 * lowercases URI authorities), so the whole destination is hex-encoded.
 *
 * Clean-room from open-remote-ssh's sshDestination.ts (MIT): same encoding
 * scheme, independent implementation.
 */

export interface SshDestination {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
}

/**
 * Parse a `user@host:port` string. Any of the three parts may be absent.
 * Port is the part after the *last* colon (so IPv6 literals without brackets
 * are ambiguous - callers should bracket them, as OpenSSH does).
 */
export function parseSshDestination(dest: string): SshDestination {
  const input = dest.trim();

  let user: string | undefined;
  const atPos = input.lastIndexOf("@");
  if (atPos !== -1) {
    user = input.substring(0, atPos);
  }

  let port: number | undefined;
  const colonPos = input.lastIndexOf(":");
  if (colonPos !== -1 && colonPos > atPos) {
    const portStr = input.substring(colonPos + 1);
    // Only treat as port if it's all digits; otherwise it's part of the host
    // (e.g. an unbracketed IPv6 literal - rare and not worth breaking).
    if (/^\d+$/.test(portStr)) {
      port = parseInt(portStr, 10);
    }
  }

  const start = atPos !== -1 ? atPos + 1 : 0;
  const end = port !== undefined ? colonPos : input.length;
  const host = input.substring(start, end);

  if (!host) {
    throw new Error(`Invalid SSH destination: "${dest}"`);
  }

  return { host, user, port };
}

/** Render a destination back to `user@host:port` form. */
export function formatSshDestination(d: SshDestination): string {
  let s = d.host;
  if (d.user) s = `${d.user}@${s}`;
  if (d.port) s = `${s}:${d.port}`;
  return s;
}

/**
 * Encode a destination as a hex blob for use in a `ssh-remote+<hex>` authority.
 * JSON-encode then hex - robust against any character and survives VS Code's
 * authority lowercasing (hex is case-insensitive).
 */
export function encodeAuthority(d: SshDestination): string {
  const json = JSON.stringify({
    hostName: d.host,
    user: d.user,
    port: d.port,
  });
  return Buffer.from(json, "utf-8").toString("hex");
}

/**
 * Decode a `<hex>` authority payload back into a destination.
 * Throws if the payload is not valid hex JSON.
 */
export function decodeAuthority(hex: string): SshDestination {
  const json = Buffer.from(hex, "hex").toString("utf-8");
  const data = JSON.parse(json) as {
    hostName: string;
    user?: string;
    port?: number;
  };
  if (!data.hostName) throw new Error("Authority payload missing hostName");
  return { host: data.hostName, user: data.user, port: data.port };
}

/**
 * Split a full authority string `ssh-remote+<hex>` into the scheme and payload.
 * Returns null if the string is not an ssh-remote authority.
 */
export function parseAuthority(
  authority: string,
): { scheme: string; payload: string } | null {
  const plus = authority.indexOf("+");
  if (plus === -1) return null;
  return {
    scheme: authority.substring(0, plus),
    payload: authority.substring(plus + 1),
  };
}
