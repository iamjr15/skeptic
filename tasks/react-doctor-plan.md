# React Doctor Remaining Fixes — Implementation Plan (Revised v2)

**Current score: 96/100 | 35 warnings across 20/59 files**

Remaining warnings break down into 5 categories. This plan addresses each with
specific implementation details, file-by-file changes, and the correct ordering.

---

## Scanner Warning Checklist (source of truth)

Every warning from the last react-doctor scan, mapped to resolution:

### Missing metadata (11 warnings)
| # | File | Type | Resolution |
|---|---|---|---|
| M1 | `src/app/page.tsx` | Server component | Static metadata export |
| M2 | `src/app/projects/page.tsx` | Server component | Static metadata export |
| M3 | `src/app/sign-in/[[...sign-in]]/page.tsx` | Server component | Static metadata export |
| M4 | `src/app/sign-up/[[...sign-up]]/page.tsx` | Server component | Static metadata export |
| M5 | `src/app/github/callback/page.tsx` | Client component | Skip — transient OAuth redirect, SEO irrelevant |
| M6 | `src/app/projects/new/page.tsx` | Client component | Split to `_client.tsx` + server wrapper with static metadata |
| M7 | `src/app/projects/[id]/page.tsx` | Client component | Split to `_client.tsx` + `generateMetadata` |
| M8 | `src/app/projects/[id]/tests/page.tsx` | Client component | Split to `_client.tsx` + `generateMetadata` |
| M9 | `src/app/projects/[id]/runs/page.tsx` | Client component | Split to `_client.tsx` + `generateMetadata` |
| M10 | `src/app/projects/[id]/runs/[runId]/page.tsx` | Client component | Split to `_client.tsx` + `generateMetadata` |
| M11 | `src/app/projects/[id]/pull-requests/page.tsx` | Client component | Split to `_client.tsx` + `generateMetadata` |

Note: `settings/integrations/page.tsx` exists but was NOT flagged by the scanner (11 exact).

### Too many useState (10 warnings)
| # | File | useState count | Resolution |
|---|---|---|---|
| S1 | `src/app/projects/new/page.tsx` | 19 | useReducer (github + form) -> ~6 |
| S2 | `src/app/projects/[id]/settings/page.tsx` | 13 | useSaveStatus + useDeleteDialog hooks -> ~7 |
| S3 | `src/app/settings/page.tsx` | 12 | Group Slack status into object -> ~9. Accept warning. |
| S4 | `src/app/projects/[id]/page.tsx` | 7 | useDeleteDialog hook -> 4 |
| S5 | `src/components/test-suggestions-panel.tsx` | 7 | useReducer for generation state -> 4 |
| S6 | `src/app/projects/[id]/runs/page.tsx` | 6 | Adopt React Query (existing infra) -> 4 |
| S7 | `src/app/projects/[id]/tests/page.tsx` | 6 | Adopt React Query (existing infra) -> 4 |
| S8 | `src/components/step-player.tsx` | 7 | useReducer for image state -> 5 |
| S9 | `src/components/test-editor.tsx` | 7 | Accept — genuinely independent states |
| S10 | `src/components/debug-logs-panel.tsx` | 6 | Accept — well-structured as-is |

### Large components (6 warnings)
| # | File | Lines | Resolution |
|---|---|---|---|
| L1 | `src/app/projects/new/page.tsx` | 568 | Extract 5 sub-components -> ~200 |
| L2 | `src/components/step-player.tsx` | 509 | Extract 4 sub-components -> ~200 |
| L3 | `src/app/settings/page.tsx` | 415 | Extract SlackIntegration + 2 sections -> ~200 |
| L4 | `src/components/run-viewer.tsx` | 375 | Extract 3 sub-components -> ~200 |
| L5 | `src/app/projects/[id]/page.tsx` | 343 | Extract 3 sub-components -> ~180 |
| L6 | `src/app/projects/[id]/settings/page.tsx` | 369 | Extract 2 sub-components -> ~200 |

### Multiple setState in useEffect (5 warnings)
| # | File | Resolution |
|---|---|---|
| E1 | `src/components/run-viewer.tsx:53` | Partially reduce with inline useReducer for loading/error. Store setters remain (zustand). |
| E2 | `src/components/step-player.tsx:154` | Resolved by S8 — image reducer replaces 3 setState with 1 dispatch |
| E3 | `src/components/step-player.tsx:167` | Accept — setCurrentIndex + setIsPlaying are logically distinct |
| E4 | `src/components/branch-selector.tsx:31` | Accept — only 2 setState calls, minimal |
| E5 | `src/components/build-logs-panel.tsx:36` | Accept — expanded and expandedPhase are independent controls |

Note on E5: `expanded` and `expandedPhase` are independent controls (panel open/close vs
which phase is expanded). Deriving one from the other would break the toggle UX. Keep both.

### useEffect as event handler (1 warning)
| # | File | Resolution |
|---|---|---|
| H1 | `src/app/settings/page.tsx:92` | Accept — handles OAuth callback redirect via searchParams. Add comment. |

### useSearchParams Suspense (2 warnings — false positives)
| # | File | Resolution |
|---|---|---|
| P1 | `src/app/settings/page.tsx:50` | Already wrapped in Suspense. Scanner false positive. |
| P2 | `src/app/github/callback/page.tsx:10` | Already wrapped in Suspense. Scanner false positive. |

---

## Phase 1: Shared Hooks (do first — Phase 3 depends on these)

### 1.1 Create `useDeleteDialog` hook

**File:** `frontend/src/hooks/use-delete-dialog.ts` (new)

```typescript
import { useReducer } from "react";

type State = {
  open: boolean;
  confirm: string;
  deleting: boolean;
};

type Action =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "SET_CONFIRM"; value: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_SUCCESS" }
  | { type: "SUBMIT_ERROR" };

const initial: State = { open: false, confirm: "", deleting: false };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "OPEN":
      return { ...initial, open: true };
    case "CLOSE":
      return initial;
    case "SET_CONFIRM":
      return { ...state, confirm: action.value };
    case "SUBMIT_START":
      return { ...state, deleting: true };
    case "SUBMIT_SUCCESS":
      return initial;
    case "SUBMIT_ERROR":
      return { ...state, deleting: false };
  }
}

export function useDeleteDialog() {
  const [state, dispatch] = useReducer(reducer, initial);
  return { ...state, dispatch };
}
```

**Key design decision:** `SUBMIT_SUCCESS` closes the dialog. `SUBMIT_ERROR` keeps dialog
open with confirm text intact so user can retry. This matches current behavior.

**Consumers:** S4, S2

### 1.2 Create `useSaveStatus` hook

**File:** `frontend/src/hooks/use-save-status.ts` (new)

```typescript
import { useReducer, useEffect } from "react";

type State = { saving: boolean; error: string | null; success: boolean };

type Action =
  | { type: "SAVE_START" }
  | { type: "SAVE_SUCCESS" }
  | { type: "SAVE_ERROR"; error: string }
  | { type: "CLEAR_SUCCESS" };

const initial: State = { saving: false, error: null, success: false };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SAVE_START":
      return { saving: true, error: null, success: false };
    case "SAVE_SUCCESS":
      return { saving: false, error: null, success: true };
    case "SAVE_ERROR":
      return { saving: false, error: action.error, success: false };
    case "CLEAR_SUCCESS":
      return { ...state, success: false };
  }
}

export function useSaveStatus(autoClearMs = 3000) {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    if (!state.success) return;
    const t = setTimeout(() => dispatch({ type: "CLEAR_SUCCESS" }), autoClearMs);
    return () => clearTimeout(t);
  }, [state.success, autoClearMs]);
  return { ...state, dispatch };
}
```

**Consumer:** S2

### 1.3 No custom `useAsyncData` hook

The codebase already uses `@tanstack/react-query` with `QueryClientProvider` in
`providers.tsx` and query options defined in `lib/queries.ts`.

- **S6 and S7** -> Adopt `useQuery` with existing `runsQueryOptions` / `testCasesQueryOptions`
- **E1 (run-viewer)** -> Use inline `useReducer` for loading/error (SSE makes React Query awkward)
- Other components (debug-logs, build-logs, branch-selector) -> Keep as-is (not in warning list)

This avoids a parallel state management abstraction alongside React Query.

---

## Phase 2: Page Metadata (10 of 11 pages)

### 2.1 Static metadata — server component pages (4 pages: M1-M4)

Add `export const metadata: Metadata` directly. No file restructuring.

| Page | title | description |
|---|---|---|
| `src/app/page.tsx` | "skeptic — AI-Powered QA Testing" | "AI-powered QA testing that sees your app like a human. No selectors, no brittle scripts." |
| `src/app/projects/page.tsx` | "Projects — skeptic" | "Manage your QA testing projects" |
| `src/app/sign-in/[[...sign-in]]/page.tsx` | "Sign In — skeptic" | "Sign in to your skeptic account" |
| `src/app/sign-up/[[...sign-up]]/page.tsx` | "Sign Up — skeptic" | "Create your skeptic account" |

### 2.2 Static metadata — client component page (1 page: M6)

`src/app/projects/new/page.tsx`:
1. Create `_client.tsx` — move existing component as named export
2. `page.tsx` -> server component with static metadata + client import

### 2.3 Dynamic metadata — `[id]` pages (5 pages: M7-M11)

**Shared helper:** `src/lib/metadata-helpers.ts` (new)

```typescript
import { Metadata } from "next";

function getApiBaseUrl(): string {
  // Prefer server-only internal URL (private network, no auth needed)
  if (process.env.INTERNAL_API_URL) return process.env.INTERNAL_API_URL;
  // Allow public URL fallback only in development
  if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  // Production without INTERNAL_API_URL: skip fetch, use generic title
  return "";
}

async function getProjectName(id: string): Promise<string> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return "Project";
  try {
    const res = await fetch(`${baseUrl}/api/v1/projects/${id}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return "Project";
    const data = await res.json();
    return data.name || "Project";
  } catch {
    return "Project";
  }
}

export async function projectMetadata(id: string, pageTitle: string): Promise<Metadata> {
  const name = await getProjectName(id);
  return {
    title: `${pageTitle} — ${name} — skeptic`,
    description: `${pageTitle} for ${name}`,
  };
}
```

**Security decisions:**
- Uses `INTERNAL_API_URL` (server-only, NOT `NEXT_PUBLIC_`).
- `NEXT_PUBLIC_API_URL` fallback only in `NODE_ENV=development` (code enforces this).
- In production, if `INTERNAL_API_URL` is not set, skips fetch entirely — returns generic title.
- Does NOT make project endpoints public. Returns "Project" as generic fallback.
- No auth headers — crawlers won't have auth anyway. Generic title is acceptable.
- `revalidate: 60` caches to avoid hammering the API.

**Env provisioning step (add to each environment):**
- **Development:** `INTERNAL_API_URL=http://localhost:8000` in `frontend/.env.development`
- **Production:** `INTERNAL_API_URL=http://api:8000` (internal Docker network) in deployment config
- Do NOT use a public-facing URL for `INTERNAL_API_URL` — it should be an internal/private endpoint
- If `INTERNAL_API_URL` is not provisioned, metadata gracefully falls back to generic titles

**Next.js 15+ params pattern:**
```typescript
type Props = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return projectMetadata(id, "Overview");
}
```

**Pages (all follow same split pattern):**
| Page | Client export name | pageTitle | Params type |
|---|---|---|---|
| `projects/[id]/page.tsx` | `ProjectDetailClient` | "Overview" | `{ id: string }` |
| `projects/[id]/tests/page.tsx` | `TestCasesClient` | "Test Cases" | `{ id: string }` |
| `projects/[id]/runs/page.tsx` | `RunsClient` | "Test Runs" | `{ id: string }` |
| `projects/[id]/runs/[runId]/page.tsx` | `RunDetailClient` | "Run Results" | `{ id: string; runId: string }` |
| `projects/[id]/pull-requests/page.tsx` | `PullRequestsClient` | "Pull Requests" | `{ id: string }` |

### 2.4 Skipped: M5 (`github/callback/page.tsx` — transient OAuth redirect)

---

## Phase 3: useReducer Refactors (7 components changed, 3 accepted)

> Run AFTER Phase 2 — Phase 2 creates `_client.tsx` files, Phase 3 modifies them.
> Execute sequentially per file group.

### 3.1 `projects/new/_client.tsx` — S1 (19 useState -> ~7)

**GitHub state** -> `useReducer`:
```typescript
type GitHubState = {
  installations: GitHubInstallation[];
  installationsLoading: boolean;
  selectedInstallation: GitHubInstallation | null;
  repos: string[];
  repoLoading: boolean;
  selectedRepo: string;
  error: string | null;
};
// Actions: LOAD_INSTALLATIONS_START/SUCCESS, SELECT_INSTALLATION,
//   LOAD_REPOS_START/SUCCESS, SELECT_REPO, ERROR
```

**Form fields** -> `useReducer` with `SET_FIELD`:
```typescript
type FormState = {
  name: string; baseUrl: string; description: string;
  installCommand: string; startCommand: string; port: string; workingDirectory: string;
};
type FormAction = { type: "SET_FIELD"; field: keyof FormState; value: string };
```

**UI flow** (hostingMode, step, showGitHubSection, autoTestDeployments) -> 4 useState
**Submission** (isSubmitting) -> 1 useState

Net: 19 -> 2 useReducer + 5 useState = 7 state declarations.

### 3.2 `projects/[id]/settings/page.tsx` — S2 (13 -> ~7)

Note: This page was NOT in the metadata warning list (no M# entry), so it stays as
`page.tsx` — no `_client.tsx` split needed. Edit the existing file directly.

1. Save feedback -> `useSaveStatus()`. Removes 3 useState.
2. Delete flow -> `useDeleteDialog()`. Removes 3 useState.
3. Form fields (6) + initialized (1) -> Keep as 7 useState.

### 3.3 `settings/page.tsx` — S3 (12 -> ~9, accept warning)

Group Slack into one object. Add comment on OAuth useEffect. Accept warning.

### 3.4 `projects/[id]/_client.tsx` — S4 (7 -> 4)

Delete flow -> `useDeleteDialog()`. Keep error, triggering, selectedBranch.

### 3.5 `test-suggestions-panel.tsx` — S5 (7 -> 4)

Generation state -> inline useReducer. Keep suggestions, showPanel, acceptingIdx.

### 3.6 `projects/[id]/runs/_client.tsx` — S6 (6 -> 3+query)

Replace manual `runs/loading/error` useState + fetchRuns useEffect with:
```typescript
const { data: runs = [], isLoading, error, refetch } = useQuery(runsQueryOptions(projectId));
```

**Mutation refresh wiring:**
- After `handleTriggerRun` succeeds: call `refetch()` or `queryClient.invalidateQueries({ queryKey: ["projects", projectId, "runs"] })`
- `ErrorState onRetry`: pass `refetch` as the retry handler
- No other mutations on this page (runs are read-only here)

Keep triggering, selectedBranch, runFilter as 3 useState.

### 3.7 `projects/[id]/tests/_client.tsx` — S7 (6 -> 3+query)

Replace manual `testCases/loading/error` useState + fetchTestCases useEffect with:
```typescript
const queryClient = useQueryClient();
const { data: testCases = [], isLoading, error, refetch } = useQuery(testCasesQueryOptions(projectId));
```

**Mutation refresh wiring:**
- After test case create/delete/update: `queryClient.invalidateQueries({ queryKey: ["projects", projectId, "test-cases"] })`
- After accept suggestion: same invalidation
- `ErrorState onRetry`: pass `refetch` as the retry handler

Keep showEditor, expandedId, filter as 3 useState.

### 3.8 `step-player.tsx` — S8 (7 -> 5)

Image transition -> inline useReducer. Also resolves E2. Keep playback states (4 useState).

### 3.9-3.10: Accept S9 (test-editor) and S10 (debug-logs-panel)

---

## Phase 4: Component Splitting (6 components)

> Execute AFTER Phase 3. Run `npm run check` after each extraction.

### 4.1 `projects/new/_client.tsx` (568 -> ~200) — L1
Extract: `StepIndicator`, `ModeSelector`, `RepoSelector`, `BuildConfigForm`, `GitHubSection`

### 4.2 `step-player.tsx` (509 -> ~200) — L2
Extract: `Viewport`, `TransportControls`, `ActionsTimeline`, `ProgressBar`

### 4.3 `settings/page.tsx` (415 -> ~200) — L3
Extract: `SlackIntegration`, `AppearanceSection`, `AccountSection`

### 4.4 `run-viewer.tsx` (375 -> ~200) — L4
Extract: `RunHeader`, `RunStats`, `TestResultsTable`

### 4.5 `projects/[id]/_client.tsx` (343 -> ~180) — L5
Extract: `RecentRunsList`, `StatsGrid`, `DeleteProjectDialog`

### 4.6 `projects/[id]/settings/page.tsx` (369 -> ~200) — L6
Extract: `HostingSection`, `DangerZone`

---

## Phase 5: Verify Residuals

| Instance | Status |
|---|---|
| E1: run-viewer.tsx:53 | Partially reduced. Accept residual. |
| E2: step-player.tsx:154 | **Resolved** by S8. |
| E3: step-player.tsx:167 | **Accepted**. |
| E4: branch-selector.tsx:31 | **Accepted**. |
| E5: build-logs-panel.tsx:36 | **Accepted** — independent controls. |

---

## Execution Order (strictly sequential)

```
Phase 1: Shared hooks (2 new files, no conflicts)
  |
  v
Phase 2: Metadata (touches page.tsx files — creates _client.tsx splits)
  |   2.1: Static metadata (4 server pages)
  |   2.2: Static client split (1 page)
  |   2.3: Dynamic metadata + splits (5 pages)
  |   Run: npm run check
  v
Phase 3: useReducer refactors (touches _client.tsx files from Phase 2)
  |   Sequential per file. Run typecheck after each.
  v
Phase 4: Component splitting (structural extraction from Phase 3 results)
  |   Sequential per file. Run npm run check after each.
  v
Phase 5: Final react-doctor scan to verify score
```

---

## Expected Final Score — File-by-File Matrix

| File | Before | After | Residual warnings |
|---|---|---|---|
| `app/page.tsx` | metadata | 0 | — |
| `app/projects/page.tsx` | metadata | 0 | — |
| `app/sign-in/.../page.tsx` | metadata | 0 | — |
| `app/sign-up/.../page.tsx` | metadata | 0 | — |
| `app/github/callback/page.tsx` | metadata, Suspense(FP) | 2 | Skip metadata, Suspense FP |
| `app/projects/new/_client.tsx` | 19 useState, 568 lines | 0 | — |
| `app/projects/[id]/_client.tsx` | 7 useState, 343 lines | 0 | — |
| `app/projects/[id]/tests/_client.tsx` | 6 useState | 0 | — |
| `app/projects/[id]/runs/_client.tsx` | 6 useState | 0 | — |
| `app/projects/[id]/runs/[runId]/_client.tsx` | — | 0 | — |
| `app/projects/[id]/pull-requests/_client.tsx` | — | 0 | — |
| `app/projects/[id]/settings/page.tsx` | 13 useState, 369 lines | 1 | 7 useState (marginal) |
| `app/settings/page.tsx` | 12 useState, 415 lines, H1, P1 | 3 | 9 useState, H1, P1 (all accepted) |
| `components/step-player.tsx` | 7 useState, 509 lines, E2, E3 | 1 | E3 (accepted) |
| `components/test-suggestions-panel.tsx` | 7 useState | 0 | — |
| `components/run-viewer.tsx` | 375 lines, E1 | 1 | E1 (partially reduced) |
| `components/test-editor.tsx` | 7 useState | 1 | Accepted |
| `components/debug-logs-panel.tsx` | 6 useState | 1 | Accepted |
| `components/build-logs-panel.tsx` | E5 | 1 | Accepted |
| `components/branch-selector.tsx` | E4 | 1 | Accepted |

**Summary:**
| Metric | Before | After |
|---|---|---|
| Total warnings | 35 | ~12 |
| Files with warnings | 20 | ~10 |
| Expected score | 96 | 98-99 |

---

## New Files

| File | Purpose |
|---|---|
| `src/hooks/use-delete-dialog.ts` | Delete dialog state hook |
| `src/hooks/use-save-status.ts` | Save feedback state hook |
| `src/lib/metadata-helpers.ts` | Shared generateMetadata helper |
| 6x `_client.tsx` files | Client components split from pages (M6-M11; settings/page stays as-is) |
| ~18 sub-components in `_components/` folders | Phase 4 extractions |

## Risk Assessment

- **Low:** Phase 1, Phase 2.1, Phase 4
- **Medium:** Phase 2.2-2.3 (file boundary changes), Phase 3 (handler code changes)
- **Security:** `INTERNAL_API_URL` server-only. No project data exposed to unauthenticated.
- **Mitigation:** `cd frontend && npm run check` after each phase
