/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformAdapter } from "./types";
import { readProductJson } from "./index";

/** Local path (under $HOME) to the Kiro SSO auth token. */
const LOCAL_AUTH_TOKEN_PATH = ".aws/sso/cache/kiro-auth-token.json";

export class KiroAdapter implements PlatformAdapter {
  readonly name = "Kiro";
  readonly dataFolderName = ".kiro";
  readonly serverDataFolderName = ".kiro-server";
  readonly serverApplicationName = "kiro-server";

  /**
   * Read the Kiro SSO token (and, when present, the client-registration
   * sibling named by `clientIdHash`) from the client for forwarding to
   * the remote.
   *
   * Always forwards the token file when present — it works until expiry
   * even without the registration sibling. The registration file holds
   * the clientId/clientSecret the remote needs to refresh on its own;
   * without it, the remote signs out ~1h in (zygos issue #4).
   *
   * Resilient: if the token JSON can't be parsed or the sibling file is
   * missing, returns just the token. Many Kiro auth methods don't use
   * SSO refresh and may not produce the sibling.
   */
  readAuthFiles(): { path: string; content: string }[] {
    const cacheDir = path.join(os.homedir(), ".aws", "sso", "cache");
    const tokenAbsPath = path.join(cacheDir, "kiro-auth-token.json");
    if (!fs.existsSync(tokenAbsPath)) return [];

    let tokenContent: string;
    try {
      tokenContent = fs.readFileSync(tokenAbsPath, "utf-8");
    } catch {
      return [];
    }
    const files: { path: string; content: string }[] = [
      { path: LOCAL_AUTH_TOKEN_PATH, content: tokenContent },
    ];

    try {
      const token = JSON.parse(tokenContent);
      const hash =
        typeof token?.clientIdHash === "string" ? token.clientIdHash : "";
      if (hash && /^[a-f0-9]+$/i.test(hash)) {
        const regAbsPath = path.join(cacheDir, `${hash}.json`);
        if (fs.existsSync(regAbsPath)) {
          files.push({
            path: `.aws/sso/cache/${hash}.json`,
            content: fs.readFileSync(regAbsPath, "utf-8"),
          });
        }
      }
    } catch {
      // Token isn't valid JSON or doesn't expose clientIdHash.
      // Token alone still works until expiry.
    }
    return files;
  }

  getServerDownloadUrl(
    commit: string,
    _quality: string,
    os: string,
    arch: string,
  ): string {
    return `https://prod.download.desktop.kiro.dev/releases/remotes/${commit}/kiro-reh-${os}-${arch}.tar.gz`;
  }

  needsArgvPatch(): boolean {
    return true;
  }

  isValidRuntime(): boolean {
    try {
      const product = readProductJson();
      return String(product.applicationName ?? "")
        .toLowerCase()
        .includes("kiro");
    } catch {
      return false;
    }
  }
}
