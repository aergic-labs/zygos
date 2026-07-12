/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { detectPlatform, getProductInfo } from "../platform";
import { buildServerDownloadUrl, resolveTemplateUrl } from "../server/url";
import { FORK_TEMPLATES } from "../platform/forkTemplates";
import type { Logger } from "../common/logger";

declare const HAS_VSCODIUM_ADAPTER: boolean;

/** Read the webview HTML and substitute the script/style webview URIs
 * plus a per-panel nonce for CSP. */
function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDir = vscode.Uri.joinPath(extensionUri, "resources", "webview");
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
  return html;
}

/**
 * Register the config webview command. Must be called before
 * registerResolver so it is available even if activation fails.
 */
export function registerConfigPanel(
  context: vscode.ExtensionContext,
  logger: Logger,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("zygos.configureServerDownload", () => {
      const panel = vscode.window.createWebviewPanel(
        "zygosConfig",
        "Zygos Server Download",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "resources", "webview"),
          ],
        },
      );
      panel.webview.html = getHtml(panel.webview, context.extensionUri);

      const os = "linux";
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      let firstState = true;

      void sendState(panel, logger, os, arch, true);
      firstState = false;

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          switch (msg.type) {
            case "resolveUrl":
              await handleResolveUrl(panel, logger, msg.template, os, arch);
              break;
            case "resolveManifestUrl":
              await handleResolveManifestUrl(panel, logger, msg.template, os, arch);
              break;
            case "testUrl":
              await handleTestUrl(panel, logger, msg.url, msg.which);
              break;
            case "apply":
              await handleApply(panel, logger, msg);
              break;
            case "getState":
              await sendState(panel, logger, os, arch, firstState);
              firstState = false;
              break;
          }
        },
        undefined,
        context.subscriptions,
      );
    }),
  );
}

interface VariableValue {
  name: string;
  value: string;
}

interface PanelState {
  forkName: string;
  hasCustomTab: boolean;
  downloadMode: string;
  currentTemplate: string | undefined;
  resolvedUrl: string | undefined;
  binaryName: string | undefined;
  forkTemplates: typeof FORK_TEMPLATES;
  variables: VariableValue[];
  cdnVersionAsync: boolean;
  checksumMethod: string;
  checksumAlgo: string;
  manifestTemplate: string;
  manifestField: string;
  verifyChecksum: boolean;
  onNoChecksum: string;
}

/** Build the variable table: only non-empty values are included. */
function buildVariables(
  info: ReturnType<typeof getProductInfo>,
  os: string,
  arch: string,
): VariableValue[] {
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
  return entries
    .filter((e) => e.value && e.value.length > 0)
    .map((e) => ({ name: e.name, value: e.value as string }));
}

async function sendState(
  panel: vscode.WebviewPanel,
  logger: Logger,
  os: string,
  arch: string,
  isFirst: boolean,
): Promise<void> {
  const platform = detectPlatform();
  const info = getProductInfo(platform);
  const config = vscode.workspace.getConfiguration("zygos");
  const sd = config.get<Record<string, string>>("serverDownload", {});
  const downloadMode = sd.mode || "auto";
  const binaryName = typeof sd.binaryName === "string" ? sd.binaryName : "";

  logger.info(`[configPanel] sendState isFirst=${isFirst} downloadMode=${downloadMode} currentTemplate=${JSON.stringify(info.serverDownloadUrlTemplate?.slice(0, 80))} binaryName=${JSON.stringify(binaryName)}`);

  let resolvedUrl: string | undefined;
  try {
    resolvedUrl = await buildServerDownloadUrl(info, platform, os, arch);
    logger.info(`[configPanel] sendState resolvedUrl=${resolvedUrl}`);
  } catch (err) {
    logger.error(`[configPanel] sendState failed to resolve URL: ${err}`);
  }

  const state: PanelState = {
    forkName: platform.name,
    hasCustomTab: HAS_VSCODIUM_ADAPTER,
    downloadMode,
    currentTemplate: info.serverDownloadUrlTemplate,
    resolvedUrl,
    binaryName,
    forkTemplates: FORK_TEMPLATES,
    variables: buildVariables(info, os, arch),
    cdnVersionAsync: false,
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
  logger: Logger,
  template: string,
  os: string,
  arch: string,
): Promise<void> {
  if (!template || !template.trim()) {
    // Auto mode: resolve via the adapter.
    try {
      const platform = detectPlatform();
      const info = getProductInfo(platform);
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
    const platform = detectPlatform();
    const info = getProductInfo(platform);
    const { url, unresolved } = await resolveTemplateUrl(
      template,
      info,
      os,
      arch,
    );
    const cdnVersionAsync = template.includes("${cdnVersion}");
    await panel.webview.postMessage({
      type: "resolvedUrl",
      url,
      unresolved,
      cdnVersionAsync,
    });
  } catch (err) {
    logger.error(`[configPanel] template resolve failed: ${err}`);
    await panel.webview.postMessage({
      type: "resolvedUrl",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleResolveManifestUrl(
  panel: vscode.WebviewPanel,
  logger: Logger,
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
    const platform = detectPlatform();
    const info = getProductInfo(platform);
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
    logger.error(`[configPanel] manifest template resolve failed: ${err}`);
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
    /^\[::1\]$/.test(host);
  if (blocked) {
    return "Private/loopback hosts are not allowed";
  }
  return url;
}

async function handleTestUrl(
  panel: vscode.WebviewPanel,
  logger: Logger,
  url: string,
  which: string,
): Promise<void> {
  logger.info(`[configPanel] testing URL: ${url}`);

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
  logger: Logger,
  msg: ApplyMsg,
): Promise<void> {
  logger.info(`[configPanel] handleApply template=${JSON.stringify(msg.template?.slice(0, 80))} binaryName=${JSON.stringify(msg.binaryName)} which=${msg.which}`);
  try {
    await writeSettingsDirect(msg, logger);
    logger.info("[configPanel] settings applied");
    await panel.webview.postMessage({ type: "applied", which: msg.which });
  } catch (err) {
    const msg2 = err instanceof Error ? err.message : String(err);
    logger.error(`[configPanel] apply failed: ${msg2}`);
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
async function writeSettingsDirect(msg: ApplyMsg, logger: Logger): Promise<void> {
  const config = vscode.workspace.getConfiguration("zygos");
  const modeVal = msg.mode || "auto";

  // In auto mode, discard the template. Only custom mode uses it.
  // This prevents stale templates from lingering in settings after
  // switching back to auto.
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

  logger.info(`[configPanel] writeSettingsDirect sd=${JSON.stringify(sd)}`);

  await config.update(
    "serverDownload",
    sd,
    vscode.ConfigurationTarget.Global,
  );

  // Verify the write.
  const verify = config.get<Record<string, string>>("serverDownload", {});
  logger.info(`[configPanel] verify: serverDownload=${JSON.stringify(verify)}`);

  logger.info("[configPanel] settings applied via config API");
}
