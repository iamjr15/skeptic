import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { IosNode } from "./axe-describe-parse.js";

/**
 * Resolve a skeptic-grammar selector (`id=`/`label=`/`type=`, `role:name`, or a
 * bare name) against the last `describe-ui` snapshot's entries, returning the
 * matching native node. Mirrors the Android `resolveBySelectorHint` for iOS.
 */
export const resolveBySelectorHint = (
  selector: string,
  entries: AriaRefEntry[],
  nodes: Map<string, IosNode>,
): IosNode | null => {
  const match = (e: AriaRefEntry): boolean => {
    const node = nodes.get(e.ref);
    if (!node) return false;
    if (selector.startsWith("id=")) return node.axUniqueId === selector.slice(3);
    if (selector.startsWith("label=")) return e.name === selector.slice(6);
    if (selector.startsWith("type=")) return node.type === selector.slice(5);
    if (selector.startsWith("role=")) {
      const [role, name] = selector.slice(5).split(":");
      return e.role === role && (name === undefined || e.name === name);
    }
    return e.name === selector;
  };
  const byHint = entries.find((e) => e.selectorHint === selector);
  if (byHint) return nodes.get(byHint.ref) ?? null;
  const found = entries.find(match);
  return found ? (nodes.get(found.ref) ?? null) : null;
};
