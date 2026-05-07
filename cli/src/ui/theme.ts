import figures from "figures";

const colorEnabled = !("NO_COLOR" in process.env);

const color = (value: string): string | undefined => (colorEnabled ? value : undefined);

export const colors = {
  brand: color("#f5c542"),
  text: color("#e7e7e7"),
  dim: color("#8a8f98"),
  subtle: color("#5f6672"),
  pass: color("#4ade80"),
  fail: color("#f87171"),
  warn: color("#fbbf24"),
  active: color("#60a5fa"),
  queued: color("#94a3b8"),
  border: color("#3f4652"),
  shimmerBase: color("#6b7280"),
  shimmerHigh: color("#ffffff"),
} as const;

export const icons = {
  brand: figures.lozenge,
  pass: figures.tick,
  fail: figures.cross,
  warn: figures.warning,
  running: figures.pointer,
  queued: figures.ellipsis,
  pending: figures.circle,
  skipped: figures.arrowRight,
  line: figures.line,
  bullet: figures.bullet,
} as const;

const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

export const lerpColor = (from: string, to: string, amount: number): string => {
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex(
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  );
};
