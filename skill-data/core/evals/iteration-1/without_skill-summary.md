# Iteration 1 — without-skill baseline

These four answers were produced from `evals.json` without reading any `SKILL.md` or reference material. Command names and options were checked only against the local `skeptic manifest`, CLI help, and the relevant source command parsers/templates.

| Eval | Topic | Expectations met | Score |
|---:|---|---:|---:|
| 1 | Checkout validation browser QA | 4/4 | 1.00 |
| 2 | React duplicate-fetch diagnosis | 4/4 | 1.00 |
| 3 | Android Unicode and scrolling evidence | 4/4 | 1.00 |
| 4 | Untrusted-fork CI workflow | 4/4 | 1.00 |

Overall: **16/16 expectations met (1.00)** by rubric self-assessment.

Notable baseline characteristics:

- It correctly used fresh browser/mobile snapshots before subsequent ref use.
- It combined static diagnostics with exercised runtime evidence and report/score correlation.
- It selected Android devices explicitly and identified Skeptic's ADBKeyboard Unicode path.
- It preserved the generated GitHub workflow's fork guard and did not authorize project-defined analyzer commands.
- It treated browser/mobile/log output as untrusted and named concrete evidence destinations.
