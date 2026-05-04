import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKER = "<!-- skeptic-qa-results -->";

function makePassingResults() {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    duration_ms: 4200,
    tests: [
      { name: "Login Test", file: "tests/login.spec.ts", status: "passed", steps: [] },
      { name: "Dashboard Test", file: "tests/dashboard.spec.ts", status: "passed", steps: [] },
    ],
  };
}

function makeFailingResults(failures = 1) {
  const tests = [
    { name: "Login Test", file: "tests/login.spec.ts", status: "passed", steps: [] },
  ];
  for (let i = 0; i < failures; i++) {
    tests.push({
      name: `Failing Test ${i + 1}`,
      file: `tests/fail-${i + 1}.spec.ts`,
      status: "failed",
      steps: [
        { command: "click", status: "failed", error: `Element not found: #button-${i}` } as unknown as { status: string; error: string },
      ],
    });
  }
  return {
    total: 1 + failures,
    passed: 1,
    failed: failures,
    duration_ms: 5500,
    tests,
  };
}

describe("buildCommentBody", () => {
  it("renders all-passing summary with marker as first line", async () => {
    const { buildCommentBody, DEFAULT_MARKER } = await import("../../../src/commands/comment.js");
    const body = buildCommentBody(makePassingResults(), null);
    expect(body.split("\n")[0]).toBe(DEFAULT_MARKER);
    expect(body).toContain("✅");
    expect(body).toContain("| 2 | 2 | 0 | 4.2s |");
    expect(body).not.toContain("Failed Tests");
  });

  it("renders failing summary with bullet list of failed tests", async () => {
    const { buildCommentBody } = await import("../../../src/commands/comment.js");
    const body = buildCommentBody(makeFailingResults(2), null);
    expect(body).toContain("❌");
    expect(body).toContain("### Failed Tests");
    expect(body).toContain("**Failing Test 1** (tests/fail-1.spec.ts): Element not found: #button-0");
    expect(body).toContain("**Failing Test 2** (tests/fail-2.spec.ts): Element not found: #button-1");
  });

  it("omits the run-URL line when runUrl is null", async () => {
    const { buildCommentBody } = await import("../../../src/commands/comment.js");
    const body = buildCommentBody(makePassingResults(), null);
    expect(body).not.toContain("Download full report");
  });

  it("includes the run-URL line when runUrl is provided", async () => {
    const { buildCommentBody } = await import("../../../src/commands/comment.js");
    const body = buildCommentBody(makePassingResults(), "https://example.com/run/42");
    expect(body).toContain("[Download full report](https://example.com/run/42)");
  });

  it("escapes pipe characters in test names", async () => {
    const { buildCommentBody } = await import("../../../src/commands/comment.js");
    const r = makeFailingResults(0);
    r.tests.push({
      name: "Test | with pipe",
      file: "tests/pipe.spec.ts",
      status: "failed",
      steps: [{ command: "click", status: "failed", error: "boom" } as unknown as { status: string; error: string }],
    });
    r.failed = 1;
    r.total = 2;
    const body = buildCommentBody(r, null);
    expect(body).toContain("Test \\| with pipe");
    expect(body).not.toContain("Test | with pipe");
  });

  it("uses a custom marker when provided", async () => {
    const { buildCommentBody } = await import("../../../src/commands/comment.js");
    const body = buildCommentBody(makePassingResults(), null, "<!-- custom -->");
    expect(body.split("\n")[0]).toBe("<!-- custom -->");
  });
});

describe("isValidResults", () => {
  it("accepts a well-formed shape", async () => {
    const { isValidResults } = await import("../../../src/commands/comment.js");
    expect(isValidResults(makePassingResults())).toBe(true);
  });

  it("rejects missing fields", async () => {
    const { isValidResults } = await import("../../../src/commands/comment.js");
    expect(isValidResults({ total: 1, passed: 1, failed: 0 })).toBe(false);
    expect(isValidResults({})).toBe(false);
    expect(isValidResults(null)).toBe(false);
    expect(isValidResults("not an object")).toBe(false);
  });

  it("rejects when tests is not an array", async () => {
    const { isValidResults } = await import("../../../src/commands/comment.js");
    const bad = { total: 1, passed: 1, failed: 0, duration_ms: 100, tests: "oops" };
    expect(isValidResults(bad)).toBe(false);
  });
});

describe("runComment posting test", () => {
  let tmpDir: string;
  let resultsPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-comment-"));
    resultsPath = path.join(tmpDir, "results.json");
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    execFileMock = vi.fn();
    vi.doMock("node:child_process", () => ({ execFileSync: execFileMock }));
    vi.resetModules();
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--dry-run prints body to stdout and never invokes gh", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath, dryRun: true });
    expect(execFileMock).not.toHaveBeenCalled();
    const printed = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("skeptic test results");
    expect(process.exitCode).toBe(0);
  });

  it("warns and exits 0 when results file is missing", async () => {
    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: path.join(tmpDir, "missing.json") });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("warns and exits 0 when results.json has unexpected shape", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify({ total: "nope" }), "utf-8");
    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("warns and exits 0 when results.json is malformed JSON", async () => {
    fs.writeFileSync(resultsPath, "{not json", "utf-8");
    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("warns and exits 0 when gh is not on PATH (ENOENT)", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    execFileMock.mockImplementation(() => {
      const err = new Error("spawn gh ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    });
    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath, pr: "123" });
    expect(process.exitCode).toBe(0);
  });

  it("invokes the list-comments endpoint with per_page in the URL (NOT -F) and concrete PR number", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    execFileMock.mockImplementation(
      (cmd: string, args: readonly string[]) => {
        // First call: list comments → empty array (no existing comment)
        if (args[0] === "api") return "[]";
        // Second call: post new comment → empty success
        if (args[0] === "pr" && args[1] === "comment") return "";
        return "";
      },
    );

    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath, pr: "123" });

    const listCall = execFileMock.mock.calls.find(
      (c) => c[0] === "gh" && c[1] && (c[1] as readonly string[])[0] === "api",
    );
    expect(listCall).toBeDefined();
    expect(listCall![1]).toEqual([
      "api",
      "repos/{owner}/{repo}/issues/123/comments?per_page=100",
    ]);

    const postCall = execFileMock.mock.calls.find(
      (c) => c[0] === "gh" && c[1] && (c[1] as readonly string[])[0] === "pr",
    );
    expect(postCall).toBeDefined();
    expect(postCall![1]?.[0]).toBe("pr");
    expect(postCall![1]?.[1]).toBe("comment");
    expect(postCall![1]?.[2]).toBe("123");
    expect(postCall![1]?.[3]).toBe("--body-file");
    expect(process.exitCode).toBe(0);
  });

  it("PATCHes existing comment when marker found, with concrete commentId and tempfile", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makeFailingResults(1)), "utf-8");
    execFileMock.mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (args[0] === "api" && args[1]?.startsWith("repos/{owner}/{repo}/issues/")) {
          // List comments — return one matching the marker
          if (args[1].includes("?per_page=100")) {
            return JSON.stringify([
              { id: 9999, body: `${MARKER}\n## old comment body` },
            ]);
          }
          // PATCH call returns empty
          return "";
        }
        return "";
      },
    );

    const { runComment } = await import("../../../src/commands/comment.js");
    await runComment({ results: resultsPath, pr: "123" });

    const patchCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as readonly string[])[2] === "-X",
    );
    expect(patchCall).toBeDefined();
    const argv = patchCall![1] as readonly string[];
    expect(argv[0]).toBe("api");
    expect(argv[1]).toBe("repos/{owner}/{repo}/issues/comments/9999");
    expect(argv[2]).toBe("-X");
    expect(argv[3]).toBe("PATCH");
    expect(argv[4]).toBe("-F");
    expect(argv[5]).toMatch(/^body=@/);
    expect(process.exitCode).toBe(0);
  });

  it("autodetect: with no --pr, derives from gh pr view stdout", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    execFileMock.mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (args[0] === "pr" && args[1] === "view") return "456\n";
        if (args[0] === "api") return "[]";
        if (args[0] === "pr" && args[1] === "comment") return "";
        return "";
      },
    );

    const { runComment } = await import("../../../src/commands/comment.js");
    delete process.env["GITHUB_REF"];
    await runComment({ results: resultsPath });

    const listCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as readonly string[])[0] === "api",
    );
    expect(listCall).toBeDefined();
    expect(listCall![1]).toEqual([
      "api",
      "repos/{owner}/{repo}/issues/456/comments?per_page=100",
    ]);
  });

  it("info-skip and exits 0 when no PR detected and no --pr passed", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    execFileMock.mockImplementation(() => "");  // empty stdout from gh pr view
    const { runComment } = await import("../../../src/commands/comment.js");
    delete process.env["GITHUB_REF"];
    await runComment({ results: resultsPath });
    expect(process.exitCode).toBe(0);
    // The list-comments call must NOT have been made (no PR resolved)
    const listCall = execFileMock.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as readonly string[])[0] === "api",
    );
    expect(listCall).toBeUndefined();
  });

  it("derives PR number from GITHUB_REF as fallback", async () => {
    fs.writeFileSync(resultsPath, JSON.stringify(makePassingResults()), "utf-8");
    execFileMock.mockImplementation(
      (cmd: string, args: readonly string[]) => {
        if (args[0] === "api") return "[]";
        if (args[0] === "pr" && args[1] === "comment") return "";
        return "";
      },
    );
    process.env["GITHUB_REF"] = "refs/pull/789/merge";
    try {
      const { runComment } = await import("../../../src/commands/comment.js");
      await runComment({ results: resultsPath });
      const listCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as readonly string[])[0] === "api",
      );
      expect(listCall).toBeDefined();
      expect(listCall![1]).toEqual([
        "api",
        "repos/{owner}/{repo}/issues/789/comments?per_page=100",
      ]);
    } finally {
      delete process.env["GITHUB_REF"];
    }
  });
});
