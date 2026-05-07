#!/usr/bin/env node

// Fast path: --version / -V short-circuit BEFORE any heavy import.
// ESM static imports are hoisted to the top of the module regardless of
// where this `if` is placed, so the static `import { program } …` below
// is converted to a dynamic `await import(…)` to keep this branch truly
// fast. `__SKEPTIC_CLI_VERSION__` is substituted to a literal string by tsup
// `define` (and via vitest.config.ts `define` in tests / bin/dev.ts in
// hand-run dev).
if (process.argv.length === 3) {
  const a = process.argv[2];
  if (a === "--version" || a === "-V") {
    console.log(__SKEPTIC_CLI_VERSION__);
    process.exit(0);
  }
  if (a === "--features") {
    // Print the build-time feature map. The constants are substituted by
    // tsup `define` so the JSON literal here is fully resolved at build time
    // and printing doesn't load any other module.
    console.log(
      JSON.stringify(
        {
          AI_ASSERTIONS: __SKEPTIC_FEATURE_AI_ASSERTIONS__,
          COOKIE_EXTRACTION: __SKEPTIC_FEATURE_COOKIE_EXTRACTION__,
          RECORDING: __SKEPTIC_FEATURE_RECORDING__,
          MCP: __SKEPTIC_FEATURE_MCP__,
          ACP: __SKEPTIC_FEATURE_ACP__,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
}

void (async () => {
  const { program } = await import("../src/index.js");
  await program.parseAsync(process.argv);
})().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
