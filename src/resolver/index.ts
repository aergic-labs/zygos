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
 *
 * Shared transport: the ssh connection, SOCKS forward, and Go transport
 * server are refcounted by authority and shared between `resolve()` and
 * `resolveExecServer()`. One ssh session, one -D, one Go server per
 * authority, regardless of how many flows (windows / chained resolves)
 * are active. See `acquireTransport` / `releaseTransport`.
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
import { TransportClient, probeTransportAlive } from "../transport/client";
import { ZygosTransport } from "../transport/zygos";
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

/** Idle timeout for the Go transport server (ms). 4x the 30s client
 *  heartbeat, so a live transport never ages out; an orphan dies in
 *  ~2min. */
const TRANSPORT_IDLE_TIMEOUT_MS = 120_000;

/** Shared transport: the ssh connection + SOCKS forward + Go transport
 *  server, refcounted by authority. Both `resolve()` and
 *  `resolveExecServer()` acquire it. The monitor reads/writes the
 *  `MonitoredConnection` fields in place; `makeConnection()` reads
 *  `socksPort` per call. */
interface SharedTransport extends MonitoredConnection {
  /** Authority key (e.g. `ssh-remote+<hex>`). */
  authority: string;
  /** Remote HOME (probed). */
  home: string;
  /** Remote arch (probed). */
  arch: string;
  /** Server install path on the remote (for REH server cleanup). */
  installPath: string;
  /** Go transport port (0 = not started). */
  transportPort: number;
  /** Go transport token. */
  transportToken: string;
  /** Shared transport client. Replaced on restart. */
  transportClient: ZygosTransport | undefined;
  /** Askpass server (shared). */
  askpass: AskpassServer | undefined;
  /** Monitor for the shared conn + forward. */
  monitor: ConnectionMonitor;
  /** Refcount: number of flows holding this. */
  refs: number;
  /** Per-flow states attached to this transport. */
  flows: Set<RemoteConnection>;
  /** Restart in-progress flag. */
  restartingTransport: boolean;
  /** True if the agent forward linked a forwarded agent socket. */
  agentForwarded: boolean;
}

/** Per-flow state. Each flow (`resolve()` or `resolveExecServer()`) has
 *  its own. Holds the per-flow REH server state (`resolve()` only) and a
 *  back-reference to the shared transport. */
interface RemoteConnection {
  /** Back-reference to the shared transport. */
  shared: SharedTransport;
  /** Authority key this flow is stored under (`authority` or
   *  `${authority}:execServer`). */
  key: string;
  /** Flow kind. */
  kind: "resolve" | "execServer";
  /** REH server process (`resolve` only). */
  serverProcess: ChildProcess | undefined;
  /** REH server port (`resolve` only). */
  remotePort: number;
  /** Token file path (`resolve` only). */
  tokenFile: string;
  /** Connection token (`resolve` only). */
  connectionToken: string;
  /** Whether we own the REH server (`resolve` only). */
  ownsServer: boolean;
  /** extensionHostEnv returned by resolve(), for reuse on re-resolve. */
  extensionHostEnv?: Record<string, string | null>;
  /** makeConnection closure (`resolve` only). */
  makeConnection: () => Thenable<any>;
  /** Per-flow dead flag. Set when the flow's REH server dies, or when the
   *  shared transport dies (caller checks `flow.dead || flow.shared.dead`). */
  dead: boolean;
}

/** Options governing transport acquisition. The shared-transport
 *  refactor only applies when `share` is set (the experimental
 *  `usePersistentConnection` path); the default non-session path keeps
 *  the legacy standalone behavior (own ssh connection per flow, no
 *  refcounting). */
interface TransportAcquireOptions {
  /** Register in `this.transports` and refcount across flows. */
  share: boolean;
  /** Call `ensureServerInstalled` (probe + bootstrap). `resolve()` always
   *  installs; `resolveExecServer()` only installs on the session path. */
  install: boolean;
  /** Run the agent forward on the SOCKS channel. `resolve()` always
   *  forwards the agent; `resolveExecServer()` only does on the session
   *  path (legacy non-session execServer had no agent role). */
  agent: boolean;
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
  nodePath: string;
  dataDir: string;
}

export class SshRemoteResolver {
  /** Per-flow connection states keyed by authority (`resolve`) or
   *  `${authority}:execServer` (`resolveExecServer`). */
  private connections = new Map<string, RemoteConnection>();
  /** Shared transports keyed by authority. Refcounted. */
  private transports = new Map<string, SharedTransport>();
  /** In-flight shared transport creation promises, to dedup concurrent
   *  acquires for the same authority. */
  private transportPromises = new Map<string, Promise<SharedTransport>>();
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

    let shared: SharedTransport | undefined;
    try {
      // Share the transport across flows only on the experimental session
      // path. The default non-session path keeps the legacy behavior: each
      // resolve() opens its own ssh connection (no sharing with
      // resolveExecServer()).
      const isSession =
        sshSettings().usePersistentConnection === true && sshSessionSecretReady();

      // Session path only: reuse an existing healthy per-flow connection
      // BEFORE acquiring a transport, so we don't bump the shared refcount
      // for a flow we won't create. The non-session path keeps its existing
      // reuse check inside resolveFlow (after acquireTransport), preserving
      // the legacy behavior.
      if (isSession) {
        const existing = this.connections.get(authority);
        if (existing && !existing.dead && !existing.shared.dead) {
          // Probe before reuse: the ssh child's TCP can be dead (after apex
          // sleep) while `dead` is still false (monitor probe didn't fire,
          // shutdown timer didn't fire). On failure mark dead and fall
          // through to acquireTransport. Same probe as acquireTransport below.
          let alive = true;
          try {
            const r = await existing.shared.conn.exec("true", 5_000, true);
            if (r.exitCode !== 0 && r.exitCode !== null) alive = false;
          } catch {
            alive = false;
          }
          if (alive) {
            this.logger.info(
              `[resolve] reusing existing connection for ${authority}`,
            );
            return {
              makeConnection: existing.makeConnection,
              connectionToken: existing.connectionToken,
              ...(existing.extensionHostEnv
                ? { extensionHostEnv: existing.extensionHostEnv }
                : {}),
            };
          }
          this.logger.info(
            `[resolve] existing connection for ${authority} probe failed, marking dead`,
          );
          existing.dead = true;
        }
      }

      shared = await this.acquireTransport(authority, dest, report, {
        share: isSession,
        install: true,
        agent: true,
      });
      return await this.resolveFlow(
        authority,
        dest,
        platform,
        productInfo,
        isReconnect,
        report,
        shared,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`[resolve] failed: ${msg}`);

      // Evict any host passwords cached during this attempt so a retry
      // re-prompts instead of reusing a bad password. Key passphrases are
      // validated before caching, so only host passwords need eviction.
      // If `acquireTransport` failed, `createTransport` already evicted; if
      // `resolveFlow` failed post-acquire, evict via the shared askpass.
      if (shared?.askpass?.usedHostPassword) {
        this.logger.info("[resolve] evicting host password cache entries");
        await shared.askpass.evictHostPasswords();
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
    shared: SharedTransport,
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

    // Non-session path: reuse an existing healthy per-flow connection for
    // this authority. VS Code calls resolve() again when opening a new
    // folder on the same remote; reconnecting from scratch would kill the
    // server and re-prompt. The session path handles this earlier (in
    // resolve(), before acquireTransport) to avoid bumping the shared
    // refcount; this is the legacy check for the non-session path.
    //
    // Probe before reuse, same as the session-path fast-path and
    // acquireTransport: the ssh child's TCP can be dead (after apex sleep)
    // while `dead` is still false. On failure mark dead and fall through
    // to a fresh acquireTransport + createTransport, instead of returning a
    // stale makeConnection that ECONNREFUSEDs into vscode's permanent-error
    // dialog.
    const prev = this.connections.get(authority);
    if (prev && !prev.dead && !prev.shared.dead) {
      let prevAlive = true;
      try {
        const r = await prev.shared.conn.exec("true", 5_000, true);
        if (r.exitCode !== 0 && r.exitCode !== null) prevAlive = false;
      } catch {
        prevAlive = false;
      }
      if (prevAlive) {
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
      this.logger.info(
        `[resolve] existing connection for ${authority} probe failed, marking dead`,
      );
      prev.dead = true;
    }

    // Register a label formatter for this authority: the window title shows
    // the hostname (e.g. "root [SSH: example.com]") instead of a generic
    // "root [SSH]". Registered per-connect; the hostname is encoded in the
    // authority hex.
    if (!this.labelFormatters.has(authority)) {
      const disp = registerLabelFormatter(authority, hostLabel);
      this.labelFormatters.set(authority, disp);
    }

    // Clean up any previous (dead) per-flow connection for this authority.
    if (prev) {
      this.killConnection(prev);
      this.connections.delete(authority);
    }

    const conn = shared.conn;
    const installResult = {
      home: shared.home,
      arch: shared.arch,
      installPath: shared.installPath,
    };

    // Acquire the resolve lock and probe for an existing/zombie server in
    // one round-trip. Two parallel resolves to the same install path would
    // race on server start + metadata writes.
    report("Checking for existing server...");
    const lockProbe = await acquireLockAndProbeZombie(
      conn,
      installResult.home,
      installResult.installPath,
      shared.transportClient,
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
        if (shared.isSession) {
          const port = await this.startServerSession(
            conn,
            installResult.home,
            installResult.installPath,
            productInfo.serverApplicationName,
            tokenFile,
            connectionToken,
            shared.transportClient,
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
            shared.transportClient,
          );
        }
        throw err;
      }
    }

    // Write PID/port files for a new server, and release the resolve lock,
    // in one round-trip. Skipped when reusing an existing server. The agent
    // forward link lives on the shared transport (set in createTransport).
    try {
      if (!lockProbe.reusePort) {
        const fin = await finalizeServerStart(
          conn,
          installResult.home,
          installResult.installPath,
          remotePort,
          { releaseLock: locked },
          shared.transportClient,
        );
        this.logger.info(`[lifecycle] ${fin.log}`);
      } else if (locked) {
        // Reused an existing server; release the lock we acquired.
        await releaseResolveLock(
          conn,
          installResult.home,
          installResult.installPath,
          this.logger,
          shared.transportClient,
        );
      }
    } catch (err) {
      if (serverProcess) serverProcess.kill();
      throw err;
    }

    // Build the per-flow connection state.
    const flow: RemoteConnection = {
      shared,
      key: authority,
      kind: "resolve",
      serverProcess,
      remotePort,
      tokenFile,
      connectionToken,
      ownsServer: !lockProbe.reusePort,
      extensionHostEnv: shared.agentForwarded
        ? { SSH_AUTH_SOCK: shared.agent!.link }
        : undefined,
      makeConnection: undefined as any,
      dead: false,
    };

    // Attach exit listener on the REH server process (per-flow). The
    // shared forward's exit listener is attached in `createTransport`.
    this.attachFlowExitListeners(flow, hostLabel);

    // Register with the shared transport so its death propagates.
    shared.flows.add(flow);

    // Store the per-flow connection for cleanup on reconnect/deactivate.
    this.connections.set(authority, flow);

    report("Connected");

    // Return ManagedResolvedAuthority: core calls makeConnection() per
    // connection it needs; each SOCKS-connects to the server's port.
    // Reads socksPort from the shared transport (picks up the monitor's
    // in-place repairs) and remotePort from the per-flow state.
    const makeConnection = async (): Promise<any> => {
      if (flow.dead || flow.shared.dead) {
        // Shape as ECONNREFUSED+connect so vscode's reconnect loop treats
        // this as retryable and re-resolves (remoteAgentConnection.ts).
        // A plain Error hits the catch-all and surfaces a permanent-error
        // dialog. On retry, getAddress() re-calls resolveAuthority, which
        // re-enters resolve(); the fast-path sees existing.dead and falls
        // through to acquireTransport, which probes and rebuilds.
        const err = new Error(
          `SSH connection to ${hostLabel} is dead - triggering reconnect`,
        );
        (err as any).code = "ECONNREFUSED";
        (err as any).syscall = "connect";
        throw err;
      }
      this.logger.info(
        `[resolve] makeConnection() -> SOCKS5 to 127.0.0.1:${flow.remotePort} via :${flow.shared.socksPort}`,
      );
      const socket = await socks5Connect(
        "127.0.0.1",
        flow.shared.socksPort,
        "127.0.0.1",
        flow.remotePort,
      );
      return wrapSocket(socket);
    };
    flow.makeConnection = makeConnection;

    return {
      makeConnection,
      connectionToken,
      ...(flow.extensionHostEnv
        ? { extensionHostEnv: flow.extensionHostEnv }
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
    transportClient?: TransportClient,
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
    //
    // rm the ready file first: a prior resolve may have left a stale
    // port in it. The Go transport's waitForFile polls for "file exists
    // and non-empty" and would return the stale content immediately,
    // handing the resolver a port from a dead server. Removing it here
    // guarantees waitForFile blocks until the new wrapper writes the
    // current server's port.
    await conn.exec(`rm -f ${shellQuote(readyFile)}`);
    const cmd =
      `${envExports ? envExports + "; " : ""}` +
      `nohup ${sh} ${shellQuote(wrapperRemote)} ${shellQuote(toolsDir)} ${shellQuote(startCmd)} ${shellQuote(logFile)} ${shellQuote(readyFile)} > /dev/null 2>&1 &`;

    this.logger.info(`[resolve] starting server (session): ${startCmd}`);
    await conn.exec(cmd);

    // Wait for the ready file. On the session path the transport is up by
    // this point (onProbed threw if it failed to start), so a single
    // waitForFile call replaces the poll loop of `cat` round-trips. On the
    // non-session path there is no transport, so we fall back to the poll
    // loop.
    //
    // The session path must NOT fall back to the poll loop when waitForFile
    // fails or returns malformed content. Doing so silently routes around
    // the transport (the same anti-pattern that masked the handlePutFile
    // mkdir bug behind a confusing "Tarball extraction failed" 30s later).
    // Surface the real failure so the user sees the cause, not a symptom.
    if (transportClient) {
      let body: Buffer;
      try {
        body = await transportClient.waitForFile(readyFile, 60_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[resolve] waitForFile failed: ${msg}`,
        );
        throw new Error(
          `Failed to wait for the server-ready file via the Go transport: ${msg}. ` +
            `The session path requires the transport; falling back to the poll ` +
            `loop would mask the real failure. See the log for details.`,
        );
      }
      const trimmed = body.toString("utf-8").trim();
      const port = parseInt(trimmed, 10);
      if (!Number.isFinite(port) || port <= 0) {
        this.logger.error(
          `[resolve] server-ready file contained malformed port: ${JSON.stringify(trimmed)}`,
        );
        throw new Error(
          `Server-ready file contained a malformed port (got ${JSON.stringify(trimmed)}). ` +
            `The transport returned a non-numeric or empty response; the ` +
            `server wrapper may have written garbage. See the remote server ` +
            `log (${logFile}) for details.`,
        );
      }
      this.logger.info(`[resolve] server reported port ${port} (session)`);
      await this.verifyServerPort(conn, port, logFile);
      return port;
    }

    // Non-session path: poll the ready file via the control shell.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const result = await conn.exec(`cat ${shellQuote(readyFile)} 2>/dev/null`, undefined, true);
      const port = parseInt(result.stdout.trim(), 10);
      if (port > 0) {
        this.logger.info(`[resolve] server reported port ${port} (session)`);
        await this.verifyServerPort(conn, port, logFile);
        return port;
      }
    }
    const tail = await conn.exec(
      `tail -n 20 ${shellQuote(logFile)} 2>/dev/null`,
      undefined,
      true,
    );
    throw new Error(
      `Timed out waiting for server to start (session); log tail:\n${tail.stdout}`,
    );
  }

  /** Verify the server port is reachable through the SOCKS forward before
   *  handing it to VS Code. Shared between the waitForFile and poll paths.
   *  `logFile` is tailed on failure for diagnostics. Throws on unreachable
   *  so the resolver doesn't hand VS Code a port nothing is listening on
   *  (which would cause every subsequent reconnect to fail with
   *  "Connection refused" forever). */
  private async verifyServerPort(
    conn: ISshConnection,
    port: number,
    logFile: string,
  ): Promise<void> {
    const socksPort = conn.getSocksPort?.() ?? 0;
    if (socksPort > 0) {
      const reachable = await this.waitForRemotePort(socksPort, port, 10_000);
      if (reachable) {
        this.logger.info(`[resolve] server port ${port} reachable`);
      } else {
        const tail = await conn.exec(
          `tail -n 20 ${shellQuote(logFile)} 2>/dev/null`,
          undefined,
          true,
        );
        this.logger.error(
          `[resolve] server reported port ${port} but it is not reachable; log tail:\n${tail.stdout}`,
        );
        throw new Error(
          `Server reported port ${port} but it is not reachable ` +
            `through SOCKS ${socksPort}. See the remote server log ` +
            `(${logFile}) for details.`,
        );
      }
    }
    this.logger.info(`[resolve] server started on port ${port} (session)`);
  }

  /** Dial 127.0.0.1:<port> on the remote through the SOCKS forward,
   *  retrying until it connects or the deadline passes. */
  private async waitForRemotePort(
    socksPort: number,
    port: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const sock = await socks5Connect(
          "127.0.0.1",
          socksPort,
          "127.0.0.1",
          port,
          2000,
        );
        sock.destroy();
        return true;
      } catch {
        await sleep(250);
      }
    }
    return false;
  }

  /**
   * Bootstrap the Go transport server on the remote. Ships the binary
   * (base64-over-shell, one-time), writes a bearer token, starts it, and
   * polls for the port. Returns the port + token for the client.
   *
   * Session path only. Replaces the ssh session control shell and the
   * HTTP tunnel.
   *
   * `socksPort` is the session's local SOCKS5 forward. When non-zero, the
   * resolver probes a still-running transport from a prior session first
   * and reuses it (port + token) instead of re-shipping the binary and
   * orphaning the old detached process. Zero (non-session) skips the probe
   * and keeps the legacy standalone-transport-per-flow behavior intact.
   */
  private async startTransport(
    conn: ISshConnection,
    home: string,
    arch: string,
    socksPort: number,
  ): Promise<{ port: number; token: string }> {
    const remoteDirName = `${home}/.ssh-remote`;
    const binRemote = `${remoteDirName}/zygos-tunnel-${arch}`;
    const metaFile = `${remoteDirName}/tunnel-meta.json`;
    const logFile = `${remoteDirName}/tunnel.log`;

    // Session path only: probe the existing transport before re-shipping.
    // A live transport from a prior resolve (reload, re-resolve, restart)
    // is reused as-is: no binary ship, no --detach, no orphaned process.
    // A dead/missing transport falls through to the ship-and-start path.
    if (socksPort > 0) {
      const probed = await this.probeExistingTransport(
        conn,
        remoteDirName,
        socksPort,
      );
      if (probed) {
        this.logger.info(
          `[resolve] reusing existing go transport on port ${probed.port}`,
        );
        return probed;
      }
      // Stale meta file but a dead transport: try to reap the pid before
      // re-shipping so we don't race a still-shutting-down process. The pid
      // comes from the meta file read in probeExistingTransport; pass it
      // through so we don't re-read the file here.
      // (Fall through: probe returned null with no pid to reap.)
    }

    // The transport ships before the busybox bootstrap now, so the remote
    // dir doesn't exist yet. The first putFile (zygos-tunnel-x64.new)
    // creates it: Go's doPut calls os.MkdirAll(filepath.Dir(p), 0755)
    // before writing. No separate mkdir round-trip needed.

    // Ship the binary. base64-over-shell: the transport isn't up yet, so
    // putFile falls back to the control-shell path.
    const localBin = path.join(
      this.extensionPath,
      "tools",
      "tunnel",
      `tunnel-linux-${arch}`,
    );
    const bin = fs.readFileSync(localBin);
    this.logger.info(`[resolve] shipping go transport (${bin.length} bytes)...`);
    const shipStart = Date.now();
    // Write to a temp path, then rename over the target. Writing directly
    // fails with ETXTBSY when a previous transport is still running from
    // the target path (the reload case). Rename is atomic and the running
    // process keeps the old inode.
    const tmpBin = `${binRemote}.new`;
    const putResult = await conn.putFile!(tmpBin, bin, "0755");
    if (putResult.exitCode !== 0) {
      throw new Error(
        `Failed to ship go transport (exit ${putResult.exitCode}): ${putResult.stderr}`,
      );
    }
    const mvResult = await conn.exec(
      `mv -f ${shellQuote(tmpBin)} ${shellQuote(binRemote)}`,
    );
    if (mvResult.exitCode !== 0) {
      throw new Error(
        `Failed to install go transport: ${mvResult.stderr || mvResult.stdout}`,
      );
    }
    this.logger.info(
      `[resolve] go transport shipped in ${Date.now() - shipStart}ms`,
    );

    // Start detached. --detach makes the binary re-exec in a new session
    // (no controlling terminal), so it survives the shell exit without
    // nohup. --root bounds file ops to the user's home. --meta-file writes
    // a single atomic JSON file with port/pid/token (replaces the prior
    // tunnel-port + tunnel-pid pair; the resolver reads it in one cat).
    // The binary self-generates its bearer token from crypto/rand and
    // writes it into the meta file, so no --token-file is passed here.
    const cmd =
      `${shellQuote(binRemote)} --detach ` +
      `--port 0 ` +
      `--meta-file ${shellQuote(metaFile)} ` +
      `--idle-timeout-ms ${TRANSPORT_IDLE_TIMEOUT_MS} ` +
      `--root ${shellQuote(home)} ` +
      `>> ${shellQuote(logFile)} 2>&1`;
    this.logger.info(`[resolve] starting go transport...`);
    await conn.exec(cmd);
    this.logger.info(`[resolve] waiting for go transport port...`);

    // Poll the meta file. Short quiet execs that interleave. The transport
    // isn't up yet (we're waiting for it to start), so this can't ride the
    // transport's waitForFile op; it stays on the control shell.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(500);
      const result = await conn.exec(
        `cat ${shellQuote(metaFile)} 2>/dev/null`,
        undefined,
        true,
      );
      const meta = parseMetaFile(result.stdout);
      if (meta && meta.port > 0) {
        this.logger.info(`[resolve] go transport started on port ${meta.port}`);
        return { port: meta.port, token: meta.token };
      }
    }
    throw new Error("Timed out waiting for go transport to start");
  }

  /**
   * Probe a still-running Go transport on the remote. Reads the single
   * tunnel-meta.json file (port/pid/token in one read), then dials the
   * transport's HEALTH op through the SOCKS5 forward. Returns
   * `{ port, token, pid }` if alive, `null` otherwise. The pid is
   * returned so the caller can reap a stale transport without re-reading
   * the file.
   *
   * Session path only; the non-session path doesn't keep a transport
   * around between flows.
   */
  private async probeExistingTransport(
    conn: ISshConnection,
    remoteDir: string,
    socksPort: number,
  ): Promise<{ port: number; token: string; pid: number } | null> {
    const res = await conn.exec(
      `cat ${shellQuote(`${remoteDir}/tunnel-meta.json`)} 2>/dev/null`,
      undefined,
      true,
    );
    // No meta file: no prior transport, ship a fresh one.
    if (res.exitCode !== 0) return null;
    // Meta file exists. The Go binary writes it atomically (temp + rename),
    // so a partial/garbage file is a real error (disk corruption, partial
    // write across filesystems, manual edit), not a "no transport" state.
    // Returning null here would silently re-ship the binary and overwrite
    // the corruption, the same "training wheels" pattern that masks real
    // failures elsewhere. Throw so the user sees the corruption.
    const meta = parseMetaFile(res.stdout);
    if (!meta) {
      throw new Error(
        `tunnel-meta.json exists but is malformed (unparseable JSON or ` +
          `missing fields): ${JSON.stringify(res.stdout.trim().slice(0, 200))}`,
      );
    }
    if (meta.port <= 0) {
      throw new Error(`tunnel-meta.json has an invalid port: ${meta.port}`);
    }
    if (!/^[0-9a-f]{64}$/.test(meta.token)) {
      throw new Error(
        `tunnel-meta.json has an invalid token (expected 64-char hex, ` +
          `got length ${meta.token.length}: ${meta.token.slice(0, 8)}...)`,
      );
    }

    const alive = await probeTransportAlive(socksPort, meta.port, meta.token);
    if (!alive) {
      // Dead transport: reap the pid so the binary doesn't race the new
      // one we're about to ship. The pid came from the meta file read
      // above; no second round-trip.
      if (meta.pid > 0) {
        await this.killStaleTransportPid(conn, meta.pid);
      }
      return null;
    }
    return { port: meta.port, token: meta.token, pid: meta.pid };
  }

  /**
   * Kill a stale transport process by pid. Best-effort: a dead pid is a
   * no-op. Used after probeExistingTransport reports the transport dead so
   * a still-shutting-down process doesn't race the new one (ETXTBSY, port
   * conflict, etc.). The pid comes from the meta file read in
   * probeExistingTransport; no extra file read here.
   *
   * Session path only.
   */
  private async killStaleTransportPid(
    conn: ISshConnection,
    pid: number,
  ): Promise<void> {
    if (!pid || pid <= 0) return;
    // `kill <pid> 2>/dev/null` is a no-op if the pid is gone. Don't wait
    // for it to exit; the new transport listens on a fresh port, so
    // there's no port race; the old one just exits on idle or SIGTERM.
    await conn.exec(`kill ${pid} 2>/dev/null || true`, undefined, true);
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
   *
   * Per-flow listener: only the REH server process (resolve flow). The
   * shared forward's listener is attached in `createTransport`.
   */
  private attachFlowExitListeners(
    flow: RemoteConnection,
    hostLabel: string,
  ): void {
    const serverProc = flow.serverProcess;
    if (!serverProc) return;
    serverProc.on("close", (code, signal) => {
      if (flow.dead) return; // already marked
      this.logger.error(
        `[health] Server process exited (code=${code} signal=${signal}) - marking flow dead`,
      );
      flow.dead = true;
      // Status bar item shown on death. Auto-disposes after 10s.
      const status = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      status.text = `$(error) SSH: ${hostLabel} disconnected - reconnecting...`;
      status.tooltip = `Server process exited (code=${code})`;
      status.show();
      setTimeout(() => status.dispose(), 10_000);
    });
  }

  /**
   * Attach an exit listener on the shared SOCKS forward (non-session only).
   * On close (and not a monitor-initiated restart), marks the shared
   * transport dead - all flows' makeConnection() fast-fail and core
   * reconnects each window.
   */
  private attachSharedForwardExitListeners(
    shared: SharedTransport,
    hostLabel: string,
  ): void {
    const forwardProc = shared.forwardProcess;
    if (!forwardProc) return; // session: forward is inside the ssh child
    forwardProc.on("close", (code, signal) => {
      // If the monitor restarted the forward, shared.forwardProcess points
      // to the new process; this is the old one exiting, expected during
      // repair, not a failure.
      if (shared.forwardProcess !== forwardProc) return;
      if (shared.dead) return;
      this.logger.error(
        `[health] SOCKS forward exited (code=${code} signal=${signal}) - marking shared transport dead`,
      );
      shared.dead = true;
      const status = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      status.text = `$(error) SSH: ${hostLabel} disconnected - reconnecting...`;
      status.tooltip = `SOCKS forward exited (code=${code})`;
      status.show();
      setTimeout(() => status.dispose(), 10_000);
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
   * and connect to TCP ports on the remote, all through the shared SSH
   * connection.
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

    let shared: SharedTransport | undefined;
    try {
      // Share the transport with resolve() only on the experimental session
      // path. The default non-session path keeps the legacy behavior: own
      // ssh connection, no install probe, no agent forward (the resolve
      // flow's install covers the host; execServer just relays through its
      // own ssh -D).
      const isSession =
        sshSettings().usePersistentConnection === true && sshSessionSecretReady();
      shared = await this.acquireTransport(authority, dest, () => {}, {
        share: isSession,
        install: isSession,
        agent: isSession,
      });
      this.logger.info(`[resolveExecServer] SSH connected to ${hostLabel}`);

      // Build the per-flow connection state. The execServer path has no
      // REH server; the shared monitor covers the conn + forward.
      const flow: RemoteConnection = {
        shared,
        key: `${authority}:execServer`,
        kind: "execServer",
        serverProcess: undefined,
        remotePort: 0,
        tokenFile: "",
        connectionToken: "",
        ownsServer: false,
        makeConnection: undefined as any,
        dead: false,
      };

      const execKey = `${authority}:execServer`;
      const prev = this.connections.get(execKey);
      if (prev) {
        this.killConnection(prev);
        this.connections.delete(execKey);
      }
      this.connections.set(execKey, flow);
      shared.flows.add(flow);

      // The transport client is shared with the resolve flow. Passed to
      // SshExecServer.spawn for real streaming stdin/stdout/stderr.
      // ZygosTransport (contract + zygos ops), handed to the exec server
      // typed as the base TransportClient so it can only reach the contract.
      const transportClient: TransportClient | undefined =
        shared.transportClient;

      const execServer = new SshExecServer(
        shared.conn,
        shared.socksPort,
        this.logger,
        transportClient,
      );
      this.logger.info(`[resolveExecServer] ready for ${hostLabel}`);
      return execServer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.info(`[resolveExecServer] failed: ${msg}`);

      // Evict any host passwords cached during this attempt so a retry
      // re-prompts instead of reusing a bad password. If `acquireTransport`
      // failed, `createTransport` already evicted; otherwise evict via the
      // shared askpass.
      if (shared?.askpass?.usedHostPassword) {
        this.logger.info(
          "[resolveExecServer] evicting host password cache entries",
        );
        await shared.askpass.evictHostPasswords();
      }

      throw err;
    }
  }

  // --- Shared transport ---

  /**
   * Acquire the shared transport for `authority`. Refcounted: the first
   *  caller creates it (connect, probe, start transport, start -D forward,
   *  build monitor); subsequent callers reuse it and bump the refcount.
   *  Concurrent acquires dedup via an in-flight promise.
   *
   *  When `opts.share` is false the transport is standalone: not registered
   *  in `this.transports`, no refcount, no dedup. Each flow owns its own.
   *  This is the legacy non-session behavior.
   */
  private async acquireTransport(
    authority: string,
    dest: { host: string; user?: string; port?: number },
    report: (msg: string) => void,
    opts: TransportAcquireOptions,
  ): Promise<SharedTransport> {
    if (!opts.share) {
      return this.createTransport(authority, dest, report, opts);
    }
    const existing = this.transports.get(authority);
    if (existing && !existing.dead) {
      // The shared transport may be stale: its ssh child's TCP can be
      // dead (e.g. after apex sleep) while `dead` is still false, because
      // the ConnectionMonitor's periodic probe didn't fire during sleep
      // and the local server's shutdown timer may not have fired yet
      // either. Probe the conn before reusing; on failure, mark dead and
      // fall through to createTransport so callers (notably artizo's
      // resolveExecServer path) don't get pinned to a dead SOCKS port.
      // Same shape as SshSessionClient.tryReconnect's exec probe.
      let alive = true;
      try {
        const r = await existing.conn.exec("true", 5_000, true);
        if (r.exitCode !== 0 && r.exitCode !== null) alive = false;
      } catch {
        alive = false;
      }
      if (alive) {
        existing.refs++;
        this.logger.info(
          `[resolve] reusing shared transport for ${authority} (refs=${existing.refs})`,
        );
        return existing;
      }
      this.logger.info(
        `[resolve] shared transport for ${authority} probe failed, marking dead`,
      );
      existing.dead = true;
    }

    // If a creation is in flight, wait for it, then bump the refcount.
    const inFlight = this.transportPromises.get(authority);
    if (inFlight) {
      const shared = await inFlight;
      if (shared.dead) {
        // It died in the meantime; recurse to create a fresh one.
        return this.acquireTransport(authority, dest, report, opts);
      }
      shared.refs++;
      return shared;
    }

    // Tear down any dead existing transport before creating a new one.
    if (existing) {
      this.killSharedTransport(existing);
      this.transports.delete(authority);
    }

    const p = this.createTransport(authority, dest, report, opts);
    this.transportPromises.set(authority, p);
    try {
      const shared = await p;
      this.transports.set(authority, shared);
      return shared;
    } finally {
      this.transportPromises.delete(authority);
    }
  }

  /**
   * Create a new (shared or standalone) transport for `authority`.
   *  Connects, optionally probes + installs (`opts.install`), optionally
   *  starts the Go transport (session path), starts the SOCKS forward
   *  (non-session path), optionally does the agent forward (`opts.agent`),
   *  and starts the monitor.
   *
   *  On failure, evicts host passwords, stops askpass, and rethrows.
   */
  private async createTransport(
    authority: string,
    dest: { host: string; user?: string; port?: number },
    report: (msg: string) => void,
    opts: TransportAcquireOptions,
  ): Promise<SharedTransport> {
    const askpass = await this.maybeStartAskpass();
    try {
      report("Connecting via SSH...");
      const isSession =
        sshSettings().usePersistentConnection === true && sshSessionSecretReady();
      const sessionSocksPort = isSession ? await findFreePort() : undefined;
      const conn = this.connectionFactory!(dest, {
        logger: this.logger,
        ...this.connectionExtras(),
        ...this.askpassOptions(askpass),
        ...(sessionSocksPort ? { socksPort: sessionSocksPort } : {}),
      });
      await conn.connect();

      const sharedRef: SharedTransport = {
        authority,
        conn,
        socksPort: 0,
        forwardProcess: undefined,
        isSession,
        remotePort: 0,
        serverProcess: undefined,
        dead: false,
        ownsServer: false,
        agent: undefined,
        home: "",
        arch: "",
        installPath: "",
        transportPort: 0,
        transportToken: "",
        transportClient: undefined,
        askpass,
        monitor: undefined as any,
        refs: 1,
        flows: new Set(),
        restartingTransport: false,
        agentForwarded: false,
      };

      const markSharedDead = (): void => {
        if (sharedRef.dead) return;
        sharedRef.dead = true;
      };

      let restartingTransport = false;
      const startTransportClient = async (
        home: string,
        arch: string,
      ): Promise<void> => {
        const t = await this.startTransport(
          conn,
          home,
          arch,
          sharedRef.socksPort,
        );
        sharedRef.transportPort = t.port;
        sharedRef.transportToken = t.token;
        const client = new ZygosTransport({
          socksPort: sharedRef.socksPort,
          port: t.port,
          token: t.token,
          logger: this.logger,
          onUnreachable: () => {
            void handleTransportUnreachable();
          },
        });
        conn.setTransportClient?.(client);
        sharedRef.transportClient = client;
      };

      const handleTransportUnreachable = async (): Promise<void> => {
        if (restartingTransport || sharedRef.dead) return;
        restartingTransport = true;
        sharedRef.restartingTransport = true;
        this.logger.error(
          "[health] transport unreachable - restarting in place",
        );
        try {
          const old = sharedRef.transportClient;
          await startTransportClient(sharedRef.home, sharedRef.arch);
          old?.dispose();
          this.logger.info(
            `[health] transport restarted in place on port ${sharedRef.transportPort}`,
          );
        } catch (err) {
          this.logger.error(
            `[health] transport restart failed: ${err instanceof Error ? err.message : String(err)} - marking connection dead`,
          );
          markSharedDead();
        } finally {
          restartingTransport = false;
          sharedRef.restartingTransport = false;
        }
      };

      // Probe + install + (session) start transport so the tarball rides it.
      // Skipped entirely for the legacy non-session execServer flow, which
      // never installed (the resolve flow's install already covered the
      // host; execServer just relays through its own ssh -D).
      let agent: AgentForward | undefined;
      if (opts.install) {
        report("Ensuring server is installed...");
        const platform = detectPlatform();
        const productInfo = getProductInfo(platform);
        const installResult = await ensureServerInstalled(
          conn,
          platform,
          productInfo,
          this.logger,
          this.extensionPath,
          {
            onDownloadProgress: (() => {
              let lastPct = -5;
              return (received: number, total: number | undefined) => {
                if (total) {
                  const pct = Math.floor((received / total) * 100);
                  // Report every 5%, plus the final 100%.
                  if (pct < lastPct + 5 && pct < 100) return;
                  lastPct = pct;
                  const mb = (received / 1_048_576).toFixed(1);
                  const totalMb = (total / 1_048_576).toFixed(0);
                  report(`Downloading server... ${pct}% (${mb}/${totalMb} MB)`);
                } else {
                  const mb = (received / 1_048_576).toFixed(1);
                  report(`Downloading server... ${mb} MB`);
                }
              };
            })(),
            onPhase: (phase) => {
              if (phase === "verifying-checksum") {
                report("Verifying server checksum...");
              } else if (phase === "extracting") {
                report("Extracting server tarball...");
              } else if (phase === "verifying") {
                report("Verifying server install...");
              }
            },
            onProbed: async ({ home, arch }) => {
              sharedRef.home = home;
              sharedRef.arch = arch;
              if (!isSession) return;
              const sp = conn.getSocksPort?.() ?? sessionSocksPort!;
              await waitForPort(sp, 10_000);
              sharedRef.socksPort = sp;
              // The transport is required on the session path, not optional.
              // A silent fallback to base64 here used to hide transport-start
              // failures (e.g. the handlePutFile mkdir bug) behind a confusing
              // downstream error 30s later. Surface the real failure so the
              // user sees the actual cause instead of a symptom.
              try {
                await startTransportClient(home, arch);
                this.logger.info(
                  `[resolve] go transport on port ${sharedRef.transportPort} (putFile/execWithStdin routed through transport)`,
                );
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(
                  `[resolve] go transport failed to start: ${msg}`,
                );
                throw new Error(
                  `Failed to start the Go transport on the remote: ${msg}. ` +
                    `The session path requires the transport; falling back to ` +
                    `base64 would mask the real failure. See the log for details.`,
                );
              }
            },
          },
        );
        sharedRef.home = installResult.home;
        sharedRef.arch = installResult.arch;
        sharedRef.installPath = installResult.installPath;
        agent = {
          home: installResult.home,
          link: agentLinkPath(installResult.home, this.agentLinkId(authority)),
        };
        sharedRef.agent = agent;
      }

      // SOCKS forward + agent forward.
      if (isSession) {
        // Session: the -D is folded into the ssh child. socksPort was
        // assigned earlier (before the transport start) so the transport
        // client could reach the remote service. Only assign here if the
        // early start was skipped.
        if (!sharedRef.socksPort) {
          sharedRef.socksPort = conn.getSocksPort?.() ?? sessionSocksPort!;
          await waitForPort(sharedRef.socksPort, 10_000);
        }
        // Agent forward: one-shot exec in the control shell. The session's
        // ssh child keeps the session (and forwarded agent socket) alive,
        // so no keep-alive loop is needed (unlike startSocksForward).
        if (opts.agent && agent) {
          const agentCmd = agentForwardCommandOneshot(agent.home, agent.link);
          const agentResult = await conn.exec(agentCmd.command);
          sharedRef.agentForwarded =
            parseAgentForwardReady(agentResult.stdout, agentCmd.marker) ?? false;
        }
        this.logger.info(
          `[resolve] SOCKS proxy on 127.0.0.1:${sharedRef.socksPort} (session, agent=${sharedRef.agentForwarded})`,
        );
      } else {
        report("Starting SOCKS forward...");
        sharedRef.socksPort = await findFreePort();
        const started = this.startSocksForward(
          conn,
          sharedRef.socksPort,
          opts.agent ? agent : undefined,
        );
        sharedRef.forwardProcess = started.process;
        // Wait for the SOCKS proxy and the remote agent report.
        const [, agentForwarded] = await Promise.all([
          waitForPort(sharedRef.socksPort, 10_000),
          started.agentReady,
        ]);
        sharedRef.agentForwarded = agentForwarded;
        this.logger.info(
          `[resolve] SOCKS proxy on 127.0.0.1:${sharedRef.socksPort}`,
        );
      }

      // Start the health monitor. On sleep/wake, it probes and repairs the
      // SOCKS forward if needed, or marks dead to trigger a core reconnect.
      const monitor = new ConnectionMonitor(
        sharedRef,
        {
          findFreePort,
          startSocksForward: (c, p, a) => this.startSocksForward(c, p, a),
          waitForPort,
        },
        this.logger,
        (msg) => report(msg),
      );
      sharedRef.monitor = monitor;
      monitor.start();

      // Attach exit listener on the shared forward (non-session). Detects
      // process death immediately, not at the next 60s monitor probe.
      this.attachSharedForwardExitListeners(sharedRef, dest.host);

      this.logger.info(
        `[resolve] shared transport for ${authority} ready (socks=${sharedRef.socksPort}, transport=${sharedRef.transportPort})`,
      );
      return sharedRef;
    } catch (err) {
      if (askpass?.usedHostPassword) {
        this.logger.info("[resolve] evicting host password cache entries");
        await askpass.evictHostPasswords();
      }
      try {
        void askpass?.stop();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Decrement the shared transport's refcount; tear down at zero. Called
   *  from `killConnection` when a per-flow state is destroyed. */
  private releaseTransport(shared: SharedTransport): void {
    shared.refs--;
    if (shared.refs <= 0) {
      this.killSharedTransport(shared);
      this.transports.delete(shared.authority);
    }
  }

  /** Tear down a shared transport: stop the monitor, stop askpass, kill
   *  the forward, close the conn, and clean up transport files on the
   *  remote. Best-effort; safe to call on a partially-constructed shared. */
  private killSharedTransport(shared: SharedTransport): void {
    try {
      shared.monitor?.stop();
    } catch {
      /* ignore */
    }
    try {
      void shared.askpass?.stop();
    } catch {
      /* ignore */
    }
    try {
      shared.transportClient?.dispose();
    } catch {
      /* ignore */
    }
    // Clean up transport files on the remote. Only when the transport
    // started (transportPort > 0). Best-effort, fire-and-forget. The binary
    // is left in place (reused next session); only the meta file and log
    // are removed. The pid lives in tunnel-meta.json (single atomic JSON
    // file with port/pid/token): read it, kill the process, then rm the
    // meta + log.
    if (shared.transportPort > 0 && shared.home) {
      const dir = `${shared.home}/.ssh-remote`;
      const metaFile = `${dir}/tunnel-meta.json`;
      void shared.conn
        .exec(`cat ${shellQuote(metaFile)} 2>/dev/null`, undefined, true)
        .then((r) => {
          const meta = parseMetaFile(r.stdout);
          if (meta && meta.pid > 0) {
            void shared.conn.exec(`kill ${meta.pid} 2>/dev/null`).catch(() => {
              /* best effort */
            });
          }
        })
        .catch(() => {
          /* best effort */
        });
      const cmd =
        `rm -rf ${shellQuote(metaFile)} ` + `${shellQuote(`${dir}/tunnel.log`)}`;
      void shared.conn.exec(cmd).catch(() => {
        /* best effort */
      });
    }
    if (shared.isSession) {
      // Session: closing the connection stops the local server and its
      // ssh child. No separate forward or server process to kill.
      void shared.conn.close();
      return;
    }
    try {
      shared.forwardProcess?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    void shared.conn.close();
  }

  /** Kill all active connections (called on deactivate). */
  dispose(): void {
    for (const [key, flow] of this.connections) {
      this.logger.info(`[resolve] cleaning up ${key}`);
      this.killConnection(flow);
    }
    this.connections.clear();
    // Any leftover shared transports (shouldn't normally be any, since
    // killConnection releases refs; but guard for safety).
    for (const [authority, shared] of this.transports) {
      this.logger.info(`[resolve] cleaning up shared transport ${authority}`);
      this.killSharedTransport(shared);
    }
    this.transports.clear();
    for (const disp of this.labelFormatters.values()) disp.dispose();
    this.labelFormatters.clear();
  }

  private killConnection(flow: RemoteConnection): void {
    const shared = flow.shared;
    // Per-flow REH server cleanup (resolve flow that owns its server).
    if (flow.kind === "resolve" && flow.ownsServer) {
      try {
        flow.serverProcess?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Only remove token/PID/port files if we started the server.
      // A reused server from another window still needs them.
      void removeConnectionTokenFile(shared.conn, flow.tokenFile, this.logger);
      if (shared.installPath) {
        const transport = shared.transportClient;
        void Promise.all([
          removeServerMetadata(
            shared.conn,
            shared.home,
            shared.installPath,
            this.logger,
            transport,
          ),
          releaseResolveLock(
            shared.conn,
            shared.home,
            shared.installPath,
            this.logger,
            transport,
          ),
        ]);
      }
    }
    // Detach from the shared transport.
    shared.flows.delete(flow);
    this.releaseTransport(shared);
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

/** Parse the tunnel-meta.json file content. Returns null on missing/invalid
 *  JSON so callers can treat a missing file as "no existing transport"
 *  without a separate existence check. The Go binary writes this file
 *  atomically (temp + rename) at startup with {port, pid, token}. */
function parseMetaFile(
  stdout: string,
): { port: number; pid: number; token: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const meta = JSON.parse(trimmed) as {
      port?: number;
      pid?: number;
      token?: string;
    };
    if (
      typeof meta.port !== "number" ||
      typeof meta.pid !== "number" ||
      typeof meta.token !== "string"
    ) {
      return null;
    }
    return { port: meta.port, pid: meta.pid, token: meta.token };
  } catch {
    return null;
  }
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
