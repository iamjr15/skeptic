/**
 * Environment variable interpolation for config values.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */

const ENV_PATTERN = /\$\{([^}]+)\}/g;

export function interpolateEnv(value: string): string {
  return value.replace(ENV_PATTERN, (_, expr: string) => {
    const [name, ...rest] = expr.split(":-");
    const fallback = rest.join(":-"); // rejoin in case default contains :-
    const envVal = process.env[name!.trim()];
    if (envVal !== undefined) return envVal;
    if (rest.length > 0) return fallback;
    return "";
  });
}

/** Recursively interpolate all string values in an object. */
export function interpolateEnvDeep(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(interpolateEnvDeep);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateEnvDeep(v);
    }
    return result;
  }
  return obj;
}
