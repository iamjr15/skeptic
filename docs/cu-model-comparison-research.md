# Computer-Use (CU) Model Comparison for AI-Driven QA Testing

> Research compiled: February 27, 2026
> Purpose: Definitive comparison of CU models for skeptic's browser-based E2E testing

---

## Executive Summary

The CU model landscape has matured rapidly. As of February 2026, there are **6 viable options** for driving browser-based E2E tests. The key finding: **no single model dominates across accuracy, speed, and cost**. The optimal strategy for skeptic is a **multi-model approach** using cheap/fast models for simple navigation steps and premium models for complex interactions.

**Top-line recommendation for skeptic:**
1. **Primary (default):** Gemini 2.5 Flash or BU 2.0 for most test steps (best cost/speed ratio)
2. **Complex interactions:** Claude Sonnet 4.6 (best CU accuracy at mid-tier pricing)
3. **Fallback/retry:** Claude Opus 4.6 or Gemini 2.5 CU model (highest raw accuracy)
4. **Budget alternative:** BU-30B self-hosted for high-volume simple tasks

---

## 1. Claude Computer Use (Anthropic)

### Models Available
| Model | OSWorld-Verified | Price (Input/Output per MTok) | Released |
|-------|-----------------|-------------------------------|----------|
| Claude Opus 4.6 | **72.7%** | $5 / $25 | Feb 5, 2026 |
| Claude Sonnet 4.6 | **72.5%** | $3 / $15 | Feb 17, 2026 |
| Claude Opus 4.5 | 61.4% | $5 / $25 | Nov 2025 |
| Claude Sonnet 4.5 | ~58% | $3 / $15 | Sep 2025 |

### Key Capabilities
- **Zoom Action** (new in 2026): High-res inspection of small UI elements. Solves the "blurry text" problem that plagued earlier CU models.
- **Screenshot-based loop**: Model receives screenshot, reasons about it, emits click/type/scroll actions.
- Available via Anthropic API with `computer_use` tool type.
- **Prompt caching**: 5-min cache writes at $3.75/MTok (Sonnet), cache hits at $0.30/MTok -- critical for reducing cost when screenshots repeat context.

### Cost Per Test Estimate
- A 50-step browser task costs **$0.50-$2.00** depending on resolution (from production deployment guide).
- Each screenshot is ~1,500-3,000 tokens (depending on resolution).
- A typical 20-step E2E test: ~40,000-80,000 input tokens + ~5,000 output tokens.
- **Sonnet 4.6 cost per 20-step test: ~$0.12-$0.25**
- **Opus 4.6 cost per 20-step test: ~$0.20-$0.60**

### Speed
- Sonnet 4.6: Fast inference, ~2-4 seconds per step decision.
- Opus 4.6: Slower, ~4-8 seconds per step decision.
- Total time for 20-step test: **40-80 seconds (Sonnet)**, **80-160 seconds (Opus)**.

### Strengths for QA Testing
- Highest raw accuracy on OSWorld (desktop automation benchmark).
- Zoom Action eliminates many false failures from small text/buttons.
- 94% accuracy on insurance form benchmarks (highest of any model).
- Best at multi-step reasoning and self-correction.
- Sonnet 4.6 brought Opus-level CU quality to Sonnet pricing -- massive win.

### Weaknesses
- Screenshot tokens are expensive at scale.
- No dedicated "computer use" fine-tuned model -- uses general-purpose model with CU tools.
- Slower than purpose-built browser agents.

---

## 2. OpenAI Operator / CUA (Computer-Using Agent)

### Model
| Model | WebVoyager (via Operator) | Price (Input/Output per MTok) | Status |
|-------|--------------------------|-------------------------------|--------|
| computer-use-preview | ~87% (as Operator) | $3 / $12 | Beta/Preview |

### How It Works
- Built on **GPT-4o vision** + reinforcement learning for GUI interaction.
- Available via the **Responses API** (NOT Chat Completions).
- Operates in a continuous loop: sends screenshot -> receives action (click, type, scroll, etc.) -> executes -> sends new screenshot.
- Powers "Operator" (consumer product) and available as API for developers.
- OpenAI published a dedicated **testing agent demo** (`openai/openai-testing-agent-demo` on GitHub).

### API Availability
- **Yes, available via API** as `computer-use-preview` model.
- Uses Responses API with `computer_use` tool.
- Supports Docker or Playwright as execution environments.
- Safety checks built-in: model can flag risky actions for human confirmation.

### Cost Per Test Estimate
- $3/MTok input, $12/MTok output.
- Similar token consumption to Claude CU (screenshot-based).
- **Estimated cost per 20-step test: ~$0.10-$0.20** (slightly cheaper than Claude Sonnet due to lower output pricing).
- No prompt caching currently mentioned for CUA.

### Speed
- GPT-4o base means fast vision processing.
- Reported average task duration via Operator: **~196 seconds** for complex multi-step tasks (BU 2.0 benchmark comparison).
- Slower than Claude Sonnet for browser tasks in head-to-head benchmarks.

### Strengths
- Cheapest per-token among premium CU models.
- OpenAI published a dedicated QA testing demo -- shows they see testing as a primary use case.
- Strong self-correction via RL training.

### Weaknesses
- Still in "preview" / beta -- not production-grade.
- "Susceptible to exploits and inadvertent mistakes" (per OpenAI's own docs).
- 70.9% accuracy in BU 2.0 benchmark comparison -- significantly below Claude and Gemini.
- Slowest average task duration (196s) in BU benchmarks.
- Not recommended for "fully authenticated environments or high-stakes tasks."

---

## 3. Google Gemini Computer Use / Project Mariner

### Models
| Model | WebVoyager | Online-Mind2Web | Price (Input/Output per MTok) | Released |
|-------|-----------|-----------------|-------------------------------|----------|
| Gemini 2.5 Computer Use | **Leading** | **Leading** | Uses Gemini 2.5 Pro/Flash pricing | Oct 7, 2025 |
| Project Mariner (consumer) | 83.5% | N/A | $249.99/mo (AI Ultra plan) | May 2025 |

### How It Works
- **Gemini 2.5 Computer Use** is a specialized model fine-tuned specifically for GUI interaction.
- Unlike Claude/OpenAI which use general models with CU tools, Google built a dedicated CU model.
- Operates in a screenshot -> reason -> action loop, same pattern.
- Supports 13 predefined UI actions + custom functions.
- Evaluated by **Browserbase** on normalized harness (industry-standard eval).
- Available via Gemini API and Vertex AI.

### Benchmark Performance
From the official Gemini Computer Use model card:
- **Online-Mind2Web**: State-of-the-art (outperforms all competitors).
- **WebVoyager**: State-of-the-art (outperforms all competitors).
- **AndroidWorld**: Strong generalization to mobile.
- Lower latency than competitors on web tasks.

### Cost Per Test Estimate
- No separate pricing published -- uses Gemini 2.5 Pro or Flash family rates.
- **Gemini 2.5 Pro**: ~$1.25/MTok input, ~$5/MTok output (estimate from available data).
- **Gemini 2.5 Flash**: ~$0.08-$0.15/MTok input, ~$0.30-$0.60/MTok output.
- If using Flash for CU: **estimated cost per 20-step test: ~$0.02-$0.05** (dramatically cheaper).
- If using Pro for CU: **estimated cost per 20-step test: ~$0.08-$0.15**.

### Speed
- Google explicitly highlights "lower latency" as a differentiator.
- **81.7% accuracy at 143s average task duration** (from BU 2.0 benchmark, labeled as "Gemini 3 Pro").
- Faster than OpenAI CUA (196s) but slower than BU 2.0 (62s) and Claude Opus (104s).

### Strengths
- Purpose-built CU model (not a general model with tools bolted on).
- Best benchmark scores on web-specific tasks (Mind2Web, WebVoyager).
- Flash pricing makes it potentially the cheapest premium CU option.
- Strong Android support (if mobile testing ever matters).
- Browserbase partnership for standardized evaluation.

### Weaknesses
- "Not yet an unlock for production agents" per industry analysis -- still new.
- No direct self-reported OSWorld scores for comparison with Claude.
- Consumer version (Project Mariner) locked behind $250/mo AI Ultra plan.
- API model in preview, less battle-tested than Claude CU.

---

## 4. Morph Browser Testing

### What Morph Actually Is (Clarification)
Based on research, **Morph is NOT primarily a CU model provider**. Morph has pivoted/expanded into several areas:

1. **Morph Fast Apply** -- Code editing at 10,500 tok/s (their core product).
2. **Morph WarpGrep** -- Fast code search.
3. **Morph Browser Testing** -- A browser automation SDK (currently in beta).
4. **Morph Infinibranch Browsers** -- Serverless Chromium infrastructure ($0.07/browser-hour).

### Morph Browser Testing SDK
```typescript
import { MorphClient } from '@morphllm/morphsdk';
const morph = new MorphClient({ apiKey: "YOUR_API_KEY" });
const result = await morph.browser.execute({
  task: "Verify the homepage loads and has a working navigation menu",
  url: "https://example.com"
});
```

- Claims to be "10x cheaper and 250% faster" than alternatives.
- Uses natural language task descriptions.
- Currently in **beta**.
- Only works with remote URLs (no localhost).

### Morph's CU Model (morph-computer-use-v1)
- **Very limited public information.** This appears to be the model powering Morph's browser testing product internally.
- Not publicly benchmarked against Claude/OpenAI/Gemini on standard benchmarks.
- Morph's public models (morph-v3-fast, morph-v3-large) are code-editing models, not CU models.
- **morph-v3-fast**: $0.80/MTok input, $1.20/MTok output, 82K context.
- **morph-v3-large**: $0.90/MTok input, $1.90/MTok output, 262K context.

### Morph Browser API (What We Currently Use in skeptic)
Based on our MEMORY.md:
- Base URL: `https://browser.morphllm.com`
- Create task: `POST /browser-task/async`
- Poll task: `GET /tasks/{task_id}`
- Task duration: 1.5-3 minutes per test case (max_steps=30)
- Status: `running`, `completed`, `failed`, `error`

### Assessment for skeptic
- We are already integrated with Morph's browser API.
- It works, but we have no benchmark data to compare accuracy vs. direct Claude/Gemini CU.
- Morph's value proposition is the **managed infrastructure** (browser provisioning, recording, screenshots) rather than the CU model itself.
- They may be wrapping a frontier model (Claude/GPT/Gemini) behind their API -- unknown.

---

## 5. Browser-Use BU-30B / BU 2.0

### Models
| Model | Architecture | Accuracy | Avg Task Duration | Price (Input/Output per MTok) |
|-------|-------------|----------|-------------------|-------------------------------|
| BU 2.0 | Proprietary | **83.3%** | **62s** | $0.60 / $3.50 |
| BU 1.0 (bu-latest) | Proprietary | 74.7% | 58s | $0.20 / $2.00 |
| BU-30B-A3B-Preview | MoE (30B total, 3B active) | ~74% | Fast | Self-hostable (open source) |

### BU 2.0 (January 27, 2026)
- **83.3% accuracy** -- matches Claude Opus 4.5 while being **40% faster**.
- **62 second average task duration** -- fastest of any premium CU option.
- +12% accuracy improvement over BU 1.0.
- Available via Browser Use Cloud API.

### BU 2.0 Benchmark Comparison (from official changelog)
| Model | Accuracy | Avg Task Duration |
|-------|----------|-------------------|
| BU 2.0 | 83.3% | 62s |
| BU 1.0 | 74.7% | 58s |
| Claude Opus 4.5 | 82.3% | 104s |
| Gemini 3 Pro | 81.7% | 143s |
| GPT-5.2 | 70.9% | 196s |

### BU-30B-A3B-Preview (December 16, 2025)
- **Open source** (available on HuggingFace: `browser-use/bu-30b-a3b-preview`).
- MoE architecture: 30B total parameters, only 3B active at inference.
- **200 tasks per $1** -- 4x more cost-efficient than BU 1.0.
- Can be self-hosted for maximum control.
- Best for high-volume, simpler browser tasks.

### Browser Use Framework
- **79,000+ GitHub stars** -- the dominant open-source browser automation framework.
- Raised **$17M** in March 2025.
- Key insight from their "Bitter Lesson" post: "99% of the work is in the model. Agent frameworks fail because their action spaces are incomplete."
- They moved from Playwright to raw **Chrome DevTools Protocol (CDP)** for maximum model freedom.
- Gemini 3 is reportedly "the best model for Browser Use" (per their changelog).
- LLM judge uses `gemini-2.5-flash` for eval (87% alignment with human labels).

### Cost Per Test Estimate
- BU 2.0: **~$0.04-$0.08 per 20-step test** (dramatically cheaper than direct Claude/OpenAI).
- BU-30B self-hosted: **~$0.005-$0.01 per 20-step test** (essentially just GPU compute).
- BU 1.0: **~$0.02-$0.04 per 20-step test**.

### Strengths
- Best speed-to-accuracy ratio of any option.
- Open-source framework means full control over the agent loop.
- BU-30B can be self-hosted for zero API cost.
- Purpose-built for browser automation (not general-purpose CU).
- Stealth infrastructure for bypassing bot detection.
- Strong evaluation infrastructure (600,000+ tasks run in testing).

### Weaknesses
- BU 2.0 is proprietary (not open source, only via Cloud API).
- BU-30B is open source but lower accuracy than BU 2.0.
- Narrower than Claude/Gemini -- only browser, no desktop.
- New company, less proven at enterprise scale.

---

## 6. Other Notable Mentions

### Microsoft Fara-7B
- 7B parameter CU model, designed to run locally.
- Rivals GPT-4o performance at a fraction of the size.
- Good for privacy-sensitive scenarios (local inference).
- Experimental release.

### GUI-Owl-1.5 (Mobile-Agent-v3.5)
- State-of-the-art on 20+ GUI benchmarks for open-source models.
- **56.5 on OSWorld**, 71.6 on AndroidWorld, 48.4 on WebArena.
- Sizes: 2B/4B/8B/32B/235B.
- Best option if multi-platform (desktop + mobile + browser) is needed.

### Magnitude
- Claims **93.9% on WebVoyager** -- highest reported score.
- Pure-vision approach (no DOM reliance).
- Uses multi-model architecture internally.

---

## 7. Definitive Benchmark Comparison

### OSWorld (Desktop Automation) -- February 2026
| Model | OSWorld-Verified | Notes |
|-------|-----------------|-------|
| Claude Opus 4.6 | **72.7%** | Highest overall |
| Claude Sonnet 4.6 | **72.5%** | Near-Opus at 1/5 cost |
| GPT-5.2 | ~65% | Estimated |
| Claude Opus 4.5 / Sonnet 4.5 | 61.4% / ~58% | Previous gen |
| GUI-Owl-1.5 (235B) | 56.5% | Open source SOTA |

### WebVoyager (Web Navigation) -- Various Sources
| Agent/Model | WebVoyager Score | Notes |
|-------------|-----------------|-------|
| Magnitude | **93.9%** | Multi-model, pure vision |
| Browserable (Gemini 2.0 Flash + fallback) | **90.4%** | Multi-model |
| Browser Use (GPT-4o) | **89.1%** | Open source framework |
| OpenAI Operator | ~87% | Consumer product |
| Gemini 2.5 Computer Use | **SOTA** (specific score unpublished) | Per Google model card |
| Project Mariner | 83.5% | Consumer product |
| Runner H 0.1 | 67% | Earlier agent |
| Original WebVoyager agent | 50% | Baseline |

### Browser Use's Own Benchmark (Jan 31, 2026) -- 100 Hard Tasks
| Model | Accuracy | Notes |
|-------|----------|-------|
| ChatBrowserUse 2 (BU 2.0) | Highest | Purpose-built for BU framework |
| Claude Sonnet 4.5 | ~60%+ | Strong but expensive |
| Gemini 2.5 Flash | ~35% | Lowest on hard tasks |

### BU 2.0 Benchmark (Jan 27, 2026) -- Browser Automation
| Model | Accuracy | Avg Task Duration |
|-------|----------|-------------------|
| BU 2.0 | **83.3%** | **62s** |
| Claude Opus 4.5 | 82.3% | 104s |
| Gemini 3 Pro | 81.7% | 143s |
| BU 1.0 | 74.7% | 58s |
| GPT-5.2 | 70.9% | 196s |

---

## 8. Cost Comparison Matrix

### Token Pricing (per Million Tokens)
| Model | Input | Cached Input | Output |
|-------|-------|-------------|--------|
| Claude Opus 4.6 | $5.00 | $0.50 | $25.00 |
| Claude Sonnet 4.6 | $3.00 | $0.30 | $15.00 |
| OpenAI CUA (computer-use-preview) | $3.00 | N/A | $12.00 |
| Gemini 2.5 Pro | ~$1.25 | ~$0.13 | ~$5.00 |
| Gemini 2.5 Flash | ~$0.08 | ~$0.01 | ~$0.30 |
| BU 2.0 | $0.60 | $0.06 | $3.50 |
| BU 1.0 | $0.20 | $0.02 | $2.00 |
| Morph v3-fast | $0.80 | N/A | $1.20 |

### Estimated Cost Per 20-Step E2E Test
| Model/Agent | Cost Per Test | Time Per Test | Cost for 100 Tests |
|-------------|--------------|---------------|---------------------|
| Claude Opus 4.6 | $0.20-$0.60 | 80-160s | $20-$60 |
| Claude Sonnet 4.6 | $0.12-$0.25 | 40-80s | $12-$25 |
| OpenAI CUA | $0.10-$0.20 | ~100s+ | $10-$20 |
| Gemini 2.5 CU (Pro) | $0.08-$0.15 | ~70-140s | $8-$15 |
| Gemini 2.5 CU (Flash) | $0.02-$0.05 | ~50-100s | $2-$5 |
| BU 2.0 | $0.04-$0.08 | ~62s | $4-$8 |
| BU 1.0 | $0.02-$0.04 | ~58s | $2-$4 |
| BU-30B (self-hosted) | $0.005-$0.01 | ~60s | $0.50-$1 |
| Morph Browser API | Unknown (managed) | 90-180s | Unknown |

---

## 9. Speed Comparison

### Average Task Duration (Complex Multi-Step Browser Tasks)
| Model/Agent | Avg Duration | Steps/Minute |
|-------------|-------------|--------------|
| BU 1.0 | **58s** | ~20 |
| BU 2.0 | **62s** | ~19 |
| Claude Opus 4.5 | 104s | ~12 |
| Gemini 3 Pro | 143s | ~8 |
| Morph Browser API | 90-180s | ~10-15 |
| GPT-5.2 | 196s | ~6 |

### Key Speed Insights
- BU models are **2-3x faster** than frontier models because they're purpose-built for browser action.
- Browser Use built a "special LLM gateway that reduces latency by 6x" (Oct 2025).
- Speed matters enormously for QA testing cost -- a 2x faster model halves your compute/browser time.

---

## 10. Multi-Model Strategy for skeptic

### The Case for Multi-Model
From the research, every competitive browser agent uses multiple models:
- **Browserable** (90.4% WebVoyager): Gemini 2.0 Flash primary + GPT-4o + Claude 3.5 Sonnet fallback.
- **Magnitude** (93.9% WebVoyager): Multi-model, pure vision approach.
- **Browser Use**: Recommends different models for different task types.

### Proposed skeptic Multi-Model Architecture

#### Tier 1: Simple Navigation (70% of steps)
**Use:** BU 2.0 or Gemini 2.5 Flash
- Click links, fill simple text fields, navigate between pages.
- Cost: $0.02-$0.04 per test.
- These steps don't need deep reasoning.

#### Tier 2: Complex Interactions (25% of steps)
**Use:** Claude Sonnet 4.6 or Gemini 2.5 CU (Pro)
- Form validation, dropdown selection, multi-step workflows.
- Dynamic content, iframes, shadow DOM.
- Cost: $0.10-$0.20 per test.

#### Tier 3: Failure Recovery / Retry (5% of steps)
**Use:** Claude Opus 4.6
- When Tier 1 or 2 fails, retry with the most capable model.
- Complex error states, unexpected modals, CAPTCHAs.
- Cost: $0.30-$0.60 per test (but only used on failures).

### Estimated Blended Cost Per Test (Multi-Model)
- **Simple test (5 steps):** ~$0.02-$0.05
- **Medium test (15 steps):** ~$0.05-$0.12
- **Complex test (30 steps):** ~$0.10-$0.25
- **100 tests daily:** ~$5-$15/day = **$150-$450/month**

### Implementation Approach
1. **Step classifier**: Before each step, a cheap model (Gemini Flash / GPT-5 Nano) classifies the step as simple/complex.
2. **Model router**: Routes to the appropriate CU model based on classification.
3. **Retry with escalation**: If a step fails with the cheap model, automatically retry with the premium model.
4. **Prompt caching**: Cache system prompts and page context aggressively (90% cost reduction on cache hits).

---

## 11. Recommendations for skeptic

### Immediate Actions (Current Architecture)
We currently use Morph's browser API. Short-term optimizations:
1. **Benchmark Morph's actual accuracy** -- Run our 3 test cases with direct Claude Sonnet 4.6 CU and compare to Morph results.
2. **Measure cost per test** -- Instrument Morph API calls to understand true cost.
3. **Consider Browser Use Cloud** as an alternative managed service -- better benchmarked, transparent pricing.

### Medium-Term Migration Path
1. **Build our own CU orchestrator** using the Browser Use open-source framework.
2. **Integrate Claude Sonnet 4.6** as the primary CU model (best accuracy-to-cost for testing).
3. **Use Gemini 2.5 Flash** for simple navigation steps (10-20x cheaper).
4. **Implement step-level model routing** for optimal cost.

### Long-Term Vision
1. **Self-host BU-30B** for high-volume testing on our own GPU infrastructure.
2. **Fine-tune a small CU model** on our specific test patterns (most tests are similar patterns).
3. **Build evaluation infrastructure** similar to Browser Use's approach (LLM judge, statistical analysis).

---

## 12. Key Takeaways

1. **Claude Sonnet 4.6 is the best CU model for the price** -- 72.5% OSWorld (near-Opus), $3/$15 per MTok, good speed.

2. **BU 2.0 offers the best speed-to-accuracy ratio** -- 83.3% accuracy in 62 seconds, at $0.60/$3.50 per MTok.

3. **Gemini 2.5 Flash is the budget king** -- purpose-built CU model at ~$0.08/$0.30 per MTok.

4. **OpenAI CUA is the weakest option for testing** -- 70.9% accuracy, 196s duration, still in beta.

5. **Multi-model is the winning strategy** -- every top-performing agent uses it.

6. **The agent framework matters as much as the model** -- Browser Use's "bitter lesson": give the model maximum freedom, minimize abstractions.

7. **Evaluation infrastructure is critical** -- Single-run tests are unreliable. Need statistical rigor with multiple runs.

8. **Morph is a black box** -- We have no visibility into what model they use or how it compares. Consider migrating to transparent alternatives.

9. **Prompt caching can reduce CU costs by up to 90%** -- Critical for screenshot-heavy workflows.

10. **Browser Use's BU-30B is the most interesting new entrant** -- Open source, self-hostable, 200 tasks per $1. Worth watching for v2.
