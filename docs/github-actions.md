# GitHub Actions

Generate the maintained workflow into an application repository:

```bash
skeptic add github-action
```

The workflow installs the version-matched npm package, starts the app, waits
for its URL, runs Doctor and browser specs, uploads SARIF when write permission
is available, emits workflow annotations and a step summary, and preserves QA
evidence as an artifact.

Review these project-specific lines before committing it:

- `npm run dev` and `http://127.0.0.1:3000`;
- the Node version and package-manager install step;
- whether the repository has Skeptic specs;
- the Doctor blocking policy;
- artifact retention and sensitive-pixel policy.

The SARIF upload is guarded for untrusted fork pull requests because their
tokens do not receive `security-events: write`. Do not remove the guard. By
default the artifact staging step excludes PNG and video files even when a run
manifest contains them. Set `SKEPTIC_CI_INCLUDE_SENSITIVE=true` only in a
trusted workflow after reviewing the target pages and retention policy.

Project-defined analyzer commands remain disabled unless the workflow
explicitly supplies `--allow-project-commands`; installing Skeptic does not
grant that authority.
