#!/usr/bin/env node
/**
 * Zygos SSH askpass - Node.js client.
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Connects to the extension host via a Unix socket (Unix) or named pipe
 * (Windows), sends the prompt, and writes the password to stdout for ssh.
 */

const net = require("net");
const fs = require("fs");

/**
 * Decode octal escape sequences (\nnn) that ssh may add for non-ASCII
 * characters (e.g. Chinese prompts). The octal sequences are UTF-8 bytes.
 */
function decodeOctalEscapes(str) {
  if (!str) return str;
  const matches = str.match(/(?:\\[0-7]{3})+/g);
  if (!matches) return str;
  let result = str;
  for (const match of matches) {
    const octals = match.match(/\\([0-7]{3})/g);
    if (!octals) continue;
    const bytes = octals.map((oct) => parseInt(oct.slice(1), 8));
    const decoded = Buffer.from(bytes).toString("utf8");
    result = result.replace(match, decoded);
  }
  return result;
}

const rawPrompt = process.argv[2];
const socketPath = process.argv[3];

if (!rawPrompt || !socketPath) {
  console.error("Usage: askpass-main.js <prompt> <socket-path>");
  process.exit(1);
}

const prompt = decodeOctalEscapes(rawPrompt);

// On some systems (e.g. macOS), Unix domain socket files may not be
// visible via fs.existsSync even when the socket is listening. Retry a
// few times, then attempt connection anyway.
let retries = 3;
while (!fs.existsSync(socketPath) && retries > 0) {
  const now = Date.now();
  while (Date.now() - now < 100) {
    // busy wait 100ms
  }
  retries--;
}

const client = net.createConnection(socketPath);
let response = "";

client.on("connect", () => {
  // The token authenticates this client to the extension host. It's passed
  // via env (not argv) so it never appears in the process listing.
  const token = process.env.ZYGOS_SSH_ASKPASS_TOKEN || "";
  const request = JSON.stringify({ request: prompt, token }) + "\n";
  client.write(request);
});

client.on("data", (data) => {
  response += data.toString();
  if (response.endsWith("\n")) {
    try {
      const parsed = JSON.parse(response.trim());
      if (parsed.password !== undefined) {
        process.stdout.write(parsed.password);
        client.end();
        process.exit(0);
      } else if (parsed.cancelled) {
        client.end();
        process.exit(1);
      } else {
        console.error("Invalid response from extension");
        client.end();
        process.exit(1);
      }
    } catch (err) {
      console.error("Failed to parse response:", err.message);
      client.end();
      process.exit(1);
    }
  }
});

client.on("error", (err) => {
  console.error(`Socket error: ${err.message}`);
  process.exit(1);
});

client.on("end", () => {
  if (!response) {
    console.error("Connection closed without response");
    process.exit(1);
  }
});

// 5-minute timeout - if the user walks away, don't hang forever.
setTimeout(
  () => {
    console.error("Timeout waiting for password");
    client.end();
    process.exit(1);
  },
  5 * 60 * 1000,
);
