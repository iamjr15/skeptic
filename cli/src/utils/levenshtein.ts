/**
 * Levenshtein edit distance. Classic DP, O(m*n) time & space.
 * Fine for vocabularies under a few hundred words.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Candidates from `pool` similar to `input`. Mirrors Maestro's heuristic:
 *   - Levenshtein distance ≤ threshold (default 3), OR
 *   - Substring match in either direction when input is ≥ 3 chars.
 * De-duped, sorted by distance ascending.
 */
export function findSimilar(
  input: string,
  pool: readonly string[],
  threshold: number = 3,
): string[] {
  const needle = input.toLowerCase();
  const scored = pool.map((c) => {
    const hay = c.toLowerCase();
    return {
      candidate: c,
      distance: levenshtein(needle, hay),
      substring: input.length >= 3 && (hay.includes(needle) || needle.includes(hay)),
    };
  });

  const matches = scored.filter((x) => x.distance <= threshold || x.substring);
  matches.sort((a, b) => a.distance - b.distance);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m.candidate)) {
      seen.add(m.candidate);
      out.push(m.candidate);
    }
  }
  return out;
}
