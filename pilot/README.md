# Pilot: real three-arm comparison

This directory contains the **real measured pilot** harness for
`normalize_detuning/v1`. It exists to answer one question with measured data
instead of demo numbers:

> Is the candidate routine (arm C) at least as good as the two baselines (arms A
> and B) on the frozen audit inputs, at a lower projected cost?

The pilot writes **raw arm records only** (decisions, values, latency). It never
reads protected blind labels and never scores anything itself; scoring happens
later in `routine_compare`, in-process, from the protected labels.

## Three arms

| Arm | What it is | Participant | Cost basis |
| --- | --- | --- | --- |
| **A** | LLM agent following the same contract with the same model/prompt version, executed by an external agent runner. Records are ingested with `--arm-a`. | `llm-agent` (provider/model/promptVersion recorded) | `unmetered` unless a meter is attached |
| **B** | Independent hand-written implementation of the contract: [`pilot/arm-b.mjs`](./arm-b.mjs). No import of `seed/routines/**` and no import of `lib/engine.js` dispatch. | `script` (local) | `local-script`, `perRequestUsd: 0` |
| **C** | The candidate routine executed through the real engine: `lib/engine.js#invokeRoutine(root, id, version, input, {log:false})`. | `script` (local) | `local-script`, `perRequestUsd: 0` |

B and C are **scripted arms**. A is the **LLM agent arm**. B's independence is
deliberate: agreement between B and C measures the contract, not shared code.

## Fair conditions

All three arms must satisfy the same conditions for a run to be comparable:

- **Same inputs.** The audit set is `fixtures/normalize_detuning/v1/audit.inputs.json`
  from the registry root: 100 synthetic cases, frozen before the run. The runner
  reads inputs only; it never reads `blind/**` labels or the legacy
  label-bearing `audit.json` (if that file is missing, the run fails instead of
  falling back).
- **Same contract revision.** Every record carries
  `conditions.contractRevision` from the routine manifest.
- **Same fallback model.** `conditions.fallbackModel: "ask-user"`; a fallback
  never invents a numeric answer.
- **Same per-request budget.** `conditions.perRequestBudgetMs` (default 60000 or
  the value from `preregistration.json`).
- **Same workload horizon.** `workload.requests × workload.horizonDays`
  (default: audit case count requests over 30 days, overridable by the
  preregistration file).
- **Same repeats.** `--repeats 3` for every arm — repeats 1..3 are separate runs
  over the same frozen inputs.

## Repeats and primary comparison

- **Repeat 1 is primary** for every comparison metric.
- **Repeats 2..3 are diagnostic.** `routine_compare` reports per-arm
  repeatability: the number of `caseId`s whose decision/route disagrees across
  repeats.
- Scripted arms (B/C) are deterministic; the pilot self-test asserts that B and C
  produce identical decision/value fields across repeats 1..3.
- The LLM agent arm (A) may legitimately differ across repeats; that divergence
  is part of what the repeatability diagnostic measures.

## Blind discipline

The pilot is run under the same blind rules as the candidate:

1. Read `fixtures/<id>/<version>/audit.inputs.json` **only**. This file contains
   inputs, never labels.
2. Never read `blind/<id>/<version>/*.labels.json`.
3. Never read the pre-split label-bearing audit fixture.
4. Never write `correct`, `expected` or `expect` into an arm record. The runner
   strips/refuses such fields, and the self-test fails if any generated record
   contains them.
5. `routines/<id>/<version>/preregistration.json` must already be frozen before
   this run; the pilot does not freeze or edit it.

The arm-record decision fields (`decision`, `reason`, `fieldId`, `sourceUnit`,
`valueHz`) are **raw decisions**. They must not be interpreted as correct or
incorrect: correctness is computed by `routine_compare` from the protected
labels, in-process, and written to a protected detail file (mode 0600).

## How to run

```bash
# Scripted arms only (B and C), 3 repeats each.
node pilot/run.mjs \
  --root "$DSH_HOME/routine-registry" \
  --run-id "pilot-real-1" \
  --routine normalize_detuning \
  --version 1 \
  --repeats 3

# With the measured LLM agent arm; --arm-a points at a directory holding
# arm-a-r1.json..arm-a-r3.json (or arm-a-run-1.json..; both names are accepted).
node pilot/run.mjs \
  --root "$DSH_HOME/routine-registry" \
  --run-id "pilot-real-1" \
  --routine normalize_detuning \
  --version 1 \
  --repeats 3 \
  --arm-a "/path/to/arm-a-records"
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `$DSH_HOME/routine-registry` | Registry root seeded in the v2 layout |
| `--run-id <id>` | `pilot-<UTC yyyymmdd>` | Output directory name under `<root>/arms/` |
| `--routine <id>` | `normalize_detuning` | Routine to execute for arm C |
| `--version <label>` | `1` | Routine version to execute for arm C |
| `--repeats <n>` | `3` | Repeats per scripted arm (1..10) |
| `--arm-a <dir>` | — | Optional measured arm-A records to validate and ingest |
| `--help` | — | Usage |

Output (under the registry root, **not** committed to git):

```
<root>/arms/<runId>/arm-a-r1.json   # only with --arm-a
<root>/arms/<runId>/arm-a-r2.json
<root>/arms/<runId>/arm-a-r3.json
<root>/arms/<runId>/arm-b-r1.json
<root>/arms/<runId>/arm-b-r2.json
<root>/arms/<runId>/arm-b-r3.json
<root>/arms/<runId>/arm-c-r1.json
<root>/arms/<runId>/arm-c-r2.json
<root>/arms/<runId>/arm-c-r3.json
```

`--arm-a` records are validated (schema v2, `kind: "arm-run"`, `arm: "A"`,
`provenance: "measured"`, repeat matching the filename, full audit case
coverage, no label fields) and written to `arm-a-r<repeat>.json`. The raw
per-case shape coming from the LLM agent runner is accepted as-is:
`{caseId, decision, reason, fieldId, sourceUnit, valueHz}`. When `latencyMs` or
`costUsd` is absent it is supplemented as `null` (never as a fabricated value);
`participant`, `conditions` and `repeat` are preserved exactly as recorded, and
the model/provider/prompt-version information is never rewritten. `correct` /
`expected` / `expect` are rejected. The records are not re-scored and the pilot
does not look at labels to check them.

The runner prints, per arm: route/outcome distribution, case count, and p50/p95
latency for repeat 1, plus the exact `routine_compare` command to run next.

## How to compare

```bash
# Through the harness tool (preferred):
routine_compare {"runId":"pilot-real-1","routine":"normalize_detuning","version":"1"}
```

`routine_compare`:

- loads the protected labels and the latest evaluation report for gates and
  eligibility;
- scores the arm records in-process and writes a **public aggregate report**
  plus a **protected per-case detail** file (mode 0600) under
  `blind/runs/<id>-v<version>-<UTC stamp>.json`;
- uses repeat 1 as the primary comparison and repeats 2..3 for repeatability;
- projects cost per arm as `setup + maintenance + requests × perRequest`; the
  projection is `null` when the arm's cost basis is `unmetered`;
- returns `pilotDecision`:
  `advance-to-shadow` | `do-not-advance` | `inconclusive`.

`advance-to-shadow` requires: report gates passed, end-to-end success ≥ each
baseline, and a complete measured cost projection lower than both baselines.
Synthetic-input pilots may still reach `advance-to-shadow` (it is a shadow
decision), but release remains blocked by `eligibility`. Non-measured arm
records are excluded from a scored comparison; a comparison with no measured
arm records fails with an error instead of producing a decision.

## Cost basis meaning

| `cost.basis` | Meaning | Projection |
| --- | --- | --- |
| `local-script` | Arm B/C: a local deterministic script; no metered spend, latency measured with `process.hrtime.bigint()`. | `perRequestUsd: 0`, setup/maintenance `0`, total projected `0` |
| `unmetered` | Arm A: an LLM agent run without an attached meter. Setup/maintenance tokens/authoring cost are recorded only if known; the projection is `null`. | `null` (not comparable on cost until metered) |
| `metered` | A run with an attached meter; `perRequestUsd`/`setupUsd`/`maintenanceUsd` are real measured amounts. | numeric |

The pilot itself never invents cost numbers: scripted arms are declared
`local-script` with zero per-request spend, and arm A keeps whatever basis its
recording run declared.

## Arm record schema (spec v2 §5)

Each `arms/<runId>/arm-<a|b|c>-r<repeat>.json`:

```json
{
  "schemaVersion": 2,
  "kind": "arm-run",
  "runId": "pilot-real-1",
  "arm": "B",
  "repeat": 1,
  "provenance": "measured",
  "participant": { "kind": "script", "provider": "local", "model": "pilot/arm-b.mjs", "promptVersion": null },
  "conditions": { "contractRevision": "normalize_detuning/v1", "fallbackModel": "ask-user", "perRequestBudgetMs": 60000 },
  "cost": { "basis": "local-script", "perRequestUsd": 0, "setupUsd": 0, "maintenanceUsd": 0, "authoringHours": null },
  "workload": { "cases": 100, "requests": 100, "horizonDays": 30 },
  "cases": [
    {
      "caseId": "audit-001",
      "decision": "accept",
      "reason": null,
      "fieldId": "probe_detuning",
      "sourceUnit": "rad/s",
      "valueHz": -248.85788553988746,
      "latencyMs": 0.0123,
      "costUsd": 0,
      "firstRoute": "accept",
      "finalOutcome": "resolved"
    }
  ]
}
```

Outcome mapping: `accept → resolved`, `defer → deferred`,
`fallback/exception → fallback-unresolved`. `firstRoute` is the first decision
the arm produced; `finalOutcome` is what the run reports after fallback
handling. There is deliberately no `correct`/`expected` field.

## How to verify the pilot itself

```bash
node --check pilot/*.mjs          # syntax
node pilot/selftest.mjs           # end-to-end harness self-check, exit 0/1
```

`pilot/selftest.mjs` builds a temporary registry root from `seed/**`, executes
`pilot/run.mjs` for real (B/C × 3 repeats, then an arm-A ingest run), and
asserts:

- arm-record schema v2 and full case coverage;
- determinism of B and C across repeats;
- arm-B contract parity with the engine (arm C) on the same inputs;
- no `correct`/`expected`/`expect` field in any generated record;
- the runner refuses to run when `audit.inputs.json` is unavailable (it never
  falls back to label-bearing fixtures);
- `--arm-a` validates measured records, preserves their participant/conditions/
  repeat metadata, and writes them as `arm-a-r<repeat>.json`.

The self-test does not read blind labels and does not perform any scoring.


## Metering arm A (token usage and wall clock)

Arm A is a real LLM agent run, so its cost is measured rather than declared:

1. run the agent (per `pilot/arm-a-prompt.md`) and keep the child session id;
2. fold its durable session log with the DSH token-meter's provider-reported
   usage fields (`tokenUsage`: input/output/cache read/cache write):
   ```bash
   node pilot/meter-session.mjs --session <session-id> --out pilot/evidence/<run>/usage-a-r1.json
   ```
3. pass the usage directory to the runner:
   ```bash
   node pilot/run.mjs --root "$DSH_HOME/routine-registry" --run-id <run> \
     --arm-a <arm-a-records-dir> --arm-a-usage pilot/evidence/<run> \
     --cost-model pilot/cost-model.json
   ```

The runner attaches to each arm-A record: the model snapshot
(provider/model plus the DeepSeek-V4.1-Flash label), the prompt file hash, the
session id, the token counts, the measured batch wall clock, and the USD token
cost from the declared model prices. `latency.basis` is
`session-wall-clock` for arm A: the agent batches the cases, so per-case
percentiles are not isolated. B/C keep per-case `hrtime` measurements.

`pilot/cost-model.json` declares the model prices, the labor rate, and per-arm
setup/maintenance hours plus a component breakdown (construction, labeling,
tests, routing, verification, fallback, human review). These are **declared
assumptions**; replace them with the provider contract and staff rates before
trusting projected totals. `routine_compare` computes
`setup + maintenance + requests × per-request`, the cost per correct
resolution, and marks the cost picture complete only when every arm has numeric
per-request, setup and maintenance costs.
