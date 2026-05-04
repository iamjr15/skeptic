# Maestro + Expect Feature Adoption — Todo

## Prerequisites
- [x] P1. Add `sourceDir` to ExecutionContext
- [x] P2. Extract `executeNestedSteps()` helper
- [x] P3. Inject AIClient into execution pipeline

## Phase 1: Foundation
- [x] F1. Workspace-level hooks (config schema + flowToInput + engine)
- [x] F4. Adversarial AI prompts
- [x] F8. New step types (back, doubleClick, hover, copyTextFrom)
- [x] F9. Visual regression diff images (already works — diff-*.png generated)

## Phase 2: Core Commands
- [x] F2. Step-level retry block
- [x] F3. Diff-aware --target modes (--diff boolean + --target changes|unstaged|branch)
- [x] F6. scrollUntilVisible
- [x] F12. executionOrder config (flowsOrder + sorting in test.ts)
- [x] F13. Browser permissions (setPermissions)
- [x] F14. Geolocation mocking (setLocation)
- [x] F15. Clock manipulation (travel)

## Phase 3: JavaScript & AI
- [x] F5. JavaScript integration (runScript/evalScript + sandbox + faker)
- [x] F16. Multi-agent AI providers (openai, anthropic clients + factory + interface)

## Phase 4: UX & Polish
- [x] F7. Interactive TUI plan review (-y/--yes flag added, CI detection wired)
- [x] F11. Saved flows (-f flag + slug utility + generate --save)
- [x] F17. audit command
- [x] F18. Session replay (--trace flag wired to EngineOptions)

## Review
- [x] TypeScript compiles with zero errors
- [x] All 155 tests pass
- [ ] Playwright tracing implementation in engine (--trace flag wired, engine code pending)
- [ ] TUI review screen components (deferred — infrastructure wired)
