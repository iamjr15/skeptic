import { describe, it, expect, vi } from "vitest";
import type { Page, Locator } from "playwright";
import { resolveElement } from "../../../src/executor/element-resolver.js";

/** Create a mock Locator with configurable count (how many elements match). */
function mockLocator(count: number): Locator {
  const loc = {
    count: vi.fn().mockResolvedValue(count),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    waitFor: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue("mock text"),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  } as unknown as Locator;
  return loc;
}

/** Create a mock Page where specific strategies match or miss. */
function createMockPage(overrides: {
  roleButton?: number;
  roleLink?: number;
  roleHeading?: number;
  textExact?: number;
  textPartial?: number;
  label?: number;
  placeholder?: number;
  testid?: number;
  css?: number;
} = {}): Page {
  const {
    roleButton = 0,
    roleLink = 0,
    roleHeading = 0,
    textExact = 0,
    textPartial = 0,
    label = 0,
    placeholder = 0,
    testid = 0,
    css = 0,
  } = overrides;

  // Track exact vs partial getByText calls
  let textCallCount = 0;

  const page = {
    getByRole: vi.fn().mockImplementation((role: string) => {
      if (role === "button") return mockLocator(roleButton);
      if (role === "link") return mockLocator(roleLink);
      if (role === "heading") return mockLocator(roleHeading);
      return mockLocator(0);
    }),
    getByText: vi.fn().mockImplementation((_text: string, opts?: { exact?: boolean }) => {
      if (opts?.exact) return mockLocator(textExact);
      textCallCount++;
      return mockLocator(textCallCount === 1 ? textPartial : textPartial);
    }),
    getByLabel: vi.fn().mockReturnValue(mockLocator(label)),
    getByPlaceholder: vi.fn().mockReturnValue(mockLocator(placeholder)),
    getByTestId: vi.fn().mockReturnValue(mockLocator(testid)),
    locator: vi.fn().mockReturnValue(mockLocator(css)),
  } as unknown as Page;

  return page;
}

describe("resolveElement", () => {
  describe("ARIA ref guard (defensive)", () => {
    // resolveSelectorArg routes `@eN` to resolveAriaRef, so resolveElement should never see one.
    // The guard exists so a future caller that bypasses resolveSelectorArg gets a clear error
    // instead of a confusing "Could not find element matching '@e1'" from the auto-detect chain.
    it("@eN selectors throw an internal-error explainer (must not reach the auto-detect chain)", async () => {
      const page = createMockPage();
      await expect(resolveElement(page, "@e1")).rejects.toThrow(
        /must go through resolveSelectorArg/,
      );
    });
  });

  describe("explicit prefixes", () => {
    it("testid= prefix goes directly to getByTestId", async () => {
      const page = createMockPage({ testid: 1 });
      const result = await resolveElement(page, "testid=submit-btn");

      expect(page.getByTestId).toHaveBeenCalledWith("submit-btn");
      expect(page.getByRole).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("testid= prefix throws when no element found", async () => {
      const page = createMockPage({ testid: 0 });

      await expect(resolveElement(page, "testid=missing")).rejects.toThrow(
        'No element found with test-id "missing"',
      );
    });

    it("css= prefix goes directly to locator", async () => {
      const page = createMockPage({ css: 1 });
      const result = await resolveElement(page, "css=.btn-primary");

      expect(page.locator).toHaveBeenCalledWith(".btn-primary");
      expect(page.getByRole).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("css= prefix throws when no element found", async () => {
      const page = createMockPage({ css: 0 });

      await expect(resolveElement(page, "css=.nonexistent")).rejects.toThrow(
        'No element found with CSS selector ".nonexistent"',
      );
    });

    it("role= prefix with name goes to getByRole", async () => {
      const page = createMockPage();
      // Override getByRole to return a match for the explicit role call
      const matchingLoc = mockLocator(1);
      (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(matchingLoc);

      const result = await resolveElement(page, "role=button:Submit");

      expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Submit" });
      expect(result).toBeDefined();
    });

    it("role= prefix without name works", async () => {
      const page = createMockPage();
      const matchingLoc = mockLocator(1);
      (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(matchingLoc);

      const result = await resolveElement(page, "role=navigation");

      expect(page.getByRole).toHaveBeenCalledWith("navigation", {
        name: undefined,
      });
      expect(result).toBeDefined();
    });
  });

  describe("auto-detect chain", () => {
    it("resolves via role button first when it matches", async () => {
      const page = createMockPage({ roleButton: 1, textExact: 1 });
      await resolveElement(page, "Submit");

      // getByRole("button") should be called, and since it matches, text shouldn't be needed
      expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Submit" });
    });

    it("falls through to role link when button misses", async () => {
      const page = createMockPage({ roleButton: 0, roleLink: 1 });
      await resolveElement(page, "About Us");

      expect(page.getByRole).toHaveBeenCalledWith("button", { name: "About Us" });
      expect(page.getByRole).toHaveBeenCalledWith("link", { name: "About Us" });
    });

    it("falls through to exact text when roles miss", async () => {
      const page = createMockPage({
        roleButton: 0,
        roleLink: 0,
        roleHeading: 0,
        textExact: 1,
      });
      await resolveElement(page, "Welcome");

      expect(page.getByText).toHaveBeenCalledWith("Welcome", { exact: true });
    });

    it("falls through to label when text misses", async () => {
      const page = createMockPage({
        roleButton: 0,
        roleLink: 0,
        roleHeading: 0,
        textExact: 0,
        label: 1,
      });
      await resolveElement(page, "Email");

      expect(page.getByLabel).toHaveBeenCalledWith("Email");
    });

    it("falls through to placeholder when label misses", async () => {
      const page = createMockPage({
        roleButton: 0,
        roleLink: 0,
        roleHeading: 0,
        textExact: 0,
        label: 0,
        placeholder: 1,
      });
      await resolveElement(page, "Search...");

      expect(page.getByPlaceholder).toHaveBeenCalledWith("Search...");
    });

    it("falls through to testid in auto-detect when earlier strategies miss", async () => {
      const page = createMockPage({
        roleButton: 0,
        roleLink: 0,
        roleHeading: 0,
        textExact: 0,
        label: 0,
        placeholder: 0,
        testid: 1,
      });
      await resolveElement(page, "my-component");

      expect(page.getByTestId).toHaveBeenCalledWith("my-component");
    });

    it("falls through to CSS locator as final fallback", async () => {
      const page = createMockPage({
        roleButton: 0,
        roleLink: 0,
        roleHeading: 0,
        textExact: 0,
        textPartial: 0,
        label: 0,
        placeholder: 0,
        testid: 0,
        css: 1,
      });
      await resolveElement(page, "div.container");

      expect(page.locator).toHaveBeenCalledWith("div.container");
    });

    it("throws descriptive error when nothing matches", async () => {
      const page = createMockPage(); // everything returns count 0

      await expect(resolveElement(page, "nonexistent")).rejects.toThrow(
        'Could not find element matching "nonexistent"',
      );
    });
  });

  describe("returns first match", () => {
    it("calls .first() on the matching locator", async () => {
      const loc = mockLocator(3); // 3 matches
      const page = createMockPage();
      (page.getByRole as ReturnType<typeof vi.fn>).mockReturnValue(loc);

      const result = await resolveElement(page, "role=button:Save");
      expect(loc.first).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });
});
