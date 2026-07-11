/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach } from "vitest";
import {
  resetConfig,
  resetOutputChannels,
  resetStatusBarItems,
} from "./__mocks__/vscode";

// Reset the shared `vscode` mock stores after every test so module-level state
// (config values, output channels, status bar items) never leaks between
// tests. Individual tests may still reset in their own `beforeEach`.
afterEach(() => {
  resetConfig();
  resetOutputChannels();
  resetStatusBarItems();
});
