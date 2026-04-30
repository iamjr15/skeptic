import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import type { InkReporter } from "../reporter/ink-reporter.js";

export interface TUIOptions {
  watch: boolean;
  onRerun: () => Promise<void>;
  onRerunFailed: () => Promise<void>;
  onAbort: () => Promise<void>;
  onQuit: () => Promise<void>;
}

export const renderTUI = async (reporter: InkReporter, opts: TUIOptions) => {
  const instance = render(<App reporter={reporter} {...opts} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
    patchConsole: true,
    incrementalRendering: true,
  });

  return {
    waitUntilExit: async (): Promise<void> => { await instance.waitUntilExit(); },
    unmount: () => instance.unmount(),
  };
};
