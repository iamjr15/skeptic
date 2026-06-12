import type { DaemonRpcRequest, DaemonRpcResponse } from "./socket.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DriverElement, DriverSession } from "../driver/types.js";
import { renderSnapshot } from "../commands/snapshot-render.js";

const ok = (result: unknown): DaemonRpcResponse => ({ result });
const fail = (message: string): DaemonRpcResponse => ({ error: message });

const SESSION_PERSIST_NOTE =
  "Stable artifact: copy a selectorHint into your test. In this session @eN refs persist until navigation or the next `skeptic snapshot`.";

type Params = Record<string, unknown>;

const sessionName = (p: Params): string =>
  typeof p["session"] === "string" && p["session"] ? (p["session"] as string) : "default";

const requireOpen = (registry: SessionRegistry, name: string): string | null =>
  registry.has(name) ? null : `no open session "${name}" — run \`skeptic open <url>\` first`;

const resolveTarget = async (s: DriverSession, p: Params): Promise<DriverElement> => {
  if (typeof p["ref"] === "string" && p["ref"]) return s.resolveRef(p["ref"] as string);
  if (typeof p["selector"] === "string" && p["selector"]) return s.resolveSelector(p["selector"] as string);
  throw new Error("a ref (@eN) or --selector is required");
};

const applyVerb = async (el: DriverElement, verb: string, p: Params): Promise<void> => {
  switch (verb) {
    case "click": return el.click();
    case "fill": return el.fill(String(p["text"] ?? ""));
    case "type": return el.type(String(p["text"] ?? ""));
    case "press": return el.press(String(p["key"] ?? ""));
    case "hover": return el.hover();
    case "check": return el.check();
    case "uncheck": return el.uncheck();
    case "select": return el.selectOption((p["value"] as string | string[]) ?? "");
    case "scrollIntoView": return el.scrollIntoView();
    default: throw new Error(`unknown act verb "${verb}"`);
  }
};

/**
 * Dispatch the `session.*` RPC surface against the daemon-held interactive
 * sessions. Each handler runs serialized through the registry's per-session
 * mutex and reuses skeptic's existing capture/resolve/screenshot helpers.
 */
export async function dispatchSession(
  req: DaemonRpcRequest,
  registry: SessionRegistry,
): Promise<DaemonRpcResponse> {
  const p = (req.params ?? {}) as Params;
  const name = sessionName(p);

  try {
    switch (req.method) {
      case "session.open": {
        const url = String(p["url"] ?? "");
        if (!url) return fail("session.open: a url is required");
        const result = await registry.run(name, async (s) => {
          await s.open(url, {
            ...(typeof p["waitUntil"] === "string" ? { waitUntil: p["waitUntil"] as "load" } : {}),
            ...(p["timeoutMs"] !== undefined ? { timeoutMs: Number(p["timeoutMs"]) } : {}),
          });
          return { session: name, url: s.url(), title: await s.title() };
        });
        return ok(result);
      }

      case "session.snapshot": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const result = await registry.run(name, async (s) => {
          const capture = await s.snapshot({
            viewport: p["viewport"] !== false,
            includeCursorInteractive: true,
            extractLinkHrefs: true,
          });
          const rendered = renderSnapshot(capture, {
            interactive: Boolean(p["interactive"]),
            compact: Boolean(p["compact"]),
          });
          return {
            session: name,
            url: s.url(),
            title: await s.title(),
            yaml: rendered.yaml,
            refs: rendered.refs,
            stats: rendered.stats,
            truncated: capture.truncated,
            note: SESSION_PERSIST_NOTE,
          };
        });
        return ok(result);
      }

      case "session.act": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const verb = String(p["verb"] ?? "");
        const result = await registry.run(name, async (s) => {
          if (verb === "scroll") {
            await s.scroll({ dx: Number(p["dx"] ?? 0), dy: Number(p["dy"] ?? 0) });
            return { ok: true, verb };
          }
          const el = await resolveTarget(s, p);
          await applyVerb(el, verb, p);
          return { ok: true, verb, target: p["ref"] ?? p["selector"] };
        });
        return ok(result);
      }

      case "session.query": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const query = String(p["query"] ?? "text");
        const result = await registry.run(name, async (s) => {
          if (query === "url") return { value: s.url() };
          if (query === "title") return { value: await s.title() };
          const el = await resolveTarget(s, p);
          if (query === "text") return { value: await el.textContent() };
          if (query === "box") return { value: await el.boundingBox() };
          if (query === "visible") return { value: await el.isVisible() };
          if (query === "enabled") return { value: await el.isEnabled() };
          if (query === "checked") return { value: await el.isChecked() };
          if (query === "value") return { value: await el.inputValue() };
          throw new Error(
            `unsupported query "${query}" (supported: text, value, box, visible, enabled, checked, url, title)`,
          );
        });
        return ok(result);
      }

      case "session.screenshot": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const shotName = String(p["name"] ?? "screenshot");
        const result = await registry.run(name, async (s) => {
          const shot = await s.screenshot(shotName, {
            fullPage: Boolean(p["fullPage"]),
            annotate: Boolean(p["annotate"]),
          });
          return { path: shot.path, ...(shot.annotations ? { annotations: shot.annotations } : {}) };
        });
        return ok(result);
      }

      case "session.observe": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const collector = String(p["collector"] ?? "console");
        const result = await registry.run(name, async (s) => {
          const evidence = await s.collectEvidence();
          if (collector === "errors") {
            const console = evidence["console"] as { messages?: Array<{ type: string }> } | undefined;
            const errors = (console?.messages ?? []).filter((m) => m.type === "error");
            return { collector: "errors", errors, count: errors.length };
          }
          return { collector, snapshot: evidence[collector] ?? null };
        });
        return ok(result);
      }

      case "session.wait": {
        const guard = requireOpen(registry, name);
        if (guard) return fail(guard);
        const result = await registry.run(name, async (s) => {
          if (p["ms"] !== undefined) {
            await s.wait(Number(p["ms"]));
            return { ok: true };
          }
          if (typeof p["selector"] === "string" && p["selector"]) {
            const el = await s.resolveSelector(p["selector"] as string);
            await el.waitFor({
              ...(typeof p["state"] === "string" ? { state: p["state"] as "visible" } : {}),
              ...(p["timeoutMs"] !== undefined ? { timeoutMs: Number(p["timeoutMs"]) } : {}),
            });
            return { ok: true };
          }
          throw new Error("session.wait needs --ms or a selector");
        });
        return ok(result);
      }

      case "session.close": {
        const closed = await registry.close(name);
        return ok({ closed, session: name });
      }

      case "session.list": {
        return ok({ sessions: registry.list() });
      }

      default:
        return fail(`unknown session method: ${req.method}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
