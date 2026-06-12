import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { NativeNode } from "./uiautomator-parse.js";

/**
 * Resolve a skeptic-grammar selector (`res=`/`desc=`/`text=`/`class=`, or a
 * bare `role:name`) against the last snapshot's entries, returning the matching
 * native node. Mirrors the web element-resolver grammar for the mobile target.
 */
export const resolveBySelectorHint = (
  selector: string,
  entries: AriaRefEntry[],
  nodes: Map<string, NativeNode>,
): NativeNode | null => {
  const match = (e: AriaRefEntry): boolean => {
    const node = nodes.get(e.ref);
    if (!node) return false;
    if (selector.startsWith("res=")) return node.resourceId === selector.slice(4);
    if (selector.startsWith("desc=")) return e.name === selector.slice(5);
    if (selector.startsWith("text=")) return e.name === selector.slice(5);
    if (selector.startsWith("class=")) return node.className.endsWith(selector.slice(6));
    if (selector.startsWith("role=")) {
      const [role, name] = selector.slice(5).split(":");
      return e.role === role && (name === undefined || e.name === name);
    }
    // Bare string → match by accessible name.
    return e.name === selector;
  };
  // Prefer the selectorHint match (exact), then fall back to the generic matcher.
  const byHint = entries.find((e) => e.selectorHint === selector);
  if (byHint) return nodes.get(byHint.ref) ?? null;
  const found = entries.find(match);
  return found ? (nodes.get(found.ref) ?? null) : null;
};
