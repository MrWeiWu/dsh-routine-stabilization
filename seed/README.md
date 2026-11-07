# Routine Stabilization — built-in seed example

This directory is the **synthetic seed** shipped with the `Routine Stabilization` plugin. It
contains the versioned example routine `normalize_detuning/v1` (normalize an explicitly declared
detuning value to Hz), its frozen fixture sets, an independent reference checker, the initial
candidate registry, and three paired pilot arms.

> **Provenance: synthetic.** Every case, value, cost and latency figure below was generated for
> this example. No hardware, lab, or production workload is represented, and the arm numbers are
> a deterministic demonstration of the comparison format — not a benchmark result. Fixture sets
> are frozen at `2026-11-04T00:00:00Z`; `approvedRelease` is `null` and the registry entry is a
> `candidate`, not a release.

## Layout (identical in `seed/` and after copying `seed/` → registry root)

```
routine-stabilization/seed/
├── README.md                                       this file
├── registry/
│   └── registry.json                               initial candidate registry (root/fallback null)
├── routines/normalize_detuning/v1/
│   ├── manifest.json                               versioned routine contract (schemaVersion 1)
│   ├── guard.js                                    export function decide(input)
│   ├── binding.js                                  export function bind(input)
│   └── execution.js                                export function run(bound)
├── fixtures/normalize_detuning/v1/
│   ├── dev.json                                    30 curated cases incl. the page-5 anchors
│   ├── audit.json                                  100 deterministic synthetic representative cases
│   └── challenge.json                              40 constructed near-miss cases
├── evals/
│   ├── reference_check.mjs                         compatibility entry (forwards to canonical check)
│   └── normalize_detuning/v1/
│       ├── reference_check.mjs                     independent evaluator (manifest.evidence.evaluator)
│       └── generate_fixtures.mjs                   deterministic fixture/arm generator
└── arms/
    ├── arm-a.json                                  arm A (slow + expensive baseline)
    ├── arm-b.json                                  arm B (medium heuristic pipeline)
    └── arm-c.json                                  arm C (routine-stabilization target)
```

`manifest.evidence.fixtureSets` and `manifest.evidence.evaluator` use paths **relative to the
registry root** (`fixtures/normalize_detuning/v1/*.json`,
`evals/normalize_detuning/v1/reference_check.mjs`). The evaluator resolves its own paths from
`import.meta.url` (e.g. `new URL('../../../fixtures/normalize_detuning/v1/dev.json',
import.meta.url)`), so it also works when the plugin executes it with the registry root as cwd:

```bash
cd <registry-root>
node evals/normalize_detuning/v1/reference_check.mjs    # exit 0
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
| CI evaluation gate: fixtures + evaluator | `fixtures/normalize_detuning/v1/*.json`, `evals/normalize_detuning/v1/reference_check.mjs` | dev/audit/challenge gates, coverage, silent errors, independent recomputation |
| Blind pilot / three-arm comparison | `arms/arm-{a,b,c}.json` | 100 paired audit cases, cost/latency/coverage comparison |
| Reproducibility / provenance record | this `README.md` + `manifest.evidence` | synthetic provenance, frozen timestamps, regeneration seeds |

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
`Hz → 1`, `kHz → 1000`, `rad/s → 1/(2π)`; the sign is always preserved. Postconditions checked by
the engine: `finite-output`, `preserve-field-id`, `unit-hz`, `sign-preserved`. On any check
failure the engine discards the value and falls back to `ask-user`.

## Fixture sets

All sets share `{schemaVersion: 1, provenance: "synthetic", frozenAt: "2026-11-04T00:00:00Z"}`.
Every case is `{id, description, input, expect: {decision, reason|null, checks|null}}`; accepted
cases carry `checks: {fieldId, unit: 'Hz', valueHz, absToleranceHz: 1e-9, relTolerance: 1e-12}`,
deferred cases carry `checks: null` and a reason from the manifest vocabulary.
Non-finite values are encoded as the JSON number tokens `1e999` / `-1e999`, which `JSON.parse`
reads as `±Infinity`.

| Set | Cases | Expected accept | Expected defer | Purpose |
| --- | --- | --- | --- | --- |
| `dev` | 30 | 16 | 14 | Curated contract examples + the page-5 anchors |
| `audit` | 100 | 78 | 22 | Deterministic synthetic representative workload (78% solvable, inside the 70–85% band) |
| `challenge` | 40 | 6 | 34 | Near-misses: missing unit, unsupported units/schema, competing fields, conflicting declarations, non-finite values, multi-candidate; defer is the majority and every defer has a reason |

`deferred` audit/challenge cases are deferrals because the case input itself is ambiguous or
invalid — none depends on external state. The audit set is generated with fixed PRNG seeds
(`0x5eed2026` for cases, `0x0a0d17` for the deterministic shuffle; challenge shuffle `0x0beef`),
so rerunning `generate_fixtures.mjs` produces byte-identical files.

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

## Three-arm pilot data

Each arm is `{schemaVersion: 1, runId: "example", arm, label, workload: {requests: 100,
horizonDays: 30}, setupCostUsd, maintenanceCostUsd, cases: [{caseId, resolved, correct, costUsd,
latencyMs}]}` with the 100 `caseId`s paired one-to-one, in order, to `audit.json`.

| Arm | Coverage (resolved) | Silent errors | Decision-level e2e | Resolved + correct | Horizon cost | Avg latency |
| --- | --- | --- | --- | --- | --- | --- |
| A — unversioned manual review | 72% | 4 | 86% | 68% | $2497.41 | 2018 ms |
| B — medium heuristic pipeline | 77% | 3 | 93% | 74% | $1007.99 | 1037 ms |
| C — normalize_detuning/v1 | 78% | 0 | 100% | 78% | $450.63 | 457 ms |

Arm C is the target: coverage ≥ 60%, zero silent errors (one-sided 95% upper bound < 5% at 0/78),
a handful of deliberate defers (the 22 expected-defer audit cases), e2e not below A/B, and the
lowest horizon cost and latency. Arm A is intentionally slow and expensive; arm B sits in
between.

## Independent verification

```bash
cd routine-stabilization

# 1) Canonical independent evaluator (manifest.evidence.evaluator); also works from any cwd.
node seed/evals/normalize_detuning/v1/reference_check.mjs

# 2) Compatibility entry point for the original acceptance command.
node seed/evals/reference_check.mjs

# 3) Syntax-check every JS/MJS file.
for f in $(find seed -name '*.js' -o -name '*.mjs'); do node --check "$f" || exit 1; done

# 4) Regenerate the deterministic fixtures/arms (byte-identical on rerun).
node seed/evals/normalize_detuning/v1/generate_fixtures.mjs
```

The evaluator re-implements admission and conversion independently, validates the manifest,
resolves and reads every evidence path, checks dev/audit/challenge counts, recomputes all accepted
`valueHz` values, verifies the page-5 anchors, and checks the arm gates (C coverage ≥ 60%,
C silent errors 0, C e2e ≥ A/B, C cheapest and lowest latency). It exits non-zero (`process.exit(1)`)
on the first failed assertion and prints a statistics summary plus `REFERENCE CHECK PASSED` on
success.

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
