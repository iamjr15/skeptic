import { setStream } from "./logger.js";

/**
 * Divert all logger output to stderr. ACP server mode owns stdout for the
 * NDJSON protocol channel — any stray write corrupts the framing. Call this
 * BEFORE the SDK opens the transport.
 */
export function redirectStdoutLogsToStderr(): void {
  setStream(process.stderr);
}
