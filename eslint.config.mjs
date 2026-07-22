import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  module: "readonly",
  console: "readonly",
  process: "readonly",
  require: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  global: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  fetch: "readonly",
  AbortSignal: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "vendor/**",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "upstream/**",
      "research/**",
      "tmp/**",
      "tools/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Browser-side webview code; runs in the webview, not Node. Uses DOM
    // globals and the VS Code webview API; not part of the bundle's TS
    // strictness.
    files: ["resources/webview/**"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        acquireVsCodeApi: "readonly",
        console: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["scripts/**", "esbuild.config.mjs"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
