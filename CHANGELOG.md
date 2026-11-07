# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Known limitations

- The example audit set is synthetic; the pilot remains in shadow.
- Browser-side visual checks of the Settings page are manual.

[0.1.0]: https://github.com/MrWeiWu/dsh-routine-stabilization/releases/tag/v0.1.0
