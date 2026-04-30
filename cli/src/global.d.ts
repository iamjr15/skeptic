// Build-time constants substituted by tsup `define`.
// Declared in an ambient (non-module) file so they're visible everywhere.
//
// Phases 2 and 5 reference these. tsup substitutes literal values at build
// time so esbuild dead-code-eliminates `if (__SKEPTIC_FEATURE_X__) { … }`
// branches when the feature is off.
//
// In dev/test (tsx, vitest) where tsup isn't running, vitest.config.ts's
// `define` block AND cli/bin/dev.ts's globalThis assignments provide
// runtime values so `__SKEPTIC_FEATURE_*__` references don't throw
// ReferenceError.

declare const __SKEPTIC_FEATURE_AI_ASSERTIONS__: boolean;
declare const __SKEPTIC_FEATURE_COOKIE_EXTRACTION__: boolean;
declare const __SKEPTIC_FEATURE_RECORDING__: boolean;
declare const __SKEPTIC_FEATURE_MCP__: boolean;
declare const __SKEPTIC_FEATURE_ACP__: boolean;
declare const __SKEPTIC_CLI_VERSION__: string;

// playwright-core's package.json exposes `./lib/server` but ships no .d.ts
// for that subpath. skeptic's `skeptic browsers install` command uses
// `registry.resolveBrowsers`, `.install`, and `.installDeps` from there.
// Type as a minimal opaque interface — the call sites duck-type against
// the documented shape.
declare module "playwright-core/lib/server" {
  interface Executable {
    name: string;
    browserName?: string;
    directory?: string;
    downloadURLs?: string[];
  }
  export interface Registry {
    resolveBrowsers(args: string[], options: Record<string, unknown>): Executable[];
    install(executables: Executable[], options: { force?: boolean }): Promise<void>;
    installDeps(executables: Executable[], dryRun: boolean): Promise<void>;
    validateHostRequirementsForExecutablesIfNeeded(
      executables: Executable[],
      langName: string,
    ): Promise<void>;
  }
  export const registry: Registry;
}
