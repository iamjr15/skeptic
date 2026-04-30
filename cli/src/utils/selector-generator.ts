// Source: agent-browser/cli/src/native/snapshot.rs:609-720 © Vercel Inc., Apache 2.0
// (Selector-generation strategy informed by agent-browser's element-tagging approach.
//  The recorder-helper algorithm (testid → role/name → text → css path) is original.)

import type { ElementHandle, Page } from "playwright";

/**
 * Embedded recorder-helper IIFE — exposes `window.__skeptic_selector(el)` returning
 * a stable skeptic-grammar selector string. Priority order:
 *   1. `testid=<id>` if `data-testid` is present
 *   2. `role=<role>:<name>` if implicit/explicit role + accessible name are stable
 *   3. raw text content if short and unique
 *   4. `css=<path>` as the conservative fallback (id → unique class → tag chain)
 *
 * The function is idempotent and side-effect free — it does NOT mutate the DOM.
 *
 * IIFE wrapper preserved verbatim for parity with B0's recorder-script.js shape
 * (deleted in B1; if re-introduced, this string is what gets copied into dist/).
 */
export const SELECTOR_HELPER_SCRIPT = `(function () {
  if (typeof window === "undefined" || window.__skeptic_selector) return;

  function getRole(el) {
    var explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    return null;
  }

  function getAccessibleName(el) {
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    var labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      var ref = document.getElementById(labelledby);
      if (ref && ref.textContent) return ref.textContent.trim();
    }
    var alt = el.getAttribute && el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    var title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    var text = (el.textContent || "").trim();
    if (text.length > 0 && text.length < 80) return text;
    return null;
  }

  function escapeCssIdent(value) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    return value.replace(/([^a-zA-Z0-9_-])/g, "\\\\$1");
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return "#" + escapeCssIdent(el.id);

    var path = [];
    var current = el;
    var depth = 0;
    while (current && current.nodeType === 1 && depth < 8) {
      var segment = current.tagName.toLowerCase();
      var classList = current.classList ? Array.from(current.classList) : [];
      var stableClass = classList.find(function (c) {
        // Filter out auto-generated/utility classes (heuristic).
        return c.length > 0 && c.length < 40 && !/^[a-zA-Z]*-?\\d+$/.test(c);
      });
      if (stableClass) segment += "." + escapeCssIdent(stableClass);

      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) {
          return s.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          var index = siblings.indexOf(current) + 1;
          segment += ":nth-of-type(" + index + ")";
        }
      }

      path.unshift(segment);
      if (current.id) {
        path[0] = "#" + escapeCssIdent(current.id);
        break;
      }
      current = current.parentElement;
      depth++;
    }
    return path.join(" > ");
  }

  window.__skeptic_selector = function (el) {
    if (!el) return "";

    var testid = el.getAttribute && el.getAttribute("data-testid");
    if (testid) return "testid=" + testid;

    var role = getRole(el);
    var name = getAccessibleName(el);
    if (role && name && name.length < 60) return "role=" + role + ":" + name;
    if (role && role !== "generic") return "role=" + role;

    var text = (el.textContent || "").trim();
    if (text && text.length > 0 && text.length < 60) return text;

    var css = cssPath(el);
    if (css) return "css=" + css;
    return "css=" + el.tagName.toLowerCase();
  };
})();`;

let helperEnsuredPages = new WeakSet<Page>();

/**
 * Inject the selector helper into the live document (idempotent per-page).
 * Uses `addScriptTag({ content })` rather than `addInitScript` because the
 * latter only runs on FUTURE document creation — useless for an already-loaded
 * inspect target.
 */
export const ensureSelectorHelper = async (page: Page): Promise<void> => {
  if (helperEnsuredPages.has(page)) return;
  await page.addScriptTag({ content: SELECTOR_HELPER_SCRIPT });
  helperEnsuredPages.add(page);
};

/**
 * Run `window.__skeptic_selector` for the given handle, returning the stable
 * skeptic-grammar selector. Falls back to `""` on any error so the caller can
 * use a CSS attribute-selector fallback.
 *
 * Implementation note: we pass the function as a string (rather than a TS
 * arrow) so `window`/`Element` don't need to be in tsconfig's `lib`.
 */
export const generateSelectorForHandle = async (
  page: Page,
  handle: ElementHandle,
): Promise<string> => {
  await ensureSelectorHelper(page);
  try {
    // ElementHandle.evaluate accepts a function whose first arg is the resolved
    // node. Cast through `unknown` to avoid pulling DOM types into tsconfig's lib.
    const fn = ((el: unknown): string => {
      const w = (globalThis as unknown as {
        __skeptic_selector?: (el: unknown) => string;
      });
      return typeof w.__skeptic_selector === "function" ? w.__skeptic_selector(el) : "";
    }) as Parameters<ElementHandle["evaluate"]>[0];
    const value = (await handle.evaluate(fn)) as string;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
};

/** Reset the per-page memoization — used by tests. */
export const __resetSelectorHelperCache = (): void => {
  helperEnsuredPages = new WeakSet<Page>();
};
