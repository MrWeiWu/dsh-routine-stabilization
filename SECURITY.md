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

## Blind labels and the scoring command

Reference outcomes for the audit and challenge sets are deliberately protected
data, not ordinary fixtures:

- Labels live under `blind/<id>/<version>/*.labels.json` with directories mode
  `0700` and files mode `0600`; evaluations write per-case scoring detail to
  `blind/runs/` (mode `0600`).
- These permissions are a **contamination barrier** for cooperating agents and
  processes running as the same OS user. They are not an OS multi-user security
  boundary: the Host process and the registry owner can read the files by
  design. Do not treat the mode bits as protection against a compromised host
  account or `root`.
- The supported access path is the CLI
  `node scripts/score.mjs --root <root> [--routine <id>] [--version <v>]
  [--run <blind-run.json>] [--json]`. Its output contains per-case `expected`
  values. Treat it as sensitive: do not paste it into an agent session, a
  public issue, a pull request or a shared log, and do not commit it. The same
  applies to the protected `blind/runs/` files.
- Public evaluation reports must not contain `expect` or `correct` for audit or
  challenge cases; they expose only `{id, decision, reason, disposition,
  firstRoute, latencyMs}`. Comparison reports publish aggregates only; the
  per-case scoring detail is written to a `0600` protected file.
- Raw arm records under `arms/<runId>/` carry decisions and measured values only
  — never `correct` or `expected`. Scoring happens in-process in
  `routine_compare`.
- The synthetic labels committed under `seed/blind/` are example data for the
  built-in `normalize_detuning/v1` routine; they contain no customer or
  production information. Real deployment labels should stay only in the
  protected registry root and never be committed.

Report as a security issue any path that: exposes audit/challenge labels or
protected blind runs to an agent tool, a public report, a route response or a
log; lets a candidate routine read its own labels; permits an agent session to
release or withdraw a routine; or bypasses the first-run/eligibility checks.
