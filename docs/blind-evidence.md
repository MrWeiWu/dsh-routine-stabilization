# Blind evidence

The framework separates the data a routine may be **tuned** on from the data used
to **prove** it. This page describes where each kind lives, how labels are
protected, and the only supported way to look at reference outcomes.

## Why split the evidence

A representative audit set and a near-miss challenge set are only evidence if the
routine and its author never saw their expected answers while the routine was
being built. Keeping labels inline with inputs (as v0.1 did) makes that
guarantee unenforceable: any process that can read the fixture can read the
answer. v0.2 therefore splits every blind set into an **inputs file** that is
freely readable and a **labels file** that is readable only through the scoring
path.

## Layout (v2)

Under a registry root (the packaged copy lives in `seed/`; `routine_seed` copies
it, preserving modes):

```
fixtures/<id>/<version>/dev.json                  dev cases, inline expected values, readable
fixtures/<id>/<version>/audit.inputs.json          audit ids, descriptions and inputs only
fixtures/<id>/<version>/challenge.inputs.json      challenge ids, descriptions and inputs only
blind/<id>/<version>/audit.labels.json             audit expected values, file 0600, dirs 0700
blind/<id>/<version>/challenge.labels.json         challenge expected values, file 0600, dirs 0700
blind/runs/<id>-v<version>-<UTC stamp>.json        per-case scoring detail, file 0600
```

`dev` stays inline because derivation and tuning on `dev` is intended. Audit and
challenge labels are *only* consumed by the evaluation and comparison code; the
runtime never reads them, and the candidate routine never receives them as
input.

The manifest declares both halves of the evidence:

```json
"evidence": {
  "fixtureSets": {
    "dev": "fixtures/normalize_detuning/v1/dev.json",
    "audit": "fixtures/normalize_detuning/v1/audit.inputs.json",
    "challenge": "fixtures/normalize_detuning/v1/challenge.inputs.json"
  },
  "blindLabels": {
    "audit": "blind/normalize_detuning/v1/audit.labels.json",
    "challenge": "blind/normalize_detuning/v1/challenge.labels.json"
  },
  "dataClass": "synthetic",
  "provenance": "synthetic",
  "realDeploymentData": false,
  "preregistration": "preregistration.json"
}
```

`fixtureSets` paths are relative to the registry root. `blindLabels` paths are
resolved against the same root, so the protection boundary is the registry
layout rather than a build-time secret.

## Permissions

The label directories are mode `0700` and the label files are mode `0600`. In
the packaged seed these modes are set by the fixture generator and re-applied by
`routine_seed`, so a fresh registry reproduces them. Check them with:

```bash
# files must read -rw-------, directories drwx------
ls -l seed/blind/normalize_detuning/v1

# scripts/check.sh asserts the same with a Node mode check:
# it seeds a temporary root and verifies no group/world bits survive the copy,
# because some copy paths and git checkouts do not preserve 0600.
```

These permissions stop cooperating agents, child processes and accidental
broad reads by the same OS user from picking labels up. They are a
**contamination barrier, not a security boundary**: the Host process runs as
your user, and `root`/the file owner can always read the files. Real customer
labels should live only in the protected registry root, never in the
repository.

## First-run rule

A blind audit set may gate a **release at most once**. Every evaluation records:

```json
"auditUse": {
  "labelsSha256": "…",
  "inputsSha256": "…",
  "preregHash": "…",
  "firstRunAt": "2026-11-07T00:00:00.000Z",
  "lastRunAt": "2026-11-07T00:00:00.000Z",
  "runs": 1,
  "fresh": true
}
```

- The first evaluation that opens a label set makes it count as evidence
  (`firstRunAt` set, `runs: 1`, `fresh: true`).
- Running an evaluation against the same labels a second time still reports
  metrics, but the report is marked `auditUse.fresh: false`, `runs ≥ 2`, and
  adds the `audit-reused` eligibility blocker. This is deliberate: once you
  have seen (or the routine has effectively been tuned against) a failure, the
  set is no longer blind for that version.
- To obtain fresh evidence, freeze a new label set for a new candidate version
  and keep the old report as history. Do not "re-run until green".

## The scoring command

`scripts/score.mjs` is the release reviewer's interface to reference outcomes.
It reads the stored labels under `blind/` **and** the protected per-case detail
file that `routine_evaluate` wrote (or an explicit `--run` file), joins them,
and prints the aggregate plus per-case `expected`/`decision`/`correct` rows:

```bash
# newest blind run under the default registry root ($DSH_HOME/routine-registry)
node scripts/score.mjs --root "$DSH_HOME/routine-registry"

# a specific routine version and run file
node scripts/score.mjs --root /path/to/registry --routine normalize_detuning \
  --version 1 --run /path/to/registry/blind/runs/normalize_detuning-v1-*.json

# machine-readable output for a review record
node scripts/score.mjs --root /path/to/registry --json
```

If the labels or the run file are unreadable, or the run was produced against
different labels, the command exits non-zero with the reason instead of
degrading to a partial table. It does not import the engine or execute the
routine; it only joins stored decisions with stored expected values. The
command and its output are for the **release reviewer**: an agent under
evaluation must not read the blind label files or the scoring output.

## What is public, what is protected

| Record | Location | Contains |
| --- | --- | --- |
| Public evaluation report | `reports/` | gates, aggregate metrics, per-case `{id, decision, reason, disposition, firstRoute, latencyMs}` for blind sets; `expected`/`correct` only for `dev` cases; `eligibility`, `auditUse`, `budget` and `blindRun {path, sha256, protected}` |
| Protected blind run | `blind/runs/`, mode `0600` | per-case `expected`, `decision`, `correct`, checks and disposition for audit and challenge |
| Public comparison report | `reports/` | arm aggregates, discordant counts, bootstrap, latency, cost projection, repeatability, `pilotDecision` |
| Protected comparison detail | `blind/runs/`, mode `0600` | per-case scoring of arm decisions against labels |
| Raw arm records | `arms/<runId>/`, mode `0644` | decisions and measured values only — never `correct` or `expected` |

Any `expected`/`correct` for an audit or challenge case in a public report is a
bug; report it via [SECURITY.md](../SECURITY.md).

## Leaks and remediation

Treat any of the following as a leak: copying labels into `dev` or into files an
agent can read, pasting score output or a protected run into an agent session or
a public issue, changing a routine after reading blind failures without a new
version, or reusing a label set across versions and calling the second report
fresh. After a leak, freeze a new label set and a new candidate version; the
contaminated set may remain as historical evidence only.

## Related

- [Preregistration](preregistration.md) — the frozen protocol that must exist
  before a label set is opened.
- [Pilot protocol](pilot-protocol.md) — how reference outcomes are scored during
  the real pilot.
- [Framework](framework.md) — the rules in context.


## Agent-tool guard

The Host also installs a tool guard that refuses any agent tool call whose
arguments name the protected tree (`blind/`, the audit/challenge label files).
The guard makes accidental reads by the agent fail loudly; it is a discipline
barrier, not a kernel-level isolation: the agent and the operator share one OS
user, and an obfuscated shell command could still reach the files. The real
read barrier is the 0700/0600 mode enforced by `pilot/meter-session`'s sibling
`store.seedExample` and by the scoring workflow (labels are for the release
reviewer, through `scripts/score.mjs`).
