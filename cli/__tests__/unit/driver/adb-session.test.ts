import { describe, it, expect, vi } from "vitest";
import { AdbDriver } from "../../../src/driver/mobile/adb-driver.js";
import type { Adb } from "../../../src/driver/mobile/adb.js";

const DUMP = `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false" enabled="true">
    <node index="0" class="android.widget.LinearLayout" clickable="true" enabled="true" resource-id="com.x:id/row_net" bounds="[0,200][1080,400]">
      <node index="0" class="android.widget.TextView" text="Network & internet" bounds="[40,260][600,320]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="com.x:id/search" clickable="true" enabled="true" bounds="[0,420][1080,520]" />
  </node>
</hierarchy>`;

const makeAdb = () => {
  const calls: string[][] = [];
  const adb: Adb = {
    text: vi.fn(async (args: string[]) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("cat /sdcard/skeptic-dump.xml")) return DUMP;
      if (joined.includes("wm size")) return "Physical size: 1080x2400";
      if (joined.includes("dumpsys window")) return "mCurrentFocus=Window{a b com.x/com.x.Main}";
      return "";
    }),
    bytes: vi.fn(async () => Buffer.from("PNG")),
  };
  return { adb, calls };
};

describe("AndroidAdbDriverSession", () => {
  it("snapshots a dump into refs and taps a ref at its bounds center", async () => {
    const { adb, calls } = makeAdb();
    const driver = AdbDriver.fromAdb("emulator-5554", adb);
    const session = await driver.newSession({ artifactDir: "/tmp" });

    await session.open("com.x");
    const cap = await session.snapshot();

    const row = cap.entries.find((e) => e.name === "Network & internet");
    expect(row, "clickable row should be a ref").toBeDefined();
    expect(row!.role).toBe("button");
    expect(row!.selectorHint).toBe("res=com.x:id/row_net");

    const el = await session.resolveRef(row!.ref);
    await el.click();
    // center of [0,200][1080,400] = (540, 300)
    const tap = calls.find((c) => c.join(" ") === "shell input tap 540 300");
    expect(tap, "should tap the row center").toBeDefined();
  });

  it("resolves a selector by res= hint and rejects unicode input", async () => {
    const { adb } = makeAdb();
    const session = await AdbDriver.fromAdb("e", adb).newSession({ artifactDir: "/tmp" });
    await session.open("com.x");
    await session.snapshot();

    const search = await session.resolveSelector("res=com.x:id/search");
    await expect(search.fill("café")).rejects.toThrow(/unicode_unsupported/);
    await expect(search.fill("plain@ascii.com")).resolves.toBeUndefined();
  });

  it("errors clearly when resolving an unknown ref", async () => {
    const { adb } = makeAdb();
    const session = await AdbDriver.fromAdb("e", adb).newSession({ artifactDir: "/tmp" });
    await session.open("com.x");
    await session.snapshot();
    await expect(session.resolveRef("e999")).rejects.toThrow(/adbRef:not_found/);
  });

  it("retries uiautomator dump past the transient null-root failure", async () => {
    let attempts = 0;
    const adb: Adb = {
      text: vi.fn(async (args: string[]) => {
        const j = args.join(" ");
        if (j.includes("uiautomator dump")) {
          attempts++;
          return attempts < 3 ? "ERROR: null root node returned by UiTestAutomationBridge." : "";
        }
        if (j.includes("cat /sdcard/skeptic-dump.xml")) return attempts < 3 ? "" : DUMP;
        if (j.includes("wm size")) return "Physical size: 1080x2400";
        return "";
      }),
      bytes: vi.fn(async () => Buffer.from("")),
    };
    const session = await AdbDriver.fromAdb("e", adb).newSession({ artifactDir: "/tmp" });
    await session.open("com.x");
    const cap = await session.snapshot();
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(cap.entries.length).toBeGreaterThan(0);
  });
});
