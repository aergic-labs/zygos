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

  /** Read the Kiro SSO token from the client to forward to the remote. */
  readAuthToken(): string | undefined {
    const p = path.join(os.homedir(), LOCAL_AUTH_TOKEN_PATH);
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      return undefined;
    }
  }

  /** Path (relative to remote $HOME) where the server expects to find the token. */
  getAuthTokenPath(): string {
    return LOCAL_AUTH_TOKEN_PATH;
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
