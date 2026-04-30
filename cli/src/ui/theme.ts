import figures from "figures";

export const colors = {
  brand:       "#ffd700",
  pass:        "#4caf50",
  fail:        "#f44336",
  warn:        "#ff9800",
  active:      "#2196f3",
  dim:         "#666666",
  shimmerBase: "#555555",
  shimmerHigh: "#ffffff",
  text:        "#e0e0e0",
} as const;

export const icons = {
  pass:    figures.tick,
  fail:    figures.cross,
  running: figures.pointer,
  pending: figures.circle,
  queued:  figures.ellipsis,
  brand:   figures.lozenge,
} as const;

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

export const lerpColor = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const clamp = Math.max(0, Math.min(1, t));
  return rgbToHex(
    Math.round(r1 + (r2 - r1) * clamp),
    Math.round(g1 + (g2 - g1) * clamp),
    Math.round(b1 + (b2 - b1) * clamp),
  );
};
