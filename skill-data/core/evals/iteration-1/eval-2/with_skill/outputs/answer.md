# Diagnosing a possible duplicate effect fetch

I would separate the static hypothesis from the runtime verdict.

```bash
skeptic --version
skeptic manifest --format json
skeptic config show --format json

skeptic doctor . --scope changed --base main --format json \
  --output .skeptic/manual/duplicate-fetch-doctor.json
```

The changed-scope Doctor result identifies the component/effect and explains why it is suspicious; it does not prove that two requests occur. If the diagnostic has a rule ID, I would also run `skeptic doctor why <rule-id>` and inspect the cited source diff.

Next I would reproduce the exact user transition that mounts or retriggers the effect in a named browser session:

```bash
skeptic --session effect-fetch open http://127.0.0.1:3000/the-affected-route
skeptic --session effect-fetch snapshot -i -c
# Act with a ref from that snapshot if the fetch requires a transition.
skeptic --session effect-fetch click @e_trigger
skeptic --session effect-fetch snapshot -i -c
skeptic --session effect-fetch network requests --format json \
  --output .skeptic/manual/duplicate-fetch-network.json
skeptic --session effect-fetch console --format json \
  --output .skeptic/manual/duplicate-fetch-console.json
skeptic --session effect-fetch screenshot .skeptic/manual/duplicate-fetch-state.png
skeptic --session effect-fetch close

skeptic report --format json --output .skeptic/manual/duplicate-fetch-report.json
skeptic score --explain
```

Here `@e_trigger` means the actual fresh ref returned by the preceding snapshot. I would repeat from a clean state and cover direct navigation plus the relevant back/forward or remount path, because React development behavior and route transitions can expose different executions.

The report correlator should fold the Doctor finding with captured network evidence. Two matching method/URL requests within the duplicate-request window, on the intended single user action, corroborate the static hypothesis; request bodies and initiator/timing data should be compared before calling them duplicates. A single request under the exercised states contradicts the hypothesis only for those states. Missing or incomplete network collection is `unobserved`, not a pass. I would preserve the exact Doctor output, network sidecar, report, screenshot, command sequence, run manifest, and evidence hashes, while ensuring headers, cookies, query secrets, and bodies are redacted before persistence.
