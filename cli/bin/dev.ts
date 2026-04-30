// Dev bootstrap for ad-hoc `tsx`/`node --import tsx` runs.
//
// Bare `__SKEPTIC_FEATURE_*__` and `__SKEPTIC_CLI_VERSION__` identifiers are
// defined three ways:
//   - In production builds: tsup `define` substitutes literal values.
//   - In vitest tests:      vitest.config.ts `define` block.
//   - In hand-run dev:      this file sets them on globalThis BEFORE
//                           importing the program, so esbuild's runtime
//                           lookup falls back to the global.
//
// Usage: `tsx cli/bin/dev.ts <args>` instead of `tsx cli/bin/skeptic.ts`.

const g = globalThis as Record<string, unknown>;
g["__SKEPTIC_CLI_VERSION__"] = "0.0.0-dev";
g["__SKEPTIC_FEATURE_AI_ASSERTIONS__"] = true;
g["__SKEPTIC_FEATURE_COOKIE_EXTRACTION__"] = true;
g["__SKEPTIC_FEATURE_RECORDING__"] = true;
g["__SKEPTIC_FEATURE_MCP__"] = true;
g["__SKEPTIC_FEATURE_ACP__"] = true;

// Importing the .ts source directly (this file is only meant to be run
// under tsx, which understands TS extensions). The eslint-style comment
// below disables the project's import-path rule for this single line.
// eslint-disable-next-line
// @ts-expect-error -- intentional .ts import; this file runs only under tsx
await import("./skeptic.ts");
