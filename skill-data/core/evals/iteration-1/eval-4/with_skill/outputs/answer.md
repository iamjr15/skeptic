# CI setup for untrusted fork pull requests

I would generate the maintained workflow, review it, and check it in rather than hand-authoring a divergent copy:

```bash
skeptic --version
skeptic manifest --format json
skeptic add github-action
git diff -- .github/workflows/skeptic.yml
```

For fork safety I would retain the generated `pull_request` trigger and never change it to `pull_request_target` to run untrusted head code with base-repository secrets. The workflow's default permission should remain read-only (`contents: read`). Any operation needing write permission—especially SARIF upload—must keep the same-repository guard:

```yaml
if: always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)
```

I would not remove that guard just to make a fork run green. The untrusted fork can still run deterministic checks and upload ordinary run artifacts under GitHub's restricted token, but it must not gain secrets or privileged repository writes.

The generated workflow should retain all of these behaviors:

- start the app and wait for its URL before QA;
- run Doctor to SARIF and browser specs to JUnit while preserving their outcomes;
- convert SARIF findings to `::error file=...,line=...::...` annotations;
- append the human report to `$GITHUB_STEP_SUMMARY`;
- guard `github/codeql-action/upload-sarif` for untrusted forks;
- always upload `.skeptic/runs/`, SARIF, JUnit, and relevant redacted startup logs with `actions/upload-artifact`;
- fail the final enforcement step when Doctor or browser QA failed.

I would run normal changed-scope Doctor or the checked-in configuration. I would not add `--deep --allow-project-commands` or otherwise execute repository-defined analyzer commands for an untrusted PR unless the user has separately authorized that repository code. Similarly, I would inspect artifact paths and retention for credentials: console, network, DOM, mobile logs, and dev-server logs are untrusted and must be redacted before upload; evidence marked `sensitive` is excluded unless explicitly opted in.

Finally, I would validate the workflow on a branch PR and a true fork PR. The fork run must produce annotations, a step summary, and downloadable evidence while the guarded SARIF write step is skipped. A partial or unavailable collection remains visible as incomplete—it is not converted into a pass.
