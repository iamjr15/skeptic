import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sumsPath = resolve(process.argv[2] ?? join(root, "dist/BINARY_SHA256SUMS"));
const output = resolve(process.argv[3] ?? join(root, "dist/skeptic.rb"));
const cargo = readFileSync(join(root, "Cargo.toml"), "utf8");
const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error("workspace version is missing");
const sums = new Map(readFileSync(sumsPath, "utf8").trim().split(/\r?\n/).map((line) => {
  const [sum, name] = line.trim().split(/\s+/);
  return [name.replace(/^\*/, ""), sum];
}));
const binaries = ["skeptic", "skeptic-runner", "skeptic-doctor", "skeptic-mobile", "skeptic-report"];
const base = `https://github.com/iamjr15/skeptic/releases/download/v${version}`;

function block(platform, indent = "    ") {
  const main = `skeptic-${platform}`;
  if (!sums.has(main)) throw new Error(`missing checksum for ${main}`);
  let text = `${indent}url "${base}/${main}"\n${indent}sha256 "${sums.get(main)}"\n`;
  for (const binary of binaries.slice(1)) {
    const asset = `${binary}-${platform}`;
    if (!sums.has(asset)) throw new Error(`missing checksum for ${asset}`);
    text += `${indent}resource "${binary}" do\n${indent}  url "${base}/${asset}"\n${indent}  sha256 "${sums.get(asset)}"\n${indent}end\n`;
  }
  return text;
}

const formula = `class Skeptic < Formula
  desc "Deterministic agent-native QA for web and mobile"
  homepage "https://github.com/iamjr15/skeptic"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
${block("darwin-arm64")}
    else
${block("darwin-x64")}
    end
  end

  on_linux do
    if Hardware::CPU.arm?
${block("linux-arm64")}
    else
${block("linux-x64")}
    end
  end

  def install
    suffix = OS.mac? ? "darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}" : "linux-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
    bin.install "skeptic-#{suffix}" => "skeptic"
    resources.each do |runtime|
      runtime.stage { bin.install Dir["*"][0] => runtime.name }
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skeptic --version")
    assert_match "skeptic.command-manifest/1", shell_output("#{bin}/skeptic manifest --format json")
  end
end
`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, formula);
console.log(`Generated ${output}`);
