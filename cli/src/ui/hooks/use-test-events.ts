import { useSyncExternalStore } from "react";
import type { InkReporter } from "../../reporter/ink-reporter.js";
import type { TUIState } from "../types.js";

export const useTestEvents = (reporter: InkReporter): TUIState => {
  return useSyncExternalStore(reporter.subscribe, reporter.getSnapshot);
};
