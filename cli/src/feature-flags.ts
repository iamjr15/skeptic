// `FEATURES` is for read-only INSPECTION (e.g. `skeptic --features` output).
// It does NOT participate in dead-code elimination — gates that should remove
// code from the bundle MUST use the bare identifier directly:
//
//   if (__SKEPTIC_FEATURE_ACP__) { await import("./commands/acp.js"); }
//
// esbuild's `define` only substitutes bare identifiers, not member access.
// Wrapping the constant inside a property read like `if (FEATURES.ACP)`
// compiles to a runtime property read and the dynamic import survives DCE.
//
// The bare `__SKEPTIC_FEATURE_*__` constants are declared in `src/global.d.ts`
// (ambient — visible to every TS file). At build time tsup substitutes them
// to literal `true`/`false`. In dev (vitest, tsx via bin/dev.ts), they're
// runtime-defined via vitest config's `define` and globalThis assignments.

const env = (k: string, fallback: boolean): boolean => {
  const g = (globalThis as Record<string, unknown>)[k];
  return typeof g === "boolean" ? g : fallback;
};

export const FEATURES = {
  AI_ASSERTIONS:
    typeof __SKEPTIC_FEATURE_AI_ASSERTIONS__ !== "undefined"
      ? __SKEPTIC_FEATURE_AI_ASSERTIONS__
      : env("__SKEPTIC_FEATURE_AI_ASSERTIONS__", true),
  COOKIE_EXTRACTION:
    typeof __SKEPTIC_FEATURE_COOKIE_EXTRACTION__ !== "undefined"
      ? __SKEPTIC_FEATURE_COOKIE_EXTRACTION__
      : env("__SKEPTIC_FEATURE_COOKIE_EXTRACTION__", true),
  RECORDING:
    typeof __SKEPTIC_FEATURE_RECORDING__ !== "undefined"
      ? __SKEPTIC_FEATURE_RECORDING__
      : env("__SKEPTIC_FEATURE_RECORDING__", true),
  MCP:
    typeof __SKEPTIC_FEATURE_MCP__ !== "undefined"
      ? __SKEPTIC_FEATURE_MCP__
      : env("__SKEPTIC_FEATURE_MCP__", true),
  ACP:
    typeof __SKEPTIC_FEATURE_ACP__ !== "undefined"
      ? __SKEPTIC_FEATURE_ACP__
      : env("__SKEPTIC_FEATURE_ACP__", true),
} as const;

export type FeatureName = keyof typeof FEATURES;
