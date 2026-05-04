# skeptic Feature Gap Plan — Narrative Competitive Analysis

> **Date**: 2026-02-27
> **Context**: Features Narrative (trynarrative.com) has that skeptic doesn't, with research-backed implementation plans.

---

## Executive Summary

After thorough research of Narrative's product, the broader AI QA market, and skeptic's current capabilities, there are **8 major feature gaps**. Each is detailed below with the recommended implementation approach, third-party services to use, estimated effort, and priority.

| # | Feature | Priority | Effort | Key Service/Tool |
|---|---------|----------|--------|-----------------|
| 1 | No-Code Test Recording (Chrome Extension) | **P0** | Large | rrweb + Chrome Extension + LLM |
| 2 | AI Test Suggestions | **P0** | Large | Firecrawl + Gemini |
| 3 | Self-Healing / Anti-Flaky Tests | **P1** | Medium | LLM intent-based (already partial via Morph) |
| 4 | AI Visual Assertions | **P1** | Medium | Gemini Flash Vision + pixelmatch |
| 5 | Console Logs + Network Capture | **P1** | Medium | JS injection via Morph prompts |
| 6 | Mobile Web Testing | **P2** | Small | Morph viewport config |
| 7 | Email Flow Testing | **P2** | Medium | Mailosaur API |
| 8 | Org-Wide SSO + RBAC | **P2** | Medium-Large | Clerk Organizations |

Bonus features (not in Narrative but differentiators):
| # | Feature | Priority | Effort |
|---|---------|----------|--------|
| 9 | Role-Based Journey Testing | **P3** | Medium |
| 10 | Analytics Dashboard | **P3** | Medium |

---

## Feature 1: No-Code Test Recording (Chrome Extension)

### What It Is
Users click through their web app in a real browser, and skeptic automatically generates a natural-language test case from their interactions. Zero code, zero manual step writing.

### Why It Matters
- Narrative's #1 feature — "Write in product language or record steps"
- Dramatically lowers the barrier to test creation (from 10 min to 2 min per test)
- Captures real user behavior, not imagined test scenarios

### Recommended Architecture

```
Chrome Extension (rrweb + custom events)
    ↓ (WebSocket/batch upload)
skeptic Backend (event processor)
    ↓ (significant action extraction)
LLM Translation (Gemini)
    ↓ (natural language test case)
skeptic Test Case (pre-filled, editable)
```

### Implementation Plan

**Recording Layer — Chrome Extension:**
- Build a Chrome Extension (Manifest V3) that injects `@rrweb/record` into the target page
- Augment rrweb with a custom plugin to capture:
  - Element ARIA roles, labels, visible text, form labels
  - Page URL, title, heading hierarchy at each interaction
  - Screenshots at significant actions (via `chrome.tabs.captureVisibleTab()`)
- Filter events to "significant actions" only (clicks on interactive elements, form inputs, navigation, submissions)
- Stream events to skeptic backend via authenticated WebSocket

**Translation Layer — LLM:**
- For each significant action, build a context bundle:
  ```json
  {
    "action": "click",
    "element": {"role": "button", "text": "Add to Cart", "aria-label": "Add item to cart"},
    "page": {"url": "/products/123", "title": "Blue Widget - Store"},
    "screenshot_before": "base64...",
    "screenshot_after": "base64..."
  }
  ```
- Feed to Gemini with prompt: "Convert these browser interactions into a natural-language test case with title, steps, and expected results"
- Output: Pre-filled test case in skeptic's existing format

**Frontend Integration:**
- "Record a Test" button in skeptic dashboard
- Opens the target app URL with recording overlay enabled
- Real-time step preview as user interacts
- "Stop Recording" → Review generated test case → Save

### Third-Party Dependencies
| Service | Purpose | Cost |
|---------|---------|------|
| `@rrweb/record` (npm) | DOM event recording | Free (MIT) |
| Gemini API | Event-to-test-case translation | ~$0.01/test case |
| Chrome Web Store | Extension distribution | $5 one-time |

### Key Technical Decisions
1. **rrweb over raw event listeners** — battle-tested (19K stars), plugin system, handles edge cases (SPA navigation, dynamic content)
2. **Chrome Extension over injected script** — works with any deployed URL, no code changes needed in the target app
3. **LLM translation over rule-based** — produces natural language that Morph can later execute, handles varied UI patterns gracefully
4. **Capture multiple element identifiers** — role, text, aria-label, testid, CSS path → LLM picks the most human-readable description

### Risks
- Shadow DOM and iframe recording fidelity (rrweb known limitation)
- Extension approval process (1-2 weeks for Chrome Web Store)
- Event volume filtering (raw rrweb = 1000s of events/min, need smart filtering)

---

## Feature 2: AI Test Suggestions

### What It Is
skeptic proactively suggests test cases the user hasn't written, by analyzing the app and identifying untested features and critical paths.

### Why It Matters
- Narrative's "Get new test suggestions" feature — AI suggests new tests, sync to calendar
- Moves skeptic from reactive (user writes tests) to proactive (AI finds gaps)
- Directly improves test coverage without user effort

### Recommended Architecture

```
                    ┌──────────────┐
                    │  PR Webhook  │
                    │ (GitHub)     │
                    └──────┬───────┘
                           │
┌──────────────┐  ┌───────┴────────┐  ┌──────────────┐
│ Site Crawler │  │ Diff Analyzer  │  │ Existing     │
│ (Firecrawl)  │→ │ (PR changes)   │→ │ Test Cases   │
└──────┬───────┘  └───────┬────────┘  └──────┬───────┘
       │                  │                   │
       └──────────┬───────┘───────────────────┘
                  ↓
    ┌─────────────────────────┐
    │ Feature Inference Engine │
    │ (LLM: Gemini)           │
    │ - Infer features        │
    │ - Map changes → features│
    │ - Find coverage gaps    │
    └────────────┬────────────┘
                 ↓
    ┌─────────────────────────┐
    │ Priority Ranker          │
    │ - Auth/payment flows    │
    │ - Change recency        │
    │ - Coverage gap size     │
    └────────────┬────────────┘
                 ↓
    ┌─────────────────────────┐
    │ Suggestions UI           │
    │ - Ranked test ideas     │
    │ - One-click "Create"    │
    │ - PR comment posting    │
    └─────────────────────────┘
```

### Implementation Plan

**Phase 1 — Site Discovery + Feature Inference (MVP):**
1. When user triggers "Suggest Tests" or on project setup, crawl the deployed app using **Firecrawl**
   - `/map` endpoint → full URL inventory
   - `/scrape` per URL → page structure (forms, buttons, links, navigation)
2. Feed site model to Gemini: "Given this site structure, infer all user-facing features and suggest test cases for each"
3. Compare suggestions against existing test cases (embedding similarity via Gemini embeddings)
4. Display ranked suggestions in the UI with "Create Test" action

**Phase 2 — PR Diff Awareness:**
1. On PR webhook, fetch diff via GitHub API
2. Parse changed files to identify new routes, modified components, changed forms
3. Map changes to features → suggest tests specifically for the delta
4. Post suggestions as GitHub PR comment

**Phase 3 — Continuous Monitoring:**
1. Re-crawl periodically (nightly or on-demand)
2. Detect new features added since last crawl
3. Auto-suggest tests before PRs are opened

### Priority Scoring Algorithm
```python
def compute_priority(feature: DiscoveredFeature) -> float:
    score = 0.0
    if feature.involves_forms:        score += 3.0  # Data mutation
    if feature.involves_auth:         score += 4.0  # Security critical
    if feature.involves_payment:      score += 5.0  # Revenue critical
    if feature.is_primary_navigation: score += 2.0  # Core UX
    if feature.recently_changed:      score += 2.0  # Recent = more bugs
    if feature.crosses_pages:         score += 2.0  # Multi-page flows break more
    if feature.no_existing_test:      score += 3.0  # Completely untested
    return score
```

### Third-Party Dependencies
| Service | Purpose | Cost |
|---------|---------|------|
| Firecrawl | Site crawling + structured extraction | Free tier (500 credits/mo), then $19/mo |
| Gemini API | Feature inference + test generation | ~$0.05/crawl |
| Gemini Embeddings | Test case ↔ feature similarity matching | ~$0.001/comparison |

### Key References
- **AutoE2E** (ICSE 2025) — 79% feature coverage via LLM-driven discovery
- **CoverUp** (FSE 2025) — coverage-guided iterative test generation
- **Sentry AI** — PR-triggered test generation using production error data

---

## Feature 3: Self-Healing / Anti-Flaky Tests

### What It Is
When UI changes (new selectors, layout changes, timing issues), tests automatically adapt instead of failing. Only actual bugs cause failures.

### Why It Matters
- Narrative's "Goodbye flaky tests" — their #3 feature
- #1 pain point in E2E testing industry (test maintenance cost)
- Without self-healing, test suites become unmaintainable at scale

### skeptic's Current Position
**skeptic is already 70% there.** Because Morph Browser SDK uses AI (computer-use model) to interpret natural-language instructions at runtime, it doesn't rely on fixed CSS selectors. It finds elements fresh each run based on intent. This is "Pattern C: Intent-Based Testing" — the most resilient approach.

### What's Missing (the 30%)

1. **Change detection scoring** — distinguish "UI changed, same functionality" from "actual bug"
2. **Confidence reporting** — "healed" state between pass/fail
3. **Element fingerprinting** — track which elements Morph interacted with across runs
4. **Visual baseline comparison** — verify page looks the same despite DOM changes

### Implementation Plan

**Step 1 — Accessibility Tree Snapshots:**
- After each Morph test step, capture the page's accessibility tree
- Store as baseline on first successful run
- Compare on subsequent runs: if >80% structural similarity but target element changed → "healed"

**Step 2 — Three-State Results:**
- Add `healed` status alongside `passed` and `failed`
- `healed` = test passed but the AI had to adapt to UI changes
- Show healing history in the test results UI → early warning of UI drift

**Step 3 — Element Fingerprinting:**
- When Morph successfully interacts with an element, capture: role, text, aria-label, position, parent context
- On subsequent runs, compare fingerprints to assess whether the AI found the "same" element
- If fingerprint similarity < threshold → flag as potential issue

**Step 4 — LLM-as-Healer Fallback:**
- If Morph fails on a step, capture current page accessibility tree
- Send to Gemini: "The test was trying to [action] on [element description]. Here is the current page. Is this element still present under a different name/position, or is it actually missing?"
- If healed → retry with LLM guidance; if genuinely missing → fail

### Third-Party Dependencies
- None new — uses existing Morph SDK + Gemini API

### Key Insight
Most competitors (Testim, Mabl, Healenium) solve self-healing at the **locator level** — fixing CSS selectors. skeptic can skip this entirely because Morph has no locators. Instead, focus on the **semantic level** — confirming that the test's intent was fulfilled despite UI changes.

---

## Feature 4: AI Visual Assertions

### What It Is
AI automatically verifies how the product **looks and works** — not just functional pass/fail, but visual correctness (layout, styling, content).

### Why It Matters
- Narrative's "Verify with AI assertions" — their #2 feature
- Catches visual regressions that functional tests miss (broken layouts, overlapping elements, wrong colors)
- No manual baseline management needed with LLM vision

### Recommended Architecture: Hybrid LLM Vision + Pixel Diff

```
                    Screenshot captured by Morph
                              ↓
                  ┌───────────┴───────────┐
                  │  Fast Pixel Comparison │ (SSIM / pixelmatch)
                  │  Against baseline      │
                  └───────────┬───────────┘
                              │
               ┌──────────────┴──────────────┐
               │                              │
         SSIM ≥ 0.95                   SSIM < 0.95
         (no change)                   (change detected)
               │                              │
               ↓                              ↓
          ✅ Pass                    ┌────────────────┐
                                    │ LLM Vision      │
                                    │ (Gemini Flash)   │
                                    │ Semantic analysis│
                                    └────────┬────────┘
                                             │
                                    ┌────────┴────────┐
                                    │                  │
                              Intentional         Regression
                              change              detected
                                    │                  │
                                    ↓                  ↓
                              ✅ Pass            ❌ Fail + report
```

### Implementation Plan

**Tier 1 — LLM Vision Assertions (immediate value):**
- After each test step, send the Morph screenshot to Gemini Flash Vision with prompt:
  ```
  You are a QA engineer reviewing this screenshot.
  Test case: "{test_case_description}"
  Current step: "{step_description}"
  Expected: "{expected_outcome}"

  Analyze the screenshot and return JSON:
  {
    "passed": boolean,
    "confidence": 0.0-1.0,
    "issues": ["list of visual issues found"],
    "description": "what you see"
  }
  ```
- Store assertion results alongside existing test step data
- New `visual_assertion` Temporal activity

**Tier 2 — Baseline Regression Detection:**
- On first successful run, store "golden" screenshots per step in GCS
- On subsequent runs, fast-compare with `pixelmatch-py` or SSIM
- Only route flagged changes (SSIM < 0.95) to the LLM for semantic analysis
- This saves cost: most runs will have no visual changes

**Tier 3 — Visual Diff UI:**
- Side-by-side comparison viewer in the frontend (baseline vs current)
- Highlighted diff regions
- Approve/reject workflow for intentional visual changes

### Third-Party Dependencies
| Service | Purpose | Cost |
|---------|---------|------|
| Gemini Flash Vision | Semantic screenshot analysis | ~$0.01/screenshot |
| `pixelmatch-py` (pip) | Fast pixel comparison | Free (ISC) |
| `SSIM-PIL` (pip) | Structural similarity | Free (MIT) |
| `Pillow` (pip) | Image processing | Free (MIT) |

### Cost Estimate
- 30 steps × 10 tests = 300 screenshots per run
- With Tier 2 filtering (only flagged changes go to LLM): ~$0.50-3.00 per run
- Without filtering (all to LLM): ~$3-9 per run (Gemini Flash)

---

## Feature 5: Console Logs + Network Activity Capture

### What It Is
Auto-capture console output (logs, errors, warnings) and network requests during test execution as debug artifacts.

### Why It Matters
- Narrative's "Fix bugs faster" — console logs, network activity, video in one place
- Engineers need these to debug test failures (not just "it failed" but "why")
- Currently skeptic only has screenshots and video — missing the two most important debug signals

### The Challenge
Morph Browser SDK operates a managed remote browser. skeptic can't directly attach CDP sessions or Playwright page event listeners to Morph's browser.

### Recommended Approach: JavaScript Injection via Morph Prompts

**Console Log Capture:**
1. Before each Morph test task, prepend an instruction:
   ```
   Before starting the test, run this JavaScript in the browser console:

   (function() {
     window.__skeptic_logs = [];
     ['log','warn','error','info','debug'].forEach(m => {
       const orig = console[m].bind(console);
       console[m] = function(...args) {
         window.__skeptic_logs.push({
           type: m,
           message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
           timestamp: Date.now()
         });
         orig.apply(console, args);
       };
     });
     window.addEventListener('error', e => {
       window.__skeptic_logs.push({type:'exception', message:e.message, timestamp:Date.now()});
     });
   })();
   ```
2. After test completion, add an extraction step:
   ```
   Run this JavaScript and report the result: JSON.stringify(window.__skeptic_logs)
   ```
3. Parse the response and store as `console-logs.json` in GCS

**Network Activity Capture:**
1. Similarly inject a `PerformanceObserver` or `fetch`/`XMLHttpRequest` interceptor:
   ```javascript
   (function() {
     window.__skeptic_network = [];
     const origFetch = window.fetch;
     window.fetch = async function(...args) {
       const start = Date.now();
       const url = typeof args[0] === 'string' ? args[0] : args[0].url;
       const method = args[1]?.method || 'GET';
       try {
         const res = await origFetch.apply(this, args);
         window.__skeptic_network.push({
           url, method, status: res.status, duration: Date.now() - start, failed: false
         });
         return res;
       } catch(e) {
         window.__skeptic_network.push({
           url, method, status: 0, duration: Date.now() - start, failed: true, error: e.message
         });
         throw e;
       }
     };
   })();
   ```
2. Extract after test: `JSON.stringify(window.__skeptic_network)`
3. Store as `network-log.json` in GCS

**Alternative — Morph debug_url CDP access:**
- If Morph's `debug_url` exposes a CDP WebSocket endpoint, connect a lightweight Python CDP client during test execution
- Capture `Runtime.consoleAPICalled` and `Network.*` events in parallel
- This is cleaner but depends on Morph exposing CDP access (needs investigation)

### Frontend Display
- Add tabs to the test result detail view: **Steps | Console | Network | Video | Screenshots**
- Console tab: filterable log list (log/warn/error) with color coding and timestamps
- Network tab: request list with method, URL, status, duration, expandable headers/body

### Third-Party Dependencies
- None new — uses JS injection via existing Morph task prompts + GCS storage

---

## Feature 6: Mobile Web Testing

### What It Is
Test responsive/mobile versions of web apps across different device viewports and user agents.

### Why It Matters
- Narrative's "What can you test?" section shows "Mobile web" as a capability
- Mobile traffic is 50%+ for most web apps — mobile bugs are high-impact
- Easy win — low effort, high value

### Implementation Plan
- Add a `device_profile` field to the test case model (optional)
- Pre-define popular device profiles:
  ```python
  DEVICE_PROFILES = {
      "iphone_14": {"width": 390, "height": 844, "user_agent": "Mozilla/5.0 (iPhone...)", "is_mobile": True},
      "pixel_7": {"width": 412, "height": 915, "user_agent": "Mozilla/5.0 (Linux; Android...)", "is_mobile": True},
      "ipad_pro": {"width": 1024, "height": 1366, "user_agent": "Mozilla/5.0 (iPad...)", "is_mobile": True},
      "desktop_1080p": {"width": 1920, "height": 1080, "user_agent": "...", "is_mobile": False},
  }
  ```
- Pass viewport/UA configuration to Morph task parameters
- Frontend: device selector dropdown when creating/editing test cases

### Effort: Small (1-2 days)
- Schema migration: add `device_profile` column to test_cases table
- Backend: pass device config to Morph task creation
- Frontend: device selector component

---

## Feature 7: Email Flow Testing

### What It Is
Test email-dependent flows (signup confirmations, password resets, OTP/2FA codes) end-to-end.

### Why It Matters
- Narrative's "What can you test?" shows "Emails" as a capability
- Many critical user flows involve email (onboarding, password reset, notifications)
- Currently impossible to test in skeptic — a gap in E2E coverage

### Recommended Service: Mailosaur

```python
# pip install mailosaur
from mailosaur import MailosaurClient
from mailosaur.models import SearchCriteria

client = MailosaurClient("MAILOSAUR_API_KEY")

# Wait for email after triggering it in the app
criteria = SearchCriteria()
criteria.sent_to = f"test@{SERVER_ID}.mailosaur.net"
email = client.messages.get(SERVER_ID, criteria, timeout=30000)

# Extract OTP code
otp = email.html.codes[0].value

# Extract verification link
link = next(l for l in email.html.links if "verify" in l.href)
```

### Implementation Plan
1. Add `email_verification` step type to test case model
2. New Temporal activity: `verify_email_activity`
   - Calls Mailosaur API to wait for and retrieve email
   - Extracts OTP codes, verification links, or validates content
   - Returns extracted data to the next Morph task step
3. Store `MAILOSAUR_API_KEY` and `MAILOSAUR_SERVER_ID` as project-level secrets
4. Multi-step test workflow: Morph action → email verification → Morph continues with extracted data

### Third-Party Dependencies
| Service | Purpose | Cost |
|---------|---------|------|
| Mailosaur | Email inbox API + OTP extraction | From $9/mo (paid), free trial |

---

## Feature 8: Org-Wide SSO + RBAC

### What It Is
Team-based access control: organizations, roles (admin/tester/viewer), permissions, and enterprise SSO.

### Why It Matters
- Narrative's "Security and compliance" shows: Org-wide SSO and role-based access
- Required for enterprise adoption — teams need access control
- Without it, all users see all projects (data isolation issue)

### Implementation Plan: Clerk Organizations

**Phase 1 — Basic Organizations:**
1. Enable Organizations in Clerk Dashboard
2. Add `organization_id` column to: projects, test_cases, runs, test_results
3. Extract `org_id` from Clerk JWT in FastAPI middleware
4. Scope all DB queries by `organization_id`
5. Add `<OrganizationSwitcher />` to frontend sidebar

**Phase 2 — RBAC:**
```
Roles:
  org:owner  → all permissions
  org:admin  → projects:*, runs:*, members:manage, settings:manage
  org:tester → projects:read, runs:execute, runs:read, results:read
  org:viewer → projects:read, results:read (read-only)

Permissions:
  org:projects:create, org:projects:read, org:projects:update, org:projects:delete
  org:runs:execute, org:runs:read, org:runs:cancel
  org:results:read
  org:settings:manage
  org:members:manage
```

Frontend: `<Protect permission="org:projects:create">` guards
Backend: `require_permission("org:projects:create")` dependencies

**Phase 3 — Enterprise SSO:**
- Clerk supports SAML SSO out of the box (Okta, Azure AD, Google Workspace)
- Zero custom code — configured per organization in Clerk Dashboard
- Requires Clerk Enterprise plan

### Third-Party Dependencies
| Service | Purpose | Cost |
|---------|---------|------|
| Clerk Organizations | Multi-tenant RBAC | Included in Clerk Pro ($25/mo) |
| Clerk Enterprise SSO | SAML/OIDC SSO | Clerk Enterprise plan |

---

## Narrative's "What Can You Test?" — Full Coverage Analysis

From the screenshot, Narrative advertises testing capabilities for 9 categories:

| Category | Narrative | skeptic Today | Gap | Fix |
|----------|-----------|-------------|-----|-----|
| Onboarding flow | ✅ | ✅ (natural language tests) | None | — |
| Checkout experience | ✅ | ✅ | None | — |
| Search and filter | ✅ | ✅ | None | — |
| Analytics dashboard | ✅ | ✅ | None | — |
| Visual quality | ✅ | ❌ | **Gap** | Feature 4 (AI Visual Assertions) |
| Mobile web | ✅ | ❌ | **Gap** | Feature 6 (Device profiles) |
| Emails | ✅ | ❌ | **Gap** | Feature 7 (Mailosaur) |
| Uploads and downloads | ✅ | ⚠️ Partial | Minor | Morph can handle with prompt engineering |
| Role-based journeys | ✅ | ❌ | **Gap** | Multi-step journeys with per-step credentials |

---

## Narrative's Security & Compliance — Gap Analysis

| Feature | Narrative | skeptic Today | Gap |
|---------|-----------|-------------|-----|
| Encrypted in transit + at rest (TLS 1.3 / AES-256) | ✅ | ✅ (Neon + GCS handle this) | None |
| Org-wide SSO + role-based access | ✅ | ❌ | **Gap** → Feature 8 |
| SOC 2 Type II audit | 🔄 In progress | ❌ | Future consideration |

---

## Recommended Implementation Order

### Sprint 1-2 (Quick Wins)
1. **Mobile Web Testing** (Feature 6) — 1-2 days, high visible impact
2. **Console + Network Capture** (Feature 5) — 3-5 days, JS injection approach

### Sprint 3-4 (Core Differentiators)
3. **AI Visual Assertions** (Feature 4) — 1 week, LLM vision + pixelmatch
4. **Self-Healing Enhancements** (Feature 3) — 1 week, three-state results + fingerprinting

### Sprint 5-8 (Major Features)
5. **AI Test Suggestions** (Feature 2) — 2-3 weeks, Firecrawl + Gemini pipeline
6. **No-Code Test Recording** (Feature 1) — 3-4 weeks, Chrome Extension + rrweb + LLM

### Sprint 9-10 (Enterprise Readiness)
7. **Email Flow Testing** (Feature 7) — 1 week, Mailosaur integration
8. **Org-Wide SSO + RBAC** (Feature 8) — 2-3 weeks, Clerk Organizations migration

---

## Third-Party Service Summary

| Service | Features Using It | Monthly Cost Estimate |
|---------|------------------|----------------------|
| **Firecrawl** | AI Test Suggestions | $19/mo (Starter) |
| **Mailosaur** | Email Testing | $9/mo (Starter) |
| **Gemini Flash API** | Visual Assertions, Test Suggestions, Recording Translation | $5-20/mo (usage-based) |
| **rrweb** (npm) | Test Recording | Free (MIT) |
| **pixelmatch-py** (pip) | Visual Regression | Free (ISC) |
| **Clerk Organizations** | SSO + RBAC | Included in current plan |
| **Chrome Web Store** | Extension distribution | $5 one-time |

**Total estimated additional cost: ~$35-50/month** (mostly Firecrawl + Mailosaur)

---

## What skeptic Has That Narrative Doesn't (Keep Investing)

These are competitive advantages skeptic should continue to strengthen:

1. **GitHub deep integration** — PR-triggered runs, check runs, PR comments, diff-powered testing
2. **App hosting / auto-build** (Daytona) — zero-setup: clone, build, serve, test
3. **PR diff analysis** — intelligent test scoping based on what changed
4. **API key management** — programmatic CI/CD access
5. **Step-by-step execution viewer** — granular visibility with screenshots per step
6. **Slack notifications** — team-level alerting on test results
