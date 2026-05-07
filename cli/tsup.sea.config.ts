import { defineConfig } from "tsup";
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
    "skeptic-sea": "bin/skeptic.ts",
  },
  format: ["cjs"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  outExtension: () => ({ js: ".cjs" }),
  sourcemap: buildSourcemap,
  minify: minifyBuild,
  treeshake: true,
  splitting: false,
  skipNodeModulesBundle: false,
  clean: false,
  banner: {
    js: "/*! @license skeptic-cli — see LICENSES.md for third-party attributions */",
  },
  dts: false,
  external: [
    "playwright",
    "playwright-core",
    "better-sqlite3",
  ],
  // The SEA payload must not contain bare runtime requires for ordinary
  // npm packages because Node's embedded snapshot cannot resolve them from
  // inside the injected blob. Keep only the heavy/native browser sidecars on
  // disk next to the binary and bundle every pure-JS package transitively.
  noExternal: [
    /^(?!(playwright|playwright\/.*|playwright-core|playwright-core\/.*|better-sqlite3|better-sqlite3\/.*)$).*/,
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
    options.alias = {
      ...(options.alias ?? {}),
      "react-devtools-core": resolve(here, "src/utils/empty-stub.cjs"),
    };
  },
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
});
