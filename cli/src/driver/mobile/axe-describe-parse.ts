import type { AriaRefEntry } from "../../executor/aria-ref-types.js";
import type { CaptureResult } from "../../executor/aria-snapshot-capture.js";

/** Per-ref native detail for iOS, kept off the platform-agnostic AriaRefEntry.
 *  Coordinates are iOS POINTS (axe `tap`/describe-ui share the same point space). */
export interface IosNode {
  ref: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  center: { x: number; y: number };
  type: string;
  axUniqueId: string;
  enabled: boolean;
  value: string | null;
}

export interface IosParseResult {
  capture: CaptureResult;
  nodes: Map<string, IosNode>;
}

interface AxeNode {
  type?: string;
  role?: string;
  role_description?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  title?: string | null;
  frame?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  custom_actions?: string[];
  children?: AxeNode[];
}

/** AXe element `type` → skeptic role. */
export const deriveRole = (n: AxeNode): string => {
  switch (n.type) {
    case "Button":
      return "button";
    case "TextField":
    case "SecureTextField":
      return "textbox";
    case "SearchField":
      return "searchbox";
    case "StaticText":
      return "text";
    case "Image":
      return "image";
    case "Slider":
      return "slider";
    case "Switch":
    case "Toggle":
      return "switch";
    case "Heading":
      return "heading";
    case "Link":
      return "link";
    case "Cell":
      return "listitem";
    case "Application":
      return "application";
    case "NavigationBar":
      return "navigation";
    case "TabBar":
      return "tablist";
    default:
      return (n.role_description || "generic").toString();
  }
};

const INTERACTIVE = new Set([
  "Button", "TextField", "SecureTextField", "SearchField", "Slider", "Switch",
  "Toggle", "Link", "Cell", "Stepper", "SegmentedControl",
]);

const isInteractive = (n: AxeNode): boolean =>
  INTERACTIVE.has(n.type ?? "") || (n.custom_actions?.length ?? 0) > 0;

const ownName = (n: AxeNode): string => (n.AXLabel ?? n.title ?? n.AXValue ?? "").toString().trim();

/** First non-empty label among descendants — names a tappable cell from its child text. */
const firstDescendantText = (n: AxeNode): string => {
  for (const c of n.children ?? []) {
    const t = ownName(c);
    if (t) return t;
  }
  for (const c of n.children ?? []) {
    const t = firstDescendantText(c);
    if (t) return t;
  }
  return "";
};

/** Stable selector grammar: id=<AXUniqueId> › label=<AXLabel> › type=<type>. */
const buildSelectorHint = (n: AxeNode, resolvedName: string): string => {
  const id = (n.AXUniqueId ?? "").trim();
  if (id) return `id=${id}`;
  if (resolvedName) return `label=${resolvedName}`;
  return `type=${n.type ?? "?"}`;
};

/**
 * Parse `axe describe-ui` JSON into the platform-agnostic CaptureResult plus a
 * native side-registry (point-space bounds for tapping). Mirrors the Android
 * uiautomator parser: mints e1,e2,… depth-first over interactive / labelled
 * nodes, folds a tappable cell's child text into its name, and claims the
 * subtree of an interactive node so its child labels don't get their own refs.
 */
export const parseAxeDescribe = (
  json: string,
  opts: { bundleId?: string; screen?: { width: number; height: number } } = {},
): IosParseResult => {
  let roots: AxeNode[];
  try {
    const parsed = JSON.parse(json) as AxeNode | AxeNode[];
    roots = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    roots = [];
  }

  const entries: AriaRefEntry[] = [];
  const nodes = new Map<string, IosNode>();
  const lines: string[] = [];
  let refCounter = 0;
  const scope = opts.bundleId ? `app=${opts.bundleId}` : "app=*";

  const walk = (node: AxeNode, depth: number, claimed: boolean): void => {
    const role = deriveRole(node);
    const interactive = isInteractive(node);
    const nm = ownName(node);
    // Ref-worthy: any interactive control; OR an unclaimed labelled text/heading leaf.
    const refWorthy =
      interactive || (!claimed && nm.length > 0 && (node.type === "StaticText" || node.type === "Heading"));

    let nextClaimed = claimed;
    let nextDepth = depth;

    if (refWorthy) {
      const ref = `e${++refCounter}`;
      const name = nm || (interactive ? firstDescendantText(node) : "");
      const f = node.frame;
      const bounds = f ? { x1: f.x, y1: f.y, x2: f.x + f.width, y2: f.y + f.height } : null;
      const selectorHint = buildSelectorHint(node, name);
      const kind: AriaRefEntry["kind"] = name.length > 0 && role !== "generic" ? "aria" : "cursor-interactive";

      entries.push({ ref, kind, role, name, nth: 0, scopeSelector: scope, selectorHint, matchCountAtSnapshot: 0 });

      if (bounds) {
        nodes.set(ref, {
          ref,
          bounds,
          center: { x: Math.round((bounds.x1 + bounds.x2) / 2), y: Math.round((bounds.y1 + bounds.y2) / 2) },
          type: node.type ?? "",
          axUniqueId: (node.AXUniqueId ?? "").trim(),
          enabled: node.enabled !== false,
          value: node.AXValue ?? null,
        });
      }

      lines.push(`${"  ".repeat(depth)}- ${role}${name ? ` "${name}"` : ""} [ref=${ref}]`);
      nextDepth = depth + 1;
      if (interactive) nextClaimed = true;
    }

    for (const child of node.children ?? []) walk(child, nextDepth, nextClaimed);
  };

  for (const root of roots) walk(root, 0, false);

  // Backfill nth + matchCountAtSnapshot per (role, name) group.
  const groups = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.role} ${e.name}`;
    const n = groups.get(key) ?? 0;
    e.nth = n;
    groups.set(key, n + 1);
  }
  for (const e of entries) e.matchCountAtSnapshot = groups.get(`${e.role} ${e.name}`) ?? 1;

  let offViewportRefs: Set<string> | undefined;
  if (opts.screen) {
    const { width, height } = opts.screen;
    offViewportRefs = new Set();
    for (const [ref, n] of nodes) {
      if (n.center.x < 0 || n.center.y < 0 || n.center.x > width || n.center.y > height) offViewportRefs.add(ref);
    }
    if (offViewportRefs.size === 0) offViewportRefs = undefined;
  }

  const capture: CaptureResult = {
    yaml: lines.join("\n"),
    entries,
    truncated: false,
    ...(offViewportRefs ? { offViewportRefs } : {}),
  };
  return { capture, nodes };
};

/** Screen size in points from the Application root's frame (for off-viewport + scroll math). */
export const screenFromDescribe = (json: string): { width: number; height: number } | null => {
  try {
    const parsed = JSON.parse(json) as AxeNode | AxeNode[];
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const r of roots) {
      if (r.frame && r.frame.width > 0 && r.frame.height > 0) {
        return { width: Math.round(r.frame.width), height: Math.round(r.frame.height) };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
};
