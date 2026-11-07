# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a vulnerability. Report it privately to
the maintainers through GitHub's "Report a vulnerability" (Security → Advisories)
for this repository, or by contacting the maintainer listed in `package.json`.

Include the impact, a reproduction (tool call or request), the affected version
and any suggested fix. We aim to acknowledge within 7 days.

## Scope notes

- The plugin runs in the Harness Host process and can write files under the
  configured registry root (`$DSH_HOME/routine-registry` by default). Untrusted
  routine hooks are executed in-process; only install routines you have reviewed.
- The Settings panel reaches the Host through exact Connection Fetch routes under
  `/api/routine-stabilization`. Those routes are admitted by the Harness
  Connection service (owner browser principal); the plugin implements no second
  authentication mechanism and exposes no unauthenticated HTTP surface.
- Agent tools can propose candidate routines and run evaluations, but cannot
  release or withdraw them. Release/withdrawal stay user-only actions.
- The example fixtures are synthetic; do not treat them as production data.
