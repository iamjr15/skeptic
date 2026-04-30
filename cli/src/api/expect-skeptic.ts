import { expect as playwrightExpect } from "@playwright/test";

/**
 * Re-export Playwright's `expect` so test authors get the full matcher catalog
 * (toHaveURL, toBeVisible, etc.) with one import:
 *
 *   import { test, expect } from "skeptic-cli";
 *
 * Skeptic-specific matchers — toMatchSnapshot, toBeAccessible — land in B5/B6.
 * They're defined here so the surface is stable; B5 plugs in the real bodies.
 */
export const expect = playwrightExpect;

export type { Expect } from "@playwright/test";
