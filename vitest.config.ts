import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    // Build-time flags that esbuild substitutes in production. In tests,
    // default both to false - platform tests mock detectPlatform, and
    // argv.ts falls back to the vscodium extension ID.
    HAS_KIRO_ADAPTER: "false",
    HAS_VSCODIUM_ADAPTER: "false",
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    include: [
      "test/unit/**/*.test.ts",
      "test/property/**/*.property.test.ts",
    ],
    exclude: ["test/integration/**", "node_modules/**", "upstream/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
    },
    alias: [
      // Mock the `vscode` module so tests can import files that reference
      // the VS Code API without pulling in the real runtime.
      { find: /^vscode$/, replacement: "/test/__mocks__/vscode.ts" },
    ],
  },
});
