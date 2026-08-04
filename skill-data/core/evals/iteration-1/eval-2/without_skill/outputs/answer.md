# Diagnosing a possible duplicate fetch

Treat the effect warning as a hypothesis. Static analysis can identify a suspicious effect/fetch pattern, but only an exercised runtime path can show whether two equivalent requests actually occur.

First, run Doctor only on the pull request's changed scope and make the base explicit:

```bash
E=.skeptic/manual/duplicate-fetch-pr
mkdir -p "$E"

skeptic doctor . \
  --scope changed \
  --base origin/main \
  --format json \
  --output "$E/doctor.json"
```

I would record the rule ID, file/span, confidence, and explanation from `doctor.json`, but would not label the duplicate confirmed. I would also not pass `--allow-project-commands` unless the project-defined analyzer commands were separately reviewed and authorized.

Next, exercise the smallest browser path that mounts the component and triggers the effect. Clear old observations immediately before the trigger so Strict Mode startup noise, polling, retries, prefetch, and earlier navigation are not accidentally counted. Re-snapshot after every navigation or meaningful DOM change:

```bash
S=duplicate-fetch-pr
skeptic --session "$S" open http://127.0.0.1:3000/the-relevant-route
skeptic --session "$S" snapshot -i -c > "$E/01-route.snapshot.txt"
skeptic --session "$S" console --clear
skeptic --session "$S" errors --clear
skeptic --session "$S" network requests --clear
skeptic --session "$S" network har start

# If an interaction triggers the effect, use a ref from 01-route.snapshot.txt.
skeptic --session "$S" click @trigger_ref
skeptic --session "$S" wait 1000
skeptic --session "$S" snapshot -i -c > "$E/02-after-trigger.snapshot.txt"
skeptic --session "$S" network requests --filter "/api/relevant-resource" > "$E/runtime.network.txt"
skeptic --session "$S" console > "$E/runtime.console.txt"
skeptic --session "$S" errors > "$E/runtime.errors.txt"
skeptic --session "$S" network har stop "$E/runtime.har"
skeptic --session "$S" screenshot "$E/after-trigger.png" --full
skeptic --session "$S" close
```

The request comparison must use the semantic request identity relevant to the application: method, normalized URL/query, body or operation name, and timing. Two lines are not automatically a bug: one may be a CORS preflight, an intentional retry after failure, a redirect, polling, or two different request bodies. Conversely, two successful identical requests caused by one user action are strong runtime evidence.

The proof run should be a deterministic Skeptic spec for that exact route/action. The spec must clear the request buffer immediately before the trigger, capture the relevant request set, and assert the expected count. Run only that spec first:

```bash
skeptic run tests/relevant-effect.spec.ts \
  --format json \
  --output "$E/run.json"
```

The run creates `.skeptic/runs/<run-id>/manifest.json` and a network sidecar. Use the actual `<run-id>` reported by the run; do not guess it. Fold that run together with Doctor's static diagnostics, then inspect the score explanation and coverage:

```bash
RUN_MANIFEST=.skeptic/runs/<run-id>/manifest.json

skeptic report \
  --manifest "$RUN_MANIFEST" \
  --diagnostics "$E/doctor.json" \
  --format json \
  --output "$E/correlated-report.json"

skeptic score \
  --manifest "$RUN_MANIFEST" \
  --diagnostics "$E/doctor.json" \
  --explain > "$E/score-explain.txt"
```

The diagnosis is **confirmed** only if the single exercised trigger produces the equivalent duplicate requests and the correlated report marks the effect/fetch diagnostic as corroborated. It is **disproved for this path and environment** only if the manifest shows that the relevant path was covered and the captured network sidecar shows the expected single request; that is not a universal proof for unexercised dependency values, production-only behavior, or a different React mode. If the run did not cover the component or request trigger, the answer remains “not proven,” regardless of the static finding or numeric score.
