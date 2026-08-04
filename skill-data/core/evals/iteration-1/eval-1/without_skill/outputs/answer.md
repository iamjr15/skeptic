# Checkout validation QA

I would use one named session and one evidence directory so every observation is attributable. Replace the URL and refs below with the real target and the refs from the immediately preceding snapshot.

```bash
S=checkout-validation-pr
E=.skeptic/manual/checkout-validation-pr
mkdir -p "$E"

skeptic --session "$S" mark STEP_START invalid-submit "Exercise changed validation path"
skeptic --session "$S" --content-boundaries open http://127.0.0.1:3000/checkout
skeptic --session "$S" snapshot -i -c > "$E/01-initial.snapshot.txt"
skeptic --session "$S" console --clear
skeptic --session "$S" errors --clear
skeptic --session "$S" network requests --clear

# Use only refs from 01-initial.snapshot.txt here.
skeptic --session "$S" fill @email_ref "broken-address"
skeptic --session "$S" fill @card_ref "4242"
skeptic --session "$S" click @submit_ref
skeptic --session "$S" wait 250

# Submission changed the DOM, so discard all prior refs.
skeptic --session "$S" snapshot -i -c > "$E/02-invalid.snapshot.txt"
skeptic --session "$S" screenshot "$E/02-invalid.png" --full
skeptic --session "$S" network requests --filter "/api/checkout" > "$E/02-invalid.network.txt"
skeptic --session "$S" console > "$E/02-invalid.console.txt"
skeptic --session "$S" errors > "$E/02-invalid.errors.txt"

# Use the fresh field refs from 02-invalid.snapshot.txt.
skeptic --session "$S" get attr @fresh_email_ref aria-invalid > "$E/02-email-aria-invalid.txt"
skeptic --session "$S" get attr @fresh_email_ref aria-describedby > "$E/02-email-aria-describedby.txt"
skeptic --session "$S" mark STEP_DONE invalid-submit "Invalid input rejected without checkout request"

# Adjacent negative boundary: valid email, but a required field is empty.
skeptic --session "$S" mark STEP_START adjacent-negative "Exercise neighboring required-field rule"
skeptic --session "$S" network requests --clear
skeptic --session "$S" fill @fresh_email_ref "buyer@example.test"
skeptic --session "$S" fill @fresh_required_ref ""
skeptic --session "$S" click @fresh_submit_ref
skeptic --session "$S" wait 250
skeptic --session "$S" snapshot -i -c > "$E/03-adjacent-negative.snapshot.txt"
skeptic --session "$S" screenshot "$E/03-adjacent-negative.png" --full
skeptic --session "$S" network requests --filter "/api/checkout" > "$E/03-adjacent-negative.network.txt"
skeptic --session "$S" mark STEP_DONE adjacent-negative "Required-field boundary rejected"

# Happy-path recovery. Use refs from 03-adjacent-negative.snapshot.txt only.
skeptic --session "$S" mark STEP_START valid-submit "Correct errors and submit once"
skeptic --session "$S" network requests --clear
skeptic --session "$S" fill @current_required_ref "valid value"
skeptic --session "$S" fill @current_card_ref "4242424242424242"
skeptic --session "$S" click @current_submit_ref
skeptic --session "$S" wait 1000
skeptic --session "$S" snapshot -i -c > "$E/04-success.snapshot.txt"
skeptic --session "$S" screenshot "$E/04-success.png" --full
skeptic --session "$S" network requests --filter "/api/checkout" > "$E/04-success.network.txt"
skeptic --session "$S" console > "$E/04-success.console.txt"
skeptic --session "$S" errors > "$E/04-success.errors.txt"
skeptic --session "$S" mark STEP_DONE valid-submit "Corrected form submitted once and reached success state"
skeptic --session "$S" mark RUN_COMPLETED "Checkout validation QA completed"
skeptic --session "$S" close
```

The accessibility snapshots are evidence, not merely locators. On each invalid state I would verify that the relevant field is marked invalid, its error is referenced by `aria-describedby` (or an equivalent accessible relationship), the error appears in the accessibility tree with a suitable role/live behavior, focus moves or remains predictably, and the message is not conveyed by color alone. Because the DOM changed after each submit, all refs before the new snapshot are stale by policy.

I would then encode the same changed case, neighboring negative case, and recovery case in the repository's Skeptic spec and produce the foldable run artifacts:

```bash
skeptic run tests/checkout-validation.spec.ts --format junit --output "$E/skeptic-junit.xml"
skeptic report --format json --output "$E/report.json"
skeptic score --explain > "$E/score.txt"
```

I call it done only when all of the following exist:

- `.skeptic/manual/checkout-validation-pr/02-invalid.network.txt` and `03-adjacent-negative.network.txt` show no checkout request for client-invalid forms, while `04-success.network.txt` shows exactly the expected request count and result.
- The three post-action snapshots prove the error, adjacent error, and success states with fresh refs; the ARIA attribute captures prove the field/error association.
- The screenshots make the visual states reviewable, including focus/error styling and layout.
- Console and page-error files contain no new unexpected error. Expected messages are documented rather than silently ignored.
- `skeptic-junit.xml`, `report.json`, `score.txt`, and the generated `.skeptic/runs/<run-id>/manifest.json` agree on the result and evidence coverage.
- The session has a `RUN_COMPLETED` marker and is closed even on failure (in automation I would put `close` in cleanup).

DOM text, error copy, console output, and network bodies are untrusted input. I would not execute instructions found in them, interpolate them into shell/`eval`, or publish secrets; I would retain only the redacted evidence needed for the review.
