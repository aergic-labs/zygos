/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Remote authority resolver for `ssh-remote+<hex>` authorities.
 *
 * `resolve()` returns a `ManagedResolvedAuthority` with a `makeConnection()`
 * factory returning a `ManagedMessagePassing` (duplex byte stream). Core sends
 * the server protocol over that stream directly - no local listening port.
 *
 * Flow:
 *   1. Parse the authority -> SSH destination
 *   2. Connect via SSH, ensure the server is installed
 *   3. Start the server on the remote (SSH exec, parse the listening port)
 *   4. Open a SOCKS dynamic forward (ssh -D <socksPort> -N)
 *   5. Return ManagedResolvedAuthority whose makeConnection() does a
 *      SOCKS5 connect to 127.0.0.1:<remotePort> through the ssh -D channel
 *
 * managed-resolver path, required for `resolveExecServer`
 * chaining (devcontainer-over-SSH).
 */

import * as vscode from "vscode";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "../common/logger";
import { SshConnection, type SshConnectOptions } from "../ssh/connection";
import { sshSettings } from "../ssh/sshConfig";
import { decodeAuthority, parseAuthority } from "../ssh/destination";
import { detectPlatform, getProductInfo } from "../platform";
import { ensureServerInstalled } from "../remote/install";
import { shellQuote, remoteShPath, remoteToolsDir } from "../remote/busybox";
import { copyAuthFiles } from "../remote/authToken";
import {
  writeConnectionTokenFile,
  removeConnectionTokenFile,
  readConnectionTokenFile,
} from "../remote/connectionToken";
import { socks5Connect } from "../net/socks5";
import { wrapSocket } from "../net/managedConnection";
import { SshExecServer } from "../remote/execServer";
import { AskpassServer } from "../ssh/askpassServer";
import {
  acquireLockAndProbeZombie,
  finalizeServerStart,
  removeServerMetadata,
  releaseResolveLock,
} from "../remote/lifecycle";
import {
  ConnectionMonitor,
  type MonitoredConnection,
} from "../health/connectionMonitor";

/** A SOCKS forward + server process pair. The monitor updates
 * socksPort/forwardProcess/dead in place; makeConnection() reads them
 * on each call, applying repairs without a full re-resolve. */
interface RemoteConnection extends MonitoredConnection {
  /** Path on the remote where the connection token was written. */
  tokenFile: string;
  /** Monitor for this connection, stopped on cleanup. */
  monitor: ConnectionMonitor;
  /** Askpass server (if enabled), stopped on cleanup. */
  askpass?: AskpassServer;
  /** Remote HOME dir, for cleanup commands. */
  home: string;
  /** Server install path on the remote, for PID/port file cleanup. */
  installPath: string;
  /** Stored makeConnection closure for reuse on re-resolve. */
  makeConnection: () => Thenable<any>;
  /** Connection token for reuse on re-resolve. */
  connectionToken: string;
}

const LISTENING_RE = /Extension host agent listening on (\d+)/;

/**
 * Collect proxy env vars to forward to the remote server.
 *
 * Reads zygos.httpProxy / zygos.httpsProxy settings. Empty string = off.
 * Explicit settings, no env var sniffing. The remote server
 * needs these to reach the extension marketplace from behind a
 * corporate proxy.
 *
 * Returns `{ http_proxy, https_proxy }` with only the keys that have values.
 */
export function collectProxyEnv(): Record<string, string> {
  const config = vscode.workspace.getConfiguration("zygos");
  const httpProxy = config.get<string>("httpProxy", "").trim();
  const httpsProxy = config.get<string>("httpsProxy", "").trim();

  const env: Record<string, string> = {};
  if (httpProxy) env.http_proxy = httpProxy;
  if (httpsProxy) env.https_proxy = httpsProxy;
  return env;
}

export type ConnectionFactory = (
  dest: { host: string; user?: string; port?: number },
  opts: Partial<SshConnectOptions>,
) => SshConnection;

export class SshRemoteResolver {
  /** Active connections keyed by authority (for reconnect cleanup). */
  private connections = new Map<string, RemoteConnection>();
  /** Label formatters keyed by authority (disposed on reconnect/deactivate). */
  private labelFormatters = new Map<string, vscode.Disposable>();

  constructor(
    private readonly logger: Logger,
    private readonly extensionPath: string,
    private readonly connectionFactory: ConnectionFactory = (dest, opts) =>
      SshConnection.fromDestination(dest, opts),
  ) {}

  async resolve(
    authority: string,
    context: { resolveAttempt: number },
  ): Promise<{
    makeConnection: () => Thenable<any>;
    connectionToken: string | undefined;
    extensionHostEnv?: Record<string, string | null>;
  }> {
    const parsed = parseAuthority(authority);
    if (!parsed) {
      throw new Error(`Not an ssh-remote authority: ${authority}`);
    }

    const dest = decodeAuthority(parsed.payload);
    const platform = detectPlatform();
    const productInfo = getProductInfo(platform);
    const isReconnect = context.resolveAttempt > 1;
    const hostLabel = dest.user ? `${dest.user}@${dest.host}` : dest.host;

    this.logger.info(
      `resolve(${authority}) attempt=${context.resolveAttempt}${isReconnect ? " (reconnect)" : ""}`,
    );

    // Notifications don't render during the "Opening Remote" loading phase
    // (they queue and flash at the end). The status bar is visible; report
    // progress there and expose the output channel for per-step logs.
    this.logger.show();
    const status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    status.text = `$(sync~spin) SSH: Connecting to ${hostLabel}...`;
    status.tooltip = `Zygos: connecting to ${hostLabel}`;
    status.show();

    const report = (msg: string): void => {
      this.logger.info(`[resolve] ${msg}`);
      status.text = `$(sync~spin) SSH: ${msg}`;
    };

    // Start askpass before resolveFlow so it's available in the catch block
    // for host password eviction on failure.
    const askpass = await this.maybeStartAskpass();

    try {
      return await this.resolveFlow(
        authority,
        dest,
        platform,
        productInfo,
        isReconnect,
        report,
        askpass,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`[resolve] failed: ${msg}`);

      // Evict any host passwords cached during this attempt so a retry
      // re-prompts instead of reusing a bad password. Key passphrases are
      // validated before caching, so only host passwords need eviction.
      if (askpass?.usedHostPassword) {
        this.logger.info("[resolve] evicting host password cache entries");
        await askpass.evictHostPasswords();
      }

      // Show a retry notification. The user clicks Retry to reload the
      // window, which re-triggers resolve for the same authority.
      const action = await vscode.window.showErrorMessage(
        `SSH connection to ${hostLabel} failed: ${msg}`,
        "Retry",
      );
      if (action === "Retry") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }

      throw err;
    } finally {
      status.dispose();
    }
  }

  private async resolveFlow(
    authority: string,
    dest: { host: string; user?: string; port?: number },
    platform: ReturnType<typeof detectPlatform>,
    productInfo: ReturnType<typeof getProductInfo>,
    isReconnect: boolean,
    report: (msg: string) => void,
    askpass: AskpassServer | undefined,
  ): Promise<{
    makeConnection: () => Thenable<any>;
    connectionToken: string | undefined;
    extensionHostEnv?: Record<string, string | null>;
  }> {
    // Register a label formatter for this authority: the window title shows
    // the hostname (e.g. "root [SSH: example.com]") instead of a generic
    // "root [SSH]". Registered per-connect; the hostname is encoded in the
    // authority hex.
    const hostLabel = dest.user ? `${dest.user}@${dest.host}` : dest.host;

    // Reuse an existing healthy connection for this authority. VS Code
    // calls resolve() again when opening a new folder on the same remote;
    // reconnecting from scratch would kill the server and re-prompt.
    const prev = this.connections.get(authority);
    if (prev && !prev.dead) {
      this.logger.info(
        `[resolve] reusing existing connection for ${authority}`,
      );
      return {
        makeConnection: prev.makeConnection,
        connectionToken: prev.connectionToken,
      };
    }

    // Register label formatter only when not reusing (avoids per-resolve leak).
    if (!this.labelFormatters.has(authority)) {
      const disp = registerLabelFormatter(authority, hostLabel);
      this.labelFormatters.set(authority, disp);
    }

    // Clean up any previous (dead) connection for this authority.
    if (prev) {
      this.killConnection(prev);
      this.connections.delete(authority);
    }

    // Connect and install.
    report("Connecting via SSH...");
    const conn = this.connectionFactory(dest, {
      logger: this.logger,
      ...this.connectionExtras(),
      ...this.askpassOptions(askpass),
    });
    await conn.connect();

    report("Ensuring server is installed...");
    const installResult = await ensureServerInstalled(
      conn,
      platform,
      productInfo,
      this.logger,
      this.extensionPath,
      {
        onDownloadProgress: (received, total) => {
          if (total) {
            const pct = Math.floor((received / total) * 100);
            const mb = (received / 1_048_576).toFixed(1);
            const totalMb = (total / 1_048_576).toFixed(0);
            report(`Downloading server... ${pct}% (${mb}/${totalMb} MB)`);
          } else {
            const mb = (received / 1_048_576).toFixed(1);
            report(`Downloading server... ${mb} MB`);
          }
        },
        onPhase: (phase) => {
          if (phase === "extracting") {
            report("Extracting server tarball...");
          } else if (phase === "verifying") {
            report("Verifying server install...");
          }
        },
      },
    );

    // Acquire the resolve lock and probe for an existing/zombie server in
    // one round-trip. Two parallel resolves to the same install path would
    // race on server start + metadata writes.
    report("Checking for existing server...");
    const lockProbe = await acquireLockAndProbeZombie(
      conn,
      installResult.home,
      installResult.installPath,
    );
    this.logger.info(`[lifecycle] ${lockProbe.log}`);
    const locked = lockProbe.locked;

    // Copy the IDE auth files (e.g. Kiro SSO token + refresh-registration
    // sibling) so the remote can authenticate and refresh on its own.
    report("Copying auth files...");
    await copyAuthFiles(conn, installResult.home, platform, this.logger);

    // Generate a connection token (the server validates this on every
    // connection). Written to a chmod 600 file on the remote and passed via
    // --connection-token-file to keep it out of `ps`.
    let connectionToken: string;
    let tokenFile: string;
    let remotePort: number;
    let serverProcess: ChildProcess | undefined;

    if (lockProbe.reusePort) {
      // Existing healthy server from another window - reuse it.
      // Read the existing token from the file; the server validates against
      // the token it was started with, not a new one we generate.
      report("Reusing existing server...");
      remotePort = lockProbe.reusePort;
      serverProcess = undefined;
      const existingToken = await readConnectionTokenFile(
        conn,
        installResult.home,
        this.logger,
        installResult.installPath,
      );
      if (!existingToken) {
        this.logger.info(
          "[resolve] reused server but no token file found, generating new",
        );
        connectionToken = generateToken();
        tokenFile = await writeConnectionTokenFile(
          conn,
          installResult.home,
          connectionToken,
          this.logger,
          installResult.installPath,
        );
      } else {
        connectionToken = existingToken;
        tokenFile = `${installResult.home}/.ssh-remote/conn-token-${path.basename(installResult.installPath)}`;
        this.logger.info("[resolve] using existing connection token");
      }
    } else {
      // Start a new server with a fresh token. The token is piped to the
      // server start script via SSH stdin and written to the token file on
      // the remote before the server starts, keeping it out of `ps`.
      report("Starting server...");
      connectionToken = generateToken();
      const suffix = `-${path.basename(installResult.installPath)}`;
      tokenFile = `${installResult.home}/.ssh-remote/conn-token${suffix}`;
      try {
        const started = await this.startServer(
          conn,
          installResult.home,
          installResult.installPath,
          productInfo.serverApplicationName,
          tokenFile,
          connectionToken,
          isReconnect,
        );
        remotePort = started.port;
        serverProcess = started.process;
      } catch (err) {
        if (locked) {
          await releaseResolveLock(
            conn,
            installResult.home,
            installResult.installPath,
            this.logger,
          );
        }
        throw err;
      }
    }

    // Write PID/port files for a new server, and release the resolve lock,
    // in one round-trip. Skipped when reusing an existing server.
    let forwardProcess: ChildProcess | undefined;
    let socksPort = 0;
    try {
    if (!lockProbe.reusePort) {
      const fin = await finalizeServerStart(
        conn,
        installResult.home,
        installResult.installPath,
        remotePort,
        { releaseLock: locked },
      );
      this.logger.info(`[lifecycle] ${fin.log}`);
    } else if (locked) {
      // Reused an existing server; just release the lock we acquired.
      await releaseResolveLock(
        conn,
        installResult.home,
        installResult.installPath,
        this.logger,
      );
    }

    // Open a SOCKS dynamic forward (ssh -D <port> -N). Core calls
    // makeConnection() for each server-protocol connection it needs; each
    // call does a SOCKS5 CONNECT to 127.0.0.1:remotePort through this proxy.
    report("Starting SOCKS forward...");
    socksPort = await findFreePort();
    forwardProcess = this.startSocksForward(conn, socksPort);

    // Wait for the SOCKS proxy to be ready.
    await waitForPort(socksPort, 10_000);
    this.logger.info(
      `[resolve] SOCKS proxy on 127.0.0.1:${socksPort} -> remote:${remotePort}`,
    );
    } catch (err) {
      if (serverProcess) serverProcess.kill();
      if (forwardProcess) forwardProcess.kill();
      throw err;
    }

    // Build the mutable connection object. The monitor updates
    // socksPort/forwardProcess/dead in place; makeConnection() reads them
    // on each call, applying repairs without a full re-resolve.
    const connState: RemoteConnection = {
      serverProcess,
      forwardProcess,
      socksPort,
      remotePort,
      tokenFile,
      conn,
      dead: false,
      monitor: undefined as any, // set below
      askpass,
      home: installResult.home,
      installPath: installResult.installPath,
      makeConnection: undefined as any, // set below
      connectionToken,
      ownsServer: !lockProbe.reusePort,
    };

    // Attach exit listeners to detect process death immediately, not minutes
    // later when core calls makeConnection() or the monitor's periodic probe
    // runs. Sets `dead`; makeConnection() fast-fails and triggers core's
    // reconnect.
    this.attachExitListeners(connState, hostLabel);

    // Start the health monitor. On sleep/wake, it probes and repairs the
    // SOCKS forward if needed, or marks dead to trigger a core reconnect.
    const monitor = new ConnectionMonitor(
      connState,
      {
        findFreePort,
        startSocksForward: (c, p) => this.startSocksForward(c, p),
        waitForPort,
      },
      this.logger,
      (msg) => report(msg),
    );
    connState.monitor = monitor;
    monitor.start();

    // Store the connection for cleanup on reconnect/deactivate.
    this.connections.set(authority, connState);

    report("Connected");

    // Return ManagedResolvedAuthority: core calls makeConnection() per
    // connection it needs; each SOCKS-connects to the server's port.
    // Reads from connState, picking up the monitor's in-place repairs
    // (new socksPort/forwardProcess) transparently.
    const makeConnection = async (): Promise<any> => {
      if (connState.dead) {
        throw new Error(
          `SSH connection to ${hostLabel} is dead - triggering reconnect`,
        );
      }
      this.logger.info(
        `[resolve] makeConnection() -> SOCKS5 to 127.0.0.1:${connState.remotePort} via :${connState.socksPort}`,
      );
      const socket = await socks5Connect(
        "127.0.0.1",
        connState.socksPort,
        "127.0.0.1",
        connState.remotePort,
      );
      return wrapSocket(socket);
    };
    connState.makeConnection = makeConnection;

    return { makeConnection, connectionToken };
  }

  /**
   * Start the VS Code server on the remote. Returns the port it's listening on.
   * The SSH process stays alive (the server runs in the foreground).
   */
  private async startServer(
    conn: SshConnection,
    home: string,
    installPath: string,
    serverApp: string,
    tokenFile: string,
    connectionToken: string,
    _isReconnect: boolean,
  ): Promise<{ port: number; process: ChildProcess }> {
    const serverScript = `${installPath}/bin/${serverApp}`;
    const toolsDir = remoteToolsDir(home);
    const sh = remoteShPath(home);
    const remoteDirName = path.dirname(tokenFile);

    // Extensions to install on the remote at server startup.
    const extensionIds = vscode.workspace
      .getConfiguration("zygos")
      .get<string[]>("defaultExtensions", [])
      .filter((id) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i.test(id));

    // Build the server start command.
    // --port=0 lets the OS pick a free port; parsed from stdout.
    // --connection-token-file avoids exposing the token via `ps`.
    const startParts = [
      shellQuote(serverScript),
      "--start-server",
      "--host=127.0.0.1",
      "--port=0",
      `--connection-token-file ${shellQuote(tokenFile)}`,
      "--enable-remote-auto-shutdown",
      "--accept-server-license-terms",
    ];
    for (const extId of extensionIds) {
      startParts.push(`--install-extension ${shellQuote(extId)}`);
    }
    const startCmd = startParts.join(" ");

    // Forward apex-side HTTP/HTTPS proxy env to the remote server to reach
    // the extension marketplace / update endpoints from behind a corporate
    // proxy. Matches MS remote-ssh's proxy forwarding.
    const proxyEnv = collectProxyEnv();
    const envExports = Object.entries(proxyEnv)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("; ");

    // The connection token is piped to the shell via SSH stdin: the shell
    // reads it with `cat`, writes it to the token file (chmod 600), then
    // `exec`s the server. The token never appears in the command line (so
    // it's not visible via `ps`) and never travels in the environment. After
    // writing the token we close stdin so `cat` gets EOF, writes the file,
    // and the `exec`'d server inherits a closed stdin (fine for
    // --start-server).
    //
    // PATH scoping: prepend `toolsDir` only for the pre-exec steps
    // (mkdir/cat) that need our busybox on a stripped host. Restore the
    // original PATH before `exec` so the long-lived server (and the
    // integrated terminals, tasks, and debug adapters it parents) inherits
    // the user's real login-shell PATH, not our polyfill. Otherwise busybox
    // applets shadow system coreutils in the terminal (zygos issue #5:
    // BusyBox `readlink` lacks `-e` and clobbers coreutils `readlink -e`).
    const writeAndStart =
      `__zy_path=$PATH; export PATH=${shellQuote(toolsDir)}:$PATH; ` +
      `mkdir -p ${shellQuote(remoteDirName)} && umask 077 && cat > ${shellQuote(tokenFile)} && ` +
      `export PATH=$__zy_path; unset __zy_path; ` +
      `exec ${startCmd}`;

    // Run via busybox sh so the pre-exec steps above resolve to our tools.
    const wrapped = `${envExports ? envExports + "; " : ""}${writeAndStart}`;

    this.logger.info(`[resolve] starting server: ${startCmd}`);

    // Spawn a long-running SSH process that runs the server.
    const child = conn.spawnProcess(`${sh} -c ${shellQuote(wrapped)}`);

    // Write the token to the shell's stdin, then close it so `cat` gets EOF,
    // writes the file, and `exec` proceeds to start the server.
    child.stdin?.write(connectionToken, "utf-8");
    child.stdin?.end();

    // Parse the listening port from stdout.
    return new Promise<{ port: number; process: ChildProcess }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGTERM");
          reject(
            new Error(
              "Timed out waiting for server to start (no listening port)",
            ),
          );
        }, 60_000);

        let stdoutBuf = "";
        let stderrBuf = "";
        let resolved = false;

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuf += chunk.toString("utf-8");
          if (resolved) return;
          const match = stdoutBuf.match(LISTENING_RE);
          if (match) {
            resolved = true;
            clearTimeout(timeout);
            const port = parseInt(match[1], 10);
            this.logger.info(`[resolve] server started on port ${port}`);
            resolve({ port, process: child });
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString("utf-8");
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`SSH spawn failed: ${err.message}`));
        });

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== null && code !== 0) {
            reject(
              new Error(
                `Server process exited with code ${code}. stderr: ${stderrBuf.slice(-2000)}`,
              ),
            );
          }
        });
      },
    );
  }

  /**
   * Set up askpass for a connection if enabled. Returns the askpass
   * server (started) or undefined. The caller is responsible for stopping
   * it on connection teardown.
   */
  private async maybeStartAskpass(): Promise<AskpassServer | undefined> {
    const config = vscode.workspace.getConfiguration("zygos");
    const enabled = config.get<boolean>("askpass", true);
    if (!enabled) return undefined;

    const server = new AskpassServer(this.logger, {
      showPrompt: (prompt, errorMessage) =>
        vscode.window.showInputBox({
          password: true,
          prompt: errorMessage ? `${prompt} (${errorMessage})` : prompt,
          title: "Zygos SSH Authentication",
          ignoreFocusOut: true,
        }),
    });
    await server.start();
    return server;
  }

  /**
   * Extra SSH connect options from user settings: custom ssh binary
   * (`zygos.sshPath`) and config file (`zygos.configFile`), both with `~/`
   * expansion. Empty values fall back to ssh defaults.
   */
  private connectionExtras(): Partial<SshConnectOptions> {
    const { sshPath, configFile } = sshSettings();
    const extras: Partial<SshConnectOptions> = {};
    if (sshPath) extras.sshPath = sshPath;
    if (configFile) extras.configFile = configFile;
    return extras;
  }

  /**
   * Build askpass-related options for SshConnection.fromDestination().
   */
  private askpassOptions(askpass: AskpassServer | undefined) {
    if (!askpass) return {};
    const scriptsDir = `${this.extensionPath}/scripts/askpass`;
    const script =
      process.platform === "win32"
        ? `${scriptsDir}/askpass.cmd`
        : `${scriptsDir}/askpass.sh`;
    const main = `${scriptsDir}/askpass-main.js`;
    const nodePath = process.execPath;
    return {
      askpass,
      askpassScript: script,
      askpassMain: main,
      nodePath,
    };
  }

  /**
   * Attach exit listeners so process death is detected immediately, not
   * at the next makeConnection() call or the monitor's 60s probe. Sets
   * `dead` instantly and shows a status bar item.
   */
  private attachExitListeners(
    connState: RemoteConnection,
    hostLabel: string,
  ): void {
    const onDead = (
      what: string,
      code: number | null,
      signal: string | null,
    ): void => {
      if (connState.dead) return; // already marked
      this.logger.error(
        `[health] ${what} exited (code=${code} signal=${signal}) - marking dead`,
      );
      connState.dead = true;
      // Status bar item shown on death. Auto-disposes after 10s.
      const status = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      status.text = `$(error) SSH: ${hostLabel} disconnected - reconnecting...`;
      status.tooltip = `${what} exited (code=${code})`;
      status.show();
      setTimeout(() => status.dispose(), 10_000);
    };

    // Capture the process reference to detect monitor replacement (repair)
    // vs. genuine death.
    const forwardProc = connState.forwardProcess;
    forwardProc?.on("close", (code, signal) => {
      // If the monitor restarted the forward, connState.forwardProcess
      // points to the new process; this is the old one exiting, expected
      // during repair, not a failure.
      if (connState.forwardProcess !== forwardProc) return;
      onDead("SOCKS forward", code, signal);
    });

    const serverProc = connState.serverProcess;
    serverProc?.on("close", (code, signal) => {
      onDead("Server process", code, signal);
    });
  }

  /**
   * Start an SSH `-D` SOCKS dynamic forward: a local SOCKS5 proxy on
   * `socksPort` that can tunnel to any host:port on the remote. Core calls
   * `makeConnection()` which does a SOCKS5 CONNECT to 127.0.0.1:remotePort.
   *
   * Returns the long-running ChildProcess. The caller must keep it alive.
   */
  private startSocksForward(
    conn: SshConnection,
    socksPort: number,
  ): ChildProcess {
    this.logger.info(`[resolve] starting SOCKS forward -D ${socksPort}`);

    const child = conn.spawnProcess(undefined, [
      "-D",
      String(socksPort),
      "-N", // no remote command, just forward
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "-o",
      "TCPKeepAlive=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ExitOnForwardFailure=yes",
    ]);

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf-8").trim();
      if (line) this.logger.debug(`[socks] ${line}`);
    });

    child.on("close", (code) => {
      this.logger.info(`[resolve] SOCKS forward exited (code=${code})`);
    });

    return child;
  }

  /**
   * Resolve an exec server for chained authorities (e.g.
   * `artizo-container+<hex>@ssh-remote+<hex>`).
   *
   * Returns an `ExecServer` backed by SSH exec + SOCKS. The child resolver
   * (e.g. artizo) calls methods on it to spawn processes, read/write files,
   * and connect to TCP ports on the remote, all through this SSH connection.
   *
   * No REH server here - the ExecServer runs commands on the SSH host, not
   * the VS Code server. The child resolver starts its own server (e.g.
   * inside a container) using this.
   */
  async resolveExecServer(
    authority: string,
    _context: { resolveAttempt: number; execServer?: unknown },
  ): Promise<unknown> {
    this.logger.info(`[resolveExecServer] authority=${authority}`);

    const parsed = parseAuthority(authority);
    if (!parsed) {
      throw new Error(`Not an ssh-remote authority: ${authority}`);
    }

    const dest = decodeAuthority(parsed.payload);
    const hostLabel = dest.user ? `${dest.user}@${dest.host}` : dest.host;

    // Show the output channel so logs are visible during chained resolves.
    this.logger.show();

    // Start askpass before connecting so it's available in the catch block
    // for host password eviction on failure.
    const askpass = await this.maybeStartAskpass();

    try {
      const conn = this.connectionFactory(dest, {
        logger: this.logger,
        ...this.connectionExtras(),
        ...this.askpassOptions(askpass),
      });
      await conn.connect();
      this.logger.info(`[resolveExecServer] SSH connected to ${hostLabel}`);

      // Start a SOCKS forward for tcpConnect().
      const socksPort = await findFreePort();
      const forwardProcess = this.startSocksForward(conn, socksPort);
      await waitForPort(socksPort, 10_000);
      this.logger.info(`[resolveExecServer] SOCKS on :${socksPort}`);

      // Build the mutable connection + monitor (same as resolve()).
      // The execServer path has no server process; the monitor can only repair
      // the SOCKS forward. If SSH dies it marks dead.
      const connState: RemoteConnection = {
        serverProcess: undefined,
        forwardProcess,
        socksPort,
        remotePort: 0,
        tokenFile: "",
        conn,
        dead: false,
        monitor: undefined as any,
        askpass,
        home: "",
        installPath: "",
        makeConnection: undefined as any,
        connectionToken: "",
        ownsServer: false,
      };
      this.attachExitListeners(connState, dest.host);
      const monitor = new ConnectionMonitor(
        connState,
        {
          findFreePort,
          startSocksForward: (c, p) => this.startSocksForward(c, p),
          waitForPort,
        },
        this.logger,
      );
      connState.monitor = monitor;
      monitor.start();

      const execKey = `${authority}:execServer`;
      const prev = this.connections.get(execKey);
      if (prev) {
        this.killConnection(prev);
        this.connections.delete(execKey);
      }
      this.connections.set(execKey, connState);

      const execServer = new SshExecServer(conn, socksPort, this.logger);
      this.logger.info(`[resolveExecServer] ready for ${hostLabel}`);
      return execServer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`[resolveExecServer] failed: ${msg}`);

      // Evict any host passwords cached during this attempt so a retry
      // re-prompts instead of reusing a bad password.
      if (askpass?.usedHostPassword) {
        this.logger.info(
          "[resolveExecServer] evicting host password cache entries",
        );
        await askpass.evictHostPasswords();
      }

      throw err;
    }
  }

  /** Kill all active connections (called on deactivate). */
  dispose(): void {
    for (const [authority, conn] of this.connections) {
      this.logger.info(`[resolve] cleaning up ${authority}`);
      this.killConnection(conn);
    }
    this.connections.clear();
    for (const disp of this.labelFormatters.values()) disp.dispose();
    this.labelFormatters.clear();
  }

  private killConnection(conn: RemoteConnection): void {
    try {
      conn.monitor?.stop();
    } catch {
      /* ignore */
    }
    try {
      void conn.askpass?.stop();
    } catch {
      /* ignore */
    }
    try {
      conn.forwardProcess?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (conn.ownsServer) {
      try {
        conn.serverProcess?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Only remove token/PID/port files if we started the server.
      // A reused server from another window still needs them.
      void removeConnectionTokenFile(conn.conn, conn.tokenFile, this.logger);
      if (conn.installPath) {
        void removeServerMetadata(
          conn.conn,
          conn.home,
          conn.installPath,
          this.logger,
        );
        void releaseResolveLock(
          conn.conn,
          conn.home,
          conn.installPath,
          this.logger,
        );
      }
    }
  }
}

// --- Helpers ---

export function generateToken(): string {
  // Cryptographically secure: this token is the sole credential guarding the
  // remote server. 16 bytes -> 32 hex chars. Never use Math.random() here.
  return crypto.randomBytes(16).toString("hex");
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Failed to find free port"));
      }
    });
  });
}

export function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    function tryConnect(): void {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 200);
        }
      });
    }
    tryConnect();
  });
}

// --- Registration ---

/**
 * Register a resource label formatter for a specific ssh-remote authority:
 * the window title and explorer show `SSH: <hostname>` instead of just
 * `SSH`. MS Remote-SSH does the same; registers per-authority with the real
 * hostname baked into the suffix.
 */
export function registerLabelFormatter(
  authority: string,
  hostLabel: string,
): vscode.Disposable {
  return (vscode.workspace as any).registerResourceLabelFormatter({
    scheme: "vscode-remote",
    authority,
    formatting: {
      label: "${path}",
      separator: "/",
      tildify: true,
      workspaceSuffix: `SSH: ${hostLabel}`,
    },
  });
}

/**
 * Register the ssh-remote authority resolver with the host.
 * Uses `as any` casts for the proposed API.
 */
export function registerResolver(
  context: vscode.ExtensionContext,
  logger: Logger,
): SshRemoteResolver {
  const resolver = new SshRemoteResolver(logger, context.extensionPath);

  // Register the resolver. The proposed API is:
  //   vscode.workspace.registerRemoteAuthorityResolver("ssh-remote", resolver)
  // The resolver needs `resolve(authority, context)` returning a ResolvedAuthority.
  (vscode.workspace as any).registerRemoteAuthorityResolver("ssh-remote", {
    resolve: (authority: string, context: { resolveAttempt: number }) =>
      resolver.resolve(authority, context),
    resolveExecServer: (
      authority: string,
      context: { resolveAttempt: number; execServer?: unknown },
    ) => resolver.resolveExecServer(authority, context),
  });

  context.subscriptions.push({ dispose: () => resolver.dispose() });

  return resolver;
}
