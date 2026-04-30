import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type {
  AccessibilitySnapshot,
  ConsoleSnapshot,
  NetworkSnapshot,
  PerformanceSnapshot,
} from "../observability/types.js";
import type { TestArtifacts } from "./types.js";
import { formatPerfTraceMarkdown } from "../reporter/perf-trace-md.js";
import { logger } from "../utils/logger.js";

export interface SidecarWriteInput {
  flowDir: string;
  metrics: Record<string, unknown>;
  artifacts: TestArtifacts;
}

/**
 * Writes the three observability sidecars (`perf-trace.md`, `console.json`,
 * `network.json`) into the test's flowDir and populates `artifacts` with their
 * paths. Each write is wrapped in its own try/catch — sidecar failures must
 * never mask the test result. Shared between the engine and the runner worker
 * so both code paths emit byte-identical sidecars.
 */
export const writeSidecars = async (input: SidecarWriteInput): Promise<void> => {
  const { flowDir, metrics, artifacts } = input;
  const perf = metrics["performance"] as PerformanceSnapshot | undefined;
  const net = metrics["network"] as NetworkSnapshot | undefined;
  const con = metrics["console"] as ConsoleSnapshot | undefined;
  const a11y = metrics["accessibility"] as AccessibilitySnapshot | undefined;

  try {
    const md = formatPerfTraceMarkdown({
      ...(perf !== undefined ? { performance: perf } : {}),
      ...(net !== undefined ? { network: net } : {}),
      ...(con !== undefined ? { console: con } : {}),
      ...(a11y !== undefined ? { accessibility: a11y } : {}),
    });
    const perfTracePath = join(flowDir, "perf-trace.md");
    await writeFile(perfTracePath, md, "utf-8");
    artifacts.perfTrace = perfTracePath;
  } catch (err) {
    logger.warn(`perf-trace.md write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (con) {
    try {
      const consolePath = join(flowDir, "console.json");
      await writeFile(consolePath, JSON.stringify(con, null, 2), "utf-8");
      artifacts.consoleSnapshot = consolePath;
    } catch (err) {
      logger.warn(`console.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (net) {
    try {
      const networkPath = join(flowDir, "network.json");
      await writeFile(networkPath, JSON.stringify(net, null, 2), "utf-8");
      artifacts.networkSnapshot = networkPath;
    } catch (err) {
      logger.warn(`network.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};
