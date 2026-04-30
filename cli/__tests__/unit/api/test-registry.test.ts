import { describe, expect, it, beforeEach } from "vitest";
import {
  beginRegistration,
  endRegistration,
  test,
  type FileRegistry,
} from "../../../src/api/test.js";

const NOOP = async (): Promise<void> => {};

describe("api/test registry", () => {
  let registry: FileRegistry;

  beforeEach(() => {
    registry = beginRegistration("/virt/spec.ts");
  });

  it("registers tests in declaration order with stable ids", () => {
    test("a", NOOP);
    test("b", NOOP);
    test("c", NOOP);
    const captured = endRegistration();
    expect(captured?.tests.map((t) => t.id)).toEqual([
      "/virt/spec.ts#0",
      "/virt/spec.ts#1",
      "/virt/spec.ts#2",
    ]);
  });

  it("test.skip and test.only flag the entry", () => {
    test("plain", NOOP);
    test.skip("skipped", NOOP);
    test.only("focused", NOOP);
    const captured = endRegistration();
    expect(captured?.tests.map((t) => ({ name: t.name, skip: t.skip, only: t.only }))).toEqual([
      { name: "plain", skip: false, only: false },
      { name: "skipped", skip: true, only: false },
      { name: "focused", skip: false, only: true },
    ]);
  });

  it("test.use merges file-level options across calls", () => {
    test.use({ url: "https://a", retries: 1 });
    test.use({ url: "https://b" });
    const captured = endRegistration();
    expect(captured?.fileUse).toEqual({ url: "https://b", retries: 1 });
  });

  it("test.beforeEach / test.afterEach append to the right hook list", () => {
    test.beforeEach(NOOP);
    test.beforeEach(NOOP);
    test.afterEach(NOOP);
    const captured = endRegistration();
    expect(captured?.beforeEach).toHaveLength(2);
    expect(captured?.afterEach).toHaveLength(1);
  });

  it("disables stale registry — calling test() outside a registration block throws", () => {
    endRegistration();
    expect(() => test("orphan", NOOP)).toThrowError(/outside a spec file/);
    // Reopen so the afterEach in this beforeEach doesn't fail.
    registry = beginRegistration("/virt/spec2.ts");
    void registry;
  });

  it("test name + ordinal collide cleanly when duplicate names exist", () => {
    test("dup", NOOP);
    test("dup", NOOP);
    const captured = endRegistration();
    expect(captured?.tests.map((t) => t.id)).toEqual([
      "/virt/spec.ts#0",
      "/virt/spec.ts#1",
    ]);
  });
});
