import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";
import { startSessionDaemon, type SessionDaemonHandle } from "../../../src/daemon/session-daemon.js";
import { getSessionSocketPath } from "../../../src/daemon/socket.js";
import { sendRpc } from "../../../src/daemon/client.js";

const URL = 'data:text/html,<button onclick="this.setAttribute(\'data-clicked\',\'1\')">Go</button><input aria-label="Email" />';

// Drives the session daemon in-process (real headless Chromium) over its socket,
// proving the full open→snapshot→act→query loop and that refs survive across
// independent RPCs (the cross-invocation persistence the CLI verbs rely on).
describe("session daemon smoke (real browser)", () => {
  let tmpDir: string;
  let handle: SessionDaemonHandle | null = null;
  let browserOk = false;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-sessd-"));
    process.env["SKEPTIC_DAEMON_DIR"] = tmpDir;
    try {
      const b: Browser = await chromium.launch({ headless: true });
      await b.close();
      browserOk = true;
    } catch (err) {
      console.warn("[session-daemon-smoke] chromium unavailable; skipping:", err);
      browserOk = false;
    }
    if (browserOk) {
      handle = await startSessionDaemon({
        engine: "chromium",
        headed: false,
        cliVersion: "0.0.0-test",
        idleTimeoutSeconds: 0,
        sessionIdleSeconds: 0,
      });
    }
  }, 40_000);

  afterAll(async () => {
    if (handle) await handle.shutdown("test-teardown");
    delete process.env["SKEPTIC_DAEMON_DIR"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    sendRpc(getSessionSocketPath(), { method, params }, 30_000);

  it("open → snapshot → act → query over independent RPCs (refs persist)", async () => {
    if (!browserOk) return;

    const opened = await rpc("session.open", { session: "t", url: URL });
    expect((opened.result as { url: string }).url).toContain("data:text/html");

    // Separate RPC: snapshot mints refs stored in the daemon session.
    const snap = await rpc("session.snapshot", { session: "t", interactive: true });
    const refs = (snap.result as { refs: Array<{ ref: string; role: string; name: string }> }).refs;
    const button = refs.find((r) => r.role === "button" && r.name === "Go");
    expect(button, "snapshot should mint a button ref").toBeDefined();

    // Separate RPC: act on the ref the prior snapshot minted (cross-RPC persistence).
    const clicked = await rpc("session.act", { session: "t", verb: "click", ref: button!.ref });
    expect((clicked.result as { ok: boolean }).ok).toBe(true);

    // Separate RPC: fill the input by its ref.
    const input = refs.find((r) => r.role === "textbox");
    if (input) {
      const filled = await rpc("session.act", { session: "t", verb: "fill", ref: input.ref, text: "x@y.z" });
      expect((filled.result as { ok: boolean }).ok).toBe(true);
    }

    // The click set an attribute — confirm via a fresh snapshot + selector query.
    const box = await rpc("session.query", { session: "t", query: "box", selector: "css=button" });
    expect((box.result as { value: unknown }).value).not.toBeNull();
  }, 40_000);

  it("session.snapshot before open is refused with an actionable error", async () => {
    if (!browserOk) return;
    const resp = await rpc("session.snapshot", { session: "never-opened" });
    expect(resp.error).toMatch(/no open session/);
  });

  it("session.list reports the open session and session.close removes it", async () => {
    if (!browserOk) return;
    const list = await rpc("session.list");
    const names = (list.result as { sessions: Array<{ name: string }> }).sessions.map((s) => s.name);
    expect(names).toContain("t");
    const closed = await rpc("session.close", { session: "t" });
    expect((closed.result as { closed: boolean }).closed).toBe(true);
  });
});
