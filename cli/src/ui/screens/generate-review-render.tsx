import React from "react";
import { render } from "ink";
import { GenerateReviewScreen } from "./generate-review-screen.js";

export const renderGenerateReview = (tests: string[]): Promise<{ approved: string[] }> =>
  new Promise((resolve) => {
    let resolved = false;
    let instance: ReturnType<typeof render> | null = null;

    const finish = (approved: string[]) => {
      if (resolved) return;
      resolved = true;
      instance?.unmount();
      resolve({ approved });
    };

    const onApprove = (indices: number[]) =>
      finish(
        indices
          .map((i) => tests[i])
          .filter((y): y is string => typeof y === "string"),
      );
    const onSkip = () => finish([]);

    instance = render(
      <GenerateReviewScreen tests={tests} onApprove={onApprove} onSkip={onSkip} />,
      {
        exitOnCtrlC: false,
        alternateScreen: true,
        patchConsole: true,
        incrementalRendering: true,
      },
    );
  });
