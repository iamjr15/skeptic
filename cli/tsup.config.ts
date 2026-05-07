import { defineConfig } from "tsup";
import { cp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf-8")) as {
  version: string;
};
const buildSourcemap = process.env.SKEPTIC_SOURCEMAP === "true";
const minifyBuild = process.env.SKEPTIC_MINIFY !== "false";

export default defineConfig({
  entry: {
    skeptic: "bin/skeptic.ts",
    index: "src/index.ts",
    // Runner worker — referenced from runner/discover.ts and runner/execute.ts via
    // `new URL("./worker.mjs", import.meta.url)`. Must live next to dist/skeptic.mjs.
    worker: "src/runner/worker.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  sourcemap: buildSourcemap,
  minify: minifyBuild,
  treeshake: true,
  splitting: false,
  clean: true,
  // Banner injects a `require()` shim for CJS deps (Commander, etc.) that
  // call `require("events")` etc. internally. Without this, esbuild's ESM
  // output uses a `__require` stub that throws on Node built-ins.
  // The shebang already lives at the top of bin/skeptic.ts; esbuild preserves
  // entry shebangs.
  // The license comment lands first (some bundlers reorder; keeping it at the
  // head of the banner ensures it's the very first line of every emitted .mjs).
  // The createRequire shim is load-bearing for CJS deps that call
  // `require("events")` internally — do not remove or split.
  banner: {
    js: [
      "/*! @license skeptic-cli — see LICENSES.md for third-party attributions */",
      "import { createRequire as __skepticCreateRequire } from 'node:module';",
      "const require = __skepticCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  dts: { entry: "src/index.ts" },

  // Canonical externals (must remain runtime-resolved):
  external: [
    "playwright",
    "playwright-core",
    "better-sqlite3",
  ],

  // Pure JS — bundle for tree-shaking.
  noExternal: [
    "commander",
    "zod",
    "yaml",
    "glob",
    "chokidar",
    "chalk",
    "figures",
    "cli-truncate",
    "string-width",
    "pretty-ms",
    "minimatch",
    "web-vitals",
    "@google/generative-ai",
    "@faker-js/faker",
    "fast-xml-parser",
    "pixelmatch",
    "pngjs",
    "react",
    "ink",
    "ink-spinner",
    "@modelcontextprotocol/sdk",
    "@agentclientprotocol/sdk",
    "@axe-core/playwright",
  ],

  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
    options.alias = {
      ...(options.alias ?? {}),
      "react-devtools-core": resolve(here, "src/utils/empty-stub.cjs"),
    };
  },

  // Build-time substitutions. Bare identifiers (matched by esbuild's `define`)
  // are declared in src/global.d.ts. Phase 5 extends this with feature flags;
  // for now only the version is used (Phase 2's fast path).
  define: {
    __SKEPTIC_CLI_VERSION__: JSON.stringify(pkg.version),
    __SKEPTIC_FEATURE_AI_ASSERTIONS__:
      process.env.SKEPTIC_FEATURE_AI_ASSERTIONS ?? "true",
    __SKEPTIC_FEATURE_COOKIE_EXTRACTION__:
      process.env.SKEPTIC_FEATURE_COOKIE_EXTRACTION ?? "true",
    __SKEPTIC_FEATURE_RECORDING__:
      process.env.SKEPTIC_FEATURE_RECORDING ?? "true",
    __SKEPTIC_FEATURE_MCP__: process.env.SKEPTIC_FEATURE_MCP ?? "true",
    __SKEPTIC_FEATURE_ACP__: process.env.SKEPTIC_FEATURE_ACP ?? "true",
  },

  async onSuccess() {
    // Two asset groups must ship next to dist/skeptic.mjs:
    // 1. templates/ (read by `skeptic init`, `guidance-loader`)
    // 2. web-vitals.iife.js (injected into the page by performance-collector;
    //    must exist on disk because Phase 7 moves web-vitals to devDependencies)
    await cp(
      resolve(here, "templates"),
      resolve(here, "dist/templates"),
      { recursive: true },
    );
    await cp(
      resolve(here, "node_modules/web-vitals/dist/web-vitals.iife.js"),
      resolve(here, "dist/web-vitals.iife.js"),
    );
  },
});
