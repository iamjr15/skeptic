import type { Driver, DriverSession } from "../driver/types.js";
import { PlaywrightDriver } from "../driver/playwright/playwright-driver.js";
import { loadPlaywright } from "../utils/playwright-loader.js";
import { getSessionArtifactDir } from "./socket.js";
import type { Engine } from "./lifecycle.js";

/** Serializes operations against one session so two concurrent CLI invocations
 *  can't desync its RefMap mid-action. */
class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<T>;
  }
}

interface SessionEntry {
  readonly name: string;
  readonly session: DriverSession;
  readonly mutex: AsyncMutex;
  idle: NodeJS.Timeout | null;
  readonly createdAt: number;
  lastUsedAt: number;
  url: string;
}

export interface SessionInfo {
  name: string;
  url: string;
  ageMs: number;
  idleMs: number;
}

export interface SessionRegistryOptions {
  engine: Engine;
  headed: boolean;
  /** Per-session idle reap, seconds. 0 disables. Default 180. */
  sessionIdleSeconds?: number;
  /** Driver factory override (tests inject a mock). Default launches a real browser. */
  createDriver?: () => Promise<Driver>;
  /** Notified whenever the session count changes, so the daemon can re-evaluate its own idle timer. */
  onChange?: () => void;
  /** Called once per newly created session (before its first navigation) — used to
   *  attach console/network collectors so they capture from the first load. */
  onSessionCreate?: (session: DriverSession) => Promise<void>;
  /** Wall-clock source (injectable for deterministic tests). */
  now?: () => number;
}

/**
 * Holds the interactive browser sessions inside the session daemon process. The
 * Browser is launched lazily on first `open`; each named session is an isolated
 * context+page (a `DriverSession`) whose RefMap persists across CLI invocations.
 */
export class SessionRegistry {
  private driver: Driver | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  /** In-flight session creations, keyed by name — dedupes concurrent first-opens
   *  so two racing CLI calls don't each launch a context for the same session. */
  private readonly pending = new Map<string, Promise<SessionEntry>>();
  private driverPromise: Promise<Driver> | null = null;
  private readonly idleSeconds: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionRegistryOptions) {
    this.idleSeconds = opts.sessionIdleSeconds ?? 180;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  private ensureDriver(): Promise<Driver> {
    if (this.driver) return Promise.resolve(this.driver);
    // Dedupe concurrent first-launches so we never start two browsers.
    if (this.driverPromise) return this.driverPromise;
    this.driverPromise = (async () => {
      if (this.opts.createDriver) {
        this.driver = await this.opts.createDriver();
      } else {
        const pw = await loadPlaywright();
        const browser = await pw[this.opts.engine].launch({ headless: !this.opts.headed });
        this.driver = PlaywrightDriver.fromBrowser(browser, true);
      }
      return this.driver;
    })();
    return this.driverPromise;
  }

  private getOrCreate(name: string): Promise<SessionEntry> {
    const existing = this.sessions.get(name);
    if (existing) {
      this.touch(existing);
      return Promise.resolve(existing);
    }
    const inflight = this.pending.get(name);
    if (inflight) return inflight;

    // All concurrent callers await this exact promise, so their continuations
    // fire in attachment order (preserving call order) once it resolves.
    const creation = (async () => {
      try {
        const driver = await this.ensureDriver();
        const session = await driver.newSession({ artifactDir: getSessionArtifactDir(name) });
        if (this.opts.onSessionCreate) await this.opts.onSessionCreate(session);
        const entry: SessionEntry = {
          name,
          session,
          mutex: new AsyncMutex(),
          idle: null,
          createdAt: this.now(),
          lastUsedAt: this.now(),
          url: "",
        };
        this.sessions.set(name, entry);
        this.touch(entry);
        this.opts.onChange?.();
        return entry;
      } finally {
        this.pending.delete(name);
      }
    })();
    this.pending.set(name, creation);
    return creation;
  }

  /** Serialize `fn` against the named session (created on demand). */
  async run<T>(name: string, fn: (session: DriverSession) => Promise<T>): Promise<T> {
    const entry = await this.getOrCreate(name);
    return entry.mutex.run(async () => {
      this.touch(entry);
      const result = await fn(entry.session);
      entry.url = entry.session.url();
      return result;
    });
  }

  async close(name: string): Promise<boolean> {
    const entry = this.sessions.get(name);
    if (!entry) return false;
    if (entry.idle) clearTimeout(entry.idle);
    this.sessions.delete(name);
    await entry.session.close().catch(() => {});
    this.opts.onChange?.();
    return true;
  }

  async closeAll(): Promise<void> {
    const names = [...this.sessions.keys()];
    for (const name of names) await this.close(name);
    if (this.driver) {
      await this.driver.close().catch(() => {});
      this.driver = null;
    }
  }

  list(): SessionInfo[] {
    const t = this.now();
    return [...this.sessions.values()].map((e) => ({
      name: e.name,
      url: e.url,
      ageMs: t - e.createdAt,
      idleMs: t - e.lastUsedAt,
    }));
  }

  private touch(entry: SessionEntry): void {
    entry.lastUsedAt = this.now();
    if (entry.idle) clearTimeout(entry.idle);
    if (this.idleSeconds > 0) {
      entry.idle = setTimeout(() => {
        void this.close(entry.name);
      }, this.idleSeconds * 1000);
      entry.idle.unref?.();
    }
  }
}
