import assert from "node:assert/strict";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const assets = resolve(process.argv[2] ?? "dist");
const platform = process.argv[3];
assert(platform, "usage: node scripts/smoke-runtime.mjs <asset-directory> <platform>");
const root = mkdtempSync(join(tmpdir(), "skeptic-bundle-smoke-"));
const bin = join(root, "bin");
const project = join(root, "project");
const extension = process.platform === "win32" ? ".exe" : "";
const binary = (name) => join(bin, `${name}${extension}`);

function run(name, args) {
  const result = spawnSync(binary(name), args, { cwd: project, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  mkdirSync(bin);
  mkdirSync(project);
  for (const name of ["skeptic", "skeptic-runner", "skeptic-doctor", "skeptic-mobile", "skeptic-report"]) {
    const asset = join(assets, `${name}-${platform}${extension}`);
    assert(existsSync(asset), `missing runtime binary: ${asset}`);
    copyFileSync(asset, binary(name));
    chmodSync(binary(name), 0o755);
  }

  assert.match(run("skeptic", ["--version"]), /^skeptic \d+\.\d+\.\d+/);
  assert.equal(JSON.parse(run("skeptic", ["manifest", "--format", "json"])).ok, true);

  writeFileSync(join(project, "sample.ts"), "export const answer: number = 42;\n");
  const doctor = JSON.parse(run("skeptic", ["doctor", project, "--format", "json"]));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.data.filesScanned, 1);

  const spec = join(project, "portable.spec.ts");
  writeFileSync(spec, `import { test, expect } from "skeptic-cli";
test("standalone runtime includes web and crypto sources", async () => {
  expect(new URL("https://example.com/portable").pathname).toBe("/portable");
  const bytes = new TextEncoder().encode("portable");
  expect(new TextDecoder().decode(bytes)).toBe("portable");
  expect((await crypto.subtle.digest("SHA-256", bytes)).byteLength).toBe(32);
});
`);
  const result = join(root, "result.json");
  // This spec never opens a browser. A nonexistent browser binary also prevents
  // optional evidence collection from attaching to a real local session.
  run("skeptic-runner", ["__worker", spec, "--root", project,
    "--skeptic-bin", join(root, "browser-disabled"), "--session", "bundle-smoke",
    "--result", result]);
  const { tests } = JSON.parse(readFileSync(result, "utf8"));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].status, "passed", JSON.stringify(tests[0]));
  console.log(`Complete runtime smoke passed: ${platform}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
