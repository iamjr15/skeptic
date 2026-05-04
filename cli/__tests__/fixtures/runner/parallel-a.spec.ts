import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "skeptic-cli";

const logPath = process.env["SKEPTIC_PARALLEL_LOG"];

const mark = (label: string): void => {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${label}:${Date.now()}\n`, "utf-8");
};

test("parallel: a", async () => {
  mark("a:start");
  await delay(1_000);
  mark("a:end");
});
