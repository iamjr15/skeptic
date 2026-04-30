// Dynamic imports are intentionally NOT detected by the regex extractor — documents the
// known limitation. Coverage is a hint, not a correctness layer.
export const dyn = (variant: string) => import(`./b-${variant}`);
