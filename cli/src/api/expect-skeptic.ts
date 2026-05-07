import { createRequire } from "node:module";
import type { expect as playwrightExpect } from "@playwright/test";

type PlaywrightExpect = typeof playwrightExpect;

const req = createRequire(import.meta.url);
let cachedExpect: PlaywrightExpect | null = null;

const loadExpect = (): PlaywrightExpect => {
  cachedExpect ??= (req("@playwright/test") as { expect: PlaywrightExpect }).expect;
  return cachedExpect;
};

/**
 * Re-export Playwright's `expect` so test authors get the full matcher catalog
 * (toHaveURL, toBeVisible, etc.) with one import:
 *
 *   import { test, expect } from "skeptic-cli";
 *
 * Skeptic-specific matchers — toMatchSnapshot, toBeAccessible — land in B5/B6.
 * They're defined here so the surface is stable; B5 plugs in the real bodies.
 */
export const expect = new Proxy(((...args: unknown[]) => {
  return (loadExpect() as unknown as (...innerArgs: unknown[]) => unknown)(...args);
}) as PlaywrightExpect, {
  apply(_target, thisArg, args) {
    return Reflect.apply(loadExpect() as unknown as (...innerArgs: unknown[]) => unknown, thisArg, args);
  },
  get(_target, prop, receiver) {
    return Reflect.get(loadExpect() as unknown as object, prop, receiver);
  },
  set(_target, prop, value, receiver) {
    return Reflect.set(loadExpect() as unknown as object, prop, value, receiver);
  },
});

export type { Expect } from "@playwright/test";
