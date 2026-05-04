# Plan: `skeptic record` Command (#26)

## Context

The competitive-analysis entry attributes `record` to Maestro, but **Maestro does not have an interaction recorder** — its `record` command writes a video of a *pre-existing* flow (`skeptic-refs/maestro/maestro-cli/src/main/java/maestro/cli/command/RecordCommand.kt:45-191`), and Maestro Studio is a manual REPL-style editor that emits coordinate-based gestures (`skeptic-refs/maestro/maestro-studio/web/src/components/device-and-device-elements/InteractableDevice.tsx:22-44, 118-128`). There is no event capture, no selector synthesis, no session model. Porting from Maestro is impossible because the feature doesn't exist there.

The actual reference implementation is **Playwright's codegen**, vendored at `/Users/iamjr15/Desktop/skeptic/cli/node_modules/playwright-core/lib/server/recorder/`. The capture mechanism is an **injected polling script** (`pollingRecorderSource` in `cli/node_modules/playwright-core/lib/generated/`) that hooks the page's DOM and exposes two bindings — `__pw_recorderRecordAction` and `__pw_recorderPerformAction` — back to the Node side. Action types covered: `click`, `fill`, `press`, `hover`, `check`, `uncheck`, `select`, `navigate`, `openPage`, `closePage`, `setInputFiles`, plus assertion modes. Debouncing happens in `recorderUtils.js:87-99` (`shouldMergeAction` merges rapid same-target events). Code emission flows through `lib/server/codegen/language.js:29-35` `generateCode(actions[], languageGenerator, options)`; built-in generators are `JavaScript`, `Python`, `CSharp`, `Java`, `Jsonl` (`lib/server/codegen/languages.js:29-63`).

**The hard truth from the source survey:** Playwright's recorder is **not exposed via public API**. The entry point is `BrowserContext._enableRecorder({language, mode, outputFile})` — underscore-prefixed in client code. `RecorderApp.show()` always launches a separate Chromium UI window. `languageSet()` is hardcoded; you can't register a custom language generator without forking. The two viable porting strategies:

- **Option A (preferred):** Don't reuse Playwright's recorder at all. Write a small custom recorder via DOM injection + `page.exposeBinding`. Capture events ourselves, synthesize selectors using skeptic's existing element-resolver priority, emit YAML. ~250 lines of skeptic-side code, zero monkey-patching of Playwright internals, fully under our control.
- **Option B:** Drive `BrowserContext._enableRecorder` with `mode: "recording"`, suppress the inspector UI via env vars / monkey-patch, and listen on `BrowserContext.Events.RecorderEvent` (the programmatic recorder app pattern at `lib/server/recorder/recorderApp.js:314-343`). Translate Playwright actions to skeptic YAML. ~150 lines but depends on internal-API stability.

**This plan picks Option A.** Reasoning:
1. Playwright's selector synthesizer is opaque (locked inside the injected polling script) and produces `getByRole(...)` / `locator('css=...')` strings. skeptic's selector vocabulary is different — bare strings that the element-resolver chain interprets — and we want generated YAML to be **consistent with the rest of skeptic**, not a transcription of Playwright API calls.
2. Option A has no underscore-prefixed APIs; everything used is documented (`page.exposeBinding`, `addInitScript`, page event listeners).
3. skeptic's MCP server already does `page.exposeBinding` and `addInitScript` patterns elsewhere; the team has muscle memory for the pattern.
4. We get clean integration with #31 (ARIA refs) and #37 (relational selectors) in v2 — the recorder can synthesize those formats without fighting Playwright's preferred output.

**Cross-references with other plans:**
- **#31 ARIA snapshot-ref** could be the *output format* for recorded flows — emit `ariaSnapshot: true` then `click: "@eN"` instead of bare-string selectors. Defer to v2 of `record` (Phase 5 below). v1 emits bare-string selectors using skeptic's element-resolver priority.
- **#37 composable selectors** could similarly enrich emitted selectors (e.g., `click: { text: "Save", below: "Email" }` when the recorder sees an unstable text-only selector). Defer.
- The recorder Phase 5 design is sequenced *after* #31 and #37 land; the v1 record command works standalone.

**Goal (v1):** `skeptic record [output.yaml]` opens a headed Chromium, navigates to the configured URL, captures user interactions until Ctrl+C / browser close, and writes a runnable skeptic YAML flow to the output file. The emitted flow uses skeptic's selector vocabulary (bare strings), skeptic's step shapes, and runs cleanly via `skeptic test <output.yaml>` against the same target.

**Out of scope (v1):**
- Pre-existing-recorder surfaces: no Maestro Studio-style coordinate gestures, no replay-and-edit UI, no selector inspector overlay.
- Multi-tab/multi-context recording. v1 records the first context, first page; opening a popup is captured as `openPage`; tab switching is not first-class.
- ARIA snapshot-ref output (defer to Phase 5 / cross-plan integration).
- Network mocking, storage state extraction, file uploads beyond `setInputFiles` shape.

---

## Phase 1 — Command surface, lifecycle, output skeleton

### 1.1 New command

**File:** `cli/src/index.ts:166-171` (after the `mcp` command registration, before `audit`)

```ts
program
  .command("record")
  .description("Record browser interactions and emit a skeptic YAML flow")
  .argument("[output]", "output file path (default: ./recorded-<timestamp>.yaml)")
  .option("-u, --url <url>", "starting URL (default: from config)")
  .option("-c, --config <path>", "path to config file")
  .option("--device <id>", "device profile for viewport emulation")
  .option("--name <name>", "flow name written to YAML metadata", "Recorded flow")
  .option("--no-tags", "omit default tag (otherwise tags: [recorded])")
  .option("--cookies", "load cookies from existing browser session before recording")
  .option("--cookies-from <browser>", "specific browser for cookie extraction")
  .option("--include-sensitive", "DO NOT redact password fields (default: redacted)")
  .action(async (output: string | undefined, cmdOpts: RecordCommandOptions) => {
    const { runRecord } = await import("./commands/record.js");
    await runRecord(output, cmdOpts);
  });
```

### 1.2 Command module skeleton

**File:** `cli/src/commands/record.ts` (new)

```ts
export interface RecordCommandOptions {
  url?: string;
  config?: string;
  device?: string;
  name?: string;
  tags?: boolean;            // false when --no-tags
  cookies?: boolean;
  cookiesFrom?: string;
  includeSensitive?: boolean; // false by default; opt-in to record password fields
}

export async function runRecord(
  outputPath: string | undefined,
  opts: RecordCommandOptions,
): Promise<void> {
  const config = loadConfig({ configPath: opts.config });
  const baseUrl = opts.url ?? config.url ?? "http://localhost:3000";
  const resolvedOutput = outputPath ?? `./recorded-${new Date().toISOString().replace(/[:.]/g, "-")}.yaml`;
  // The metadata URL we'll write to YAML — origin only, so resolveUrl() concatenation works
  // correctly when the user's baseUrl includes a path or query.
  const metaUrl = new URL(baseUrl).origin;

  // Pre-flight: refuse to overwrite existing files BEFORE launching browser.
  if (fs.existsSync(resolvedOutput)) {
    logger.error(`Output file already exists: ${resolvedOutput}. Pass a different name or delete it first.`);
    process.exitCode = 1;
    return;
  }

  // Device profile from config or --device flag (mirrors test.ts pattern)
  const viewport = resolveViewport(config, opts.device);

  const recorder = new RecorderSession({
    baseUrl,
    viewport,
    cookieOpts: opts.cookies
      ? { browsers: opts.cookiesFrom ? [opts.cookiesFrom] : undefined }
      : null,
    includeSensitive: opts.includeSensitive ?? false,
  });

  // Print the security/privacy banner BEFORE the browser opens — it's the user's last chance
  // to abort if they're recording in a privacy-sensitive context.
  logger.warn(
    `skeptic record: starting interactive recording. Anything you type, click, or navigate will be captured.\n` +
    `  - Password fields are ${opts.includeSensitive ? "INCLUDED (--include-sensitive)" : "redacted by default"}.\n` +
    `  - URL query strings are NOT redacted — review the output before sharing.\n` +
    `  - Cookies are ${opts.cookies ? "loaded from your browser session" : "NOT loaded"} (recorded YAML metadata reflects this).\n` +
    `  - Press Ctrl+C or close the browser to stop.`,
  );

  try {
    await recorder.start();
    await recorder.waitForCompletion();
  } finally {
    await recorder.stop();
  }

  const flowName = opts.name ?? "Recorded flow";
  const tags = opts.tags === false ? [] : ["recorded"];

  const yaml = renderYaml({
    name: flowName,
    url: metaUrl,                                // origin only — see comment above
    tags,
    auth: opts.cookies ? "cookies" : undefined,  // bake cookies-required into the flow metadata
    actions: recorder.actions,
  });

  fs.writeFileSync(resolvedOutput, yaml, "utf-8");
  logger.success(`Recorded ${recorder.actions.length} step(s) → ${chalk.cyan(resolvedOutput)}`);
  const replayHint = opts.cookies
    ? `skeptic test ${resolvedOutput} --cookies${opts.cookiesFrom ? ` --cookies-from ${opts.cookiesFrom}` : ""}`
    : `skeptic test ${resolvedOutput}`;
  logger.info(`Run: ${chalk.cyan(replayHint)}`);
}
```

`RecorderSession` lives in a sibling module (1.3). `renderYaml` is the YAML emitter (Phase 4).

**Cookie wiring fix.** Earlier draft called a fictitious `extractCookies(baseUrl, browser)` returning Playwright cookies. The real APIs are `extractCookies(domain, opts): SerializedCookie[]` (synchronous; returns the extraction-result format with browser metadata, NOT Playwright cookie shape) and `extractAndInjectCookies(context, hostname, opts): Promise<…>` which handles the full extract + map + inject pipeline. Use `extractAndInjectCookies` after the browser context is created — see 1.3 below.

**Lifecycle hardening.** `await recorder.waitForCompletion()` is wrapped in `try/finally` so `stop()` always runs. `stop()` (1.3) is idempotent and removes signal handlers. Without this, Ctrl+C can leave the browser process and child processes leaking.

**Replay-aware output.** When `--cookies` was used during recording, the flow's `auth: cookies` metadata is set so the generated YAML can replay correctly (skeptic's `auth: cookies` triggers cookie loading on `skeptic test`). The replay hint shown to the user also includes `--cookies` so they don't have to remember.

**Output filename collision:** if `outputPath` already exists, refuse to overwrite. Use `uniqueSlug`-style suffix logic OR error out with a hint to pass an explicit name. Erring on the safe side is right for a command that takes interactive input the user can't easily reproduce — choose error-out:

```ts
if (fs.existsSync(resolvedOutput)) {
  logger.error(`Output file already exists: ${resolvedOutput}. Pass a different name or delete it first.`);
  process.exitCode = 1;
  return;
}
```

This check runs **after** the recorder has captured actions (so the user doesn't lose work to a path collision discovered after recording). Actually no — that's worse: now the user records, sees an error, and *still* loses the recording. Run the check **before** the browser launches. If the user wants to record again to the same name, they confirm by deleting the prior file first.

### 1.3 The recorder session class

**File:** `cli/src/commands/record-session.ts` (new — kept separate from `record.ts` so the lifecycle is testable in isolation)

Outline:
```ts
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { extractAndInjectCookies } from "../cookies/extractor.js";

export interface CapturedAction {
  type: "navigate" | "click" | "type" | "press" | "select" |
        "openPage" | "submit";
  selector?: string;
  value?: string;
  url?: string;
  key?: string;
  isPasswordField?: boolean;   // recorder script flags input type="password"
  timestamp: number;
}

// `scroll` is intentionally absent. skeptic's scroll handler accepts only "up"|"down"|"top"|"bottom"
// or a selector — capturing pixel positions would produce broken YAML at replay. Excluding scroll
// from the trust-boundary allowlist also means a malicious page can't smuggle scroll actions
// through the binding to confuse the renderer. v2 may introduce an absolute `scrollTo: 500` step
// and re-enable scroll capture.

const ALLOWED_TYPES = new Set<CapturedAction["type"]>([
  "navigate", "click", "type", "press", "select", "openPage", "submit",
]);
const MAX_VALUE_LENGTH = 4096;       // cap binding payload values to prevent flooding
const MAX_ACTIONS = 5000;            // cap total captured actions per session

export class RecorderSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private completion: Promise<void>;
  private resolveCompletion!: () => void;
  private signalHandlers: Array<{ event: string; handler: () => void }> = [];
  private stopped = false;

  readonly actions: CapturedAction[] = [];

  constructor(private readonly opts: {
    baseUrl: string;
    viewport: { width: number; height: number };
    cookieOpts: { browsers?: string[] } | null;   // null = no cookies
    includeSensitive: boolean;                     // false → redact password fields
  }) {
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: false });
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
    });

    // Cookie injection uses the real extract+inject API, not the synchronous extractCookies.
    // The hostname comes from the baseUrl; injection happens AFTER the context is created.
    if (this.opts.cookieOpts !== null) {
      const hostname = new URL(this.opts.baseUrl).hostname;
      try {
        await extractAndInjectCookies(this.context, hostname, this.opts.cookieOpts);
      } catch (err) {
        // Cookie extraction failure shouldn't kill the session — surface as warning.
        logger.warn(`Cookie injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Bind capture function BEFORE any init script registration, so even the first page sees the binding.
    // Validation lives inside the binding handler, NOT inside the page-side script (where any page's JS
    // could call it with arbitrary payloads).
    await this.context.exposeBinding("__skeptic_recordAction", (_source, payload) => {
      this.handleCapturedEvent(payload);
    });

    // Inject the recorder script into every page in this context (existing + future).
    await this.context.addInitScript({ path: RECORDER_SCRIPT_PATH });

    this.page = await this.context.newPage();

    // Page-level events — capture navigations, popups, and ALL page closures.
    // Attach close handler to every page including future popups; otherwise closing a popup
    // leaves the session hanging when the user expected the recording to end.
    const wirePage = (p: Page) => {
      p.on("framenavigated", (frame) => {
        if (frame === p.mainFrame() && frame.url() !== "about:blank") {
          this.appendAction({
            type: "navigate",
            url: this.relativizeUrl(frame.url()),
            timestamp: Date.now(),
          });
        }
      });
      p.on("close", () => {
        // End the session when ALL pages close. If popups are still open, keep recording.
        if (this.context && this.context.pages().length === 0) {
          this.resolveCompletion();
        }
      });
    };

    wirePage(this.page);

    this.context.on("page", (newPage) => {
      this.appendAction({
        type: "openPage",
        url: this.relativizeUrl(newPage.url()),
        timestamp: Date.now(),
      });
      wirePage(newPage);
    });

    // Browser-disconnect handling — covers the case where the user kills Chromium directly
    // (force-quit, OS sleep waking with stale state, etc.). browser.on("disconnected") fires
    // earlier than context.on("close") in those scenarios, and is the canonical signal per
    // Playwright docs.
    this.browser.on("disconnected", () => {
      this.resolveCompletion();
    });
    // context.on("close") is the fallback for the normal-quit path (user closes the window).
    this.context.on("close", () => {
      this.resolveCompletion();
    });

    // Initial navigation: replay-fidelity matters here.
    //
    // skeptic's resolveUrl (cli/src/executor/context.ts:53-58) concatenates a path against the
    // metadata `url`. If we set `metadata.url = "http://host/forms/x?utm=1"` and the recorded
    // first navigate is `/forms/x?utm=1`, replay produces "http://host/forms/x?utm=1/forms/x?utm=1"
    // — broken. So:
    //   - metadata.url = ORIGIN only (e.g., "http://host")
    //   - first navigate = pathname + search + hash from baseUrl (e.g., "/forms/x?utm=1")
    //
    // The runRecord caller (1.2) handles the metadata side. Here we emit the navigation step
    // using the path-component derived from baseUrl.
    const baseUrlObj = new URL(this.opts.baseUrl);
    const initialPath = (baseUrlObj.pathname || "/") + baseUrlObj.search + baseUrlObj.hash;
    this.appendAction({
      type: "navigate",
      url: initialPath,
      timestamp: Date.now(),
    });
    await this.page.goto(this.opts.baseUrl);

    this.installSignalHandlers();
  }

  private capWarned = false;

  appendAction(action: CapturedAction): void {
    if (this.actions.length >= MAX_ACTIONS) {
      // Soft cap — log once, drop subsequent actions WITHOUT appending a fake step.
      // Earlier draft pushed { type: "navigate", url: "<truncated>" } which would replay as a
      // bogus navigation. Don't pollute the action stream.
      if (!this.capWarned) {
        this.capWarned = true;
        logger.warn(`Recorder capture cap reached (${MAX_ACTIONS} actions). Subsequent actions dropped.`);
      }
      return;
    }

    // Apply Phase 2.3 collation here (dedup + type-merging) — no recursive callback.
    const collated = this.normalizeAndDedup(action);
    if (collated === null) return;
    this.actions.push(collated);
    this.renderLiveCounter();
  }

  async waitForCompletion(): Promise<void> {
    return this.completion;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.removeSignalHandlers();
    try { await this.context?.close(); } catch { /* already closed */ }
    try { await this.browser?.close(); } catch { /* already closed */ }
  }

  private installSignalHandlers(): void {
    const handler = () => this.resolveCompletion();
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    this.signalHandlers.push(
      { event: "SIGINT", handler },
      { event: "SIGTERM", handler },
    );
  }

  private removeSignalHandlers(): void {
    for (const { event, handler } of this.signalHandlers) {
      process.removeListener(event as NodeJS.Signals, handler);
    }
    this.signalHandlers = [];
  }

  private handleCapturedEvent(payload: unknown): void {
    // VALIDATION at the trust boundary. The injected page can be a malicious site;
    // the binding handler must accept only known shapes, bounded sizes, AND required fields.
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    const type = p["type"];
    if (typeof type !== "string" || !ALLOWED_TYPES.has(type as CapturedAction["type"])) return;

    const value = typeof p["value"] === "string" ? String(p["value"]).slice(0, MAX_VALUE_LENGTH) : undefined;
    const selector = typeof p["selector"] === "string" ? String(p["selector"]).slice(0, MAX_VALUE_LENGTH) : undefined;
    const url = typeof p["url"] === "string" ? String(p["url"]).slice(0, MAX_VALUE_LENGTH) : undefined;
    const key = typeof p["key"] === "string" ? String(p["key"]).slice(0, 32) : undefined;
    const isPasswordField = p["isPasswordField"] === true;

    // PER-TYPE REQUIRED-FIELD VALIDATION. Reject malformed payloads at the trust boundary
    // so a malicious page can't smuggle e.g. {type: "click"} (no selector) and end up with
    // `click: undefined` in the rendered YAML.
    const t = type as CapturedAction["type"];
    if ((t === "navigate" || t === "openPage") && !url) return;
    if ((t === "click" || t === "submit") && !selector) return;
    if (t === "type" && (!selector || value === undefined)) return;
    if (t === "select" && (!selector || value === undefined)) return;
    if (t === "press" && !key) return;

    const action: CapturedAction = {
      type: t,
      selector,
      value,
      url,
      key,
      isPasswordField,
      timestamp: Date.now(),
    };

    // Password redaction (default-on; opt-in via --include-sensitive)
    if (action.type === "type" && action.isPasswordField && !this.opts.includeSensitive) {
      action.value = "<REDACTED:password>";
    }

    this.appendAction(action);
  }

  private normalizeAndDedup(action: CapturedAction): CapturedAction | null {
    // Body lives in Phase 2.3 below — same signature, same return contract:
    //   - return the action unchanged to append
    //   - return null to drop (dedup)
    //   - mutate this.actions for type-collation (replace last action)
    // The handleCapturedEvent path in 1.3 calls appendAction(action), which calls this method
    // exactly once per validated action. There is NO duplicate normalization.
    return action;
  }

  private renderLiveCounter(): void {
    if (!process.stdout.isTTY) return;
    process.stdout.write(`\r\x1b[KRecording... ${this.actions.length} step(s) captured. Press Ctrl+C to stop.`);
  }

  private relativizeUrl(absUrl: string): string {
    try {
      const u = new URL(absUrl);
      const base = new URL(this.opts.baseUrl);
      if (u.origin !== base.origin) return absUrl;
      return u.pathname + u.search + u.hash;
    } catch {
      return absUrl;
    }
  }
}
```

**Critical fixes from review:**
- **No more `onAction` callback** that recursed back into `appendAction` — `appendAction` directly mutates `this.actions`, no closure-passing required.
- **Binding payload validation** at the trust boundary: type must be in the allowed set; string fields are length-capped at 4 KB; total action count is capped at 5000. Prevents a malicious page from exhausting recorder memory.
- **Password-field redaction** by default; the recorder script (Phase 2.1) sets `isPasswordField: true` for `<input type="password">` and the Node-side handler replaces the value with `"<REDACTED:password>"` unless `--include-sensitive` was passed.
- **`closePage` action removed** from the schema — it had no skeptic YAML mapping anyway. Multi-page scenarios still surface `openPage` markers; closures are silent.
- **Browser-disconnect handling** via `context.on("close")` resolves the completion promise — covers the case where the user kills the browser process directly rather than Ctrl+C.
- **Idempotent `stop()`** with try/catch so SIGINT racing with browser close doesn't double-close.

**Lifecycle decisions:**
- **Session ends on:** all pages closed, SIGINT, SIGTERM. Process exit triggers a short flush window (<500ms) for the YAML write.
- **Headed only.** Headless mode for a recorder makes no sense; document that `--headed` is implicit and ignored if passed.
- **Single context.** Multi-context (incognito + regular side-by-side) is power-user territory; defer.
- **No live preview.** The terminal where `skeptic record` runs prints a single line at the bottom: "Recording (N steps captured)... press Ctrl+C to stop." Update on every captured action via ANSI carriage return. Implementation: `process.stdout.write("\r" + line)` at the end of `appendAction`. Skip if `!process.stdout.isTTY`.

### 1.4 Tests: `cli/__tests__/unit/commands/record-cli-surface.test.ts`

Help-text assertion (idiom: `add-cli-surface.test.ts` from `provider-aware-ci-scaffold.md` 3.5):

```ts
it("advertises record command with all flags", () => {
  const help = execFileSync("node", [skepticBin, "record", "--help"], { encoding: "utf-8" });
  expect(help).toContain("[output]");
  expect(help).toContain("--url");
  expect(help).toContain("--device");
  expect(help).toContain("--cookies");
});
```

**File:** `cli/__tests__/unit/commands/record.test.ts`

- Output filename collision → `process.exitCode = 1`, no browser launch.
- Default output filename uses an ISO timestamp (`recorded-2026-04-25T12-34-56-789Z.yaml`) — matches the `runRecord` sketch's `new Date().toISOString().replace(/[:.]/g, "-")` formula.
- `--no-tags` clears the default `recorded` tag in emitted YAML (mock `RecorderSession`, assert `renderYaml` call args).
- Cookies path threading: `--cookies --cookies-from chrome` → cookies extracted and passed to session.

---

## Phase 2 — Capture: injection script, action collation, debouncing

### 2.1 The injected recorder script

**File:** `cli/src/commands/recorder-script.ts` (new — TypeScript, compiled to a string at build time OR shipped as a static .js)

This script runs in the **page context**, not Node. It hooks `click`, `input`, `change`, `keydown`, `submit`, and form-related events; converts each to a `CapturedAction`-shaped payload; and calls `window.__skeptic_recordAction(payload)`.

**Implementation strategy:** write it as a self-contained TS file using only browser DOM APIs (no Node imports). At build time, transpile it with `esbuild --bundle --platform=browser --target=es2020 --format=iife` into a single JS string. Include this string at runtime via `context.addInitScript({ content: BUNDLED_SCRIPT })`.

The bundle step adds an `npm run build:recorder-script` task before `npm run build` (or wired into `tsc -b` via a pre-build hook). Output target: `cli/dist/recorder-script.js` (committed-or-not? **don't commit** — generate during build, gitignore the output). Wire up in `cli/package.json` build script.

**Alternative:** write the script as plain `.js` in `cli/src/commands/recorder-script.js` (no bundling needed since it has no imports). Read at runtime via `fs.readFileSync(__dirname + '/recorder-script.js', 'utf-8')` and pass to `addInitScript({ content: ... })`. Simpler. **Pick this path** — saves a build-system change.

```js
// cli/src/commands/recorder-script.js (handwritten plain JS)
(() => {
  if (window.__skeptic_recorder_installed) return;
  window.__skeptic_recorder_installed = true;

  // Pending type buffer — coalesces input events into one `type` action per field.
  // Flushed on: blur, before Enter/Tab/Escape, before submit, before navigation (beforeunload).
  let pendingType = null;  // { selector, value, isPasswordField } | null

  function emit(action) {
    if (typeof window.__skeptic_recordAction !== "function") return;
    try {
      window.__skeptic_recordAction(action);
    } catch (e) {
      // Page CSP or other rejection — fail silently rather than throw into page JS.
    }
  }

  function flushPendingType() {
    if (pendingType !== null) {
      emit({ type: "type", ...pendingType });
      pendingType = null;
    }
  }

  function selectorFor(el) {
    // Selector synthesis priority — emits a STRING that skeptic's element-resolver chain can resolve.
    // skeptic priority (element-resolver.ts:42-62): role-button → role-link → role-heading →
    // text exact → label → placeholder → testid → text partial → CSS fallback. Synthesize the
    // most specific UNIQUE form first; verify uniqueness via document.querySelectorAll.count.

    if (!el || el.nodeType !== 1) return null;

    const testid = el.getAttribute("data-testid");
    if (testid && unique(`[data-testid="${cssEscape(testid)}"]`)) {
      return `testid=${testid}`;
    }

    if (el.id && unique(`[id="${cssEscape(el.id)}"]`)) {
      // Use bare CSS form so skeptic's last-resort CSS-locator fallback resolves it.
      // CSS.escape protects against ids with special chars (`my:id`, `my.id`, etc.).
      return `css=[id="${cssEscape(el.id)}"]`;
    }

    // ARIA role + accessible name → role=role:name. skeptic's resolver expects exactly this format.
    // BUT names containing colons collide with the format separator — use the explicit role API:
    // emit JSON-encoded shape that the resolver won't ambiguously parse.
    const role = el.getAttribute("role") || implicitRole(el);
    const name = accessibleName(el);
    if (role && name) {
      // Verify uniqueness by querying the same role+name via accessibility heuristics.
      // For simplicity, fall back to text-bearing tags first; if not unique, add CSS pin.
      if (!name.includes(":") && uniqueByRoleName(role, name)) {
        return `role=${role}:${name}`;
      }
      // Name has colons OR not unique — escape via raw CSS path with attribute selector.
    }

    // Plain visible text for buttons/links (resolved via getByRole({ name }) at element-resolver.ts:45-47).
    if (name && (el.tagName === "BUTTON" || el.tagName === "A") && !name.includes(":") &&
        uniqueByRoleName(implicitRole(el), name)) {
      return name;
    }

    // Inputs: label or placeholder.
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const labelText = labelTextFor(el);
      if (labelText && !labelText.includes(":") && uniqueByLabel(labelText)) return labelText;
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && !placeholder.includes(":") && uniqueByPlaceholder(placeholder)) return placeholder;
    }

    // Last resort: structural CSS path. Wrap in `css=` so skeptic doesn't accidentally try
    // text/label/placeholder fallbacks first against the path string.
    return `css=${cssPath(el)}`;
  }

  // CSS.escape is a browser global (since Chrome 46). Always available in our target.
  function cssEscape(s) {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(s)
      : s.replace(/[^a-zA-Z0-9_-]/g, ch => "\\" + ch.codePointAt(0).toString(16) + " ");
  }

  function unique(cssSelector) {
    try {
      return document.querySelectorAll(cssSelector).length === 1;
    } catch {
      return false;
    }
  }

  // uniqueByRoleName / uniqueByLabel / uniqueByPlaceholder — small heuristics that scan the
  // accessibility tree (or query selectors as a proxy) and verify exactly one match.
  // For v1, approximate via DOM queries; refine if needed.

  // Helpers: implicitRole, accessibleName, labelTextFor, cssPath — small DOM utilities (~80 LOC total).

  document.addEventListener("click", (ev) => {
    flushPendingType();   // flush any pending input value before recording the click
    const sel = selectorFor(ev.target);
    if (!sel) return;
    emit({ type: "click", selector: sel, timestamp: Date.now() });
  }, true);

  // Input collation — collect into pendingType buffer; don't emit yet.
  // Replaces per-keystroke recording: one `type` action per field, regardless of how many keys pressed.
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") return;
    const sel = selectorFor(t);
    if (!sel) return;
    pendingType = {
      selector: sel,
      value: t.value,
      isPasswordField: t.type === "password",
    };
  }, true);

  // Flush on blur (user tabbed/clicked away from the field).
  document.addEventListener("blur", (ev) => {
    const t = ev.target;
    if (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") return;
    flushPendingType();
  }, true);

  // Select dropdowns — emit immediately on change.
  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.tagName !== "SELECT") return;
    const sel = selectorFor(t);
    if (!sel) return;
    emit({ type: "select", selector: sel, value: t.value, timestamp: Date.now() });
  }, true);

  // Form submit — flush pending input first, then mark a submit (translated to press Enter on submit button in Node-side renderer).
  document.addEventListener("submit", (ev) => {
    flushPendingType();
    const sel = selectorFor(ev.target);
    if (!sel) return;
    emit({ type: "submit", selector: sel, timestamp: Date.now() });
  }, true);

  // Keys we care about: Enter, Escape, Tab. Flush pending types first so the typed value is captured before the key.
  document.addEventListener("keydown", (ev) => {
    if (!["Enter", "Escape", "Tab"].includes(ev.key)) return;
    flushPendingType();
    emit({ type: "press", key: ev.key, timestamp: Date.now() });
  }, true);

  // Navigation (link click, JS push, form submit causing nav) — flush pending types so they
  // don't get lost when the page unloads.
  window.addEventListener("beforeunload", () => {
    flushPendingType();
  });

  // Scroll: DROPPED in v1. skeptic's `scroll` step accepts only "up"/"down"/"top"/"bottom" or a
  // selector; an absolute-pixel-position step doesn't exist. Capturing scroll positions and
  // round-tripping them through YAML is a v2 enhancement (would need a new `scrollTo: 500` schema).
  // For v1, recorded flows don't include scroll steps. Users add `scroll: down` manually if needed.
})();
```

**Critical changes from review:**

- **`flushPendingType` pattern** replaces the blur-only capture. `input` events accumulate into `pendingType`; explicit flushes happen on blur, click (capture phase, BEFORE the click is emitted), keydown (Enter/Tab/Escape), submit, and beforeunload. Result: typing "hello" then pressing Enter produces `[type "hello", press Enter]`, never the reverse.
- **Scroll DROPPED in v1.** Earlier draft emitted `scroll: String(window.scrollY)` which skeptic's scroll handler interprets as a SELECTOR, not a position. Recorded flows would fail at replay. Document the gap; users add scroll steps by hand. v2 can introduce a new `scrollTo: 500` schema.
- **Selector synthesis adds uniqueness checks** via `unique`, `uniqueByRoleName`, `uniqueByLabel`, `uniqueByPlaceholder`. Without these, two buttons named "Save" both get the same `role=button:Save` selector and `resolveElement(...).first()` lands on the wrong one at replay. The check falls through to the next priority tier when the current one isn't unique.
- **`#${id}` is wrapped in `css=[id="..."]` with `CSS.escape`.** Bare `#myid` works only when `myid` has no special chars; `#my:id` is a syntax error. Wrapping in `[id="..."]` plus `CSS.escape` handles every legal ID byte.
- **Structural CSS paths get an explicit `css=` prefix.** Without it, skeptic's resolver tries `getByText("body > div > button:nth-child(3)")` first — never matches, falls through to CSS, eventually resolves but slower and noisier in logs. Explicit `css=` short-circuits the chain.
- **Names with `:` are rejected from `role=role:name` form.** skeptic's resolver splits on the first colon (`element-resolver.ts:31-33`). A name like `"Edit: Profile"` would become `role=button` + name=`"Edit: Profile"` after parsing, which is wrong. Fall through to CSS path when the synthesized form would mis-parse.
- **`isPasswordField`** is set whenever the input element's `type === "password"`. The Node-side handler in 1.3 redacts the value before storing.

**No xpath.** skeptic's element-resolver doesn't try xpath; emitting xpath would never resolve.

**Pitfall — accessible name computation.** The full ARIA accessible-name algorithm is ~50 lines. For v1, simplified version: `aria-label` → `el.labels?.[0]?.textContent` → `el.textContent.trim()`. Document the limitation.

### 2.2 Static-file resolution

**File:** `cli/src/commands/record-session.ts`

```ts
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

const RECORDER_SCRIPT_PATH = (() => {
  // Compute path relative to the compiled .js, which sits next to the source after build.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // dist/commands/record-session.js — the .js sibling of record-session.js is recorder-script.js
  const candidate = path.join(dir, "recorder-script.js");
  if (fs.existsSync(candidate)) return candidate;
  // Fallback for source/dev mode (tsc may not copy non-.ts files)
  return path.resolve(dir, "../../src/commands/recorder-script.js");
})();
```

**Build copy step.** TypeScript's `tsc` doesn't copy non-.ts files. The current build script at `cli/package.json:10` is `tsc && cp -r templates dist/` — that template-copy MUST be preserved. Append the recorder copy:

```json
"scripts": {
  "build": "tsc && cp -r templates dist/ && cp src/commands/recorder-script.js dist/commands/recorder-script.js",
  ...
}
```

The `cp` chain is portable on macOS and Linux; if Windows support becomes a concern, swap the second `cp` for a `node` helper. For now match the existing style.

### 2.3 Node-side handler — collation, dedup, normalization

**File:** `cli/src/commands/record-session.ts` — body of `normalizeAndDedup`. The handler chain is:

```
binding payload (untrusted) → handleCapturedEvent() validates+constructs CapturedAction → appendAction(action) → normalizeAndDedup(action) → push to this.actions
```

`handleCapturedEvent` (defined inline in 1.3) is the SOLE validation/construction site — it doesn't call `normalizeAndDedup` directly; `appendAction` does. There is no double-normalization path.

```ts
// Method body (sketched in 1.3 as a stub; the full implementation):
private normalizeAndDedup(action: CapturedAction): CapturedAction | null {
  // De-dup: same type + same selector + same value within 200ms → drop the duplicate.
  const last = this.actions[this.actions.length - 1];
  if (
    last &&
    last.type === action.type &&
    last.selector === action.selector &&
    last.value === action.value &&
    action.timestamp - last.timestamp < 200
  ) {
    return null;
  }

  // Type-collation: if this is a `type` action and the last one was also a `type` to the same selector,
  // replace the last one (user kept editing the same field). We don't want N "type" steps for one field.
  if (action.type === "type" && last?.type === "type" && last.selector === action.selector) {
    this.actions.pop();
  }

  return action;
}
```

The push-then-pop pattern keeps `this.actions` always-coherent for the live counter display.

### 2.4 Tests

**File:** `cli/__tests__/unit/commands/record-collation.test.ts`

Purely Node-side. Construct a `RecorderSession` with a no-op browser (mock the `start()` method to set `this.page` to a stub), then drive `handleCapturedEvent` directly with raw payload objects:

- Two clicks 50ms apart on the same selector → 1 action.
- Two clicks 300ms apart → 2 actions.
- Type "a", type "ab", type "abc" same selector → 1 action with value `"abc"`.
- Type "abc" then click → 2 actions in order.
- Press Enter → captured as `press`, key=Enter.
- Unknown type → ignored at the binding-payload allowlist (e.g., `{type: "scroll"}` doesn't appear in actions).
- Type with `isPasswordField: true` and `includeSensitive: false` → value rewritten to `"<REDACTED:password>"`.
- Type with `isPasswordField: true` and `includeSensitive: true` → value preserved.
- Action cap (`MAX_ACTIONS = 5000`): drive 5001 valid actions; assert `this.actions.length === 5000`, the warning logged exactly once, and NO fake "navigate to <truncated>" step appears.
- Oversized value: `{type: "type", selector: "x", value: "a".repeat(20000)}` → stored value is exactly `MAX_VALUE_LENGTH` (4096) chars.
- Multi-page lifecycle: simulate two `context.on("page")` events, then close the FIRST page; assert `resolveCompletion` is NOT called (popup still open). Close the popup; NOW `resolveCompletion` is called.
- Browser disconnect: emit `browser.on("disconnected")` event; assert `resolveCompletion` is called immediately.

**File:** `cli/__tests__/integration/commands/record-script.test.ts` (new, requires Playwright)

Use Playwright directly (no skeptic CLI shell-out) to:
1. Launch a context, inject `recorder-script.js`, expose the `__skeptic_recordAction` binding.
2. `setContent` a simple HTML page with a button, input, link.
3. Programmatically click the button, type into the input, click the link.
4. Assert the recorded actions match expectations.

This test is integration because it needs a real browser. Skip-mark it if `process.env.PLAYWRIGHT_BROWSERS_PATH` setup is required and not present.

---

## Phase 3 — Recording lifecycle & polish

### 3.1 Live counter

In `RecorderSession.appendAction`, after the dedup logic:

```ts
private renderLiveCounter(): void {
  if (!process.stdout.isTTY) return;
  const line = `Recording... ${this.actions.length} step(s) captured. Press Ctrl+C to stop.`;
  process.stdout.write("\r\x1b[K" + line);
}
```

`\r\x1b[K` returns to column 0 and clears the line. Final `"\n"` is written before the YAML-saved confirmation in `runRecord`.

### 3.2 Pause / resume

**Defer.** Adding pause/resume requires keystroke handling on the Node side (e.g., the user presses `p` in the terminal). Not worth v1 complexity.

### 3.3 Error handling: page crashes

`page.on("crash", handler)` and `page.on("pageerror", handler)` — log to stderr but don't terminate. The user can choose to keep going (the action stream is already captured) or Ctrl+C. Implementation: `logger.warn` on either event.

Browser-level crashes (`browser.on("disconnected")`) **do** terminate — mark completion as resolved, write whatever YAML we have. The user sees a non-empty file even if their browser died unexpectedly.

### 3.4 Tests

**File:** `cli/__tests__/unit/commands/record-lifecycle.test.ts`

- SIGINT during recording → `waitForCompletion()` resolves; `stop()` is called.
- Browser disconnected → completion resolves; partial actions are still written.
- All pages closed → completion resolves.

---

## Phase 4 — YAML emission

### 4.1 The renderer

**File:** `cli/src/commands/record-yaml-renderer.ts` (new)

```ts
import { Document, parseDocument, stringify, YAMLSeq } from "yaml";

export interface RenderInput {
  name: string;
  url: string;
  tags: string[];
  auth?: "cookies" | "none";          // included when --cookies was used during recording
  actions: CapturedAction[];
}

interface RenderedItem {
  step: Step;
  commentBefore?: string;             // YAML comment to attach to the next step
}

export function renderYaml(input: RenderInput): string {
  const metadata: Record<string, unknown> = {
    url: input.url,
    name: input.name,
    description: `Recorded on ${new Date().toISOString().slice(0, 10)}`,
  };
  if (input.tags.length > 0) metadata["tags"] = input.tags;
  if (input.auth) metadata["auth"] = input.auth;

  // Walk the action list, producing { step, commentBefore? } items. openPage actions emit a
  // commentBefore on the NEXT step instead of becoming a step themselves.
  const items: RenderedItem[] = [];
  let pendingComment: string | null = null;
  for (const action of input.actions) {
    if (action.type === "openPage") {
      pendingComment = `Recorder note: a popup opened (${action.url ?? "unknown"}). skeptic runs the main page only.`;
      continue;
    }
    const step = actionToStep(action);
    if (step === null) continue;
    items.push({
      step,
      ...(pendingComment !== null ? { commentBefore: pendingComment } : {}),
    });
    pendingComment = null;
  }

  // Build the steps YAML with comments using `yaml`'s Document API.
  // `Document.createNode()` is the correct method for constructing nodes with attached comments
  // (NOT YAMLSeq.createNode, which doesn't exist in yaml@^2.7.1). The pattern is:
  //   1. Create a Document containing an empty YAMLSeq.
  //   2. For each item, call `stepsDoc.createNode(item.step)` to get a Node with the right type.
  //   3. Attach `commentBefore` to the node, then push it onto the seq.
  const stepsDoc = new Document(new YAMLSeq());
  const seq = stepsDoc.contents as YAMLSeq;
  for (const item of items) {
    const node = stepsDoc.createNode(item.step);
    if (item.commentBefore !== undefined) {
      // yaml's commentBefore is a string; lines starting with `#` are emitted verbatim.
      // Prefix with a space so the rendered output looks like "# Recorder note: ..." not "#Recorder...".
      node.commentBefore = ` ${item.commentBefore}`;
    }
    seq.add(node);
  }

  const metaYaml = stringify(metadata);
  const stepsYaml = String(stepsDoc);

  return `${metaYaml}---\n${stepsYaml}`;
}

function actionToStep(action: CapturedAction): Step | null {
  switch (action.type) {
    case "navigate":
      // navigate requires a URL; reject if missing (defense-in-depth — handleCapturedEvent
      // should already require url, but actionToStep guards against schema drift).
      if (!action.url) return null;
      return { navigate: action.url };

    case "click":
      if (!action.selector) return null;
      return { click: action.selector };

    case "type":
      if (!action.selector || action.value === undefined) return null;
      // Use the OBJECT form `type: { selector, text }` — handler already supports it
      // (cli/src/executor/step-handlers/type.ts:12-22). Phase 4.5 below widens the SCHEMA
      // to match the handler. No more synthetic-click workaround needed.
      return { type: { selector: action.selector, text: action.value } };

    case "press":
      if (!action.key) return null;
      return { press: action.key };

    case "select":
      if (!action.selector || action.value === undefined) return null;
      return { select: { selector: action.selector, value: action.value } };

    case "submit":
      // Implicit: the surrounding click+press Enter sequence covers form submission
      // semantically. submit actions are dropped from emitted YAML.
      return null;

    case "openPage":
      // Handled at the renderer's outer loop as a comment-before-next-step. Not a real step.
      return null;
  }
}
```

Note: `scroll` is intentionally absent from the switch since it's also absent from the `CapturedAction` union (Phase 1.3). TypeScript's exhaustiveness checking will flag this if anyone re-adds scroll without updating the switch.

**Type via object form, not synthetic clicks.** skeptic's `type` handler at `cli/src/executor/step-handlers/type.ts:12-22` already accepts `{ selector, text, clear? }` — but the schema at `cli/src/parser/flow-schema.ts:190` declares `type: z.string()`, rejecting the object form at parse time. The schema/handler mismatch is a pre-existing bug that this plan **fixes** (similar to the `waitForElement` mismatch fixed by plan #37).

**Schema widening — Phase 4.5 (new):**

```ts
// cli/src/parser/flow-schema.ts (lines 76, 190 areas)
type?: string | { selector: string; text: string; clear?: boolean };

// in StepSchema:
type: z.union([
  z.string(),
  z.object({ selector: z.string(), text: z.string(), clear: z.boolean().optional() }),
]).optional(),
```

This is a NON-BREAKING change — string-form `type: "hello"` continues to work for all existing flows. Object-form is now the recorder's emit path and the documented way to type into an explicit selector.

**Why this beats the synthetic-click approach.** Synthetic clicks have side effects: clicking a `<button>` submits a form; clicking a custom-component input may trigger focus/blur ripples that desync the recorder's pending-type buffer. The object-form `type` step skips clicking entirely — Playwright's `Locator.fill` resolves the selector and fills, no focus event leak.

**Submit handling.** When the user submits a form via Enter, the recorder script emits `[input, press Enter]`; the input event flushes `pendingType` first (Phase 2.1's flush-before-press), so the renderer sees `[type, press Enter]`. The `submit` action emitted by the form's submit listener is currently dropped at render time — it's redundant with the `press: Enter` step. Tested in Phase 4.4.

### 4.2 URL handling

`navigate` actions emit relative URLs when the destination origin matches `baseUrl` (already done in `relativizeUrl`). The initial navigation is the recorded `navigate: <pathname+search+hash>` derived from baseUrl in 1.3 — not a hardcoded `/`.

**Discard noise.** Empty or duplicate navigations (same URL as the previous navigation) are dropped during the `items` walk in `renderYaml`, BEFORE the YAMLSeq is built:

```ts
// inside renderYaml, immediately before the seq.add() loop:
const deduped: RenderedItem[] = [];
for (const item of items) {
  const prev = deduped[deduped.length - 1];
  // Drop a navigate-step that targets the same URL as the previous step.
  if (
    item.step["navigate"] !== undefined &&
    prev?.step["navigate"] === item.step["navigate"]
  ) {
    continue;
  }
  deduped.push(item);
}
// Then iterate `deduped` (not `items`) when building the seq.
```

The dedup runs after the openPage→commentBefore translation, so a popup opening to the same URL as a prior page navigation still drops the duplicate but the comment is preserved (attached to the next surviving step).

### 4.3 Multi-page handling

`openPage` is skipped from emitted YAML in v1 — skeptic has no `openPage:` step type. Instead, when an `openPage` is captured, emit a comment-line marker so the user can see where popups occurred. `closePage` is dropped at the recorder level (Phase 1.3 doesn't include it in `CapturedAction`):

```yaml
# Recorder note: a popup opened here. skeptic runs the main page only.
- click: "#open-modal"
```

Implementation: `actionToStep` returns the `Step` plus an optional leading-comment string. `renderYaml` walks the array and emits comment-then-step. The `yaml` package supports comments via `Document.commentBefore`.

### 4.4 Tests

**File:** `cli/__tests__/unit/commands/record-yaml-renderer.test.ts`

- Click + type + press Enter → expected YAML with metadata + 3 steps using `type: { selector, text }` object form.
- Two same-URL navigations → second dropped.
- `tags: []` → no `tags:` field in metadata.
- `auth: cookies` written when `--cookies` was used during recording.
- `submit` action → dropped at render time (redundant with surrounding press Enter).
- `openPage` → comment marker preserved.
- `scroll` action → not emitted by the recorder script in v1; assert `actionToStep` returns null and no scroll step appears in the output (regression bar against re-introducing the broken scroll capture).
- Selector with quotes (e.g., `text="Sign In"`) → properly YAML-escaped.
- Password redaction: a `type` action with value `"<REDACTED:password>"` renders verbatim — the user must replace the placeholder before replay. Asserts the redaction marker is preserved (not stripped or substituted) so users can find/replace it.
- Round-trip: render → parse via skeptic's `parseFlowString` → resulting flow validates against `FlowSchema`. Critical regression: object-form `type` must validate against the widened schema from 4.5.

The round-trip test is critical — the whole point is that recorded YAML is runnable. Idiom: `cli/__tests__/unit/parser/flow-parser.test.ts`.

### 4.5 Schema test for widened `type` step

**File:** `cli/__tests__/unit/parser/type-step-schema.test.ts` (new) or extend an existing schema test.

- `type: "hello"` parses (string shorthand — backwards compat).
- `type: { selector: "#email", text: "alice@example.com" }` parses (new object form).
- `type: { selector: "#email", text: "x", clear: false }` parses (optional clear).
- `type: { selector: "#email" }` (missing text) rejected with clear error.
- `type: 5` rejected.

Locks in the schema/handler convergence so the recorder's emitted YAML stays parsable.

---

## Phase 5 — Future integration with #31 / #37 (DEFERRED)

Once #31 (ARIA snapshot-ref) and #37 (composable selectors) ship, the recorder can use them as output formats. Sketch only — not part of v1:

- Add `--refs` flag to `skeptic record`. When set, the recorder injects an `ariaSnapshot: true` after every `navigate` and post-DOM-mutation. Selector synthesis becomes "find this element in the snapshot, emit `@eN`."
- Add `--relational` flag (or auto-trigger when synthesized text-only selectors are non-unique). The recorder gathers candidates around the target element and emits e.g. `click: { text: "Save", below: "Email" }` instead of the bare text.

These are large enough to be their own follow-up plans.

---

## Critical Files to Modify

| File | Phase | Change |
|------|-------|--------|
| `cli/src/index.ts` | 1.1 | Register `record` command (with `--include-sensitive` flag) |
| `cli/src/commands/record.ts` | 1.2 | New file — command entry, lifecycle orchestration |
| `cli/src/commands/record-session.ts` | 1.3, 2.2, 2.3, 3.1, 3.3 | New file — `RecorderSession` class with binding-payload validation, password redaction, cookie injection, signal cleanup |
| `cli/src/commands/recorder-script.js` | 2.1 | New plain JS file — injected into pages; flush-pending-type, uniqueness checks, CSS escape, scroll dropped, password flagging |
| `cli/package.json` | 2.2 | Append recorder script copy to existing `build` script |
| `cli/src/parser/flow-schema.ts` | 4.5 | Widen `type` step to `string | { selector, text, clear? }` (handler already supports object form; this fixes the schema/handler mismatch) |
| `cli/src/commands/record-yaml-renderer.ts` | 4.1, 4.2, 4.3 | New file — YAML emitter; origin-only metadata.url + path-derived first navigate, `auth: cookies` metadata, openPage→commentBefore, drops `submit` actions, dedups consecutive same-URL navigates |

Plus 5 new test files (1.4 ×2, 2.4 ×2, 3.4, 4.4) and an integration test that requires Playwright.

No new runtime dependencies — `playwright`, `yaml`, `chalk`, `chokidar` (the latter unused here) are already deps.

---

## Reused Utilities

- `loadConfig` — `cli/src/config/loader.ts` (config + `--config` precedence)
- `extractCookies` pattern — `cli/src/cookies/` (existing — reused via `--cookies` flag)
- `chromium.launch` + `BrowserContext` lifecycle — Playwright stable API
- `addInitScript` — Playwright (injects script into every page in a context)
- `exposeBinding` — Playwright (exposes Node fn to page-context JS)
- `parseFlowString` (round-trip test) — `cli/src/parser/flow-parser.ts`
- `FlowSchema` — `cli/src/parser/flow-schema.ts` (round-trip validation)
- `stringify` — from `yaml` package (already imported in `flow-generator.ts:2`)
- `logger.{success,info,warn,error}` — `cli/src/utils/logger.ts`
- Element-resolver priority (`cli/src/executor/element-resolver.ts:8-67`) — **read but not imported.** The recorder script's selector synthesis MIRRORS this priority but runs in the page context where skeptic's TS is unreachable. The mirror must stay aligned manually; document the link with a comment in `recorder-script.js` pointing at `element-resolver.ts:42-66`.

---

## Verification

```bash
cd cli
npm run build                # tsc + recorder-script copy
npm run check
npm test
```

**Manual smoke test (the critical one — there's no good unit-test substitute for "did the recording work"):**

```bash
# 1. Start a local app
cd ~/some-app && npm run dev   # serves on :3000 in another terminal

# 2. Record a flow
cd ~/skeptic-test-project && skeptic record recorded.yaml --url http://localhost:3000

# 3. Use the app interactively: click around, fill a form, submit, navigate.
# 4. Press Ctrl+C in the skeptic terminal.

# 5. Inspect the YAML
cat recorded.yaml

# 6. Run the recorded flow back
skeptic test recorded.yaml

# Acceptance:
# - The flow runs cleanly (every selector resolves)
# - Steps appear in the order they were performed
# - No spurious steps (rapid clicks deduplicated, scroll noise suppressed)
# - Type steps capture the final value, not per-keystroke
# - The flow's `skeptic test` execution produces the same end-state the user reached during recording
```

If the round-trip fails (selectors don't resolve), the recorder synthesized something element-resolver doesn't understand. Common diagnosis: the synthesized `role=...` form has the wrong role, or the text-based selector hit ambiguity. Add fallback diagnostics to the recorder script: when emitting, also emit a "diagnostic" suffix with element bounds — discarded in YAML but logged to stderr, so we can debug without re-recording.

**Selector quality smoke test:** record on a few public sites (Wikipedia, GitHub, a Tailwind demo) — does the YAML use `testid=` / `role=` / text often, and CSS rarely? If most selectors fall through to CSS, the `selectorFor` priority needs tuning. Capture this as a pre-merge eyeball check, not an automated test.

**Size check:** the v1 recorder-script.js is ~200-300 lines of plain JS. If it's much larger, something has scope-crept. Re-read this plan.
