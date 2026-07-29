/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadToBuffer,
  configureDownloadCache,
} from "../../src/remote/download";

let server: http.Server;
let cacheDir: string;

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "reh-cache-test-"));
  configureDownloadCache(cacheDir);
});

afterEach(() => {
  server?.close();
  server = undefined as unknown as http.Server;
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("downloadToBuffer", () => {
  it("downloads a simple response into a Buffer", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "5" });
      res.end("hello");
    });

    const buf = await downloadToBuffer(`http://127.0.0.1:${port}/`);
    expect(buf.toString()).toBe("hello");
  });

  it("calls onProgress with byte count and total", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "10" });
      res.end("0123456789");
    });

    const progress: Array<{ received: number; total: number | undefined }> = [];
    const buf = await downloadToBuffer(
      `http://127.0.0.1:${port}/`,
      (received, total) => {
        progress.push({ received, total });
      },
    );
    expect(buf.toString()).toBe("0123456789");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].received).toBe(10);
    expect(progress[progress.length - 1].total).toBe(10);
  });

  it("calls onProgress with undefined total when no Content-Length", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("data");
    });

    const totals: (number | undefined)[] = [];
    await downloadToBuffer(`http://127.0.0.1:${port}/`, (_received, t) => {
      totals.push(t);
    });
    // At least one progress call should have undefined total (no Content-Length).
    expect(totals).toContain(undefined);
  });

  it("rejects on HTTP 404", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    });

    await expect(downloadToBuffer(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("rejects on HTTP 500", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });

    await expect(downloadToBuffer(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("follows redirects", async () => {
    const port = await startServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: `/final` });
        res.end();
      } else {
        res.writeHead(200, { "Content-Length": "4" });
        res.end("done");
      }
    });

    const buf = await downloadToBuffer(`http://127.0.0.1:${port}/redirect`);
    expect(buf.toString()).toBe("done");
  });

  it("rejects on too many redirects", async () => {
    const port = await startServer((_req, res) => {
      // Always redirect to self
      res.writeHead(302, { Location: `/` });
      res.end();
    });

    await expect(downloadToBuffer(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it("rejects on connection refused", async () => {
    // Use a port that's almost certainly not listening.
    await expect(downloadToBuffer("http://127.0.0.1:59998/")).rejects.toThrow();
  });
});

describe("downloadToBuffer cache", () => {
  it("serves a cached body on second fetch without hitting the server again", async () => {
    let hits = 0;
    const port = await startServer((_req, res) => {
      hits++;
      res.writeHead(200, { "Content-Length": "5" });
      res.end("hello");
    });

    const url = `http://127.0.0.1:${port}/`;
    const first = await downloadToBuffer(url);
    expect(first.toString()).toBe("hello");
    expect(hits).toBe(1);

    // Close the server; second fetch must come from cache (no network).
    await new Promise<void>((r) => server.close(() => r()));
    server = undefined as unknown as http.Server;

    const second = await downloadToBuffer(url);
    expect(second.toString()).toBe("hello");
    expect(hits).toBe(1);
  });

  it("treats the original URL as the cache key (not the redirect target)", async () => {
    let hits = 0;
    const port = await startServer((req, res) => {
      if (req.url === "/canonical") {
        hits++;
        res.writeHead(200, { "Content-Length": "4" });
        res.end("body");
        return;
      }
      if (req.url === "/r") {
        res.writeHead(302, { Location: `/canonical` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const url = `http://127.0.0.1:${port}/r`;
    const first = await downloadToBuffer(url);
    expect(first.toString()).toBe("body");
    expect(hits).toBe(1);

    await new Promise<void>((r) => server.close(() => r()));
    server = undefined as unknown as http.Server;

    // Second fetch is keyed on `/r` (the original URL), not `/canonical`.
    const second = await downloadToBuffer(url);
    expect(second.toString()).toBe("body");
    expect(hits).toBe(1);
  });
});
