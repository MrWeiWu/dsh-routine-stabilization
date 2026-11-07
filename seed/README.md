# Routine Stabilization — built-in seed example

This directory is the **synthetic seed** shipped with the `Routine Stabilization` plugin. It
contains the versioned example routine `normalize_detuning/v1` (normalize an explicitly declared
detuning value to Hz), its frozen fixture sets and **blind** labels, the preregistration, an
independent reference checker, and the initial candidate registry.

> **Provenance: synthetic.** Every case and value below was generated for this example. No
> hardware, lab, or production workload is represented; `dataClass` and `provenance` are
> `synthetic`, `evidence.realDeploymentData` is `false`, and the shipped preregistration has no
> independent domain reviewer (`realDataAttested: false`). That combination deliberately makes the
> example **ineligible for release**: it is valid for evaluation, CI and the pilot, but the plugin's
> release-eligibility gate refuses it until real evidence and an independent reviewer exist.
> Fixtures are frozen at `2026-11-04T00:00:00Z`; `approvedRelease` is `null` and the registry entry
> is a `candidate`, not a release.

## Why the evidence is split into inputs and blind labels

The candidate agent is allowed to read the inputs it must solve, but **not** the expected answers.
The v2 layout therefore separates them:

```
fixtures/<id>/<version>/dev.json                 inline labels (dev is for deriving/tuning)
fixtures/<id>/<version>/audit.inputs.json        inputs only, readable by the candidate
fixtures/<id>/<version>/challenge.inputs.json    inputs only, readable by the candidate
blind/<id>/<version>/audit.labels.json           labels only, dir 0700 / file 0600
blind/<id>/<version>/challenge.labels.json       labels only, dir 0700 / file 0600
```

`routine_run` never needs labels. `routine_evaluate` reads them in-process and writes the protected
per-case scoring detail to `blind/runs/<id>-v<version>-<UTC stamp>.json` (mode 0600); the public
report only carries aggregates and decisions. Only the **release reviewer** opens that protected
detail, through the scoring command documented below. Only the first blind run of a label set can
gate a release; reusing the same labels marks the audit as not fresh.

## Layout (identical in `seed/` and after copying `seed/` → registry root)

```
routine-stabilization/seed/
├── README.md                                          this file
├── registry/
│   └── registry.json                                  initial candidate registry (root/fallback null)
├── routines/normalize_detuning/v1/
│   ├── manifest.json                                  versioned routine contract (schemaVersion 1)
│   ├── preregistration.json                           frozen thresholds/workload/reviewers
│   ├── guard.js                                       export function decide(input)
│   ├── binding.js                                     export function bind(input)
│   └── execution.js                                   export function run(bound)
├── fixtures/normalize_detuning/v1/
│   ├── dev.json                                       30 curated cases incl. the page-5 anchors
│   ├── audit.inputs.json                              100 deterministic inputs (labels are blind)
│   └── challenge.inputs.json                          40 constructed near-miss inputs (labels are blind)
├── blind/normalize_detuning/v1/
│   ├── audit.labels.json                              expected answers, 0700 dir / 0600 file
│   └── challenge.labels.json                          expected answers, 0700 dir / 0600 file
└── evals/
    ├── reference_check.mjs                            compatibility entry (forwards to canonical check)
    └── normalize_detuning/v1/
        ├── reference_check.mjs                        independent evaluator (manifest.evidence.evaluator)
        └── generate_fixtures.mjs                      deterministic fixture/label/preregistration generator
```

Measured three-arm pilot records are **not** seeded: generated demo arm files are not evidence.
The real pilot writes raw measured runs to `<registry-root>/arms/<runId>/arm-{a,b,c}-r<repeat>.json`
(see the repository-level `pilot/` directory).

`manifest.evidence.fixtureSets`, `manifest.evidence.blindLabels`, `manifest.evidence.evaluator` and
`manifest.evidence.preregistration` use paths **relative to the registry root**. The evaluator
resolves its own paths from `import.meta.url`, so it also works when the plugin executes it with the
registry root as cwd:

```bash
cd <registry-root>
node evals/normalize_detuning/v1/reference_check.mjs                # exit 0
node /abs/path/to/evals/normalize_detuning/v1/reference_check.mjs   # also exit 0 from any cwd
```

## Attachment mapping

The page numbers come from the attachment shipped with the task brief. The brief explicitly pins
the four anchors to **attachment page 5**; the other rows map to the attachment's framework
sections (use the attachment's own page numbers there).

| Attachment location | Seed file(s) | What it demonstrates |
| --- | --- | --- |
| **p. 5 — four anchor cases** | `fixtures/normalize_detuning/v1/dev.json` (`anchor-*`) | §Anchors below |
| Versioned routine registry | `registry/registry.json`, `routines/normalize_detuning/v1/manifest.json` | candidate/release lifecycle, `evidenceHash`, `approvedRelease`, `fallback`, `withdrawalTrigger` |
| Routine contract: guard / binding / execution | `routines/normalize_detuning/v1/{guard,binding,execution}.js` | admission, lossless binding, read-only execution, postconditions |
| CI evaluation gate: fixtures + evaluator | `fixtures/normalize_detuning/v1/*`, `blind/normalize_detuning/v1/*`, `evals/normalize_detuning/v1/reference_check.mjs` | dev/audit/challenge gates, coverage, silent errors, blind labels, independent recomputation |
| Blind pilot / three-arm comparison | repository `pilot/` + `<registry-root>/arms/<runId>/` | raw measured A/B/C runs, paired comparison |
| Preregistration | `routines/normalize_detuning/v1/preregistration.json` | frozen population, thresholds, workload, reviewers, real-data attestation |
| Reproducibility / provenance record | this `README.md` + `manifest.evidence` | synthetic provenance, frozen timestamps, regeneration seeds, frozen sha256 |

## Runtime semantics

Input shape:

```js
{
  value: number,
  unit: 'Hz' | 'kHz' | 'rad/s',
  fieldId: string,
  declaredUnit: { header?: string, schema?: string },
  candidates?: [{ fieldId, unit, role: 'detuning' | 'drive' | 'unknown' }],
  metadataSource: 'trusted-schema' | 'unverified'
}
```

`guard.js#decide` applies this deterministic order and returns `{decision, reason?, details?}`:

1. `metadataSource !== 'trusted-schema'` → defer `missing-metadata`
2. non-finite / non-number `value` → defer `invalid-value`
3. absent `unit` → defer `missing-metadata`; unit outside `Hz / kHz / rad/s` → defer `unsupported-unit`
4. absent `declaredUnit`, or neither `header` nor `schema` → defer `missing-metadata`
5. `header` and `schema` both present but not equivalent (trim + case-insensitive) → defer
   `metadata-conflict`; **no numeric answer is admissible in this case**
6. `candidates` present: an explicit `fieldId` must match at least one candidate whose role is
   `detuning` and not `drive`; otherwise defer `competing-fields`
7. no candidates: `fieldId` must be explicit, otherwise defer `missing-metadata`

`binding.js#bind` reuses the guard verdict (`throw new Error(code)` on defer), then returns
`{fieldId, unit, value, source, preservedInput}` where `source` is `candidates` or
`declared-unit` and `preservedInput` is a deep copy of the input.

`execution.js#run` is pure and returns `{fieldId, sourceUnit, valueHz}` with factors
`Hz → 1`, `kHz → 1000`, `rad/s → 1/(2π)`; the sign is always preserved. The engine wraps the
result with `unit: 'Hz'` and `contractRevision`, validates it against the manifest's real JSON
Schema (`artifact` required: `fieldId`, `unit`, `sourceUnit`, `valueHz`, `contractRevision`) and
checks the postconditions `finite-output`, `preserve-field-id`, `unit-hz`, `sign-preserved`. On any
check failure it discards the value and falls back to `ask-user`.

## Fixture sets

All sets share `{schemaVersion: 2, frozenAt: "2026-11-04T00:00:00Z"}`. `dev.json` keeps inline
labels; audit/challenge ship inputs and labels separately.

| Set | Cases | Expected accept | Expected defer | File(s) | Purpose |
| --- | --- | --- | --- | --- | --- |
| `dev` | 30 | 16 | 14 | `fixtures/.../dev.json` | Curated contract examples + the page-5 anchors |
| `audit` | 100 | 78 | 22 | `fixtures/.../audit.inputs.json` + `blind/.../audit.labels.json` | Deterministic synthetic representative workload (78% solvable, inside the 70–85% band) |
| `challenge` | 40 | 6 | 34 | `fixtures/.../challenge.inputs.json` + `blind/.../challenge.labels.json` | Near-misses: missing unit, unsupported units/schema, competing fields, conflicting declarations, non-finite values, multi-candidate |

Case shapes:

- dev case: `{id, description, input, expect: {decision, reason|null, checks|null}}`;
- `<set>.inputs.json` case: `{id, description, input}` — **no `expect`**;
- `<set>.labels.json` case: `{id, expect}` — **no `input`**.

Accepted cases carry
`checks: {fieldId, unit: 'Hz', valueHz, absToleranceHz: 1e-9, relTolerance: 1e-12}`; deferred
cases carry `checks: null` and a reason from the manifest vocabulary. Non-finite values are encoded
as the JSON number tokens `1e999` / `-1e999`, which `JSON.parse` reads as `±Infinity`.

`deferred` audit/challenge cases are deferrals because the case input itself is ambiguous or
invalid — none depends on external state. The sets are generated with fixed PRNG seeds
(`0x5eed2026` for audit cases, `0x0a0d17` for the deterministic audit shuffle, `0x0beef` for the
challenge shuffle), so rerunning `generate_fixtures.mjs` produces byte-identical files. The
canonical evaluator records a frozen sha256 for every data file and fails if the seed changes
without a deliberate review.

## Anchors (attachment page 5)

| Anchor | Fixture case id | Expected behavior |
| --- | --- | --- |
| ① `-3.25 kHz` | `anchor-neg-khz` | accept; `fieldId` preserved as `detuning_khz`; `valueHz = -3.25 × 1000 = -3250` |
| ② `+2π×150 rad/s` | `anchor-rad-s` | accept; `valueHz = (2π·150)/(2π) = 150`; sign preserved |
| ③ drive + detuning both kHz | `anchor-dual-khz-explicit` | accept **only** with an explicit detuning `fieldId`; field identity (`detuning_freq`, not `drive_freq`) and `valueHz = 0.8 × 1000 = 800` are asserted separately |
| ③ (no explicit id) | `anchor-dual-khz-no-id` | defer `competing-fields`; `bind` throws `competing-fields`; no numeric answer |
| ④ header `Hz` vs schema `rad/s` | `anchor-metadata-conflict` | defer `metadata-conflict`; no numeric answer; `bind` throws `metadata-conflict` |

The independent evaluator hard-codes these ids and re-derives every accepted value from the raw
input with the analytic formula (it never imports the runtime hooks). It also asserts the tolerance
values (`1e-9` absolute, `1e-12` relative) and sign preservation.

## Preregistration and release eligibility

`routines/normalize_detuning/v1/preregistration.json` freezes, **before** the first blind run:

- population / sampling unit / exclusions;
- thresholds: coverage floor `0.6`, silent-error ceiling `0.05`, challenge size `40`,
  challenge incorrect automatic results `0`, decided `2026-11-30`;
- workload: `100` requests, `30` days, `60000` ms per request;
- reviewers and the real-data attestation.

The shipped example is honest about itself: the only reviewer is the contract author
(`role: 'author'`, `independent: false`, `sawLabels: false`), there is **no** independent
`domain-reviewer`, and `realDataAttested` is `false`. Release eligibility therefore fails with the
`independent-reviewer-missing` and `real-data-not-attested` blockers (plus `synthetic-data`). This is
intentional: the example can be evaluated, scored and piloted, but it cannot be released. Rewriting
the preregistration after a blind run also blocks release, because the report records its hash.

## Independent verification

```bash
cd routine-stabilization

# 1) Regenerate the deterministic dev/input/label/preregistration data.
#    Rerunning must not change any sha256; the script prints every hash and
#    restores 0700 dirs / 0600 label files.
node seed/evals/normalize_detuning/v1/generate_fixtures.mjs

# 2) Canonical independent evaluator (manifest.evidence.evaluator); also works from any cwd.
#    It reads inputs + blind labels, never imports the runtime hooks, and verifies
#    anchors, counts, label/input separation, the preregistration and frozen sha256.
node seed/evals/normalize_detuning/v1/reference_check.mjs

# 3) Compatibility entry point for the original acceptance command.
node seed/evals/reference_check.mjs

# 4) Protect check: no group/other permission bits on blind labels.
find seed/blind -type f -perm /077    # must print nothing

# 5) Syntax-check every JS/MJS file.
for f in $(find seed scripts -name '*.js' -o -name '*.mjs'); do node --check "$f" || exit 1; done
```

The evaluator exits non-zero (`process.exit(1)`) on the first failed assertion and prints a
statistics summary plus `REFERENCE CHECK PASSED` on success.

## Scoring a blind run (release reviewer)

The scoring command lives at the repository root (`scripts/score.mjs`) and reads a registry root;
it does not import `lib/engine.js` and does not re-run the routine. It refuses to run when the
blind labels are unreadable, when the run was produced against different label bytes, or when the
protected detail is internally inconsistent.

```bash
# Default: latest evaluation report's blindRun.path, else newest blind/runs/*.json
node scripts/score.mjs --root "$DSH_HOME/routine-registry"

# Explicit protected run file / machine-readable output
node scripts/score.mjs --root <root> --routine normalize_detuning --version 1 \
  --run <root>/blind/runs/normalize_detuning-v1-20261107T000000Z.json --json
```

Output: per-set aggregates (cases, automatic, deferral, fallback, correct, silent errors,
coverage, end-to-end success) and one row per case with `expected`, recorded `decision`, and
`correct`. The committed blind labels are authoritative; a run that disagrees with them is rejected.

## Registry

`registry/registry.json` starts as a candidate-only registry:

```json
{
  "schemaVersion": 1,
  "root": null,
  "fallback": null,
  "routines": {
    "normalize_detuning": {
      "title": "Normalize detuning to Hz",
      "versions": {
        "1": {
          "status": "candidate",
          "createdAt": "2026-11-04T00:00:00Z",
          "evidenceHash": null,
          "approvedRelease": null
        }
      }
    }
  }
}
```

`root` and `fallback` are deliberately `null`: the plugin fills `root` at install/evaluation time
and `fallback` only after a user-approved release. `evidenceHash` is filled when the evaluation
that backs a release is recorded.
