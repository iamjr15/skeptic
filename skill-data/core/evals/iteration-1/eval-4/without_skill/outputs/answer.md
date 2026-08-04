# Skeptic CI for an untrusted fork pull request

Generate the checked-in workflow from the installed Skeptic version:

```bash
skeptic add github-action
git diff -- .github/workflows/skeptic.yml
```

This creates `.github/workflows/skeptic.yml`. If that path already exists, Skeptic refuses to replace it; use `skeptic add github-action --force` only after intentionally reviewing/replacing the existing workflow.

For fork safety, keep the generated workflow on `pull_request`, not `pull_request_target`, check out the PR code with only `contents: read`, do not inject repository secrets, and retain the generated guard on the write-capable SARIF upload:

```yaml
if: always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)
```

The workflow declares `security-events: write` so trusted runs can upload SARIF, but the guarded step must not run for a pull request whose head repository differs from the target repository. Artifact upload remains `if: always()` because it stores run output for review rather than writing code/security state back to the repository. The untrusted job should not gain any additional write permissions.

The generated jobs deliberately keep the evidence even when QA fails:

- Doctor emits `skeptic-doctor.sarif`.
- Browser QA emits `skeptic-junit.xml` and creates `.skeptic/runs/` manifests/sidecars.
- Report generation appends the human report to `$GITHUB_STEP_SUMMARY` and translates SARIF results into GitHub workflow annotations.
- `actions/upload-artifact@v4` uploads `.skeptic/runs/`, SARIF, JUnit, and `.skeptic-dev.log` under `skeptic-${{ github.run_id }}` with `if: always()`.
- The final enforcement step fails the job if either the Doctor or browser step failed, after evidence publication has had a chance to run.

One permission is intentionally *not* implicit: do not add `--allow-project-commands` to `skeptic doctor`, and do not enable the corresponding config policy for untrusted fork code. Project-defined analyzer commands execute repository-controlled programs. Skeptic's non-interactive policy should block them unless a trusted maintainer has reviewed and explicitly authorized them. If those analyzers are needed, run them only in a separate trusted workflow/job with narrowly scoped permissions and no fork-controlled secrets.

Before merging the CI change, I would verify the checked-in YAML still has the fork-head comparison, no `pull_request_target`, no secret environment variables, no permission broader than the generated `contents: read`/`security-events: write`, no project-command opt-in, the step summary and annotation commands, both upload steps, and the final result enforcement. I would then test one same-repository PR and one fork PR: the former may upload SARIF; the latter must skip SARIF upload while still producing the ordinary evidence artifact and step summary.
