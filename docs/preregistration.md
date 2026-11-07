# Preregistration

A preregistration freezes **what counts as success** before anyone sees the
blind results. Without it, thresholds and workload can be chosen after the fact
to fit the outcome, and the audit set stops being evidence.

## Where it lives

```
routines/<id>/<version>/preregistration.json
```

The manifest points at it with `evidence.preregistration` (a path relative to
the routine version directory). The plugin hashes the file, records that hash in
every evaluation (`auditUse.preregHash`) and in the report's evidence block, and
refuses to consider a version release-eligible when the hash at release time
differs from the hash at evaluation time.

## When to freeze

1. Finish deriving and tuning the routine on **dev** data.
2. Write the preregistration: population, sampling unit, exclusions, thresholds,
   workload, decision date and review triggers.
3. Freeze it — file content and `frozenAt` are now immutable for this version.
4. Only then may the first evaluation open the audit/challenge labels. That
   first run is the only run whose audit evidence can gate a release (see
   [blind evidence](blind-evidence.md#first-run-rule)).

A change after freeze is not an edit: it is a **new version** with a new
preregistration and new label sets. Version-controlled history keeps the old
file as the record of what was actually tested.

## Fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Preregistration schema, currently `1`. |
| `routine`, `version` | The exact version this protocol was frozen for. |
| `frozenAt` | RFC 3339 timestamp of the freeze; must precede the first blind run. |
| `population` | The deployment population the estimate applies to. |
| `samplingUnit` | What one request is (the denominator unit). |
| `exclusions` | Cases removed before scoring and why; declared in advance. |
| `thresholds.coverageFloor` | Minimum automatic-result coverage (default `0.6`). |
| `thresholds.silentErrorCeiling` | Maximum silent-error rate (default `0.05`, checked with a one-sided 95 % upper bound). |
| `thresholds.challengeSize` | Required near-miss count (default `40`). |
| `thresholds.challengeIncorrectAutomatic` | Allowed wrong automatic results on the challenge set (default `0`). |
| `workload.requests` | Requests the cost projection is stated over. |
| `workload.horizonDays` | Cost horizon in days. |
| `workload.perRequestBudgetMs` | Latency budget per request; drives `budget.withinBudgetRate`. |
| `decisionDate` | Date the advance/release decision is planned. |
| `nextReviewTrigger` | What forces a re-review (model, schema or dependency change; any production fallback; a day count). |
| `realDataAttested` | Whether the evidence is from attested real deployment data. `false` makes the version release-ineligible. |
| `reviewers[]` | Signatures: `name`, `role`, `signedAt`, `independent`, `sawLabels`. |

The evaluator checks the preregistered thresholds; the report records a
`budget` block (`perRequestMs`, `overBudgetCases`, `withinBudgetRate`) derived
from `workload`, and the decision record carries the cost horizon and the next
review trigger.

## Reviewer independence

Two roles sign, and they must not collapse into one person:

| Role | Who | Independence |
| --- | --- | --- |
| `author` | The person who authored the routine version and its preregistration. | `independent: false` |
| `domain-reviewer` | An independent domain reviewer who signs the protocol **before** labels are opened and later reviews reference outcomes. | `independent: true`, not the author, did not contribute the candidate hooks, did not tune against the blind sets. |

`sawLabels` records whether the reviewer had seen label values at signing time.
For an independent reviewer it must be `false` at preregistration time; the
independent review of outcomes happens after the first run through the scoring
command, and the release decision record names the signed protocol hash.

A version without an independent `domain-reviewer` signature is not
release-eligible (`independent-reviewer-missing`), even if the pilot decision is
`advance-to-shadow`. An agent may record **author** signatures only; the
agent-side preregistration write refuses to create a `domain-reviewer`
signature, so that signature is added by the user before release.

## Data class and real-data attestation

The manifest's `evidence.dataClass` (`synthetic`, `contract-derived`,
`trace-derived` or `deployment`) is the v0.2 provenance/data-class field; the
report records it as `dataClass` and also records
`evidence.realDeploymentData`. A release needs real attested evidence, which
means **both** `evidence.realDeploymentData: true` and
`preregistration.realDataAttested: true`; either one being false produces a
`synthetic-data` / `real-data-not-attested` blocker.

## The shipped example is intentionally ineligible

`seed/routines/normalize_detuning/v1/preregistration.json` is a valid
preregistration with thresholds matching the framework, one author signature
only, and `realDataAttested: false`. It contains no independent domain
reviewer, because the synthetic example has no real deployment data and no
external reviewer to attest to. That is deliberate:

- the example still evaluates, scores, and can run the pilot;
- the example can never be released — `eligibility.releaseEligible` is `false`
  and the blockers are `synthetic-data` and `independent-reviewer-missing`;
- replacing the example with a real routine means writing a new
  preregistration, attesting real data, and getting an independent signature.

This is the framework working as intended, not a missing example. See
[release eligibility](framework.md#7-preregistration-and-release-eligibility)
for the full blocker list.

## Amending a protocol

Do not edit a frozen file to change a threshold, exclusion or workload. Instead:

1. open an issue describing the change and the reason (a gate change is a
   framework change, not a routine tweak);
2. propose the next version with a new `frozenAt`, and if the change is
   outcome-relevant, freeze new blind label sets;
3. cite the old protocol hash in the pull request so reviewers can see exactly
   what changed.

## Related

- [Blind evidence](blind-evidence.md) — the label sets this protocol governs.
- [Pilot protocol](pilot-protocol.md) — how workload and cost basis feed the
  decision.
- [Review](review.md) — the signing and outcome-review procedure.
