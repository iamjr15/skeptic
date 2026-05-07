import { render } from "ink";
import type { InkReporter } from "../reporter/ink-reporter.js";
import { App } from "./app.js";

export interface RunTuiHandle {
  clear: () => void;
  unmount: () => void;
  waitUntilExit: () => Promise<void>;
}

export interface RunTuiRenderOptions {
  onAbort: () => void;
  onQuit: () => void;
  alternateScreen?: boolean;
}

export const renderRunTui = (
  reporter: InkReporter,
  options: RunTuiRenderOptions,
): RunTuiHandle => {
  const instance = render(
    <App reporter={reporter} onAbort={options.onAbort} onQuit={options.onQuit} />,
    {
      exitOnCtrlC: false,
      patchConsole: true,
      incrementalRendering: true,
      maxFps: 30,
      alternateScreen: options.alternateScreen ?? true,
    },
  );

  return {
    clear: () => instance.clear(),
    unmount: () => instance.unmount(),
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
  };
};
