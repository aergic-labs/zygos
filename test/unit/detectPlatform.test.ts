/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { detectPlatform } from "../../src/platform/index";

describe("detectPlatform", () => {
  it("throws when no adapter is compiled (both flags false in tests)", () => {
    expect(() => detectPlatform()).toThrow(/No platform adapter/);
  });
});
