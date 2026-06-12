// Fake execution worker that fails on its first run and passes on the second, keyed by a
// counter file (path in SKEPTIC_FLAKY_COUNTER). Used to verify a retried-then-passed test is
// marked `flaky` by the runner.
import { parentPort } from "node:worker_threads";
import * as fs from "node:fs";

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "start") return;
  const counterPath = process.env.SKEPTIC_FLAKY_COUNTER;
  let n = 0;
  try {
    n = Number(fs.readFileSync(counterPath, "utf-8")) || 0;
  } catch {
    n = 0;
  }
  n += 1;
  fs.writeFileSync(counterPath, String(n));

  const id = msg.allowlist[0];
  const [file, ordinalStr] = id.split("#");
  const ordinal = Number(ordinalStr);
  const passed = n >= 2;

  parentPort.postMessage({ type: "test:start", testId: id, ordinal, name: "flaky", file });
  parentPort.postMessage({
    type: "test:complete",
    testId: id,
    ordinal,
    result: {
      name: "flaky",
      file,
      status: passed ? "passed" : "failed",
      duration_ms: 1,
      steps: [
        {
          command: "test",
          args: {},
          status: passed ? "passed" : "failed",
          duration_ms: 1,
          ...(passed ? {} : { error: "flaky fail" }),
        },
      ],
      artifacts: {},
    },
  });
  parentPort.postMessage({ type: "file:complete", file, finished: [id] });
  process.exit(0);
});
