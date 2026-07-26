/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { buildServerDownloadUrl, resolveTemplateUrl } from "../remote/url";
import { resolveNearestVsCodiumVersion } from "../remote/vscodiumFeed";
import type {
  DownloadTemplateInfo,
  DownloadAdapter,
  MinimalLogger,
} from "../platform/downloadTypes";
import type { ForkTemplate } from "../platform/forkTemplates";

/**
 * Dependencies injected by the host extension. Keeps this file portable
 * across sibling projects (e.g. artizo) without hardcoding the config
 * namespace, command id, or platform-detection functions.
 */
export interface ConfigPanelDeps {
  /** VS Code config namespace, e.g. "zygos" or "artizo". */
  configNamespace: string;
  /** Command ID to register, e.g. "zygos.configureServerDownload". */
  commandId: string;
  /** Webview panel title shown to the user. */
  panelTitle: string;
  /** Product display name for in-page text, e.g. "Zygos" or "Artizo". */
  productName: string;
  /** Webview resource subdir relative to extensionUri, e.g. "resources/serverDownload". */
  webviewSubdir: string;
  /** Logger. */
  logger: MinimalLogger;
  /** Detect the platform adapter and get product info in one call. */
  getDownloadInfo: () => Promise<{ adapter: DownloadAdapter; info: DownloadTemplateInfo }> | { adapter: DownloadAdapter; info: DownloadTemplateInfo };
  /** Read raw product.json from the running IDE's appRoot. */
  readProductJson: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Fork templates for the dropdown presets. */
  forkTemplates: ForkTemplate[];
}

/** Read the webview HTML and substitute the script/style webview URIs
 * plus a per-panel nonce for CSP. */
function getHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  webviewSubdir: string,
  productName: string,
): string {
  const webviewDir = vscode.Uri.joinPath(
    extensionUri,
    ...webviewSubdir.split("/"),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDir, "app.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDir, "styles.css"),
  );
  const htmlPath = vscode.Uri.joinPath(webviewDir, "index.html").fsPath;
  const nonce = crypto.randomUUID();
  let html = fs.readFileSync(htmlPath, "utf-8");
  html = html.replaceAll("${SCRIPT_URI}", scriptUri.toString());
  html = html.replaceAll("${STYLE_URI}", styleUri.toString());
  html = html.replaceAll("${NONCE}", nonce);
  html = html.replaceAll("${PRODUCT_NAME}", productName);
  return html;
}

/**
 * Register the config webview command. Must be called before
 * registerResolver so it is available even if activation fails.
 */
export function registerServerDownloadPanel(
  context: vscode.ExtensionContext,
  deps: ConfigPanelDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(deps.commandId, () => {
      const panel = vscode.window.createWebviewPanel(
        deps.configNamespace + "Config",
        deps.panelTitle,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(
              context.extensionUri,
              ...deps.webviewSubdir.split("/"),
            ),
          ],
        },
      );
      panel.webview.html = getHtml(
        panel.webview,
        context.extensionUri,
        deps.webviewSubdir,
        deps.productName,
      );

      const os = "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      let firstState = true;
      const panelDisposables: vscode.Disposable[] = [];

      void sendState(panel, deps, os, arch, true).catch((err) => {
        panel.webview.postMessage({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
      firstState = false;

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
          switch (msg.type) {
            case "resolveUrl":
              await handleResolveUrl(panel, deps, msg.template, os, arch);
              break;
            case "resolveManifestUrl":
              await handleResolveManifestUrl(panel, deps, msg.template, os, arch);
              break;
            case "testUrl":
              await handleTestUrl(panel, deps, msg.url, msg.which);
              break;
            case "apply":
              await handleApply(panel, deps, msg);
              break;
            case "getState":
              await sendState(panel, deps, os, arch, firstState);
              firstState = false;
              break;
          }
          } catch (err) {
            panel.webview.postMessage({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
        undefined,
        panelDisposables,
      );

      panel.onDidDispose(() => {
        for (const d of panelDisposables) d.dispose();
      });
    }),
  );
}

interface VariableValue {
  name: string;
  value: string;
}

interface PanelState {
  forkName: string;
  downloadMode: string;
  currentTemplate: string | undefined;
  resolvedUrl: string | undefined;
  binaryName: string | undefined;
  forkTemplates: ForkTemplate[];
  variables: VariableValue[];
  cdnVersionAsync: boolean;
  nearestVsCodiumVersionAsync: boolean;
  checksumMethod: string;
  checksumAlgo: string;
  manifestTemplate: string;
  manifestField: string;
  verifyChecksum: boolean;
  onNoChecksum: string;
}

/** Build the variable table: only non-empty values are included. */
async function buildVariables(
  info: DownloadTemplateInfo,
  os: string,
  arch: string,
  deps: ConfigPanelDeps,
): Promise<VariableValue[]> {
  const entries: { name: string; value: string | undefined }[] = [
    { name: "commit", value: info.commit },
    { name: "quality", value: info.quality },
    { name: "version", value: info.version },
    { name: "release", value: info.release },
    { name: "productVersion", value: info.productVersion },
    { name: "windsurfVersion", value: info.windsurfVersion },
    { name: "ideVersion", value: info.ideVersion },
    { name: "os", value: os },
    { name: "arch", value: arch },
    { name: "platform", value: arch },
  ];
  // ${nearestVsCodiumVersion} only makes sense for the vscode-oss fork.
  // Other forks either ship their own reh tarballs or use a different
  // version source (windsurfVersion, ideVersion, etc.).
  let appName = "";
  try {
    appName = String((await deps.readProductJson()).applicationName ?? "");
  } catch {
    // ignore - empty name means the variable stays hidden
  }
  if (appName === "code-oss") {
    let nearest: string | undefined;
    try {
      nearest = await resolveNearestVsCodiumVersion(info.version);
    } catch {
      // leave undefined - hidden from the table
    }
    entries.push({ name: "nearestVsCodiumVersion", value: nearest });
  }
  return entries
    .filter((e) => e.value && e.value.length > 0)
    .map((e) => ({ name: e.name, value: e.value as string }));
}

async function sendState(
  panel: vscode.WebviewPanel,
  deps: ConfigPanelDeps,
  os: string,
  arch: string,
  isFirst: boolean,
): Promise<void> {
  const { adapter: platform, info } = await deps.getDownloadInfo();
  const config = vscode.workspace.getConfiguration(deps.configNamespace);
  const sd = config.get<Record<string, string>>("serverDownload", {});
  const downloadMode = sd.mode || "auto";
  const binaryName = typeof sd.binaryName === "string" ? sd.binaryName : "";
  // Saved template: only present in custom mode. Auto mode clears it so
  // switching back to custom starts fresh from detected-fork defaults.
  const savedTemplate = typeof sd.template === "string" && sd.template.trim()
    ? sd.template.trim()
    : undefined;

  deps.logger.info(`[configPanel] sendState isFirst=${isFirst} downloadMode=${downloadMode} currentTemplate=${JSON.stringify(savedTemplate?.slice(0, 80))} binaryName=${JSON.stringify(binaryName)}`);

  let resolvedUrl: string | undefined;
  try {
    resolvedUrl = await buildServerDownloadUrl(info, platform, os, arch);
    deps.logger.info(`[configPanel] sendState resolvedUrl=${resolvedUrl}`);
  } catch (err) {
    deps.logger.error(`[configPanel] sendState failed to resolve URL: ${err}`);
  }

  const state: PanelState = {
    forkName: platform.name,
    downloadMode,
    currentTemplate: savedTemplate,
    resolvedUrl,
    binaryName,
    forkTemplates: deps.forkTemplates,
    variables: await buildVariables(info, os, arch, deps),
    cdnVersionAsync: false,
    nearestVsCodiumVersionAsync: false,
    checksumMethod: info.checksumMethod ?? "sidecar",
    checksumAlgo: info.checksumAlgo ?? "",
    manifestTemplate: info.manifestTemplate ?? "",
    manifestField: info.manifestField ?? "",
    verifyChecksum: info.verifyChecksum,
    onNoChecksum: info.onNoChecksum,
  };

  await panel.webview.postMessage({ type: "state", state, isRefresh: !isFirst });
}

async function handleResolveUrl(
  panel: vscode.WebviewPanel,
  deps: ConfigPanelDeps,
  template: string,
  os: string,
  arch: string,
): Promise<void> {
  if (!template || !template.trim()) {
    // Auto mode: resolve via the adapter.
    try {
      const { adapter: platform, info } = await deps.getDownloadInfo();
      const url = await buildServerDownloadUrl(info, platform, os, arch);
      await panel.webview.postMessage({ type: "resolvedUrl", url });
    } catch (err) {
      await panel.webview.postMessage({
        type: "resolvedUrl",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  try {
    const { info } = await deps.getDownloadInfo();
    const { url, unresolved } = await resolveTemplateUrl(
      template,
      info,
      os,
      arch,
    );
    const cdnVersionAsync = template.includes("${cdnVersion}");
    const nearestVsCodiumVersionAsync = template.includes(
      "${nearestVsCodiumVersion}",
    );
    await panel.webview.postMessage({
      type: "resolvedUrl",
      url,
      unresolved,
      cdnVersionAsync,
      nearestVsCodiumVersionAsync,
    });
  } catch (err) {
    deps.logger.error(`[configPanel] template resolve failed: ${err}`);
    await panel.webview.postMessage({
      type: "resolvedUrl",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleResolveManifestUrl(
  panel: vscode.WebviewPanel,
  deps: ConfigPanelDeps,
  template: string,
  os: string,
  arch: string,
): Promise<void> {
  if (!template || !template.trim()) {
    await panel.webview.postMessage({
      type: "resolvedManifestUrl",
      url: "",
    });
    return;
  }

  try {
    const { info } = await deps.getDownloadInfo();
    const { url, unresolved } = await resolveTemplateUrl(
      template,
      info,
      os,
      arch,
    );
    await panel.webview.postMessage({
      type: "resolvedManifestUrl",
      url,
      unresolved,
    });
  } catch (err) {
    deps.logger.error(`[configPanel] manifest template resolve failed: ${err}`);
    await panel.webview.postMessage({
      type: "resolvedManifestUrl",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface TestResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  contentLength?: string;
  contentType?: string;
  error?: string;
}

/** Validate a URL is safe to fetch: https-only, no private/loopback
 * hosts. Prevents SSRF via crafted webview messages. */
function validateFetchUrl(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (url.protocol !== "https:") {
    return "Only HTTPS URLs are allowed";
  }
  const host = url.hostname.toLowerCase();
  // Reject loopback, private, link-local, and cloud metadata endpoints.
  // Also reject non-dotted IP forms (decimal, hex) that bypass the regex.
  const blocked =
    host === "localhost" ||
    host === "metadata.google.internal" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^::1$/.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
    /^\[::1\]$/.test(host) ||
    /^0x[0-9a-f]+$/i.test(host) ||
    /^\d+$/.test(host);
  if (blocked) {
    return "Private/loopback hosts are not allowed";
  }
  return url;
}

async function handleTestUrl(
  panel: vscode.WebviewPanel,
  deps: ConfigPanelDeps,
  url: string,
  which: string,
): Promise<void> {
  deps.logger.info(`[configPanel] testing URL: ${url}`);

  const result: TestResult = { ok: false };

  const validated = validateFetchUrl(url);
  if (typeof validated === "string") {
    result.error = validated;
    await panel.webview.postMessage({ type: "testResult", result, which });
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(validated, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);

    result.status = res.status;
    result.statusText = res.statusText;
    result.contentLength = res.headers.get("content-length") ?? undefined;
    result.contentType = res.headers.get("content-type") ?? undefined;

    // 200 is not enough. A 200 with an HTML body is usually an error page,
    // not the tarball. Some CDNs do this.
    const ct = result.contentType ?? "";
    const isTarball =
      ct.includes("application/gzip") ||
      ct.includes("application/x-gzip") ||
      ct.includes("application/x-tar") ||
      ct.includes("application/octet-stream") ||
      ct.includes("binary/octet-stream");
    const isHtml = ct.includes("text/html");

    if (res.ok && isTarball) {
      result.ok = true;
    } else if (res.ok && isHtml) {
      result.ok = false;
      result.error = `Server returned HTML (content-type: ${ct}). Likely an error page, not the tarball.`;
    } else if (res.ok) {
      result.ok = true;
      result.error = `Unexpected content-type: ${ct}`;
    } else {
      result.ok = false;
      result.error = `HTTP ${res.status} ${res.statusText}`;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  await panel.webview.postMessage({ type: "testResult", result, which });
}

interface ApplyMsg {
  template: string;
  binaryName: string;
  which?: string;
  mode?: string;
  checksumMethod?: string;
  checksumAlgo?: string;
  manifestTemplate?: string;
  manifestField?: string;
  verifyChecksum?: boolean;
  onNoChecksum?: string;
}

async function handleApply(
  panel: vscode.WebviewPanel,
  deps: ConfigPanelDeps,
  msg: ApplyMsg,
): Promise<void> {
  deps.logger.info(`[configPanel] handleApply template=${JSON.stringify(msg.template?.slice(0, 80))} binaryName=${JSON.stringify(msg.binaryName)} which=${msg.which}`);
  try {
    await writeSettingsDirect(msg, deps);
    deps.logger.info("[configPanel] settings applied");
    await panel.webview.postMessage({ type: "applied", which: msg.which });
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : String(err);
    deps.logger.error(`[configPanel] apply failed: ${msg2}`);
    await panel.webview.postMessage({
      type: "applyError",
      error: msg2,
      which: msg.which,
    });
  }
}

/**
 * Apply settings via the VS Code config API as a single object write.
 */
async function writeSettingsDirect(
  msg: ApplyMsg,
  deps: ConfigPanelDeps,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(deps.configNamespace);
  const modeVal = msg.mode || "auto";

  // Custom mode saves the template; auto mode discards it so switching
  // back to custom starts fresh from detected-fork defaults.
  const templateVal = modeVal === "custom" ? msg.template.trim() : "";
  const binaryVal = msg.binaryName.trim();

  // Checksum settings are always written (apply in both modes).
  const checksumMethod = msg.checksumMethod ?? "sidecar";
  const checksumAlgo = msg.checksumAlgo ?? "";
  const manifestTemplate = msg.manifestTemplate?.trim() ?? "";
  const manifestField = msg.manifestField?.trim() ?? "";
  const verifyChecksum = msg.verifyChecksum !== false;
  const onNoChecksum = msg.onNoChecksum ?? "warn";

  const sd = {
    mode: modeVal,
    template: templateVal,
    binaryName: binaryVal,
    checksumMethod,
    checksumAlgo,
    manifestTemplate,
    manifestField,
    verifyChecksum,
    onNoChecksum,
  };

  deps.logger.info(`[configPanel] writeSettingsDirect sd=${JSON.stringify(sd)}`);

  await config.update(
    "serverDownload",
    sd,
    vscode.ConfigurationTarget.Global,
  );

  // Verify the write.
  const verify = config.get<Record<string, string>>("serverDownload", {});
  deps.logger.info(`[configPanel] verify: serverDownload=${JSON.stringify(verify)}`);

  deps.logger.info("[configPanel] settings applied via config API");
}
