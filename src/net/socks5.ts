/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Minimal SOCKS5 CONNECT client.
 *
 * Only implements what `ssh -D` provides: SOCKS5 with no authentication,
 * CONNECT command to an IPv4 or hostname target. No UDP, no bind, no auth
 * methods - `ssh -D` doesn't support those.
 *
 * Usage: `socks5Connect(socksHost, socksPort, destHost, destPort)` returns a
 * Promise<net.Socket> tunneled to the destination.
 */

import * as net from "node:net";

/** SOCKS5 reply codes (RFC 1928 §4). */
const REPLY_OK = 0x00;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

/**
 * Connect to `destHost:destPort` through a SOCKS5 proxy at
 * `socksHost:socksPort`. The returned socket is the tunneled connection:
 * read/write as if connected directly to the destination.
 */
export function socks5Connect(
  socksHost: string,
  socksPort: number,
  destHost: string,
  destPort: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(socksPort, socksHost);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SOCKS5 connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let phase: "greeting" | "connect" | "done" = "greeting";
    // Accumulates received bytes across `data` events. TCP is a byte stream:
    // a reply may arrive split across events, or coalesced with the first
    // bytes of tunneled application data. We parse exact message lengths and
    // preserve any trailing bytes for the consumer.
    let buf = Buffer.alloc(0);

    const fail = (msg: string): void => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.destroy();
      reject(new Error(msg));
    };

    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`SOCKS5 socket error: ${err.message}`));
    });

    // Each handler returns true when it consumed a complete message and
    // advanced the phase, or false when it needs more bytes (or has failed).
    const processGreeting = (): boolean => {
      if (buf.length < 2) return false;
      if (buf[0] !== 0x05 || buf[1] !== 0x00) {
        fail(`SOCKS5 greeting rejected (method=${buf[1]})`);
        return false;
      }
      buf = buf.subarray(2);
      socket.write(buildConnectRequest(destHost, destPort));
      phase = "connect";
      return true;
    };

    const processConnect = (): boolean => {
      // Reply: VER REP RSV ATYP BND.ADDR BND.PORT(2). Need the fixed header
      // before we can compute the variable BND.ADDR length.
      if (buf.length < 4) return false;
      if (buf[0] !== 0x05) {
        fail(`SOCKS5 bad version in reply`);
        return false;
      }
      if (buf[1] !== REPLY_OK) {
        fail(`SOCKS5 connect rejected (code=${buf[1]})`);
        return false;
      }
      const atyp = buf[3];
      let replyLen: number;
      if (atyp === ATYP_IPV4) {
        replyLen = 4 + 4 + 2;
      } else if (atyp === ATYP_IPV6) {
        replyLen = 4 + 16 + 2;
      } else if (atyp === ATYP_DOMAIN) {
        if (buf.length < 5) return false; // need the domain-length byte
        replyLen = 4 + 1 + buf[4] + 2;
      } else {
        fail(`SOCKS5 unknown address type in reply (atyp=${atyp})`);
        return false;
      }
      if (buf.length < replyLen) return false; // wait for the full reply

      // Anything past the reply is real tunneled data that arrived coalesced
      // with the reply - hand it back to the socket so the consumer sees it.
      // Copy any bytes coalesced after the reply - they are real tunneled
      // data. subarray() is a view over `buf`; copy so it survives.
      const leftover = Buffer.from(buf.subarray(replyLen));
      socket.removeListener("data", onData);
      clearTimeout(timer);
      phase = "done";
      resolve(socket);
      // Deliver the leftover once the consumer has attached its `data` handler.
      // resolve() schedules the caller's continuation (which attaches the
      // handler) on the microtask queue; setImmediate fires after that, so the
      // listener is present. unshift() is unreliable here: the socket is
      // flowing with no listener, so re-queued bytes would be emitted to
      // nobody on the next tick, before the consumer attaches.
      if (leftover.length > 0) {
        setImmediate(() => socket.emit("data", leftover));
      }
      return false;
    };

    const onData = (chunk: Buffer): void => {
      // concat always copies into a fresh allocation, so `buf` never aliases
      // Node's reused read-buffer pool across events.
      buf = Buffer.concat([buf, chunk]);
      // A single chunk may complete the greeting and also contain the CONNECT
      // reply, so keep processing until a handler needs more bytes.
      for (;;) {
        if (phase === "greeting") {
          if (!processGreeting()) return;
        } else if (phase === "connect") {
          if (!processConnect()) return;
        } else {
          return;
        }
      }
    };

    socket.on("data", onData);

    // Kick off: send greeting (v5, 1 method: no auth).
    socket.on("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
  });
}

/** Build the SOCKS5 CONNECT request for a host:port target. */
export function buildConnectRequest(host: string, port: number): Buffer {
  const portBuf = Buffer.allocUnsafe(2);
  portBuf.writeUInt16BE(port, 0);

  // IPv4 literal?
  const ipv4 = parseIPv4(host);
  if (ipv4) {
    return Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, ATYP_IPV4]),
      ipv4,
      portBuf,
    ]);
  }

  // Otherwise treat as hostname (SOCKS5 ATYP=domain).
  const hostBuf = Buffer.from(host, "utf-8");
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, ATYP_DOMAIN, hostBuf.length]),
    hostBuf,
    portBuf,
  ]);
}

export function parseIPv4(host: string): Buffer | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const buf = Buffer.allocUnsafe(4);
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i], 10);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    buf[i] = octet;
  }
  return buf;
}
