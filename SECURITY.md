# Security Policy

skeptic is a QA tool that drives a real browser and, when explicitly opted in,
reads and decrypts local browser cookies. We take the security of that surface
seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through either channel:

- **Email:** jigyansu@riverline.ai with a subject line starting `[skeptic-security]`.
- **GitHub:** open a private advisory via the repository's
  **Security → Report a vulnerability** ("Private vulnerability reporting") page.

Please include:

- a description of the issue and its impact,
- the skeptic version (`skeptic --version`) and OS,
- minimal reproduction steps or a proof of concept,
- any relevant logs (with secrets redacted).

### Response targets

| Stage | Target |
|---|---|
| Acknowledgement of report | within 3 business days |
| Initial assessment / severity triage | within 7 business days |
| Fix or mitigation plan for confirmed issues | within 30 days, severity permitting |

We will keep you updated through remediation and will credit you in the release
notes unless you ask to remain anonymous. Please give us a reasonable window to
ship a fix before any public disclosure.

## Supported versions

skeptic is pre-1.0 and ships from a single active line. Security fixes land on
the latest published `0.2.x` release; please upgrade to the newest version
before reporting.

| Version | Supported |
|---|---|
| latest `0.2.x` | Yes |
| older `0.x` | No — please upgrade |

## Security model and considerations

skeptic has **no built-in AI/model**, makes **no outbound API calls of its own**,
and uses **no API keys**. That removes an entire class of secret-handling and
data-exfiltration risk. The areas that do warrant care:

- **Browser cookie extraction is opt-in and local.** It is off unless you pass
  `--cookies` / `--cookies-from <browser>`. When enabled, skeptic decrypts
  cookies locally using the OS keychain/secret store and injects them only into
  the local test browser context. Cookies are never transmitted off the
  machine. Treat any output bundle that may contain authenticated session
  state as sensitive and do not commit it or attach it to public CI artifacts.
- **Agent-driven browser actions.** skeptic executes the spec code it is given
  and navigates to the URLs it is pointed at. Run untrusted specs and untrusted
  target sites only in an isolated environment. Use the `safety` config block
  (`allowedDomains`, `confirmActions`, `maxOutputChars`) to constrain what a
  run may touch.
- **Evidence artifacts can contain page contents.** Screenshots, videos,
  traces, and `network.json` may capture tokens, PII, or other sensitive data
  rendered or transmitted by the page under test. Scope artifact retention and
  access accordingly.
- **The daemon listens on a local Unix socket.** The persistent `BrowserServer`
  socket lives under `~/.skeptic/` with restrictive directory permissions and
  an optional shared-secret handshake (`SKEPTIC_DAEMON_AUTH_TOKEN`). It is not
  intended to be exposed across a network boundary.

## Scope

In scope: the skeptic CLI, daemon, cookie decryption path, and the published
npm package. Out of scope: vulnerabilities in upstream dependencies (report
those upstream; we will pick up fixes), and issues that require an already
fully-compromised local machine.
