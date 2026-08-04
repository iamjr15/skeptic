# Doctor fix guide

This file is version-locked to the built-in Doctor registry. Inspect the exact
span and run `skeptic doctor why <id>` before changing behavior.

- `security/no-eval`: replace global `eval`/`Function` string execution with
  parsed data or an explicit command table.
- `security/no-dangerous-html`: render structured content or sanitize at a
  documented allowlist boundary. This rule is advisory because arbitrary
  sanitizer contracts cannot be proven statically.
- `security/auth-token-in-web-storage`: move credential tokens to Secure,
  HttpOnly, SameSite cookies and short-lived server sessions.
- `a11y/iframe-missing-sandbox`: add the smallest sandbox token set required;
  do not combine `allow-scripts` and `allow-same-origin` for untrusted content.
- `a11y/image-missing-alt`: add meaningful `alt`, or `alt=""` when the image is
  truly decorative.
- `performance/no-full-lodash-import`: use a native operation or direct
  per-function import in client code.
- `performance/no-moment`: use `Intl`, Temporal, date-fns, or dayjs according
  to the product's locale and timezone requirements.
- `correctness/no-array-index-key`: use a stable identity from the record so
  component state survives insertion and reordering.
- `performance/no-inline-list-callback`: hoist or memoize React Native
  `renderItem` with stable dependencies.
- `react-native/no-dimensions-get`: use `useWindowDimensions()` in components
  that must respond to rotation, split view, or resizing.
- `react-native/prefer-pressable`: migrate legacy Touchable components to
  Pressable while preserving role, label, hit slop, and feedback. Advisory.

Custom pattern rules and external analyzer IDs have no generic recipe; follow
the pack or analyzer's own help text.
