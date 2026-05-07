import { useEffect, useState } from "react";
import { useStdout } from "ink";

const FALLBACK_COLUMNS = 100;
const FALLBACK_ROWS = 30;

const safeColumns = (value: number | undefined): number =>
  value && value > 0 ? value : FALLBACK_COLUMNS;

const safeRows = (value: number | undefined): number =>
  value && value > 0 ? value : FALLBACK_ROWS;

export const useStdoutDimensions = (): [columns: number, rows: number] => {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<[number, number]>([
    safeColumns(stdout.columns),
    safeRows(stdout.rows),
  ]);

  useEffect(() => {
    const handleResize = (): void => {
      setDimensions([safeColumns(stdout.columns), safeRows(stdout.rows)]);
    };
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  return dimensions;
};
