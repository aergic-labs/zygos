/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import { AskpassServer } from "../../src/ssh/askpassServer";

const mockLogger = {
	info: () => {},
	debug: () => {},
	error: () => {},
	show: () => {},
	dispose: () => {},
};

describe("AskpassServer", () => {
  it("responds with the password from showPrompt", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("hunter2"),
    });
    const handle = await server.start();

    const response = await sendRequest(handle, "Password for host:", server.token);
    expect(response).toEqual({ password: "hunter2" });

    await server.stop();
  });

  it("rejects a request with no token", async () => {
    const showPrompt = vi.fn().mockResolvedValue("secret");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRaw(
      handle,
      JSON.stringify({ request: "Password:" }) + "\n",
    );
    expect(response).toEqual({ error: "unauthorized" });
    expect(showPrompt).not.toHaveBeenCalled();

    await server.stop();
  });

  it("rejects a request with a wrong token", async () => {
    const showPrompt = vi.fn().mockResolvedValue("secret");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRaw(
      handle,
      JSON.stringify({ request: "Password:", token: "deadbeef" }) + "\n",
    );
    expect(response).toEqual({ error: "unauthorized" });
    expect(showPrompt).not.toHaveBeenCalled();

    await server.stop();
  });

  it("responds with cancelled when showPrompt returns undefined", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue(undefined),
    });
    const handle = await server.start();

    const response = await sendRequest(handle, "Passphrase:", server.token);
    expect(response).toEqual({ cancelled: true });

    await server.stop();
  });

  it("handles multiple sequential requests", async () => {
    let call = 0;
    const passwords = ["pw1", "pw2"];
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockImplementation(() =>
        Promise.resolve(passwords[call++]),
      ),
    });
    const handle = await server.start();

    expect(await sendRequest(handle, "Prompt 1", server.token)).toEqual({
      password: "pw1",
    });
    expect(await sendRequest(handle, "Prompt 2", server.token)).toEqual({
      password: "pw2",
    });

    await server.stop();
  });

  it("retries up to 3 times for wrong key passphrases", async () => {
    const showPrompt = vi.fn().mockResolvedValue("wrong");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRequest(
      handle,
      "Enter passphrase for key '/nonexistent/key':",
      server.token,
    );

    // Key file doesn't exist -> validatePassphrase returns invalid each time.
    // Server should retry 3 times, then return the error.
    expect(showPrompt).toHaveBeenCalledTimes(3);
    expect(response).toHaveProperty("error");
    expect(response.error).toContain("not found");

    await server.stop();
  });

  it("passes errorMessage to showPrompt on retry", async () => {
    const calls: (string | undefined)[] = [];
    const showPrompt = vi.fn().mockImplementation((_prompt: string, errorMessage?: string) => {
      calls.push(errorMessage);
      return Promise.resolve("wrong");
    });
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    await sendRequest(
      handle,
      "Enter passphrase for key '/nonexistent/key':",
      server.token,
    );

    // First call has no errorMessage, subsequent calls do.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toContain("not found");
    expect(calls[2]).toContain("not found");

    await server.stop();
  });

  it("returns cancelled when user dismisses the prompt", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue(undefined),
    });
    const handle = await server.start();

    const response = await sendRequest(
      handle,
      "Enter passphrase for key '/nonexistent/key':",
      server.token,
    );

    // User cancelled on first attempt - no retry.
    expect(response).toEqual({ cancelled: true });

    await server.stop();
  });
});

function sendRequest(
  handle: string,
  prompt: string,
  token: string,
): Promise<{ password?: string; cancelled?: boolean; error?: string }> {
  return sendRaw(handle, JSON.stringify({ request: prompt, token }) + "\n");
}

function sendRaw(
  handle: string,
  raw: string,
): Promise<{ password?: string; cancelled?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(handle);
    let buf = "";
    client.on("connect", () => {
      client.write(raw);
    });
    client.on("data", (data) => {
      buf += data.toString();
      if (buf.endsWith("\n")) {
        client.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    client.on("error", reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error("timeout"));
    }, 2000);
  });
}
