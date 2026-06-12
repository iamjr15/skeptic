// Fake execution worker that hangs forever after `start`. Used to verify AbortSignal
// terminates in-flight workers so the run resolves promptly instead of hanging.
import { parentPort } from "node:worker_threads";

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (msg) => {
  if (msg && msg.type === "start") {
    // Keep the event loop alive; wait to be terminated.
    setInterval(() => {}, 1000);
  }
});
