// Fake execution worker that simulates an unexpected crash: it announces `ready`,
// then on `start` exits non-zero WITHOUT emitting any test results. Used to verify the
// runner synthesizes error results for unfinished tests instead of silently dropping them.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => {
  if (msg && msg.type === "start") {
    process.exit(1);
  }
});
