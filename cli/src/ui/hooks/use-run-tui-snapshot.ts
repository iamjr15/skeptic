import { useSyncExternalStore } from "react";
import type { InkReporter } from "../../reporter/ink-reporter.js";
import type { RunTuiSnapshot } from "../model.js";

export const useRunTuiSnapshot = (reporter: InkReporter): RunTuiSnapshot =>
  useSyncExternalStore(reporter.subscribe, reporter.getSnapshot, reporter.getSnapshot);
