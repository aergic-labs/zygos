/*
 * Mock SshSessionClient for unit tests. Records calls and returns
 * scripted responses. Supports substring matching and sequenced
 * responses for the polling pattern in SshSessionProcess.
 */

import type { ExecResponse } from "../../src/ssh/sshSession/protocol";

export interface MockSshSessionClientOptions {
  /** Initial SOCKS port returned by getSocksPort / status. */
  socksPort?: number;
  /** True to make start() throw. */
  startFails?: boolean;
}

interface QueuedResponse {
  substring: string;
  response: ExecResponse;
  /** Optional: only return this once, then fall through. */
  once?: boolean;
}

export class MockSshSessionClient {
  socksPort: number;
  startCalls = 0;
  stopCalls = 0;
  attachCalls = 0;
  detachCalls = 0;
  putFileCalls: { path: string; content: Buffer; mode?: string }[] = [];
  execCalls: string[] = [];
  private startFails: boolean;
  private responses: QueuedResponse[] = [];
  private defaultResponse: ExecResponse = {
    id: "mock",
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
  };

  constructor(opts: MockSshSessionClientOptions = {}) {
    this.socksPort = opts.socksPort ?? 1080;
    this.startFails = opts.startFails ?? false;
  }

  /** Queue a response for the next exec whose command contains substring. */
  setResponse(substring: string, response: Partial<ExecResponse>): this {
    this.responses.push({
      substring,
      response: { ...this.defaultResponse, ...response },
    });
    return this;
  }

  /** Queue a one-shot response (consumed after first match). */
  setResponseOnce(substring: string, response: Partial<ExecResponse>): this {
    this.responses.push({
      substring,
      response: { ...this.defaultResponse, ...response },
      once: true,
    });
    return this;
  }

  setDefault(response: Partial<ExecResponse>): this {
    this.defaultResponse = { ...this.defaultResponse, ...response };
    return this;
  }

  private match(command: string): ExecResponse {
    for (let i = 0; i < this.responses.length; i++) {
      const r = this.responses[i];
      if (command.includes(r.substring)) {
        if (r.once) this.responses.splice(i, 1);
        return r.response;
      }
    }
    return this.defaultResponse;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startFails) throw new Error("mock start failed");
  }

  async stop(): Promise<void> {
    this.stopCalls++;
  }

  async exec(command: string, _timeoutMs?: number): Promise<ExecResponse> {
    this.execCalls.push(command);
    return this.match(command);
  }

  async putFile(
    path: string,
    content: Buffer,
    mode?: string,
  ): Promise<ExecResponse> {
    this.putFileCalls.push({ path, content, mode });
    return { ...this.defaultResponse };
  }

  async getSocksPort(): Promise<number> {
    return this.socksPort;
  }
}
