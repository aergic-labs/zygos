/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as net from "node:net";
import {
  socks5Connect,
  buildConnectRequest,
  parseIPv4,
} from "../../src/net/socks5";

// --- parseIPv4 ---

describe("parseIPv4", () => {
  it("parses a valid IPv4 address", () => {
    const buf = parseIPv4("192.168.1.1");
    expect(buf).not.toBeNull();
    expect(Array.from(buf!)).toEqual([192, 168, 1, 1]);
  });

  it("parses 127.0.0.1", () => {
    const buf = parseIPv4("127.0.0.1");
    expect(Array.from(buf!)).toEqual([127, 0, 0, 1]);
  });

  it("parses 0.0.0.0", () => {
    const buf = parseIPv4("0.0.0.0");
    expect(Array.from(buf!)).toEqual([0, 0, 0, 0]);
  });

  it("parses 255.255.255.255", () => {
    const buf = parseIPv4("255.255.255.255");
    expect(Array.from(buf!)).toEqual([255, 255, 255, 255]);
  });

  it("returns null for a hostname", () => {
    expect(parseIPv4("example.com")).toBeNull();
  });

  it("returns null for a partial IP", () => {
    expect(parseIPv4("192.168.1")).toBeNull();
  });

  it("returns null for 5 parts", () => {
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
  });

  it("returns null for octet > 255", () => {
    expect(parseIPv4("192.168.1.256")).toBeNull();
  });

  it("returns null for non-numeric octet", () => {
    expect(parseIPv4("192.168.1.abc")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseIPv4("")).toBeNull();
  });
});

// --- buildConnectRequest ---

describe("buildConnectRequest", () => {
  it("builds an IPv4 CONNECT request for an IP literal", () => {
    const buf = buildConnectRequest("127.0.0.1", 8080);
    // VER(1) CMD(1=CONNECT) RSV(0) ATYP(1=IPv4) + 4 octets + 2 port bytes
    expect(buf[0]).toBe(0x05);
    expect(buf[1]).toBe(0x01);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0x01); // ATYP_IPV4
    expect(buf.subarray(4, 8)).toEqual(Buffer.from([127, 0, 0, 1]));
    expect(buf.readUInt16BE(8)).toBe(8080);
  });

  it("builds a domain CONNECT request for a hostname", () => {
    const buf = buildConnectRequest("example.com", 443);
    expect(buf[0]).toBe(0x05);
    expect(buf[1]).toBe(0x01);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0x03); // ATYP_DOMAIN
    expect(buf[4]).toBe(11); // "example.com".length
    expect(buf.subarray(5, 16).toString("utf-8")).toBe("example.com");
    expect(buf.readUInt16BE(16)).toBe(443);
  });

  it("handles port 0", () => {
    const buf = buildConnectRequest("10.0.0.1", 0);
    expect(buf.readUInt16BE(buf.length - 2)).toBe(0);
  });

  it("handles port 65535", () => {
    const buf = buildConnectRequest("10.0.0.1", 65535);
    expect(buf.readUInt16BE(buf.length - 2)).toBe(65535);
  });
});

// --- socks5Connect (integration with local TCP) ---

describe("socks5Connect", () => {
  it("connects through a fake SOCKS5 server to an IPv4 target", async () => {
    // Start a fake SOCKS5 server that accepts the greeting and replies OK.
    const socksSrv = net.createServer((socket) => {
      socket.once("data", (greeting) => {
        // Expect: 05 01 00 (v5, 1 method, no auth)
        expect(greeting[0]).toBe(0x05);
        // Reply: 05 00 (v5, no auth)
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once("data", (req) => {
          // Expect CONNECT request
          expect(req[0]).toBe(0x05);
          expect(req[1]).toBe(0x01);
          // Reply: success, bound address 0.0.0.0:0
          socket.write(
            Buffer.from([
              0x05,
              0x00,
              0x00,
              0x01, // VER, REP=OK, RSV, ATYP=IPv4
              0,
              0,
              0,
              0, // bound addr
              0,
              0, // bound port
            ]),
          );
          // Now it's a passthrough tunnel - echo data back.
          socket.pipe(socket);
        });
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      const socket = await socks5Connect(
        "127.0.0.1",
        socksPort,
        "127.0.0.1",
        12345,
        3000,
      );
      socket.write("ping");
      const data = await new Promise<Buffer>((resolve) => {
        socket.once("data", resolve);
      });
      expect(data.toString()).toBe("ping");
      socket.destroy();
    } finally {
      socksSrv.close();
    }
  });

  it("preserves application data coalesced with the CONNECT reply", async () => {
    // The remote may send its first bytes immediately, so the SOCKS reply and
    // downstream data arrive in one TCP segment. Those trailing bytes must
    // reach the consumer, not be swallowed by the handshake parser.
    const socksSrv = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00])); // greeting OK
        socket.once("data", () => {
          const reply = Buffer.from([
            0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0,
          ]);
          // Reply + immediate application data in a single write.
          socket.write(Buffer.concat([reply, Buffer.from("hello")]));
        });
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      const socket = await socks5Connect(
        "127.0.0.1",
        socksPort,
        "127.0.0.1",
        80,
        3000,
      );
      const data = await new Promise<Buffer>((resolve) => {
        socket.once("data", resolve);
      });
      expect(data.toString()).toBe("hello");
      socket.destroy();
    } finally {
      socksSrv.close();
    }
  });

  it("handles a CONNECT reply split across multiple TCP segments", async () => {
    const socksSrv = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00])); // greeting OK
        socket.once("data", () => {
          const reply = Buffer.from([
            0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0,
          ]);
          // Deliberately split the 10-byte reply so the parser must wait for
          // the remainder instead of resolving on the first partial chunk.
          socket.write(reply.subarray(0, 3));
          setTimeout(() => socket.write(reply.subarray(3)), 20);
        });
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      const socket = await socks5Connect(
        "127.0.0.1",
        socksPort,
        "127.0.0.1",
        80,
        3000,
      );
      expect(socket).toBeInstanceOf(net.Socket);
      socket.destroy();
    } finally {
      socksSrv.close();
    }
  });

  it("handles a domain-type (ATYP=3) CONNECT reply", async () => {
    const socksSrv = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00]));
        socket.once("data", () => {
          // VER REP RSV ATYP=3 LEN "x" PORT(2) - variable-length bound addr.
          socket.write(
            Buffer.from([0x05, 0x00, 0x00, 0x03, 0x01, 0x78, 0x00, 0x00]),
          );
        });
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      const socket = await socks5Connect(
        "127.0.0.1",
        socksPort,
        "127.0.0.1",
        80,
        3000,
      );
      expect(socket).toBeInstanceOf(net.Socket);
      socket.destroy();
    } finally {
      socksSrv.close();
    }
  });

  it("rejects when greeting is rejected", async () => {
    const socksSrv = net.createServer((socket) => {
      socket.once("data", () => {
        // Reply with method=0xFF (no acceptable method)
        socket.write(Buffer.from([0x05, 0xff]));
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      await expect(
        socks5Connect("127.0.0.1", socksPort, "127.0.0.1", 80, 3000),
      ).rejects.toThrow(/greeting rejected/);
    } finally {
      socksSrv.close();
    }
  });

  it("rejects when CONNECT reply is an error", async () => {
    const socksSrv = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([0x05, 0x00])); // greeting OK
        socket.once("data", () => {
          // Reply with REP=0x05 (Connection refused)
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
      });
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      await expect(
        socks5Connect("127.0.0.1", socksPort, "127.0.0.1", 80, 3000),
      ).rejects.toThrow(/connect rejected/);
    } finally {
      socksSrv.close();
    }
  });

  it("times out when server doesn't respond", async () => {
    const socksSrv = net.createServer((_socket) => {
      // Never respond
    });

    const socksPort = await new Promise<number>((resolve) => {
      socksSrv.listen(0, "127.0.0.1", () => {
        resolve((socksSrv.address() as net.AddressInfo).port);
      });
    });

    try {
      await expect(
        socks5Connect("127.0.0.1", socksPort, "127.0.0.1", 80, 500),
      ).rejects.toThrow(/timed out|error/i);
    } finally {
      socksSrv.close();
    }
  });
});
