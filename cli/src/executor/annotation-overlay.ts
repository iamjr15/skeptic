// Source: agent-browser/cli/src/native/screenshot.rs:38-52,426,512 © Vercel Inc., Apache 2.0
// (Annotation-record shape ported from Rust to TypeScript; numbered-badge DOM-injection
//  pattern adapted from the Rust expression at screenshot.rs:420-465. Shadow-DOM-isolated
//  host follows skeptic's `cursor-overlay.ts` shell so badge styles never bleed into the
//  page's CSS. fullPage scrollY projection mirrors get_scroll_offsets at screenshot.rs:493.)
//
// PII invariant: badge labels carry only the integer (`[1]`, `[2]`, …) and the entry's
// numeric `boundingBox`. The structured `annotation-map` diagnostic that flows back to
// `results.json` deliberately omits the accessible `name` field — accessible names can
// contain user data (account names, emails, document titles). The annotated PNG itself
// shows the page (which is the user's opt-in choice via `annotate: true`); we do not
// add a second copy of the textual content into JSON.
//
// All DOM access is funneled through string-based `page.evaluate(<source>)` rather than
// typed `evaluate(fn)` so we don't have to widen tsconfig's `lib` to include `dom`.
// Same pattern as `aria-snapshot-capture.ts:222`.

import type { Page } from "playwright";

const HOST_ID = "__skeptic-annotation-host";

export interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Item passed into the overlay injector. `label` is the visible badge number,
 *  `boundingBox` is page-coordinate-projected (caller adds `scrollY` for fullPage). */
export interface AnnotationOverlayItem {
  label: number;
  boundingBox: AnnotationBox;
}

interface SerializedItem {
  label: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Inject a Shadow-DOM-isolated host element with one numbered badge per item.
 * Re-injection is idempotent: any pre-existing host with the same id is removed first.
 *
 * Style isolation: the host attaches a closed shadow root and applies `all: initial`
 * so the page's CSS cannot leak in. Badges are absolutely positioned at each box's
 * top-left in document (not viewport) coordinates, so callers must add `scrollY` when
 * preparing items for a `fullPage` capture.
 */
export const injectAnnotationOverlay = async (
  page: Page,
  items: AnnotationOverlayItem[],
): Promise<void> => {
  if (items.length === 0) return;
  const payload: SerializedItem[] = items.map((it) => ({
    label: it.label,
    x: it.boundingBox.x,
    y: it.boundingBox.y,
    width: it.boundingBox.width,
    height: it.boundingBox.height,
  }));

  // String-evaluate so DOM globals (`document`, `window`) don't need to be in tsconfig's lib.
  // Inputs are JSON-encoded numbers/strings — no user data is ever interpolated into the source.
  const expr = `((items, hostId) => {
    var existing = document.getElementById(hostId);
    if (existing) existing.remove();
    var host = document.createElement('div');
    host.id = hostId;
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    var root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = ':host{all:initial;}' +
      '.bx{position:absolute;border:2px solid rgba(220,38,38,0.85);box-sizing:border-box;pointer-events:none;}' +
      '.lbl{position:absolute;left:-2px;background:rgba(220,38,38,0.95);color:#fff;' +
      'font:600 11px/14px ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'padding:0 4px;border-radius:2px;white-space:nowrap;pointer-events:none;}';
    root.appendChild(style);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var box = document.createElement('div');
      box.className = 'bx';
      box.style.left = it.x + 'px';
      box.style.top = it.y + 'px';
      box.style.width = it.width + 'px';
      box.style.height = it.height + 'px';
      var lbl = document.createElement('div');
      lbl.className = 'lbl';
      // Mirror agent-browser's "stay-inside-viewport" heuristic: top-of-bbox <14px
      // means the label would clip above the page; nudge it down inside the box.
      lbl.style.top = (it.y < 14) ? '2px' : '-14px';
      lbl.textContent = '[' + it.label + ']';
      box.appendChild(lbl);
      root.appendChild(box);
    }
    var target = document.documentElement || document.body;
    target.appendChild(host);
    return true;
  })(${JSON.stringify(payload)}, ${JSON.stringify(HOST_ID)})`;

  await page.evaluate(expr);
};

/**
 * Remove the annotation host. Best-effort — never throws so it can run inside a
 * `finally` block even when the page has been closed or navigated mid-capture.
 */
export const removeAnnotationOverlay = async (page: Page): Promise<void> => {
  try {
    const expr = `((hostId) => {
      var el = document.getElementById(hostId);
      if (el) el.remove();
      return true;
    })(${JSON.stringify(HOST_ID)})`;
    await page.evaluate(expr);
  } catch {
    // page may be closed / navigated — overlay would be gone anyway.
  }
};

/** Test seam: surface the host id so tests can assert injection without scraping CSS. */
export const ANNOTATION_OVERLAY_HOST_ID = HOST_ID;
