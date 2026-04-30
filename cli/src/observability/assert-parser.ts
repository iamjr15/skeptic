export interface Threshold {
  operator: "<" | "<=" | ">" | ">=" | "=";
  value: number;
  raw: string;
}

const THRESHOLD_RE = /^(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/;

export const parseThreshold = (expr: string, unit: "ms" | "unitless"): Threshold => {
  const trimmed = expr.trim();
  const m = THRESHOLD_RE.exec(trimmed);
  if (!m) {
    throw new Error(
      `Invalid threshold expression: "${expr}". Expected format: "<value[unit]", e.g. "<2.5s", "<=200ms", "<0.1".`,
    );
  }
  const [, op, numStr, parsedUnit] = m;
  let value = parseFloat(numStr!);
  if (unit === "ms") {
    if (parsedUnit === "s") {
      value = value * 1000;
    } else if (parsedUnit === "ms" || parsedUnit === undefined) {
      // already ms
    } else {
      throw new Error(`Time metric cannot use unit "${parsedUnit}"`);
    }
  } else {
    if (parsedUnit !== undefined) {
      throw new Error(`Unitless metric "${expr}" should not have a unit suffix`);
    }
  }
  return { operator: op as Threshold["operator"], value, raw: trimmed };
};

export const checkThreshold = (actual: number, threshold: Threshold): boolean => {
  switch (threshold.operator) {
    case "<":
      return actual < threshold.value;
    case "<=":
      return actual <= threshold.value;
    case ">":
      return actual > threshold.value;
    case ">=":
      return actual >= threshold.value;
    case "=":
      return actual === threshold.value;
  }
};
