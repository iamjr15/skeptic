import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fail = (message) => { throw new Error(message); };
const read = (path) => readFileSync(join(root, path), "utf8");

for (const path of [
  "LICENSE", "NOTICE", "LICENSES/agent-browser-LICENSE", "LICENSES/deno-LICENSE.md",
  "vendor/deno_crypto/Cargo.toml",
  "crates/skeptic-cli/assets/a11y/axe.LICENSE",
  "crates/skeptic-cli/assets/a11y/ace.js.LICENSE.txt",
]) {
  if (!existsSync(join(root, path))) fail(`missing required license file ${path}`);
}

const notice = read("NOTICE");
for (const component of ["agent-browser", "Deno", "axe-core", "Equal Access", "AXe", "react-doctor", "expect"]) {
  if (!notice.includes(component)) fail(`NOTICE is missing ${component}`);
}
if (!notice.includes("deno_crypto 0.269.0")) fail("NOTICE is missing the vendored Web Crypto runtime");

const assetRoot = join(root, "crates/skeptic-cli/assets/a11y");
for (const line of read("crates/skeptic-cli/assets/a11y/CHECKSUMS.sha256").trim().split(/\r?\n/)) {
  const [expected, filename] = line.trim().split(/\s+/);
  const actual = createHash("sha256").update(readFileSync(join(assetRoot, filename))).digest("hex");
  if (actual !== expected) fail(`asset checksum mismatch for ${filename}`);
}

const mobile = read("crates/skeptic-mobile/src/lib.rs");
if (!mobile.includes("AXE_VERSION: &str = \"1.7.1\"")) fail("AXe version pin changed unexpectedly");
if (!mobile.includes("26a64009c09a3ae980b1f1b4b377bd2a2dd96cbbde24821935e47352cb71cc69")) fail("AXe checksum pin is missing");

const requiredBinaries = ["skeptic", "skeptic-runner", "skeptic-doctor", "skeptic-mobile", "skeptic-report"];
const release = read(".github/workflows/release.yml");
const staging = read("npm/skeptic-cli/scripts/stage-platform-packages.mjs");
for (const binary of requiredBinaries) {
  if (!release.includes(binary)) fail(`release workflow does not stage ${binary}`);
  if (!staging.includes(`"${binary}"`)) fail(`platform package staging omits ${binary}`);
}
for (const directory of readdirSync(join(root, "npm/platforms"))) {
  const packageData = JSON.parse(read(`npm/platforms/${directory}/package.json`));
  if (packageData.files?.[0] !== "bin") fail(`${directory} does not publish bin/`);
  const extension = directory.startsWith("win32-") ? ".exe" : "";
  if (packageData.skepticBinary !== `bin/skeptic${extension}`) fail(`${directory} has invalid skepticBinary`);
}

for (const skill of ["core", "doctor", "evidence", "mobile"]) {
  const content = read(`skill-data/${skill}/SKILL.md`);
  if (!content.startsWith("---\nname:")) fail(`${skill} skill has invalid frontmatter`);
}

console.log("Skeptic release invariants: OK");
