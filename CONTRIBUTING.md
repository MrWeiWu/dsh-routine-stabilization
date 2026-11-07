# Contributing

Thanks for helping improve `dsh-routine-stabilization`.

## Ground rules

1. **`bash scripts/check.sh` must exit 0.** It is the repository's definition of
   done: syntax checks, JSON parses, blind-evidence permissions, preset
   validation, engine self-check, independent reference calculation, pilot
   self-test and the scoring command's refusal behavior. A change that leaves it
   red is not ready.
2. **Do not weaken checks to go green.** Do not delete tests, skip assertions,
   loosen gate thresholds, relax label permissions or edit a checker to accept a
   failure. Fix the code or, if the rule itself is wrong, explain why in the
   pull request first.
3. **Fixtures are evidence.** Every fixed failure gets a regression case in the
   appropriate set (dev for behavior, challenge for near-misses).
4. **No new runtime dependencies** without a discussion in an issue first. The
   plugin deliberately uses Node built-ins only.

## Blind evidence discipline

Audit and challenge labels are evidence only while the routine's author cannot
see them. That imposes hard rules on contributions:

- **Never copy `blind/**/*.labels.json` expectations into `dev.json`**, the
  manifest, an agent prompt, a comment, a test, or a pull request. Tuning on
  blind labels contaminates the set; the set then cannot gate a release.
- **Do not read blind labels while developing.** Reference outcomes are exposed
  only through `node scripts/score.mjs --root <registry-root>` (or the protected
  run file it reads). Even that output is sensitive: do not paste it into an
  agent session or a public issue.
- **Editing fixture inputs requires regenerating labels.** The committed
  example's fixtures and labels are produced deterministically by
  `node seed/evals/normalize_detuning/v1/generate_fixtures.mjs`; run it after an
  edit, keep the anchor cases and the 30/100/40 counts, and commit inputs and
  labels together (they are one frozen evidence set).
- **Keep modes intact.** Label directories must stay `0700` and label files
  `0600` (`ls -l seed/blind/normalize_detuning/v1` shows `drwx------` /
  `-rw-------`), and `bash scripts/check.sh` asserts the modes of a freshly
  seeded root. The committed synthetic labels are example data, not secret
  customer data — but real labels must never be committed.
- **A label set may gate one release, once.** Do not re-run an evaluation against
  the same labels and present the second report as fresh evidence; the report
  marks it `auditUse.fresh: false` and eligibility blocks it. New candidate →
  new labels.

## Changing gates or the preregistration

Gate thresholds, the release-eligibility blockers and the preregistration are
framework-level decisions, not routine tweaks:

- Open an issue describing the change and the reason before a pull request.
- A frozen `preregistration.json` is **not editable in place**. A change means a
  new routine version with a new `frozenAt`, and, if the change is
  outcome-relevant, new blind label sets.
- Changing the gate definitions or eligibility rules is a framework change: get
  agreement first and explain in the pull request how old reports stay
  interpretable.
- Reviewer independence requirements (author vs independent `domain-reviewer`)
  cannot be relaxed to make an example releasable. An agent may record author
  signatures only; the user adds the independent reviewer signature before
  release.
- `evidence.dataClass` and `evidence.realDeploymentData`, together with
  `preregistration.realDataAttested`, are attestations: do not set them to real
  deployment values without real deployment evidence.

## Pilot runs

- The pilot is **measured evidence**, not a demo. Do not fabricate, hand-edit or
  generate `arms/<runId>/**` records; records without
  `provenance: "measured"` are excluded from scoring, and a run with no measured
  records is refused — generated evidence never advances.
- Record the participant honestly: provider, model and prompt version for arm A;
  scripted arms run through `pilot/run.mjs` with measured
  `process.hrtime.bigint()` latency and `cost.basis: "local-script"`.
- Record cost honestly. An arm without a numeric `perRequestUsd` leaves the
  projection `null` and makes the cost picture incomplete; incomplete cost
  cannot advance. Do not invent a per-request price.
- Run all three repeats (1..3) and report them all; repeat 1 is primary, 2–3 are
  diagnostic. Do not drop a repeat because it behaved differently.
- Never score an arm by hand against `blind/` labels: feed raw records to
  `routine_compare`, which scores in-process and writes the public report plus
  the protected detail.

## Development loop

```bash
git clone https://github.com/MrWeiWu/dsh-routine-stabilization.git
cd dsh-routine-stabilization
bash scripts/check.sh
```

To exercise the plugin inside a Harness profile:

1. install the bundle with `plugin_manager install_bundle` (or reinstall after a
   Host-half change so a fresh module generation is loaded);
2. call `routine_seed` once, then `routine_evaluate routine=normalize_detuning
   version=1` and confirm every gate passes (the synthetic example is expected
   to be release-ineligible — check the blockers, not a release);
3. check `routine_status` for `preset: { status: "registered" }` and the Settings
   panel registration;
4. for a real pilot, run `node pilot/run.mjs --root "$DSH_HOME/routine-registry"
   --run-id <id> --repeats 3` and then `routine_compare`.

## Pull requests

- One concern per pull request; keep the diff small.
- Describe behavior changes, the evidence you ran (commands and exit codes), and
  any gate, fixture, label or preregistration change.
- If you touch the manifest schema, fixture format, blind layout or report
  format, update the relevant `docs/` page (and the README if the user-facing
  contract changed) and say in the pull request how you kept old reports
  readable.
- AGPL-3.0-or-later: contribute only code you have the right to license under it,
  and keep the SPDX headers.

## Reporting bugs

Use the issue templates. Include:

- what you ran (tool call, panel action, or command) and the exact output;
- the routine id/version and the relevant `reports/`, `blind/runs/` (avoid
  pasting label contents) or `logs/` entry;
- the report's SHA-256, evidence hash and, if relevant, the eligibility
  blockers;
- DSH version, OS, and the plugin version from `package.json`.
