# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-07

### Added

- Cross-reset blind-audit ledger (`$DSH_HOME/routine-stabilization/audit-ledger.jsonl`,
  override `ROUTINE_AUDIT_LEDGER` for tests): the first use of a label set is
  remembered outside the registry root, so recreating the root cannot turn a
  second use into a fresh first run; the comparison and release gates read it.
- `routine_compare` reports break-even request counts against each baseline and
  attaches the evaluation report hash to `candidateGates`.
- Per-case cost fields in evaluation reports and pilot arms: A records allocate
  the metered per-request cost (`costBasis: "allocated-mean"`), B/C carry the
  zero local-script marginal cost.
- Arm A attempt-level latency: `pilot/meter-session.mjs` folds per-attempt
  durations from the durable log, and the arm record reports p50/p95 over
  attempts with an explicit `latency.basis: "per-attempt"`.

### Changed

- The refined protected-tree tool guard screens only filesystem/execution tools
  and their arguments, so ordinary chat/plan text that mentions the protected
  word is no longer rejected.

## [0.3.0] - 2026-11-07

### Added

- Arm A token metering: `pilot/meter-session.mjs` folds the durable session
  usage (provider-reported fields of the DSH token-meter `tokenUsage`
  projection) into a per-session usage record; `pilot/run.mjs --arm-a-usage`
  attaches it to the raw arm-A records with the model snapshot, prompt hash and
  session id.
- Declared cost model `pilot/cost-model.json`: model prices, labor rate and a
  component breakdown (construction, labeling, tests, routing, verification,
  fallback, human review); `routine_compare` reports the complete projected
  total, setup/maintenance/per-request costs and cost per correct resolution.
- Measured metered pilot evidence under `pilot/evidence/pilot-metered-1/` with
  `pilot/RESULTS.md`: complete economic comparison, pilot decision
  `do-not-advance` at the declared horizon (C correct but not cheaper than both
  baselines), release still blocked.

### Changed

- The pilot decision is now computed from a complete cost picture when every arm
  has numeric per-request, setup and maintenance costs; the `inconclusive`
  state remains for genuinely incomplete cost data.
- Arm records may carry an arm-level `latency` method (session wall clock when
  per-case timing is not isolated); the comparison reports it instead of
  implying per-case percentiles.

### Notes

- Model prices and B/C labor hours are declared assumptions, not billing or
  time-tracking measurements; replace them with the provider contract before
  trusting projected costs.

## [0.2.0] - 2026-11-07

Review follow-up release: blind evidence, preregistration, release eligibility
and a real pilot replace the v0.1 demonstration records.

### Added

- **Blind evidence split.** Audit and challenge fixtures are now inputs-only
  (`fixtures/<id>/<version>/{audit,challenge}.inputs.json`); expected values live
  in `blind/<id>/<version>/{audit,challenge}.labels.json` with directories mode
  `0700` and files mode `0600`. The manifest declares
  `evidence.blindLabels`; the runtime never reads labels.
- **Scoring command.** `node scripts/score.mjs --root <root> [--routine <id>]
  [--version <v>] [--run <blind-run.json>] [--json]` is the only supported
  interface to reference outcomes; it prints aggregate and per-case
  `expected`/`decision`/`correct` rows and exits non-zero when the protected
  files are unreadable.
- **First-run audit rule.** Reports record
  `auditUse {firstRunAt, runs, fresh, labelsSha256, preregHash}`; a label set may
  gate a release only on its first use, and a second evaluation marks the audit
  not fresh and blocks release.
- **Protected blind runs.** Evaluation and comparison write per-case scoring
  detail to `blind/runs/…` (mode `0600`); public reports omit `expect`/`correct`
  for audit and challenge cases.
- **Preregistration.** `routines/<id>/<version>/preregistration.json` freezes
  population, sampling unit, exclusions, gate thresholds, workload and budget,
  decision date, next review trigger, `realDataAttested` and reviewer
  signatures. The plugin hashes it and refuses a missing or changed protocol.
- **Release eligibility.** Reports carry
  `eligibility {releaseEligible, blockers}` covering gates, audit freshness,
  preregistration hash, synthetic data, missing independent reviewer,
  output-schema contract failure and stale reports; the Settings panel shows
  the blockers. Synthetic evidence is mechanically unable to release.
- **Real pilot.** Measured A/B/C arm records at
  `arms/<runId>/arm-<a|b|c>-r<repeat>.json` for repeats 1..3 carry decisions and
  measured latency only. `pilot/run.mjs` runs the scripted B and C arms and
  ingests agent arm A; `routine_compare` scores records in-process against the
  protected labels and writes aggregates-only comparison reports plus protected
  per-case detail. New `pilot/arm-b.mjs` hand-written baseline,
  `pilot/selftest.mjs` plumbing test and `pilot/README.md`.
- **Pilot decision record.** `pilotDecision {decision, advance, gatesOk,
  beatsBaselines, costComplete, cheaper, reasons}` with `advance-to-shadow`,
  `do-not-advance` and `inconclusive`; advance requires a fresh passing report,
  e2e success not below each baseline and a complete measured cost projection
  cheaper than both baselines. Non-measured (generated/legacy) arm records are
  excluded from scoring, and a comparison with no measured records is refused.
- **Repeatability and cost basis.** Arms declare
  `cost.basis: metered|local-script|unmetered`; per-arm repeatability counts case
  ids whose decision/route disagrees across repeats; per-case cost and latency
  are retained.
- **Budget accounting.** Reports add
  `budget {perRequestMs, overBudgetCases, withinBudgetRate}` derived from the
  preregistered workload, and `metrics.<set>` adds `needlessDeferrals` and
  `fallbackResolved`.
- **Production-error suspension.** A production request on an active version
  whose binding/guard/execution raises an unexpected error, or whose
  postcondition/output-schema check fails, takes the fallback and suspends the
  active version with a recorded reason and a suspend decision record; it stays
  suspended until a passing re-evaluation and a new user release.
- **Docs.** New `docs/blind-evidence.md`, `docs/pilot-protocol.md`,
  `docs/preregistration.md` and `docs/review.md`; expanded
  `docs/framework.md`; README, CONTRIBUTING, SECURITY and `.gitignore` updated.

### Changed

- Evaluation report blind cases expose only
  `{id, decision, reason, disposition, firstRoute, latencyMs}`; dev cases keep
  `expected`/`correct`.
- The seed example moved to the v2 blind layout and ships a synthetic,
  author-signed preregistration with `realDataAttested: false`, so it is
  release-ineligible by construction (expected, documented behavior).
- `seed/arms/arm-{a,b,c}.json` were removed: generated demonstration records are
  no longer evidence; measured records are produced by the real pilot runner.
- The independent reference checker reads fixture inputs plus protected labels
  and re-derives expected values without importing the runtime hooks.
- Dependency-free self-checks for scoring, pilot plumbing and blind-file
  permissions run in `scripts/check.sh`.

### Fixed

- `reproducibility.caseSetHash` is now a real SHA-256 over the frozen evidence
  hashes instead of `null`.
- Complete output-schema validation (including required fields and
  `additionalProperties`) is enforced as a gate and as a release blocker.
- Reproducibility records gained `sourceRevision {available, commit, dirty,
  packageVersion}`, prompt and tool version objects, environment objects and a
  model snapshot.
- Stale report filenames were cleaned up and dangling profile links removed from
  evaluation and comparison reports.

## [0.1.0] - 2026-11-07

Initial public release.

### Added

- Versioned routine registry with immutable released versions, an active
  version and a fallback pointer.
- Runtime path: binding (field and provenance resolution) → admission guard →
  execution → postconditions → fallback, with reason-carrying deferrals and
  payload-minimized route logging.
- CI evaluation with contract, dev, coverage, silent-error (exact one-sided
  95 % upper bound), blind challenge, end-to-end success and independent
  reference-check gates; reports record per-case outcomes, evidence hashes and
  a reproducibility block.
- Paired A/B/C arm comparison with discordant counts, deterministic
  case-level bootstrap, zero-discordance bound, latency percentiles and a
  projected-cost model.
- User-only release/withdrawal with fresh-evidence enforcement, schema-drift
  suspension and decision records.
- Agent tools: `routine_status`, `routine_seed`, `routine_evaluate`,
  `routine_run`, `routine_propose`, `routine_report`, `routine_compare`.
- Settings panel (`settings.section`, order 40) with registry, report, routing
  log, Evaluate/Release/Withdraw/Seed actions and English/Chinese UI.
- `routine-stabilization` agent preset and skill.
- Built-in read-only example `normalize_detuning/v1` with 170 labeled cases,
  an independent reference calculation and three paired arm records.
- Repository consistency check (`scripts/check.sh`).
- One measured three-arm pilot run shipped as evidence
  (`pilot/evidence/pilot-real-1/`, summary in `pilot/RESULTS.md`): outcome parity
  with zero paired discordance, cost incomplete because arm A is unmetered, pilot
  decision `inconclusive`, release ineligible on synthetic evidence.

### Known limitations

- The example audit set is synthetic; the pilot remains in shadow.
- Browser-side visual checks of the Settings page are manual.

[0.2.0]: https://github.com/MrWeiWu/dsh-routine-stabilization/releases/tag/v0.2.0
[0.1.0]: https://github.com/MrWeiWu/dsh-routine-stabilization/releases/tag/v0.1.0
