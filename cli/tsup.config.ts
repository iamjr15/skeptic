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
  banner: {
    js: [
      "import { createRequire as __skepticCreateRequire } from 'node:module';",
      "const require = __skepticCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  dts: { entry: "src/index.ts" },

  // Canonical four externals (must remain runtime-resolved):
  external: [
    "playwright",
    "playwright-core",
    "better-sqlite3",
    "oxc-resolver",
    // node:sea is loaded via `createRequire("node:sea")` in sea-aware
    // modules — esbuild was stripping the `node:` prefix when the module
    // was imported statically, breaking runtime resolution. Keeping it out
    // of `external` since the static-import path no longer exists.
  ],

  // Pure JS — bundle for tree-shaking. MCP/ACP SDKs and axe-core/playwright
  // are bundled here so the SEA sidecar stays at four packages.
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
    // Ink statically imports `react-devtools-core` in build/devtools.js, but
    // only loads that path when `process.env.DEV === "true"` (see
    // ink/build/reconciler.js). With splitting: false, the bundler preserves
    // the import unconditionally and the runtime crashes with
    // ERR_MODULE_NOT_FOUND. Alias to an empty stub.
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
    // Three asset groups must ship next to dist/skeptic.mjs:
    // 1. templates/ (read by `skeptic init`, `guidance-loader`)
    // 2. recorder-script.js (injected into Playwright via addInitScript)
    // 3. web-vitals.iife.js (injected into the page by performance-collector;
    //    must exist on disk because Phase 7 moves web-vitals to devDependencies)
    await cp(
      resolve(here, "templates"),
      resolve(here, "dist/templates"),
      { recursive: true },
    );
    // recorder-script.js was deleted in B1 (recorder rebuild deferred to a later plan).
    await cp(
      resolve(here, "node_modules/web-vitals/dist/web-vitals.iife.js"),
      resolve(here, "dist/web-vitals.iife.js"),
    );
  },
});
