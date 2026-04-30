import { test } from "skeptic-cli";
import * as fs from "node:fs";

// Top-level side-effect rule (plan §4.0): each spec is imported twice — once by
// the discovery worker and once by the execution worker that picks tests up.
// We append a sentinel line per import to a file at SKEPTIC_IMPORT_LOG so the
// integration test can assert the file ends up with exactly two lines.
const log = process.env["SKEPTIC_IMPORT_LOG"];
if (log) {
  fs.appendFileSync(log, `imported@${Date.now()}\n`);
}

test("side-effect: noop", async () => {
  // Empty body — the assertion runs in the integration test against the log file.
});
