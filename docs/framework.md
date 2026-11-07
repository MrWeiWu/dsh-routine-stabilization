# The routine-stabilization framework

This document records how the plugin implements the framework it targets, in
this repository's own words. The README is the entry point; this file is the
reference for anyone changing the schema or the gates. Four companion pages go
deeper:

- [Blind evidence](blind-evidence.md) — label storage, permissions, first-run
  rule and the scoring command;
- [Preregistration](preregistration.md) — the frozen protocol and reviewer
  independence;
- [Pilot protocol](pilot-protocol.md) — measured arms, cost basis and the pilot
  decision;
- [Review](review.md) — candidate review versus reference-outcome review.

## 1. What persists, and what can be tested

A routine is one versioned operation with three separately reviewable pieces:

| Piece | File | Testable property |
| --- | --- | --- |
| Procedure | `execution.js` | returns the expected result for supported inputs |
| Applicability rule | `guard.js` | accepts exactly the inputs whose assumptions hold, and defers with a reason otherwise |
| Field/provenance binding | `binding.js` | resolves the right field and unit from trusted metadata, and refuses ambiguity |

The manifest is the contract that links them, the fixtures are the evidence that
they behave, and `evals/` is an independent calculation that does not import the
runtime hooks. v0.2 adds two records that are not code: the **preregistration**
(frozen success criteria) and the **protected blind labels** (reference outcomes
that the routine never sees).

## 2. Registry records

| Record | Minimum content |
| --- | --- |
| Identity and scope | routine id and version, owner, contract revision, allowed effects, dependencies, last approved release |
| Inputs and binding | typed arguments, required metadata, units, field identity, source of each bound value; the original input is preserved |
| Admission at runtime | predicate returning `accept` or `defer` with a reason; the manifest names the cases the routine cannot distinguish |
| Execution and checks | entrypoint, output schema, independently checkable postconditions, error policy, fallback |
| Evidence and status | derivation traces, evaluator, fixture **input** versions, blind **label** versions, coverage, failure counts, approval record, withdrawal trigger |
| Preregistration | population, sampling unit, exclusions, thresholds, workload, budget, decision date, next review trigger, attested data class, reviewer signatures |
| Blind evidence use | first/last run timestamps, run count, freshness, input and label hashes, preregistration hash, protected blind-run path and hash |

The registry document (`registry/registry.json`) holds the version state
(`candidate`, `active`, `superseded`, `withdrawn`, `suspended`), the active
version and the fallback pointer. Released versions are immutable: a change
proposes a new version. The manifest's `evidence` block carries `fixtureSets`
(dev plus audit/challenge **inputs**), `blindLabels`, `dataClass`, `provenance`,
`realDeploymentData`, `derivationTraces`, `evaluator`, `preregistration`,
`approvedRelease` and `withdrawalTrigger`.

## 3. Promotion gates

A candidate is promoted only when the latest evaluation passes every gate:

- **Contract** — manifest valid, hooks load, postconditions known, evidence
  paths resolvable and hashable, approved contract revision not drifted.
- **Preregistration** — the frozen protocol exists, parses, matches the manifest
  id/version and declares valid thresholds, workload, budget and reviewers.
- **Blind isolation** — the audit and challenge fixture sets resolve to
  inputs-only files (`labelMode: "protected"`), with their labels declared
  separately under `blind/`; inline-label blind sets fail this gate.
- **Dev** — every development case reaches the expected decision and output.
  Deliberate deferrals are expected behavior, not failures.
- **Coverage** — automatic results / representative requests ≥ the
  preregistered floor (default 60 %); deferrals are reported by reason, and
  `metrics.<set>` also reports `needlessDeferrals` (deferrals the contract did
  not require) and `fallbackResolved` (resolved by fallback; 0 for an
  `ask-user` fallback).
- **Silent error** — zero observed wrong automatic results, and the exact
  one-sided 95 % upper bound for zero events in `n` automatic results,
  `1 − 0.05^(1/n)`, is below the preregistered ceiling (5 %; n = 59 gives
  4.95 %) — the exact upper bound, not a normal approximation.
- **Challenge** — zero incorrect automatic results on the preregistered number
  of constructed near-misses (40 by default); a case that requires deferral
  fails if accepted.
- **Reference check** — the independent evaluator exits 0, run as a subprocess
  with its exit code recorded in the report.
- **End-to-end success** — correct resolution, or a correct metadata request,
  within the preregistered per-request budget; reported with its denominator
  and used by the paired comparison. It is reported alongside the gates but is
  not part of the binary `passed` conjunction.
- **Output schema** — every automatic result is validated at runtime against
  the manifest's `execution.outputSchema` (required fields and
  `additionalProperties`); a schema mismatch discards the provisional result
  and invokes the fallback, so a broken schema surfaces as a failed gate rather
  than as a wrong automatic answer.

A failed check on a runtime request discards the provisional result and invokes
the declared fallback. A failed gate blocks promotion. A release requires a
passing report whose evidence hashes still match the current manifest, hooks,
fixtures, labels and preregistration; otherwise it is refused as stale
evidence. Passing every gate is necessary but not sufficient: see
[§7 preregistration and release eligibility](#7-preregistration-and-release-eligibility).

## 4. Blind data discipline

The three uses of data stay separate, and the storage enforces the separation:

1. **dev** — derive and tune the routine, then freeze it; expected values stay
   inline in `fixtures/<id>/<version>/dev.json`;
2. **audit** — representative, previously unseen requests for the blind
   estimate; inputs live in `fixtures/<id>/<version>/audit.inputs.json`;
3. **challenge** — constructed near-misses whose intended routes are frozen
   before scoring; inputs live in
   `fixtures/<id>/<version>/challenge.inputs.json`.

Reference outcomes for audit and challenge live outside the fixture files, in
`blind/<id>/<version>/<set>.labels.json`, inside directories mode `0700` with
files mode `0600`. The runtime never reads them; `routine_evaluate` reads them
in-process only while scoring, and writes the per-case result to a protected
run file (`blind/runs/<id>-v<version>-<UTC stamp>.json`, mode `0600`). The
public report must not contain `expect`/`correct` for audit or challenge cases —
it exposes only `{id, decision, reason, disposition, firstRoute, latencyMs}`.
The scoring command ([Blind evidence](blind-evidence.md)) is the supported way
to see reference outcomes.

Related paraphrases and source files stay in the same partition; whole
acquisition batches are held back where possible. If real deployment data are
unavailable, the data are labeled synthetic and the pilot stays in shadow. The
synthetic example in `seed/` does exactly that.

**First-run rule.** A label set may gate a release only on its first use. Every
evaluation records `auditUse {labelsSha256, inputsSha256, preregHash,
firstRunAt, lastRunAt, runs, fresh}`. The first evaluation that opens a set
makes it count as evidence; a later evaluation against the same labels still
reports metrics but sets `fresh: false`, `runs ≥ 2`, and adds the
`audit-reused` blockade (a second use is not fresh evidence). Fresh evidence
therefore means new labels and, normally, a new candidate version — never
"re-run until green".

## 5. Paired comparison and the pilot decision

Three arms run on the same audit inputs: **A** a fresh LLM agent using ordinary
tools, **B** a hand-written independent implementation (`pilot/arm-b.mjs`),
**C** the candidate routine through the engine. Each arm produces a **raw
measured run record** at `arms/<runId>/arm-<a|b|c>-r<repeat>.json` for repeats
`1..3`:

- the record carries decisions, bound field, converted value, measured latency
  and per-case cost — **no** `correct` and **no** `expected`;
- `provenance` must be `"measured"`; the hand-written and routine arms are
  scripted (`cost.basis: "local-script"`, zero marginal cost, latencies
  measured with `process.hrtime.bigint()`), arm A is an agent run with recorded
  provider, model and prompt version (`cost.basis: "unmetered"` unless a meter
  is attached);
- every case records its first route (`decision`) and final outcome
  (`resolved`, `deferred`, `fallback-unresolved`).

Raw records that are not `provenance: "measured"` (for example legacy flat
`arms/*.json` demonstration files) are **not** evidence: the comparison refuses
to score a run with no measured records, and a generated record can never
advance. Correctness is computed by `routine_compare`, which loads the
protected labels and the latest report, scores the records in-process, and
writes a **public comparison report (aggregates only)** plus a **protected
per-case detail file (mode 0600, under `blind/runs/`)**. Repeat 1 is the
primary comparison; repeats 2 and 3 are diagnostic and yield a per-arm
repeatability count (case ids whose decision/route disagrees across repeats).

The projected cost per arm is `setup + maintenance + requests × perRequest`; it
is `null` when the arm has no numeric `perRequestUsd` (an unmetered arm), and
the cost picture is then incomplete. `pilotDecision` is
`{decision, advance, gatesOk, beatsBaselines, costComplete, cheaper, reasons,
rule}` with `decision` one of `advance-to-shadow`, `do-not-advance` or
`inconclusive`.

**Advance rule.** `advance-to-shadow` requires a fresh passing evaluation
report, an end-to-end success at least equal to each baseline, and a *complete
measured* cost projection lower than both baselines. A synthetic-input pilot
may still reach `advance-to-shadow` — it is a shadow decision — but the release
remains blocked by eligibility. The full protocol is
[Pilot protocol](pilot-protocol.md).

## 6. Reproducibility

Every report carries the engine and Node versions, platform and architecture,
model snapshot, prompt and tool version objects, environment, and a source
revision block (`sourceRevision {available, commit, dirty, packageVersion}`)
resolved from the checkout when available. `reproducibility.caseSetHash` is a
real SHA-256 over the frozen fixture-input and blind-label hashes (v0.1
recorded `null`), so two reports can be compared for case-set identity.
Per-case outcomes, per-case cost and latency, and a `budget` block
(`perRequestMs`, `overBudgetCases`, `withinBudgetRate`) are retained alongside
the aggregates, and a release decision record carries the cost horizon and the
next review trigger.

Re-run the affected checks after model, schema or dependency changes; label new
failures for the next development cycle and retain past regression cases. If a
dependency or model change moves outcomes, the version is re-evaluated before it
serves again; a change that invalidates the frozen protocol starts a new
version.

## 7. Preregistration and release eligibility

`routines/<id>/<version>/preregistration.json` is written and frozen after dev
tuning and **before the first blind run**. It fixes the population, sampling
unit, exclusions, thresholds (coverage floor, silent-error ceiling, challenge
size and incorrect-automatic allowance), workload (requests, cost horizon,
per-request budget), decision date, next review trigger, whether real data is
attested, and the reviewer signatures. The evaluator hashes it and records the
hash in the report (`auditUse.preregHash` and the evidence block). A changed or
missing protocol blocks release; an agent may add author signatures only — an
independent `domain-reviewer` signature must be added by the user, and
independently signed protocols are required before release. See
[Preregistration](preregistration.md).

Release is gated by a separate, schema-level eligibility check on top of the
gates. The report carries:

```json
"eligibility": {"releaseEligible": false, "blockers": [{"code": "synthetic-data", "message": "…"}], "dataClass": "synthetic", "synthetic": true}
```

Release is allowed only when `releaseEligible` is `true`. The blockers are:

| Code | Condition |
| --- | --- |
| `gates-failed` | One or more promotion gates did not pass |
| `audit-reused` | The same audit label set was already used for a gated run (`auditUse.fresh: false`) |
| `preregistration-invalid` | No frozen protocol, or it fails validation |
| `preregistration-changed` | The protocol changed after the first blind run |
| `synthetic-data` | Evidence is synthetic (`dataClass: "synthetic"` or `realDeploymentData: false`) |
| `real-data-not-attested` | `realDeploymentData` / `realDataAttested` not both true |
| `independent-reviewer-missing` | No independent `domain-reviewer` signature with `sawLabels: false` |

On top of the report-level blockers, the release action re-hashes the manifest,
hooks, fixture sets, blind labels and preregistration and refuses a **stale
report** if any changed. The data class is `evidence.dataClass` (`synthetic`,
`contract-derived`, `trace-derived` or `deployment`; v0.2 expresses provenance
this way), and a release additionally requires both
`evidence.realDeploymentData: true` and
`preregistration.realDataAttested: true`. Release and withdrawal themselves stay
**user-only** Settings actions with a two-step confirmation; no agent tool can
call them. [Review](review.md) covers the two mandatory reviews and the signing
flow.

The shipped example is honestly labeled synthetic and its preregistration has
the contract author only, so **the example is release-ineligible by
construction** (blockers `synthetic-data` and
`independent-reviewer-missing`). That is expected behavior and part of what the
example demonstrates; it does not stop evaluation, scoring or the pilot.

## 8. Suspension and withdrawal

Two different things stop a released routine:

- **Automatic suspension.** A production request on an **active** version whose
  binding/guard/execution step raises an unexpected error, or whose
  postcondition/output-schema check fails, takes the declared fallback and
  suspends the version: the registry state becomes `suspended` with a recorded
  reason, a suspend decision record is written, and serving continues only
  through the fallback (for the example, `ask-user`). Re-evaluation that detects
  schema drift also suspends an active version. A suspended version never
  re-enters service without a passing re-evaluation and a new user release.
- **User withdrawal.** The user withdraws a released version from the Settings
  panel with a reason. Release and withdrawal are user-only; agents can propose
  the next version but cannot change the serving state.

Both outcomes are recorded in the registry document and are visible in
`routine_status` and the Settings panel. The declared `withdrawalTrigger` names
the conditions that force withdrawal (for the example: any postcondition
failure, any wrong auto-accepted challenge case, any silent audit error).
