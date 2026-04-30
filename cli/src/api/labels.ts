/**
 * Single source of truth for cursor-tooltip narration labels.
 *
 * The tooltip displayed near the synthetic cursor in recorded videos shows what the test
 * is currently doing in friendly sentence form ("Running accessibility audit") instead of
 * the terse internal API name ("observability.expectAccessible").
 *
 * Why a static lookup table:
 *   - **PII safety boundary.** The tooltip ends up rendered into the page DOM and burned
 *     into the WebM. We must never interpolate user-supplied data (selectors, fill values,
 *     URLs, AI prompts) into the label. Centralising the mapping in this table means the
 *     PII-safety guard is enforced at one place — no call site can accidentally leak args
 *     into the label string.
 *   - **Translatability.** A future i18n pass only has to translate this table.
 *
 * The keys are the action names that fixture/runAction/playwright-engine pass through
 * `runAction(label, fn)` plus the synthetic `proxy.<method>` names emitted by the Page
 * Proxy in `page-proxy.ts`. Unknown actions fall through to the raw action name (still
 * not user-supplied, since the action name is itself a fixed identifier the caller chose).
 */

const LABELS: Record<string, string> = {
  // Fixture-level actions (label === the string passed to runAction).
  screenshot: "Capturing screenshot",
  "screenshot.annotated": "Taking annotated screenshot",
  snapshot: "Reading ARIA snapshot",
  settle: "Waiting for visual settle",
  "observability.expectPerformance": "Checking performance thresholds",
  "observability.expectNoNetworkErrors": "Analyzing network requests",
  "observability.expectNoConsoleErrors": "Reading console messages",
  "observability.expectAccessible": "Running accessibility audit",
  "observability.snapshot": "Snapshotting observability metrics",
  "ai.assert": "Running AI assertion",
  "ai.assertNoDefects": "Running AI defect scan",
  "ai.extract": "Extracting via AI",
  test: "Running test",

  // Page Proxy synthetic actions — kept distinct from fixture method names so a
  // proxy-emitted click never collides with a hypothetical fixture.click.
  "proxy.click": "Clicking",
  "proxy.dblclick": "Double-clicking",
  "proxy.hover": "Hovering",
  "proxy.fill": "Filling input",
  "proxy.type": "Typing",
  "proxy.press": "Pressing key",
  "proxy.selectOption": "Selecting option",
  "proxy.check": "Checking",
  "proxy.uncheck": "Unchecking",
  "proxy.tap": "Tapping",
  "proxy.setChecked": "Setting checkbox",
};

/**
 * Resolve a fixture/proxy action name to its sentence-form tooltip text.
 *
 * Falls through to the raw action name on miss (acceptable — the action name is a
 * fixed identifier chosen by the caller, never user-supplied data; see the PII rationale
 * in the file header).
 */
export const friendlyLabel = (action: string): string => {
  if (typeof action !== "string" || action.length === 0) return "";
  return LABELS[action] ?? action;
};

/** Subset of fixture/proxy actions that take long enough that the persistent tooltip
 *  should remain pinned until the action finishes (instead of auto-fading after 1.5 s).
 *  Currently advisory — the executor passes `persistent: true` per call site; this table
 *  is exported so tests can assert the long-op set is the same shape the engine uses. */
export const PERSISTENT_LABEL_ACTIONS: ReadonlySet<string> = new Set([
  "observability.expectAccessible",
  "observability.expectPerformance",
  "observability.expectNoNetworkErrors",
  "observability.expectNoConsoleErrors",
  "observability.snapshot",
  "ai.assert",
  "ai.assertNoDefects",
  "ai.extract",
  "screenshot.annotated",
  "snapshot",
  "settle",
  "test",
]);

/** Internal — exported only so the unit test can iterate every key without re-hardcoding. */
export const __TEST_LABELS = LABELS;
