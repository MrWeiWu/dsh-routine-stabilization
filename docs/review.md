# Review and sign-off

Release requires two reviews that must not be done by the same person: a review
of the **candidate** (code, contract, preregistration) and a review of the
**reference outcomes** (the blind labels and the scored results). Collapsing
them reintroduces exactly the conflict of interest the framework is designed to
remove.

## Who reviews what

| Review | Reviewer | Inputs | Output |
| --- | --- | --- | --- |
| Candidate review | Maintainer / routine author's peer | `manifest.json`, `guard.js`, `binding.js`, `execution.js`, `dev.json`, preregistration, evaluation report, source revision | approval (or changes requested) on the candidate version |
| Reference-outcome review | Independent domain reviewer, enrolled in the preregistration | Protected labels via `scripts/score.mjs`, protected blind run, public report, pilot comparison report | outcome sign-off recorded in the release decision |

The independent reviewer must not be the candidate's author, must not have
written or tuned the hooks, and must be listed in
`preregistration.json.reviewers` with `independent: true` — signed **before**
the first blind run.

## Allowed and forbidden

| Action | Candidate reviewer | Independent domain reviewer |
| --- | --- | --- |
| Read dev cases and expected values | Allowed | Allowed |
| Read candidate hooks and manifest | Allowed | Allowed |
| Inspect audit/challenge **inputs** | Allowed | Allowed |
| Open audit/challenge **labels** directly | Forbidden; use `scripts/score.mjs` | Forbidden; use `scripts/score.mjs` |
| Copy blind labels into dev or agent context | Forbidden | Forbidden |
| Tune the candidate after seeing blind failures | Only as a new version with fresh labels | Not applicable |
| Approve candidate code | Allowed | Not the purpose of the role |
| Sign reference-outcome review | Not alone — needs the independent reviewer | Allowed |
| Edit labels to match the candidate | Forbidden | Forbidden |
| Run the pilot and record measured cost | Allowed | May verify |

A reviewer who has already seen label values (for example because they were
scoring) can still review **outcomes** — that is the job — but they may not then
act as the independent signer for a *new* version's preregistration on the same
label set, and `sawLabels` must say so.

## Signing flow

1. **Author signs the protocol.** `reviewers[]` gets the author entry with
   `role: "author"`, `independent: false`, `sawLabels: false`, and a `signedAt`
   timestamp. This happens before the first blind run.
2. **Independent reviewer signs the protocol.** Same file, entry with
   `role: "domain-reviewer"`, `independent: true`, `sawLabels: false`. This is
   what satisfies the `independent-reviewer-missing` check later. The agent-side
   `routine_preregister` tool cannot add this signature: the user adds it before
   release.
3. **Evaluate.** `routine_evaluate` runs the gates, writes the public report,
   and writes the protected blind run. The report records `auditUse` (fresh,
   first run) and `reproducibility` (source revision, prompt/tool versions,
   environment, model snapshot, case-set hash).
4. **Review outcomes.** A reviewer runs `node scripts/score.mjs --root <root>`
   (or points it at a specific protected run) to inspect per-case
   `expected`/`decision`/`correct`, then reviews the public gates, the pilot
   comparison and the eligibility blockers.
5. **Record the decision.** The release decision record names the report SHA-256,
   evidence hash, preregistration hash, the pilot decision and the reviewers'
   signatures. Release itself stays a **user-only** Settings action; no agent
   tool can release or withdraw.
6. **If anything changed, restart.** A changed hook, fixture, label set,
   preregistration or source revision after the fact invalidates the evidence:
   re-evaluate (new audit set if the previous one is no longer fresh) rather than
   editing the record.

## What the outcome review checks

- Every scored `correct` in the protected detail agrees with an independently
  re-derived value, not with the routine's own output (the reference check in
  `evals/` must still exit 0).
- Deferrals are the ones the contract demands, and each carries a reason from
  the manifest vocabulary; a near-miss that must defer is not auto-accepted.
- Label provenance, counts and frozen timestamps match the manifest and the
  preregistration.
- The report is the latest one and its evidence hashes match the current files;
  the release action re-hashes the manifest, hooks, fixtures, labels and
  preregistration and refuses a stale report, so a stale evidence set is caught
  at release time rather than papered over by a signature.
- The release-eligibility blockers are empty; in particular for the shipped
  example they are **not** empty (`synthetic-data`,
  `independent-reviewer-missing`) and that is the expected outcome.

## Example

The shipped `normalize_detuning/v1` example is reviewed for format and behavior
in this repository, but its preregistration has only the `contract-author`
signature and `realDataAttested: false`. It demonstrates an honest review trail
and a mechanically release-ineligible version at the same time.

## Related

- [Preregistration](preregistration.md) — signatures and independence rules.
- [Blind evidence](blind-evidence.md) — the scoring command and protected
  records.
- [Pilot protocol](pilot-protocol.md) — decision rules that the review checks.
