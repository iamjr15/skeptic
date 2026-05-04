# Morph Ecosystem Research -- February 2026

## Executive Summary

Morph Labs (morphllm.com / morph.so) has evolved from a single "Fast Apply" model into a full platform with **three product lines**: Morph LLM (coding agent subagents), Morph Glance (GitHub PR testing), and Morph Cloud (Infinibranch VM infrastructure). Our skeptic project currently uses **only the raw REST API for browser task execution**. There are significant features we are not leveraging.

---

## 1. Morph Glance -- GitHub PR Testing Product

**URL**: https://morphllm.com/products/glance
**Docs**: https://docs.morphllm.com (under "Glance" in sidebar)

### What It Is

Glance is a **GitHub App** that automatically tests PRs in a real browser and embeds video recordings, screenshots, and error logs directly into PR comments. It reads the PR diff to determine what to test -- no manual test scripts needed.

### Key Features
- **Diff-powered testing**: Reads the PR diff and auto-determines test targets using React Fiber tree introspection (maps changed files to rendered DOM elements with bounding boxes)
- **Video recordings (MP4/WebM)** embedded in PR comments
- **Animated WebP** for Slack/Notion embedding
- **Console errors** and **network logs** captured
- **BYO browser support**: Works with managed browsers OR Playwright, Puppeteer, Browserbase
- **Free for open source repos**
- **$10/month in free compute** for private repos

### SDK Integration (NEW -- we are NOT using this)

```typescript
const morph = new MorphClient({ apiKey });

const task = await morph.browser.createTask({
  diff: prDiff,           // <-- NEW: Pass the PR diff!
  url: 'https://staging.myapp.com',
  recordVideo: true,
  maxSteps: 30,
});

const recording = await morph.browser.getRecording(task.recordingId);
const webp = await recording.getWebp();
```

### Relevance to skeptic

**HIGH**. Glance is essentially what skeptic does for PR testing, but offered as a turnkey GitHub App. We could:
1. **Adopt the `diff` parameter** in our `create_task` calls to enable diff-powered testing intelligence
2. **Use Glance's GitHub App** as a complementary lightweight option alongside skeptic's deeper workflow
3. **Study their React Fiber approach** for identifying changed components (described in their RL blog post)

---

## 2. Morph Cloud -- Infinibranch Infrastructure

**URL**: https://cloud.morph.so
**Docs**: https://cloud.morph.so/docs
**Python SDK**: `pip install morphcloud` (v0.1.104+, actively maintained)

### What It Is

Morph Cloud provides VM infrastructure with "Infinibranch" technology that enables:
- **<250ms startup times** (vs 2-3 minutes for traditional VMs)
- **Instant snapshot, branch, and restore** of entire computational environments
- **Near-zero overhead branching** (no full clone required)
- **Built-in remote desktop** accessible through browser
- **OCI compatible** -- run any Docker container

### Infinibranch Browsers (NEW Product)

**URL**: https://cloud.morph.so/web/product/browsers

A **serverless Chromium runtime** that is separate from the browser automation API we use:
- **$0.07 per browser-hour** (billed by the second)
- Self-serve **up to 1024 concurrent browsers**
- Single API call returns **CDP and Playwright/Puppeteer connection URLs**
- **Live-branching**: Fork running sessions and explore different paths without losing auth state
- **Session Replay**: Deterministic replay of sessions
- **Infinite session persistence**: Snapshot, pause, resume workflows over hours/days
- **Live View**: Monitor and control sessions in real-time

### Morph Cloud Pricing

| Plan | Price | Starting Credits (MCUs) | Max vCPU | Max RAM |
|------|-------|------------------------|----------|---------|
| Developer (Free) | $0/mo | 300 MCUs | 64 vCPU | 256 GB |
| Team | $40/mo | 1000 MCUs | 256 vCPU | 1024 GB |
| Scale | $250/mo | 7500 MCUs | 1024 vCPU | 4096 GB |

1 MCU = 1 vCPU-hour + 4 GB RAM-hours + 16 GB disk-hours

### Relevance to skeptic

**MEDIUM-HIGH**. Morph Cloud could **replace Daytona** for test environment management:
- Infinibranch browsers could replace our Morph browser API usage with direct CDP/Playwright control
- Snapshot branching enables instant parallel test environments from a single base state
- The `morphcloud` Python SDK is well-maintained and could integrate with our Temporal workflows
- **Live-branching browsers** would let us fork an authenticated browser state for parallel test case execution -- massive performance improvement

**Potential architecture**: Use Morph Cloud to provision the app hosting environment (replacing Daytona) and Infinibranch Browsers for test execution (replacing the browser.morphllm.com API).

---

## 3. Model Options for Browser Automation

### Available Models (from docs.morphllm.com)

| Model | Input Cost | Output Cost | Speed | Best For |
|-------|-----------|-------------|-------|----------|
| **morph-computer-use-v1** | $0.30/1M | $1.50/1M | 200 tok/s | Browser automation (default) |
| morph-computer-use-v0 | $0.30/1M | $1.50/1M | 200 tok/s | Browser automation (legacy) |
| gemini-3-flash-preview | $0.50/1M | $3.00/1M | 90 tok/s | External API (Google) |
| claude-sonnet-4.5 | $3.00/1M | $15.00/1M | 60 tok/s | General reasoning |

### Analysis

We currently use **morph-computer-use-v1** which is correct -- it is the default, fastest, and cheapest option.

**morph-computer-use-v1** is trained with **reinforcement learning specifically for UI verification**:
- Blog post "Learning to Test Code Changes with RL" (Jan 2026) details their reward policy
- Uses React Fiber tree to map diffs to rendered DOM elements with bounding boxes
- Reward signal based on: bringing modified components into viewport + interacting with them
- The `coverage` field tracks what % of each changed component is visible

**gemini-3-flash-preview** might be worth evaluating as a fallback for complex reasoning tasks (2x cost but uses Google's newer model). Requires `GOOGLE_API_KEY` on the server.

### Recommendation
**Stay with morph-computer-use-v1** as default. Consider adding `gemini-3-flash-preview` as an optional model for test cases requiring more complex reasoning about app state.

---

## 4. Auth Parameter -- Per-Domain Credential Support (NEW)

### What We Are Missing

Our `MorphTaskConfig` does **NOT** include the `auth` parameter. The Morph API now supports three auth modes:

### 4a. Basic Username/Password

```typescript
const result = await morph.browser.execute({
  task: "Log in with x_user and x_pass, then verify dashboard",
  url: "https://myapp.com/login",
  auth: {
    username: "test@example.com",
    password: "secret123"
  }
});
```

The agent sees placeholders (`x_user`, `x_pass`) in the task. Real values are injected when filling forms.

### 4b. Per-Domain Credentials

```typescript
auth: {
  "https://*.staging.myapp.com": {
    username: "staging-user",
    password: "staging-pass"
  },
  "https://api.external.com": {
    username: "api-user",
    password: "api-key"
  }
}
```

Scope credentials to specific domains -- useful when the app under test talks to external services.

### 4c. Cookie-Based Auth (Skip Login Entirely)

```typescript
auth: {
  cookies: [
    { name: "session", value: "abc123...", domain: "myapp.com" },
    { name: "auth_token", value: "xyz789...", domain: "myapp.com" }
  ]
}
```

**Critical for apps using Clerk, Auth0, Supabase Auth** -- these providers often block automated browsers. Cookie auth bypasses the login flow entirely.

### 4d. Browser Profiles (Persistent Logins)

Profiles let you sign in **once** (manually via a live browser URL) and **reuse that authenticated state** across test runs. Profiles are scoped to a repo.

```typescript
// Create a profile (opens live browser for manual login)
const setup = await morph.browser.profiles.createProfile({
  name: 'Staging',
  repoId: repo.repoId
});
console.log('Open to sign in:', setup.session.debugUrl);
await setup.save();

// Use the profile in tests
const result = await morph.browser.execute({
  task: "Go to the dashboard and verify it loads",
  url: "https://staging.myapp.com",
  profileId: setup.profile.id
});
```

### Relevance to skeptic

**CRITICAL**. This is the single most impactful feature we are not using. skeptic tests web apps that may require authentication. Currently, our test instructions just include credentials in the natural language task. Using the `auth` parameter would:
1. **Improve reliability** -- Morph's model handles credential injection more reliably
2. **Support Clerk-protected apps** -- Cookie-based auth bypasses third-party auth providers
3. **Enable persistent auth** -- Browser profiles eliminate login overhead per test run
4. **Support per-domain credentials** -- For apps with OAuth flows or external API auth

### Implementation Priority: **P0**

Add to `MorphTaskConfig`:
```python
@dataclass
class MorphTaskConfig:
    # ... existing fields ...
    auth: dict[str, Any] | None = None  # username/password, cookies, or per-domain
    profile_id: str | None = None  # Persistent browser profile
```

Add to `MorphBrowserAdapter.create_task()` payload:
```python
if config.auth:
    payload["auth"] = config.auth
if config.profile_id:
    payload["profile_id"] = config.profile_id
```

---

## 5. BYO Browser Support

### What It Is

Morph Glance and the browser SDK support "Bring Your Own Browser" -- you can use:
- **Playwright** (local or cloud)
- **Puppeteer** (local or cloud)
- **Browserbase** (hosted browser service)
- Any browser accessible via Chrome DevTools Protocol (CDP)

### How It Works

Instead of Morph launching a managed browser, you provide your own browser instance and Morph provides the AI intelligence layer (model + recording).

The Morph SDK is **OpenAI-compatible**, so you can use it with the `browser-use` Python SDK:

```python
from browser_use import Agent, ChatOpenAI

llm = ChatOpenAI(
    model="morph-computer-use-v1",
    api_key="your-morph-key",
    base_url="https://api.morphllm.com/v1"
)

agent = Agent(
    task="Navigate to amazon.com and get the first product title",
    llm=llm
)
result = await agent.run(max_steps=10)
```

### Relevance to skeptic

**MEDIUM**. We currently use Morph's managed browsers which is simpler. However:
- BYO browser + Infinibranch Browsers from Morph Cloud could give us more control
- Could be useful for running tests behind corporate firewalls
- OpenAI-compatible API means we could swap in alternative browser agents

---

## 6. New API Parameters We Are NOT Using

### Parameters in `execute()` / `createTask()` we should add:

| Parameter | Type | Our Status | Impact |
|-----------|------|------------|--------|
| `auth` | object | **NOT USING** | Critical for authenticated apps |
| `profileId` | string | **NOT USING** | Persistent login sessions |
| `diff` | string | **NOT USING** | Enables diff-powered test intelligence |
| `externalId` | string | **NOT USING** | Link to PR/Jira/CI for tracking |
| `repoFullName` | string | Using | Already in MorphTaskConfig |
| `commitId` | string | Using | Already in MorphTaskConfig |
| `model` | string | Using | Already defaults to v1 |
| `schema` (Zod) | ZodSchema | **NOT USING** | Structured output from tests |

### Structured Output (NEW)

```typescript
import { z } from 'zod';

const task = await morph.browser.createTask({
  task: "Get the product price",
  url: "https://store.com/product",
  schema: z.object({
    price: z.number(),
    inStock: z.boolean()
  })
});

const result = await task.complete();
console.log(result.parsed); // { price: 29.99, inStock: true }
```

**Relevance**: This is via the TypeScript SDK only. For our Python REST API usage, we would need to check if there is a JSON schema equivalent in the REST API.

### CI/CD Tracking Fields

```typescript
const result = await morph.browser.execute({
  task: "Verify homepage loads correctly",
  url: process.env.PREVIEW_URL,
  externalId: process.env.GITHUB_PR_NUMBER,
  repoFullName: process.env.GITHUB_REPOSITORY,
  commitId: process.env.GITHUB_SHA,
  recordVideo: true
});
```

We already pass `repoFullName` and `commitId` but should add `externalId` for better Morph dashboard tracking.

---

## 7. Recording API -- Features Beyond What We Use

### What We Currently Use
- Video download (MP4/WebM) via `download_recording_video()`
- WebP animation via `get_recording_webp()`
- Basic recording metadata via `get_recording()`

### What We Are Missing

The recording object from `getRecording()` includes:

| Field | Type | Our Status | Description |
|-------|------|------------|-------------|
| `videoUrl` | string | Using | MP4/WebM playback URL |
| `replayUrl` | string | Partially | rrweb interactive DOM replay URL |
| **`networkUrl`** | string | **NOT USING** | All HTTP requests/responses |
| **`consoleUrl`** | string | **NOT USING** | JavaScript console output |
| `webpUrl` | string | Using (via separate endpoint) | Animated WebP |

### New Recording Methods

**Get Errors with Screenshots:**
```typescript
const recording = await morph.browser.getRecording(result.recordingId);
const { errors, totalErrors } = await recording.getErrors();
errors.forEach(err => {
  console.log(`[${err.type}] ${err.message}`);
  if (err.screenshotUrl) {
    console.log(`Screenshot: ${err.screenshotUrl}`);
  }
});
```

**WebP with size budget:**
```typescript
const { webpUrl } = await recording.getWebp({
  width: 780,
  fps: 10,
  quality: 65,
  maxDuration: 15,
  maxSizeMb: 2.0  // Guaranteed to stay under 2MB
});
```

### Storage Details
- Recordings stored in S3 with **7-day presigned URLs**
- WebP is cached -- subsequent calls return instantly
- Per-step screenshots are available

### Relevance to skeptic

**HIGH**. We should:
1. **Capture `networkUrl` and `consoleUrl`** -- essential for debugging failed tests (network errors, JS console errors)
2. **Use `getErrors()` with screenshots** -- get specific error screenshots for PR comments
3. **Use `maxSizeMb` in WebP generation** -- control output size for GitHub PR comments

---

## 8. Morph Blog -- Technical Deep Dives

### Key Blog Posts (reverse chronological)

1. **"Learning to Test Code Changes with RL"** (Jan 9, 2026)
   - How they trained `morph-computer-use-v1` with reinforcement learning
   - Reward policy: reward for bringing modified components into viewport + engaging with them
   - Uses React Fiber tree to map code diffs to rendered DOM elements
   - Coverage field tracks what % of each changed component is visible
   - Tools: Bippy and react-grab for Fiber introspection
   - **Implication**: The `diff` parameter is NOT just metadata -- it fundamentally changes how the model explores the UI

2. **"WarpGrep: Fast, Parallel Code Retrieval with RL"** (Jan 8, 2026)
   - WarpGrep is a separate model trained for code search
   - 4x faster than Claude's stock grepping
   - Could be used in skeptic for analyzing codebases before generating test plans

3. **"The Long-Running Agent Era"** (Feb 10, 2026)
   - Long-running agents need real code search + PR review
   - Human oversight moves from IDE to pull request
   - Validates skeptic's PR-centric approach

4. **"We Hit 10,500 Tokens/Sec on B200"** (Sep 15, 2025)
   - Custom CUDA kernels + speculative execution for Fast Apply
   - 2.3x speedup over previous version

### Relevance to skeptic

The RL blog post is the most important. It confirms that **passing the `diff` parameter to Morph fundamentally improves test quality** because the model was literally trained to optimize for diff-coverage. We MUST implement this.

---

## 9. Pricing Summary

### Morph LLM (morphllm.com) -- What We Use

| Plan | Price | Credits | Rate Limits |
|------|-------|---------|-------------|
| Free | $0/mo | 250K credits | Low |
| Starter | $20/mo ($5 first month) | 2M credits | Generous |
| Pro | $60/mo | 8M credits | Generous |
| Scale | $400/mo | 80M credits | Practically none |

Free tier: 500 requests/month

**Browser automation specific pricing:**
- morph-computer-use-v1: $0.30 input / $1.50 output per 1M tokens
- A typical test (30 steps) uses roughly 50K-200K tokens

### Morph Cloud (cloud.morph.so) -- Potential Future Use

| Plan | Price | MCUs | Concurrency |
|------|-------|------|-------------|
| Developer | Free | 300 MCUs/mo | Up to 64 vCPU |
| Team | $40/mo | 1000 MCUs/mo | Up to 256 vCPU |
| Scale | $250/mo | 7500 MCUs/mo | Up to 1024 vCPU |

**Infinibranch Browsers**: $0.07/browser-hour (billed per second), up to 1024 concurrent

---

## 10. Community / Discord / Hidden Features

### Morph Discord / Community

- Community link at docs.morphllm.com
- Support email: support@morphllm.com / founders@morphllm.com
- GitHub: github.com/morphllm (8 public repos)
- LinkedIn: Morph Labs (1,086 followers)

### Hidden/Underdocumented Features Discovered

1. **Live session iframe embedding** with interactive and readonly modes:
   ```typescript
   const viewer = task.getLiveIframe?.('readonly');
   const controller = task.getLiveIframe?.({ interactive: true, height: '800px' });
   ```
   Live URLs are **unauthenticated** -- anyone with URL can view/control.

2. **WebRTC streaming at 25 fps** for live sessions.

3. **Mobile automation** is listed in the docs sidebar (under "Automation > Mobile") -- not yet documented but appears to be in development.

4. **Model Router** listed in docs sidebar -- appears to be an intelligent model selection layer.

5. **Repo Storage / Git Storage API** listed in docs sidebar -- API for storing repos, possibly for WarpGrep indexing.

6. **MCP Integration** -- Morph has an MCP server (`@morphllm/morphmcp`) for Claude Code / Cursor integration. Could integrate with skeptic's developer workflow.

---

## Gap Analysis: What skeptic Uses vs. What's Available

| Feature | Available | skeptic Uses | Priority |
|---------|-----------|-----------|----------|
| `auth` parameter (username/password) | Yes | **No** | P0 |
| `auth` parameter (cookies) | Yes | **No** | P0 |
| `auth` parameter (per-domain) | Yes | **No** | P1 |
| Browser profiles (persistent login) | Yes | **No** | P1 |
| `diff` parameter for test intelligence | Yes | **No** | P0 |
| `externalId` for tracking | Yes | **No** | P2 |
| Recording network logs | Yes | **No** | P1 |
| Recording console logs | Yes | **No** | P1 |
| Recording error screenshots | Yes | **No** | P1 |
| WebP size budget (`maxSizeMb`) | Yes | **No** | P2 |
| Structured output (Zod schema) | Yes (TS SDK) | **No** | P2 |
| Live session embedding | Yes | **No** | P3 |
| Multiple model options | Yes | Partial (v1 only) | P3 |
| Morph Cloud / Infinibranch | Yes | **No** | Future |
| Morph Glance (GitHub App) | Yes | **No** | Evaluate |
| Mobile automation | Beta | **No** | Future |

---

## Recommended Action Items

### P0 -- Implement Immediately

1. **Add `diff` parameter to MorphTaskConfig and adapter**
   - Pass the PR unified diff to every Morph task
   - This is how morph-computer-use-v1 was trained -- it fundamentally improves test targeting
   - We already have the diff from `DiffParserPort` -- just need to thread it through

2. **Add `auth` parameter to MorphTaskConfig and adapter**
   - Support username/password, cookies, and per-domain credentials
   - Critical for testing authenticated apps (especially Clerk-based apps)
   - Cookie-based auth is the recommended approach for third-party auth providers

### P1 -- Implement Next Sprint

3. **Capture network and console logs from recordings**
   - The recording object already contains `networkUrl` and `consoleUrl`
   - Store these alongside video/WebP in our test results
   - Display in frontend for debugging failed tests

4. **Capture error screenshots from recordings**
   - Use `getErrors()` API to get errors with associated screenshots
   - Much more useful for PR comments than just pass/fail

5. **Add browser profile support**
   - Allow users to create persistent browser profiles per project
   - Eliminates login overhead and improves test reliability

6. **Add per-domain auth support**
   - For apps that integrate with external services

### P2 -- Implement When Convenient

7. **Add `externalId` for Morph dashboard tracking**
8. **Use `maxSizeMb` in WebP generation** for controlled output sizes
9. **Evaluate structured output** for extracting structured test data

### Future -- Evaluate and Plan

10. **Evaluate Morph Cloud as Daytona replacement**
    - Infinibranch Browsers at $0.07/hr could replace both Daytona + browser.morphllm.com
    - Instant branching could enable parallel test execution from shared state
    - Python SDK is well-maintained

11. **Evaluate Morph Glance GitHub App**
    - Could be offered as a "lite" testing option alongside skeptic's deeper workflow

12. **Monitor mobile automation** for future mobile testing capabilities
