# Intelligent Test Prioritization & Selection (Zero-Training Approaches)

> Research compiled for skeptic QA platform. All approaches below require **zero model training** — they use online learning, heuristics, or pre-trained LLM API calls only.

---

## Table of Contents

1. [Composite Heuristic Score](#1-composite-heuristic-score)
2. [Thompson Sampling (Multi-Armed Bandit)](#2-thompson-sampling-multi-armed-bandit)
3. [UCB1 / COLEMAN (Upper Confidence Bound)](#3-ucb1--coleman-upper-confidence-bound)
4. [Bayesian Conjugate Prior (Beta-Bernoulli)](#4-bayesian-conjugate-prior-beta-bernoulli)
5. [ROCKET (Reward-Based Score Updating)](#5-rocket-reward-based-score-updating)
6. [LPT Scheduling (Longest Processing Time First)](#6-lpt-scheduling-longest-processing-time-first)
7. [Embedding-Based Semantic Test Selection](#7-embedding-based-semantic-test-selection)
8. [LLM-as-Reasoner (Zero-Shot Prioritization)](#8-llm-as-reasoner-zero-shot-prioritization)
9. [LLM Impact Analysis (Ripple-Style)](#9-llm-impact-analysis-ripple-style)
10. [Agentic Multi-Step Test Selection](#10-agentic-multi-step-test-selection)
11. [Deterministic / Algorithmic Strategies](#11-deterministic--algorithmic-strategies)
12. [Recommended Layered Architecture](#12-recommended-layered-architecture)
13. [Expected Impact](#13-expected-impact)
14. [Academic References](#14-academic-references)

---

## 1. Composite Heuristic Score

**Type**: Pure formula, no learning
**Implementation**: ~50 lines of Python (mostly SQL)
**State**: Uses existing `test_results` table

### Algorithm

```
priority(test) = w1 * failure_recency(test)        # recent failures boost priority
               + w2 * historical_failure_rate(test)  # flaky/failing tests get priority
               + w3 * days_since_last_run(test)      # stale tests get explored
               + w4 * (1 / avg_duration(test))       # shorter tests first for faster feedback
```

All four inputs come from a single SQL query against existing data. Weights can be hand-tuned or set by domain experts.

### Performance

- **APFD**: 57-85% vs ~50% for random ordering (IEEE studies on industrial CI systems)
- **Execution time**: < 1ms (single SQL query)

### Why No Training

These are deterministic formulas operating on observable metadata. No parameters are learned — weights are set by domain knowledge.

---

## 2. Thompson Sampling (Multi-Armed Bandit)

**Type**: Online Bayesian learning
**Implementation**: ~25 lines of Python
**State**: 2 floats per test case (`alpha`, `beta`)
**Foundation**: Thompson (1933), Agrawal & Goyal (ICML 2012)

### Algorithm

Each test case is modeled as a Bernoulli arm. The failure probability is unknown, so we maintain a Beta distribution as a conjugate prior.

```python
class ThompsonPrioritizer:
    def __init__(self):
        self.alpha = {}  # pseudo-count of failures detected
        self.beta = {}   # pseudo-count of passes observed

    def prioritize(self, test_ids: list[str]) -> list[str]:
        scores = {}
        for tid in test_ids:
            a = self.alpha.get(tid, 1.0)  # Beta(1,1) = uniform prior (max ignorance)
            b = self.beta.get(tid, 1.0)
            scores[tid] = random.betavariate(a, b)
        return sorted(test_ids, key=lambda t: scores[t], reverse=True)

    def update(self, test_id: str, failed: bool, decay: float = 0.95):
        # Decay old evidence (handles non-stationarity)
        self.alpha[test_id] = self.alpha.get(test_id, 1.0) * decay + (1.0 if failed else 0.0)
        self.beta[test_id] = self.beta.get(test_id, 1.0) * decay + (0.0 if failed else 1.0)
```

### Key Properties

- **Exploration is automatic**: Tests with few observations have high-variance Beta distributions — they occasionally sample high and get explored
- **Non-stationarity**: Exponential decay (`decay=0.95`) causes old evidence to fade, adapting to code changes
- **New test cases**: Automatically get `Beta(1,1)` uniform priors and are explored naturally
- **Convergence**: Mathematically optimal regret bound O(sqrt(KT ln T))

### Performance

- Matches or outperforms RETECS (neural network RL) per COLEMAN benchmarks
- Significantly better than random from cycle 1 onward
- In A/B testing contexts, reaches optimal allocation 30-50% faster than epsilon-greedy
- Executes in < 1ms

### Why No Training

Starts with `Beta(1,1)` uniform priors (maximum ignorance). Updates are single arithmetic operations after each run. No gradient descent, no loss functions, no batched training.

---

## 3. UCB1 / COLEMAN (Upper Confidence Bound)

**Type**: Online confidence-bound learning
**Implementation**: ~50-80 lines of Python
**State**: 2 values per test case + 1 global counter
**Open Source**: [coleman4hcs](https://github.com/jacksonpradolima/coleman4hcs)

### Algorithm

```python
def prioritize(test_ids):
    total_rounds += 1
    for t in test_ids:
        if count[t] == 0:
            priority[t] = float('inf')  # force exploration
        else:
            mean_reward = sum_rewards[t] / count[t]
            exploration_bonus = c * sqrt(ln(total_rounds) / count[t])
            priority[t] = mean_reward + exploration_bonus
    return sorted(test_ids, key=lambda t: priority[t], reverse=True)
```

### FRRMAB Variant (Sliding Window)

Uses a sliding window of size W over recent rewards, so Q[t] is computed only from the last W observations. This handles non-stationarity (test flakiness, code changes).

### Reward Functions

1. **RNFail**: Binary — 1 if test failed, 0 if passed
2. **TimeRank**: `reward = (N - rank + 1) / N` if failed, else 0. Tests that fail early get higher reward.

### Performance

- Evaluated on 11 large-scale real-world CI systems (industrial + open source)
- **Outperforms RETECS** (neural network RL) in both NAPFD and execution time
- Execution time: **< 1 second** even for thousands of test cases
- Comparable to genetic algorithms in 90% of cases while being orders of magnitude faster

### Why No Training

Pure scoring algorithm — maintains and updates a score per test case using arithmetic operations. No neural network, no gradient descent.

---

## 4. Bayesian Conjugate Prior (Beta-Bernoulli)

**Type**: Bayesian inference
**Implementation**: ~15-25 lines of Python
**State**: 2 floats per test case

### Algorithm

Same model as Thompson Sampling, but uses the **posterior mean** (or 95th percentile) directly instead of sampling:

```python
class BayesianPrioritizer:
    def __init__(self, decay: float = 0.98):
        self.alpha = {}
        self.beta = {}
        self.decay = decay

    def prioritize(self, test_ids: list[str]) -> list[str]:
        def score(tid):
            a = self.alpha.get(tid, 1.0)
            b = self.beta.get(tid, 1.0)
            return a / (a + b)  # posterior mean of failure probability
        return sorted(test_ids, key=score, reverse=True)

    def update(self, results: dict[str, bool]):
        for tid in self.alpha:
            self.alpha[tid] *= self.decay
            self.beta[tid] *= self.decay
        for tid, failed in results.items():
            if failed:
                self.alpha[tid] = self.alpha.get(tid, 1.0) + 1
            else:
                self.beta[tid] = self.beta.get(tid, 1.0) + 1
```

### Differences from Thompson Sampling

| Aspect | Bayesian Mean | Thompson Sampling |
|--------|--------------|-------------------|
| Selection | Deterministic | Stochastic |
| Exploration | Must add explicitly (use 95th percentile) | Built-in via sampling |
| Convergence | Exploits faster but can get stuck | Explores more, asymptotically optimal |
| Reproducibility | Same input = same output | Different each time |

### Why No Training

The Beta(1,1) prior is maximum ignorance. Every observation updates the posterior analytically — no optimization.

---

## 5. ROCKET (Reward-Based Score Updating)

**Type**: Reward-updating algorithm
**Implementation**: ~60 lines of Python
**State**: 1 score per test case
**Source**: IEEE ICST, industrial case study

### Algorithm

```
After each CI cycle:
    For each executed test t:
        if t found a fault:
            score[t] = score[t] * decay + reward * boost
        else:
            score[t] = score[t] * decay

    Add recency weighting: recently executed tests get slightly lower priority
    Add duration weighting: shorter tests get priority for faster first-failure detection
```

### Performance

- Revealed **30% more faults** when running only 20% of the test suite
- Works from day one with equal initial scores

---

## 6. LPT Scheduling (Longest Processing Time First)

**Type**: Classic bin-packing heuristic
**Implementation**: ~20 lines of Python
**State**: None (uses historical avg durations)

### Algorithm

```python
def schedule_parallel(test_cases, num_slots):
    sorted_tests = sorted(test_cases, key=lambda t: t.avg_duration, reverse=True)
    slots = [[] for _ in range(num_slots)]
    slot_times = [0.0] * num_slots
    for test in sorted_tests:
        min_slot = slot_times.index(min(slot_times))
        slots[min_slot].append(test)
        slot_times[min_slot] += test.avg_duration
    return slots
```

### Performance

- **15-30% reduction** in total wall-clock time for heterogeneous test suites
- With Morph tests ranging 1.5-3 min, saves 2-5 minutes on a 10-test run

### Why No Training

Textbook greedy algorithm. Operates on historical average durations.

---

## 7. Embedding-Based Semantic Test Selection

**Type**: Pre-trained embedding API calls
**Implementation**: ~100 lines of Python
**State**: 1 vector per test case (cached)
**Cost**: ~$0.0001 per test case embedding (one-time)

### Algorithm

1. Pre-compute embeddings for each test case description using Gemini/OpenAI embedding API
2. On each PR, embed the diff summary (or commit message)
3. Cosine similarity between diff embedding and each test embedding
4. Select/boost tests above a similarity threshold

```python
# Pre-compute (once per test case, cached in DB)
for tc in test_cases:
    tc.embedding = gemini.embed(tc.description)

# Per PR (one API call + vector math)
diff_embedding = gemini.embed(summarize_diff(pr.diff))
ranked = sorted(test_cases, key=lambda tc: cosine_sim(diff_embedding, tc.embedding), reverse=True)
```

### Performance

- Query time: < 1 second
- Research suggests similarity threshold ~0.75-0.79 for good precision/recall balance
- Adds **change-awareness** — PR modifying contact form automatically boosts contact-related tests

### Why No Training

Uses pre-trained embedding models via API. No fine-tuning, no training data.

---

## 8. LLM-as-Reasoner (Zero-Shot Prioritization)

**Type**: Zero-shot LLM prompting
**Implementation**: ~80 lines of Python
**State**: None
**Cost**: 1 LLM API call per run

### Algorithm

```
Prompt: "Given this code diff and these test cases with their recent pass/fail history,
rank the test cases by likelihood of failure. Return JSON: [{test_case_id, priority, reason}]"
```

### Performance

- **12% higher APFD** (PCI 2024 study)
- Best for ambiguous cases where embedding similarity is inconclusive
- Latency: ~2-5 seconds

### Why No Training

Pure zero-shot prompting against an existing LLM API (Gemini, already in skeptic's stack).

---

## 9. LLM Impact Analysis (Ripple-Style)

**Type**: Multi-phase LLM reasoning
**Implementation**: ~150 lines of Python
**Source**: Ripple (ICSE 2026)

### Algorithm

1. **Seed phase**: Extract directly changed code from the diff
2. **Expansion phase**: Ask LLM to reason about which other modules are affected by the change (transitive dependencies)
3. **Selection phase**: Map the full impact set to test cases

### Performance

- **39.7%-380.8% better F1** than traditional impact analysis approaches (Ripple paper)
- Catches indirect impacts that embedding similarity misses
- Latency: ~5-15 seconds (2-5 LLM calls)

### Why No Training

LLM is used as-is via API calls. The reasoning is done by prompting with code context.

---

## 10. Agentic Multi-Step Test Selection

**Type**: LLM agent with tool calls
**Implementation**: ~200 lines of Python
**Reference**: [Agentic CI](https://github.com/yksanjo/agentic-ci)

### Algorithm

1. Agent reads the diff
2. Identifies affected files/modules using tool calls (grep, file tree)
3. Maps modules to test cases using descriptions and tagging
4. Calls LLM to reason about indirect impacts
5. Returns a prioritized subset of tests

### Performance

- Handles large codebases better than single-prompt approaches
- Latency: ~10-30 seconds (multiple LLM calls)
- Most thorough of all approaches

### Why No Training

Uses off-the-shelf LLMs via API calls. Pattern storage is simple key-value, not model training.

---

## 11. Deterministic / Algorithmic Strategies

### Greedy Additional Coverage

Iteratively select the test that covers the most uncovered features. After selecting test T1 that covers features {A,B,C}, remove those from remaining tests' counts, repeat.

- APFD: 75-85% vs ~50% for random
- Requires a feature-to-test mapping (manual or auto-generated)

### Time-Constrained Greedy (Knapsack)

Given a time budget, greedily select tests that maximize feature coverage per minute of execution time.

- Detects 80%+ of failures within first 20% of execution time
- Sort by `coverage / duration` ratio and fill budget

### Change-Based Selection

Only run tests that exercise code paths affected by the current change. Requires a mapping from source files to tests (manual or instrumented).

- Microsoft reported selecting only 10-25% of tests while catching 95%+ of regressions

---

## 12. Recommended Layered Architecture

```
Layer 1: Thompson Sampling + Heuristic Score
         (always on, learns from every run, ~25 lines)
              |
Layer 2: Embedding Similarity Boost (per-PR)
         (boosts tests related to the code change, <1s)
              |
Layer 3: LLM Reasoning (optional, for high-stakes/ambiguous runs)
         (~3-5s per invocation)
              |
Layer 4: LPT Scheduling
         (assigns final prioritized list across parallel Morph slots)
```

### Combined Formula

```
final_priority(test) = thompson_sample(test)
                     * (1 + embedding_similarity(test, diff))
                     * heuristic_score(test)
```

### Implementation Effort

| Layer | Lines of Code | Dependencies | Storage |
|---|---|---|---|
| Thompson Sampling | ~25 | None (`random.betavariate`) | 2 floats per test case |
| Heuristic Score | ~50 (mostly SQL) | None | Existing `test_results` |
| Embedding Selection | ~100 | Gemini embedding API | 1 vector per test case |
| LLM Reasoning | ~80 | Gemini chat API | None |
| LPT Scheduling | ~20 | None | None |
| **Total** | **~275** | **Gemini (already in stack)** | **Minimal** |

---

## 13. Expected Impact

| Metric | Before | After | Source |
|---|---|---|---|
| Time to first failure | Random ordering | **30-50% faster** | COLEMAN (IEEE TSE) |
| Total run wall-clock time | Naive parallel | **15-30% shorter** | LPT scheduling theory |
| Tests skipped per PR | 0% | **40-70%** (95%+ fault recall) | Embedding similarity research |
| Missed regressions | N/A | **< 5%** | Thompson Sampling convergence |

For a typical 10-test skeptic suite at 1.5-3 min per test: **saving 3-10 minutes per run**.

---

## 14. Academic References

### Multi-Armed Bandit / Online Learning
- Lima & Vergilio, "A Multi-Armed Bandit Approach for Test Case Prioritization in CI Environments," IEEE TSE 2020 ([IEEE Xplore](https://ieeexplore.ieee.org/document/9086053/))
- [coleman4hcs GitHub Repository](https://github.com/jacksonpradolima/coleman4hcs)
- Agrawal & Goyal, "Analysis of Thompson Sampling for the Multi-armed Bandit Problem," ICML 2012
- Russo et al., "A Tutorial on Thompson Sampling," Stanford 2018 ([PDF](https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf))
- Auer, Cesa-Bianchi & Fischer, "Finite-time Analysis of the Multiarmed Bandit Problem," Machine Learning 2002

### Test Case Prioritization
- Spieker et al., "Reinforcement Learning for Automatic Test Case Prioritization and Selection in CI," ISSTA 2017 ([arXiv](https://arxiv.org/abs/1811.04122))
- Torbunova, Strandberg & Porres, "Dynamic Test Case Prioritization in Industrial Test Result Datasets," arXiv:2402.02925, 2024
- Ramirez et al., "Towards Explainable Test Case Prioritisation with Learning-to-Rank Models," arXiv:2405.13786, 2024
- Cheng et al., "Revisiting Test-Case Prioritization on Long-Running Test Suites," UIUC 2024

### LLM-Based Approaches (Zero Training)
- "Ripple: From Seed to Scope — Reasoning to Identify Change Impact Sets," ICSE 2026
- "LLM-Enhanced Test Case Prioritization for Complex Software Systems," PCI 2024
- "Leveraging LLM Enhanced Commit Messages for ML-Based TCP," PROMISE 2025
- "LLM-Based Automated Diagnosis of Integration Test Failures at Google," ICSE 2026 SEIP
- [Agentic CI GitHub Repository](https://github.com/yksanjo/agentic-ci)

### Parallel Test Execution
- "Engineering Optimal Parallel Task Scheduling," arXiv:2405.15371, 2024
- Bairi et al., "Quantum Computing in Test Automation: Optimizing Parallel Execution," JAIGS 2024

### Browser Automation Performance
- Garcia et al., "Exploring Browser Automation: Selenium, Cypress, Puppeteer, and Playwright," QUATIC 2024
- Goel et al., "Sprinter: Speeding up High-Fidelity Crawling of the Modern Web," NSDI 2024

### Event Streaming
- Hassan, "Choosing the Right Communication Protocol for Your Web Application," arXiv:2409.07360, 2024
- Chmelev, "Architectural Approaches to Building Real-Time Web Applications," ARJCSIT 2024

### Test Impact Analysis
- Martin Fowler, "The Rise of Test Impact Analysis"
- Plyusnin et al., "Targeted Test Selection in CI," arXiv:2509.10279, 2025
