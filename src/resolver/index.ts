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
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "../common/logger";
import { SshConnection, type ISshConnection, type SshConnectOptions } from "../ssh/connection";
import { sshSettings } from "../ssh/sshConfig";
import { SshSession } from "../ssh/sshSession/connection";
import { sshSessionSecretReady } from "../ssh/sshSessionSecret";
import { decodeAuthority, parseAuthority } from "../ssh/destination";
import { detectPlatform, getProductInfo } from "../platform";
import { ensureServerInstalled } from "../remote/install";
import {
  shellQuote,
  remoteShPath,
  remoteToolsDir,
  agentLinkPath,
  agentForwardCommand,
  agentForwardCommandOneshot,
  parseAgentForwardReady,
  type AgentForward,
} from "../remote/busybox";
import { copyAuthFiles } from "../remote/authToken";
import {
  writeConnectionTokenFile,
  removeConnectionTokenFile,
  readConnectionTokenFile,
} from "../remote/connectionToken";
import { socks5Connect } from "../net/socks5";
import { wrapSocket } from "../net/managedConnection";
import { SshExecServer } from "../remote/execServer";
import { SshTunnelClient } from "../sshTunnel/client";
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
  type SocksForward,
} from "../health/connectionMonitor";

/** Idle timeout for the remote SshTunnel service, in ms. The resolver
 *  kills the tunnel on teardown, but a hard extension-host death (crash,
 *  power loss) sends no kill. This bounds the zombie: no authenticated
 *  requests for this long and the tunnel self-exits. 120s = 4x the 30s
 *  client heartbeat, so a live tunnel never ages out; an orphan dies in
 *  ~2min. */
const SSH_TUNNEL_IDLE_TIMEOUT_MS = 120_000;

/** A SOCKS forward + server process pair. The monitor updates
 * socksPort/forwardProcess/dead in place; makeConnection() reads them per
 * call, repairing without a full re-resolve. */
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
  /** extensionHostEnv returned by resolve(), for reuse on re-resolve. */
  extensionHostEnv?: Record<string, string | null>;
  /** SshTunnel port on the remote (session path only). 0 = not started. */
  tunnelPort: number;
  /** SshTunnel bearer token (hex) for the remote service. */
  tunnelToken: string;
}

/** workspaceState key prefix for the per-window agent link id. */
const AGENT_LINK_ID_KEY = "zygos.agentLinkId:";
/** Time allowed for the forward's remote command (incl. shell init) to report. */
const AGENT_READY_TIMEOUT_MS = 30_000;

const LISTENING_RE = /Extension host agent listening on (\d+)/;

/**
 * Collect proxy env vars for the remote server.
 *
 * Reads zygos.httpProxy / zygos.httpsProxy. Empty = off. Settings only,
 * no env sniffing. The remote needs these to reach the marketplace from
 * behind a corporate proxy.
 *
 * Returns `{ http_proxy, https_proxy }`, only keys with values.
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
) => ISshConnection;

/** Ssh session deps passed from the extension context. */
export interface SshSessionDeps {
  serverScriptPath: string;
  wrapperScriptPath: string;
  tunnelScriptPath: string;
  nodePath: string;
  dataDir: string;
}

export class SshRemoteResolver {
  /** Active connections keyed by authority (for reconnect cleanup). */
  private connections = new Map<string, RemoteConnection>();
  /** Label formatters keyed by authority (disposed on reconnect/deactivate). */
  private labelFormatters = new Map<string, vscode.Disposable>();
  /** Per-window agent link ids keyed by authority (backed by workspaceState). */
  private agentLinkIds = new Map<string, string>();

  constructor(
    private readonly logger: Logger,
    private readonly extensionPath: string,
    private readonly connectionFactory: ConnectionFactory | undefined,
    private readonly workspaceState?: vscode.Memento,
    private readonly sshSessionDeps?: SshSessionDeps,
  ) {
    if (!this.connectionFactory) {
      this.connectionFactory = (dest, opts) => this.defaultConnectionFactory(dest, opts);
    }
  }

  /** Pick session vs spawn-per-exec based on settings. */
  private defaultConnectionFactory(
    dest: { host: string; user?: string; port?: number },
    opts: Partial<SshConnectOptions>,
  ): ISshConnection {
    const { usePersistentConnection } = sshSettings();
    if (usePersistentConnection && this.sshSessionDeps && sshSessionSecretReady()) {
      return SshSession.fromDestination(dest, opts, {
        ...this.sshSessionDeps,
        logger: this.logger,
      });
    }
    return SshConnection.fromDestination(dest, opts);
  }

  /**
   * Id of this window's agent symlink for `authority`. Stable across
   * re-resolves and, via workspaceState, across window reloads, so terminals
   * that survive a reload (their env is frozen) keep pointing at a link that
   * gets repointed.
   */
  private agentLinkId(authority: string): string {
    let id = this.agentLinkIds.get(authority);
    if (id) return id;
    const key = AGENT_LINK_ID_KEY + authority;
    id = this.workspaceState?.get<string>(key);
    if (!id || !/^[0-9a-f]{16}$/.test(id)) {
      id = crypto.randomBytes(8).toString("hex");
      void this.workspaceState?.update(key, id);
    }
    this.agentLinkIds.set(authority, id);
    return id;
  }

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
        ...(prev.extensionHostEnv
          ? { extensionHostEnv: prev.extensionHostEnv }
          : {}),
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
    const isSession = sshSettings().usePersistentConnection === true && sshSessionSecretReady();
    const sessionSocksPort = isSession ? await findFreePort() : undefined;
    const conn = this.connectionFactory!(dest, {
      logger: this.logger,
      ...this.connectionExtras(),
      ...this.askpassOptions(askpass),
      ...(sessionSocksPort ? { socksPort: sessionSocksPort } : {}),
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
          if (phase === "verifying-checksum") {
            report("Verifying server checksum...");
          } else if (phase === "extracting") {
            report("Extracting server tarball...");
          } else if (phase === "verifying") {
            report("Verifying server install...");
          }
        },
      },
    );

    // Mutable connection state assigned across the phases below.
    let forwardProcess: ChildProcess | undefined;
    let socksPort = 0;
    let tunnelPort = 0;
    let tunnelToken = "";
    let activeTunnelClient: SshTunnelClient | undefined;
    let restartingTunnel = false;
    // Set once connState exists (below); the restart path reads it lazily.
    let connStateRef: RemoteConnection | undefined;
    let markTunnelDead: () => void = () => {};

    // Start the tunnel and install a fresh client whose heartbeat reports
    // unreachable. Used for the initial start and for in-place restarts.
    // Throws if startSshTunnel fails.
    const startTunnelClient = async (): Promise<void> => {
      const tunnel = await this.startSshTunnel(
        conn,
        installResult.home,
        installResult.installPath,
      );
      tunnelPort = tunnel.port;
      tunnelToken = tunnel.token;
      const client = new SshTunnelClient({
        socksPort,
        tunnelPort,
        token: tunnelToken,
        logger: this.logger,
        logFilePath: this.sshSessionDeps?.dataDir
          ? path.join(this.sshSessionDeps.dataDir, `${dest.host}.tunnel-client.log`)
          : undefined,
        onUnreachable: () => {
          void handleTunnelUnreachable();
        },
      });
      conn.setTunnelClient?.(client);
      if (connStateRef) {
        connStateRef.tunnelPort = tunnelPort;
        connStateRef.tunnelToken = tunnelToken;
      }
      activeTunnelClient = client;
    };

    // The heartbeat says the tunnel is gone. VS Code won't notice: its
    // connection is to the reh server, not our tunnel, so nothing calls
    // resolve()/makeConnection() and a dead flag would just sit there.
    // Repair in place: start a fresh tunnel and swap the client. Only if
    // that fails, mark dead.
    const handleTunnelUnreachable = async (): Promise<void> => {
      if (restartingTunnel || connStateRef?.dead) return;
      restartingTunnel = true;
      this.logger.error(
        "[health] tunnel unreachable - restarting tunnel in place",
      );
      try {
        const old = activeTunnelClient;
        await startTunnelClient();
        old?.dispose();
        this.logger.info(
          `[health] tunnel restarted in place on port ${tunnelPort}`,
        );
      } catch (err) {
        this.logger.error(
          `[health] tunnel restart failed: ${err instanceof Error ? err.message : String(err)} - marking connection dead`,
        );
        markTunnelDead();
      } finally {
        restartingTunnel = false;
      }
    };

    // Start the SshTunnel early on the session path, right after the
    // install (which gives us node on the remote). Starting before
    // copyAuthFiles/writeConnectionTokenFile lets those route through the
    // tunnel (binary HTTP-over-SOCKS5) instead of the base64 control-shell
    // hack. The tunnel's own script upload still uses conn.putFile
    // (base64): the tunnel isn't up yet, and setTunnelClient runs only
    // after startSshTunnel so its bootstrap can't recurse through itself.
    if (isSession) {
      const earlySocksPort = conn.getSocksPort?.() ?? sessionSocksPort!;
      await waitForPort(earlySocksPort, 10_000);
      socksPort = earlySocksPort;
      try {
        await startTunnelClient();
        this.logger.info(
          `[resolve] ssh tunnel on port ${tunnelPort} (putFile/execWithStdin routed through tunnel)`,
        );
      } catch (err) {
        this.logger.info(
          `[resolve] ssh tunnel failed to start: ${(err as Error).message} (falling back to base64)`,
        );
      }
    }

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
    // On the session path with a tunnel, this routes through POST /exec
    // (binary) instead of the base64 heredoc hack.
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
        if (isSession) {
          const port = await this.startServerSession(
            conn,
            installResult.home,
            installResult.installPath,
            productInfo.serverApplicationName,
            tokenFile,
            connectionToken,
          );
          remotePort = port;
          serverProcess = undefined;
        } else {
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
        }
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
    const agent: AgentForward = {
      home: installResult.home,
      link: agentLinkPath(installResult.home, this.agentLinkId(authority)),
    };
    let agentForwarded = false;
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
      // Reused an existing server; release the lock we acquired.
      await releaseResolveLock(
        conn,
        installResult.home,
        installResult.installPath,
        this.logger,
      );
    }

    // Open a SOCKS dynamic forward (ssh -D <port>). Core calls
    // makeConnection() for each server-protocol connection it needs; each
    // call does a SOCKS5 CONNECT to 127.0.0.1:remotePort through this proxy.
    // The forward also owns this window's forwarded agent socket.
    report("Starting SOCKS forward...");
    if (isSession) {
      // Session: the -D is folded into the ssh child. No separate process.
      // socksPort was assigned earlier (before the tunnel start) so the
      // tunnel client could reach the remote service. Only assign here if
      // the early start was skipped (e.g. tunnel failed and socksPort was
      // never set).
      if (!socksPort) {
        socksPort = conn.getSocksPort?.() ?? sessionSocksPort!;
        await waitForPort(socksPort, 10_000);
      }
      // Agent forward: one-shot exec in the control shell. The
      // session's ssh child keeps the session (and forwarded agent
      // socket) alive, so no keep-alive loop is needed (unlike
      // startSocksForward).
      const agentCmd = agentForwardCommandOneshot(agent.home, agent.link);
      const agentResult = await conn.exec(agentCmd.command);
      agentForwarded = parseAgentForwardReady(agentResult.stdout, agentCmd.marker) ?? false;
      this.logger.info(
        `[resolve] SOCKS proxy on 127.0.0.1:${socksPort} -> remote:${remotePort} (session, agent=${agentForwarded})`,
      );
    } else {
      socksPort = await findFreePort();
      const started = this.startSocksForward(conn, socksPort, agent);
      forwardProcess = started.process;

      // Wait for the SOCKS proxy and the remote agent report.
      [, agentForwarded] = await Promise.all([
        waitForPort(socksPort, 10_000),
        started.agentReady,
      ]);
      this.logger.info(
        `[resolve] SOCKS proxy on 127.0.0.1:${socksPort} -> remote:${remotePort}`,
      );
    }
    } catch (err) {
      if (serverProcess) serverProcess.kill();
      if (forwardProcess) forwardProcess.kill();
      throw err;
    }

    // Build the mutable connection object the monitor updates in place.
    const connState: RemoteConnection = {
      serverProcess,
      forwardProcess,
      socksPort,
      remotePort,
      tokenFile,
      conn,
      dead: false,
      isSession,
      monitor: undefined as any, // set below
      askpass,
      home: installResult.home,
      installPath: installResult.installPath,
      makeConnection: undefined as any, // set below
      connectionToken,
      ownsServer: !lockProbe.reusePort,
      agent,
      tunnelPort,
      tunnelToken,
      // Terminals get SSH_AUTH_SOCK from the resolver env (VS Code sends it
      // with every remote terminal create, overriding the server's env), so
      // each window uses its own symlink. Only set when a forwarded agent
      // exists, so a remote-local agent isn't overridden.
      extensionHostEnv: agentForwarded
        ? { SSH_AUTH_SOCK: agent.link }
        : undefined,
    };
    connStateRef = connState;

    // Attach exit listeners to detect process death immediately, not minutes
    // later when core calls makeConnection() or the monitor's periodic probe
    // runs. Sets `dead`; makeConnection() fast-fails and triggers core's
    // reconnect.
    this.attachExitListeners(connState, hostLabel);

    // Fallback for the tunnel path: if an in-place restart cannot be done
    // (e.g. SSH itself is gone), mark the connection dead so a later core
    // reconnect re-resolves instead of reusing a dead connection.
    markTunnelDead = () => {
      if (connState.dead) return;
      this.logger.error(
        "[health] ssh tunnel unreachable - marking connection dead",
      );
      connState.dead = true;
      report("Reconnecting...");
    };

    // Start the health monitor. On sleep/wake, it probes and repairs the
    // SOCKS forward if needed, or marks dead to trigger a core reconnect.
    const monitor = new ConnectionMonitor(
      connState,
      {
        findFreePort,
        startSocksForward: (c, p, a) => this.startSocksForward(c, p, a),
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

    return {
      makeConnection,
      connectionToken,
      ...(connState.extensionHostEnv
        ? { extensionHostEnv: connState.extensionHostEnv }
        : {}),
    };
  }

  /**
   * Start the VS Code server on the remote. Returns the port it's listening on.
   * The SSH process stays alive (the server runs in the foreground).
   */
  private async startServer(
    conn: ISshConnection,
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

    // Write the token, then close stdin so `cat` gets EOF and `exec` runs.
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
   * Start the server backgrounded on the remote via a shipped wrapper
   * script. The wrapper backgrounds the server, watches the log for
   * the listening port, and writes it atomically to a ready file. We
   * poll the ready file from our side with short execs that interleave
   * with other session calls. No inline shell gymnastics.
   */
  private async startServerSession(
    conn: ISshConnection,
    home: string,
    installPath: string,
    serverApp: string,
    tokenFile: string,
    connectionToken: string,
  ): Promise<number> {
    const serverScript = `${installPath}/bin/${serverApp}`;
    const toolsDir = remoteToolsDir(home);
    const sh = remoteShPath(home);
    const remoteDirName = path.dirname(tokenFile);
    const logFile = `${remoteDirName}/server-start.log`;
    const readyFile = `${remoteDirName}/server-ready`;
    const wrapperRemote = `${remoteDirName}/ssh-session-start-server.sh`;

    // Write the connection token to the token file first.
    await writeConnectionTokenFile(
      conn,
      home,
      connectionToken,
      this.logger,
      installPath,
    );

    // Ship the wrapper script to the remote. Strip CR so dash on the
    // remote doesn't choke on CRLF line endings (Windows source).
    const wrapperRaw = fs.readFileSync(this.sshSessionDeps!.wrapperScriptPath);
    const wrapperContent = wrapperRaw.toString("utf-8").replace(/\r\n/g, "\n");
    await conn.putFile!(wrapperRemote, Buffer.from(wrapperContent, "utf-8"), "0755");

    // Extensions to install on the remote at server startup.
    const extensionIds = vscode.workspace
      .getConfiguration("zygos")
      .get<string[]>("defaultExtensions", [])
      .filter((id) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i.test(id));

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

    // Forward proxy env to the remote server.
    const proxyEnv = collectProxyEnv();
    const envExports = Object.entries(proxyEnv)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("; ");

    // Start the wrapper in the background. It backgrounds the server
    // (nohup so it survives), watches the log, and writes the port to
    // the ready file via temp + mv. The wrapper itself is backgrounded
    // so this exec returns immediately.
    const cmd =
      `${envExports ? envExports + "; " : ""}` +
      `nohup ${sh} ${shellQuote(wrapperRemote)} ${shellQuote(toolsDir)} ${shellQuote(startCmd)} ${shellQuote(logFile)} ${shellQuote(readyFile)} > /dev/null 2>&1 &`;

    this.logger.info(`[resolve] starting server (session): ${startCmd}`);
    await conn.exec(cmd);

    // Poll the ready file for the port. Short execs that interleave.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const result = await conn.exec(`cat ${shellQuote(readyFile)} 2>/dev/null`, undefined, true);
      const port = parseInt(result.stdout.trim(), 10);
      if (port > 0) {
        this.logger.info(`[resolve] server started on port ${port} (session)`);
        return port;
      }
    }
    throw new Error("Timed out waiting for server to start (session)");
  }

  /**
   * Bootstrap the SshTunnel service on the remote. Ships the script,
   * writes a bearer token, starts it with the remote node binary,
   * and polls for the port. Returns the port + token for the client.
   *
   * Session path only. The tunnel handles file transfers and
   * spawn-with-stdin, unclogging the control shell. Separate lifecycle
   * from the IDE server: own port file, own token file.
   */
  private async startSshTunnel(
    conn: ISshConnection,
    home: string,
    installPath: string,
  ): Promise<{ port: number; token: string }> {
    const toolsDir = remoteToolsDir(home);
    const remoteDirName = `${home}/.ssh-remote`;
    const scriptRemote = `${remoteDirName}/sshTunnel.js`;
    const tokenFile = `${remoteDirName}/ssh-tunnel-token`;
    const portFile = `${remoteDirName}/ssh-tunnel-port`;
    const pidFile = `${remoteDirName}/ssh-tunnel-pid`;
    const logFile = `${remoteDirName}/ssh-tunnel.log`;
    const nodeBin = `${installPath}/node`;

    // Ship the tunnel script. Strip CR (Windows source).
    const scriptRaw = fs.readFileSync(this.sshSessionDeps!.tunnelScriptPath);
    const scriptContent = scriptRaw.toString("utf-8").replace(/\r\n/g, "\n");
    await conn.putFile!(scriptRemote, Buffer.from(scriptContent, "utf-8"), "0755");

    // Generate the bearer token and write it to a chmod 600 file.
    const token = crypto.randomBytes(32).toString("hex");
    await conn.putFile!(tokenFile, Buffer.from(token, "utf-8"), "0600");

    // Start the service in the background. --root bounds file operations
    // to the user's home. --port 0 picks a free port, written to portFile.
    // --pid-file lets killConnection terminate us on teardown; the idle
    // timeout is the safety net for when that cannot run.
    const cmd =
      `export PATH=${shellQuote(toolsDir)}:$PATH; ` +
      `nohup ${shellQuote(nodeBin)} ${shellQuote(scriptRemote)} ` +
      `--token-file ${shellQuote(tokenFile)} ` +
      `--port 0 ` +
      `--port-file ${shellQuote(portFile)} ` +
      `--pid-file ${shellQuote(pidFile)} ` +
      `--idle-timeout-ms ${SSH_TUNNEL_IDLE_TIMEOUT_MS} ` +
      `--root ${shellQuote(home)} ` +
      `>> ${shellQuote(logFile)} 2>&1 &`;
    this.logger.info(`[resolve] starting ssh tunnel`);
    await conn.exec(cmd);

    // Poll the port file. Short quiet execs that interleave.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(500);
      const result = await conn.exec(`cat ${shellQuote(portFile)} 2>/dev/null`, undefined, true);
      const port = parseInt(result.stdout.trim(), 10);
      if (port > 0) {
        this.logger.info(`[resolve] ssh tunnel started on port ${port}`);
        return { port, token };
      }
    }
    throw new Error("Timed out waiting for ssh tunnel to start");
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
    const { sshPath, configFile, handshakeTimeoutMs, tcpTimeoutSeconds } =
      sshSettings();
    const extras: Partial<SshConnectOptions> = {};
    if (sshPath) extras.sshPath = sshPath;
    if (configFile) extras.configFile = configFile;
    if (handshakeTimeoutMs) extras.handshakeTimeoutMs = handshakeTimeoutMs;
    if (tcpTimeoutSeconds !== undefined) extras.tcpTimeoutSeconds = tcpTimeoutSeconds;
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
    conn: ISshConnection,
    socksPort: number,
    agent?: AgentForward,
  ): SocksForward {
    this.logger.info(`[resolve] starting SOCKS forward -D ${socksPort}`);

    // With an agent role the forward runs a remote command: sshd only
    // creates a forwarded agent socket for a session, and -N opens none.
    const agentCmd = agent
      ? agentForwardCommand(agent.home, agent.link)
      : undefined;

    const child = conn.spawnProcess(agentCmd?.command, [
      "-D",
      String(socksPort),
      ...(agentCmd ? [] : ["-N"]), // -N: no remote command, forward only
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

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf-8").trim();
      if (line) this.logger.debug(`[socks] ${line}`);
      stderrBuf += chunk.toString("utf-8");
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    child.on("close", (code) => {
      const tail = stderrBuf.trim().slice(-2000);
      this.logger.info(
        `[resolve] SOCKS forward exited (code=${code})${tail ? `: ${tail}` : ""}`,
      );
    });

    const agentReady =
      agent && agentCmd
        ? this.waitForAgentReady(child, agentCmd.marker, agent.link)
        : Promise.resolve(false);
    return { process: child, agentReady };
  }

  /**
   * Read the forward's stdout until the agent report after the marker, then
   * keep draining it (the keep-alive loop writes periodically). Kills the
   * forward on timeout.
   */
  private waitForAgentReady(
    child: ChildProcess,
    marker: string,
    link: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let buf = "";
      let settled = false;
      const settle = (err: Error | undefined, forwarded = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        buf = "";
        if (err) {
          reject(err);
          return;
        }
        this.logger.info(
          forwarded
            ? `[agent] SSH_AUTH_SOCK -> ${link}`
            : "[agent] no forwarded agent on this connection",
        );
        resolve(forwarded);
      };
      const timeout = setTimeout(() => {
        settle(new Error("Timed out waiting for SOCKS forward remote setup"));
        child.kill("SIGTERM");
      }, AGENT_READY_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return; // drain
        buf += chunk.toString("utf-8");
        const forwarded = parseAgentForwardReady(buf, marker);
        if (forwarded !== undefined) settle(undefined, forwarded);
      });
      child.once("error", (err) => settle(err));
      child.once("close", (code) =>
        settle(
          new Error(`SOCKS forward exited before remote setup (code=${code})`),
        ),
      );
    });
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
      const isSession = sshSettings().usePersistentConnection === true && sshSessionSecretReady();
      const sessionSocksPort = isSession ? await findFreePort() : undefined;
      const conn = this.connectionFactory!(dest, {
        logger: this.logger,
        ...this.connectionExtras(),
        ...this.askpassOptions(askpass),
        ...(sessionSocksPort ? { socksPort: sessionSocksPort } : {}),
      });
      await conn.connect();
      this.logger.info(`[resolveExecServer] SSH connected to ${hostLabel}`);

      // Start a SOCKS forward for tcpConnect().
      let forwardProcess: ChildProcess | undefined;
      let socksPort: number;
      let tunnelPort = 0;
      let tunnelToken = "";
      let tunnelHome = "";
      if (isSession) {
        socksPort = conn.getSocksPort?.() ?? sessionSocksPort!;
        await waitForPort(socksPort, 10_000);
        // Bootstrap the SshTunnel service (session path only). Needs a
        // node binary on the remote; ensureServerInstalled probes for
        // the existing reh install (fork-agnostic) and returns its path.
        // Failure is non-fatal: execServer falls back to the control shell.
        try {
          const platform = detectPlatform();
          const productInfo = getProductInfo(platform);
          const installResult = await ensureServerInstalled(
            conn,
            platform,
            productInfo,
            this.logger,
            this.extensionPath,
          );
          tunnelHome = installResult.home;
          const tunnel = await this.startSshTunnel(
            conn,
            installResult.home,
            installResult.installPath,
          );
          tunnelPort = tunnel.port;
          tunnelToken = tunnel.token;
        } catch (err) {
          this.logger.info(
            `[resolveExecServer] ssh tunnel failed to start: ${(err as Error).message}`,
          );
        }
      } else {
        socksPort = await findFreePort();
        forwardProcess = this.startSocksForward(conn, socksPort).process;
        await waitForPort(socksPort, 10_000);
      }
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
        isSession,
        monitor: undefined as any,
        askpass,
        home: tunnelHome,
        installPath: "",
        makeConnection: undefined as any,
        connectionToken: "",
        ownsServer: false,
        tunnelPort,
        tunnelToken,
      };
      this.attachExitListeners(connState, dest.host);
      const monitor = new ConnectionMonitor(
        connState,
        {
          findFreePort,
          startSocksForward: (c, p, a) => this.startSocksForward(c, p, a),
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

      // Build the tunnel client if the tunnel started. Passed to
      // SshExecServer.spawn for streaming stdin without clogging the
      // control shell.
      const tunnelClient = tunnelPort > 0
        ? new SshTunnelClient({
            socksPort,
            tunnelPort,
            token: tunnelToken,
            logger: this.logger,
            logFilePath: this.sshSessionDeps?.dataDir
              ? path.join(this.sshSessionDeps.dataDir, `${dest.host}.tunnel-client.log`)
              : undefined,
            onUnreachable: () => {
              if (connState.dead) return;
              this.logger.error(
                "[health] ssh tunnel unreachable - marking exec connection dead",
              );
              connState.dead = true;
            },
          })
        : undefined;
      if (tunnelClient) {
        conn.setTunnelClient?.(tunnelClient);
      }

      const execServer = new SshExecServer(conn, socksPort, this.logger, tunnelClient);
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
    // Clean up SshTunnel files on the remote. Only when a tunnel started
    // (tunnelPort > 0). Single rm -rf; best-effort, fire-and-forget.
    if (conn.tunnelPort > 0 && conn.home) {
      const dir = `${conn.home}/.ssh-remote`;
      // Stop the tunnel process before removing its files. Best-effort:
      // the pid file may be missing if the tunnel already self-exited on
      // idle, or the ssh session may already be gone. The pid is digits
      // only (we wrote it), so it is safe inline.
      const pidFile = `${dir}/ssh-tunnel-pid`;
      void conn.conn
        .exec(`cat ${shellQuote(pidFile)} 2>/dev/null`, undefined, true)
        .then((r) => {
          const pid = parseInt((r.stdout ?? "").trim(), 10);
          if (Number.isFinite(pid) && pid > 0) {
            void conn.conn.exec(`kill ${pid} 2>/dev/null`).catch(() => {
              /* best effort */
            });
          }
        })
        .catch(() => {
          /* best effort */
        });
      const cmd =
        `rm -rf ${shellQuote(`${dir}/ssh-tunnel-pid`)} ` +
        `${shellQuote(`${dir}/ssh-tunnel-token`)} ` +
        `${shellQuote(`${dir}/ssh-tunnel-port`)} ` +
        `${shellQuote(`${dir}/ssh-tunnel.log`)} ` +
        `${shellQuote(`${dir}/tunnel-tmp`)}`;
      void conn.conn.exec(cmd).catch(() => {
        /* best effort */
      });
    }
    if (conn.isSession) {
      // Session: closing the connection stops the local server and its
      // ssh child. No separate forward or server process to kill.
      void conn.conn.close();
      return;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Registration ---

/**
 * Register a resource label formatter for a specific ssh-remote authority:
 * the window title and explorer show `SSH: <hostname>` instead of plain
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
  const storageDir = context.globalStorageUri.fsPath;
  const sshSessionDataDir = path.join(storageDir, "sshSession");
  fs.mkdirSync(sshSessionDataDir, { recursive: true });
  const sshSessionDeps: SshSessionDeps = {
    serverScriptPath: path.join(context.extensionPath, "dist", "localServer.js"),
    wrapperScriptPath: path.join(context.extensionPath, "scripts", "sshSession", "start-server.sh"),
    tunnelScriptPath: path.join(context.extensionPath, "dist", "sshTunnel.js"),
    nodePath: process.execPath,
    dataDir: sshSessionDataDir,
  };
  const resolver = new SshRemoteResolver(
    logger,
    context.extensionPath,
    undefined,
    context.workspaceState,
    sshSessionDeps,
  );

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
