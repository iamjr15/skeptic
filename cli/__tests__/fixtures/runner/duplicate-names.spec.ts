import { test } from "skeptic-cli";

// Plan §4.0.1: duplicate names within a file are allowed; each registers at a
// distinct ordinal. Reporter output disambiguates via `#${ordinal}`.
test("dup", async () => {});
test("dup", async () => {});
