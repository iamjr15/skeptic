# QA playbook

## Plan from risk, not the happy path

Identify the user promise, state transitions, trust boundaries, and irreversible
effects. Start with a smoke path, then vary the inputs most likely to reveal a
fault: empty, minimum, maximum, malformed, duplicated, delayed, reordered,
expired, unauthorized, offline, and interrupted. Seed data that differentiates
records visibly; identical fixtures hide selection and persistence bugs.

For forms, verify keyboard-only submission, focus movement, error association,
error recovery, double submission, paste, Unicode, and server rejection. For
navigation, verify direct entry, refresh, back/forward, nested routes, and stale
sessions. For auth, test signed-out, insufficient role, expired session, and
safe redirect handling without exposing credentials.

## Seven-viewport quality pass

When layout risk is material, inspect at representative widths: 320, 375, 430,
768, 1024, 1440, and one unusually wide viewport. Check overflow, clipped text,
sticky elements, keyboard focus, touch targets, content order, readable line
length, and motion reduction. Do not declare responsive quality from a single
desktop screenshot.

## Evidence hierarchy

Prefer semantic snapshots for structure, screenshots for appearance, console
and network sidecars for runtime causality, accessibility audit output for rule
coverage, traces for timing, and video for temporal bugs. A successful command
proves only that the command completed—not that the product behaved correctly.

Classify failures as product defect, test defect, environment/tooling failure,
policy block, unsupported capability, or flaky/unsettled state. Preserve the
smallest sequence that reproduces the failure and note what was actually
observed. Never turn an unavailable capability into a pass.

## Adversarial pass

- Repeat mutating actions to find duplicate side effects.
- Navigate away during an in-flight operation.
- Use long, RTL, emoji, and combining-character text.
- Remove network connectivity and retry.
- Trigger simultaneous validation errors.
- Verify destructive actions require explicit authority.
- Verify logs, HAR, screenshots, and reports do not leak secrets.

No completion claim without fresh evidence from the current build.
