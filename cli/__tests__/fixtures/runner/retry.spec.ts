import { test } from "skeptic-cli";
import * as fs from "node:fs";
import * as path from "node:path";

// Counter persisted to a file so attempts share state across separate worker invocations
// (each retry spawns a fresh worker per plan §4.0). The path is read from an env var so
// the integration test can isolate per-run.
const COUNTER_PATH = process.env["SKEPTIC_RETRY_COUNTER"] ?? "";

const readAttempts = (): number => {
  if (!COUNTER_PATH) return 0;
  try {
    return Number.parseInt(fs.readFileSync(COUNTER_PATH, "utf-8"), 10) || 0;
  } catch {
    return 0;
  }
};

const writeAttempts = (n: number): void => {
  if (!COUNTER_PATH) return;
  fs.mkdirSync(path.dirname(COUNTER_PATH), { recursive: true });
  fs.writeFileSync(COUNTER_PATH, String(n));
};

test("retry: passes on second attempt", async () => {
  const attempts = readAttempts() + 1;
  writeAttempts(attempts);
  if (attempts < 2) {
    throw new Error(`fail-on-attempt-${attempts}`);
  }
});
