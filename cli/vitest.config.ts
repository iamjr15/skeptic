import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest reuses Vite's `define` mechanism. These mirror the build-time
  // constants substituted by tsup so unbundled test runs don't throw
  // ReferenceError on bare `__SKEPTIC_FEATURE_*__` / `__SKEPTIC_CLI_VERSION__`.
  // All features default to `true` in tests so the gated branches execute.
  define: {
    __SKEPTIC_CLI_VERSION__: '"0.0.0-dev"',
    __SKEPTIC_FEATURE_AI_ASSERTIONS__: "true",
    __SKEPTIC_FEATURE_COOKIE_EXTRACTION__: "true",
    __SKEPTIC_FEATURE_RECORDING__: "true",
    __SKEPTIC_FEATURE_MCP__: "true",
    __SKEPTIC_FEATURE_ACP__: "true",
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    globals: true,
    testTimeout: 30_000,
  },
});
