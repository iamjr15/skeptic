# Third-party licenses and attributions

skeptic-cli is distributed under the [MIT License](#mit-license-skeptic-cli)
(see `package.json:license`). Portions of skeptic are derived from upstream
projects under their own terms; those terms and the corresponding NOTICE
attributions follow.

## NOTICE — agent-browser (Apache License 2.0)

Portions of this software are derived from
[agent-browser](https://github.com/vercel-labs/agent-browser) © 2025 Vercel Inc.,
licensed under the Apache License 2.0.

The agent-browser project provided the algorithmic basis for several of
skeptic's agent-discovery primitives. The Rust originals were ported to
TypeScript as part of the v0.2.0 TS-pivot bundle. Files that contain ported
algorithms carry a `// Source: agent-browser <path>:<lines> © Vercel Inc.,
Apache 2.0` header at the top of the file. The current set of derived files,
maintained for the convenience of downstream auditors, is:

- `cli/src/api/snapshot.ts` — `render_tree` / `compact_tree` rendering modes
  (`agent-browser/cli/src/native/snapshot.rs:1060-1230`).
- `cli/src/executor/aria-snapshot-capture.ts` — cursor-interactive heuristic
  for elements that have click handlers but no ARIA role.
- `cli/src/executor/aria-ref-resolver.ts` — `RefMap` dispatch by ref kind.
- `cli/src/executor/aria-ref-types.ts` — `AriaRefEntry` / `RefEntry` shape.
- `cli/src/commands/inspect.ts` — CDP auto-discovery flow
  (`/json/version` → `/json/list` → direct `/devtools/browser` WebSocket;
  `agent-browser/cli/src/native/cdp/discovery.rs:1-100`).
- `cli/src/api/screenshot.ts` and `cli/src/executor/annotation-overlay.ts` —
  annotation-record shape and `fullPage` projection with `scrollY` offset.
- `cli/AGENTS.md` — overall workflow-doc structure (Discovery / Selectors /
  Output / Failure modes / Patterns / Cursor + video). The TypeScript content
  is original; the section ordering and the agent-facing framing are adapted.
- `cli/src/daemon/socket.ts` — line-delimited JSON framing on a Unix socket,
  malformed-line tolerance, `looks_like_http` early-exit, idle-reset signal on
  each accepted command (`agent-browser/cli/src/native/daemon.rs:357-430`).
  Stale-socket cleanup with realpath check, the `0700` parent-dir mode, and
  the optional `SKEPTIC_DAEMON_AUTH_TOKEN` shared-secret handshake are
  skeptic-original.
- `cli/src/daemon/lifecycle.ts` — start-up + shut-down skeleton: pid /
  version / engine sidecar files written on start and unlinked on exit;
  idle-timer-with-reset that re-arms on every accepted command; SIGINT /
  SIGTERM / SIGHUP handlers close the BrowserServer before process exit so
  destructors fire and Chrome processes don't get orphaned
  (`agent-browser/cli/src/native/daemon.rs:115-255` and `:439-482`).
- `cli/src/daemon/rpc.ts` — control-plane-only RPC dispatch (handshake,
  version probe, idle-reset, stop). No browser-context or page operations
  are marshaled over the socket; workers connect directly to
  `BrowserServer.wsEndpoint()` via Playwright's
  `pw[engine].connect(wsEndpoint)` and own their own `BrowserContext`. The
  handshake fields and engine-mismatch / version-mismatch paths follow the
  shape at `agent-browser/cli/src/native/daemon.rs:357-430`.
- `cli/src/daemon/client.ts` — auto-spawn-with-detached-unref, the
  version-mismatch restart loop with retry cap, and the bounded
  socket-readiness probe (`agent-browser/cli/src/connection.rs:574-602`).
  The Playwright `pw[engine].connect` + BrowserContext-per-test isolation
  model that sits on top is skeptic-original — agent-browser marshals every
  browser op over the socket, skeptic hands out the raw WebSocket and lets
  Playwright's native disconnect-cleanup handle teardown.
- `cli/src/daemon/auto-spawn.ts` — the "ensure daemon running before doing
  browser work" gate (`agent-browser/cli/src/connection.rs:574-602`).
  agent-browser calls `ensure_daemon` from the CLI main, never from a
  worker; this helper enforces the same discipline for skeptic — the
  prewarm runs in the main process so a `worker_thread` never resolves to
  `dist/worker.mjs` and mis-spawns a "daemon" that is actually the worker
  entrypoint.

All five daemon files carry the verbatim
`// Source: agent-browser/cli/src/<path>:<lines> © Vercel Inc., Apache 2.0`
header at the top, in line with the per-file convention used elsewhere in
this NOTICE. The portions above were derived from the agent-browser
sources cited; the Playwright-connection model, the shared-secret token,
and the BrowserContext-per-test isolation contract are skeptic's own.

The list above is informational and may lag the source. The authoritative
record is the per-file `// Source: agent-browser ...` header — it is checked
on every PR that touches a derived file. If you find a file that carries
agent-browser code without a header, please open an issue.

In accordance with §4(d) of the Apache License 2.0, this NOTICE block is
distributed alongside skeptic-cli (via `package.json:files`) so that
downstream consumers receive the attribution.

## Apache License 2.0 (full text)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## Inspirations (no code copy)

skeptic's cursor overlay, dual-engine accessibility audit, and several
diagnostic patterns were inspired by [`expect`](https://github.com/expectquality/expect)
(Functional Source License 1.1-MIT, becomes MIT in 2028). Per FSL's
non-compete restriction during the source-available window, skeptic does **not**
copy code from expect. Where a feature was prompted by expect's behavior,
the implementation was written from skeptic's own primitives — usually from a
different angle (e.g. cursor markers ride on a `Page` Proxy boundary in
skeptic, not on a CDP shim). The patterns are inspirational; the code is
original.

## MIT License (skeptic-cli)

```
MIT License

Copyright (c) skeptic-cli authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
