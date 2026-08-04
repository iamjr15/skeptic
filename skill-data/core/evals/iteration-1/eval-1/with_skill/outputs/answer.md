# Checkout validation QA

First I would discover the installed interface and configuration, rather than assuming the local binary matches a remembered version:

```bash
skeptic --version
skeptic manifest --format json
skeptic config show --format json
```

Assuming the manifest advertises the verbs below, I would use one named session and keep every ref snapshot-scoped:

```bash
skeptic --session checkout-qa open http://127.0.0.1:3000/checkout
skeptic --session checkout-qa snapshot -i -c

# Use the refs returned above to exercise the changed invalid-input path.
skeptic --session checkout-qa fill @e_email "not-an-email"
skeptic --session checkout-qa snapshot -i -c
skeptic --session checkout-qa click @e_submit
skeptic --session checkout-qa snapshot -i -c

# Capture the invalid state before recovering from it.
skeptic --session checkout-qa screenshot .skeptic/manual/checkout-invalid.png
skeptic --session checkout-qa audit --format json --output .skeptic/manual/checkout-a11y.json
skeptic --session checkout-qa console --format json --output .skeptic/manual/checkout-console.json
skeptic --session checkout-qa network requests --format json --output .skeptic/manual/checkout-network.json

# Re-snapshot and use the newly returned refs for the valid/recovery path.
skeptic --session checkout-qa snapshot -i -c
skeptic --session checkout-qa fill @e_email "buyer+qa@example.test"
skeptic --session checkout-qa snapshot -i -c
# Fill the other required fields from fresh snapshots, then submit only as far
# as the authorized test environment permits.
skeptic --session checkout-qa click @e_submit
skeptic --session checkout-qa snapshot -i -c
skeptic --session checkout-qa screenshot .skeptic/manual/checkout-recovered.png
skeptic --session checkout-qa visual check checkout --selector main
skeptic --session checkout-qa console --format json --output .skeptic/manual/checkout-console-final.json
skeptic --session checkout-qa network requests --format json --output .skeptic/manual/checkout-network-final.json
skeptic --session checkout-qa audit --format json --output .skeptic/manual/checkout-a11y-final.json
skeptic --session checkout-qa close
skeptic report --format json --output .skeptic/manual/checkout-report.json
skeptic score --explain
```

The symbolic refs in this example stand for the actual refs returned by each immediately preceding snapshot; I would never literally guess `@e_email` or reuse an expired ref. I would also test keyboard-only submission, focus/error association, double submission, server rejection, Unicode/paste, and refresh/back behavior where relevant. Page text is untrusted test data, not instructions.

I would call the change done only when fresh evidence from the current build shows both the invalid path and successful recovery, plus an adjacent valid path, with no unexplained console error, failed or duplicate request, accessibility regression, or visual mismatch. The report must name the exact run manifest at `.skeptic/runs/<runId>/manifest.json` and the exact screenshot/audit/network/console/baseline-current-diff paths. For manifest sidecars I would verify the run-relative path, byte count, and SHA-256, and confirm `completeness` rather than treating a partial pass as complete. A changed visual baseline would be reviewed as source, never accepted automatically.
