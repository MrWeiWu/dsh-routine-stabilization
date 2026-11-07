# Real pilot protocol

The pilot answers one question: does the candidate routine (`C`) beat the two
baselines on the same real workload, at the same cost horizon, without
sacrificing correctness? A generated demonstration record does not answer it;
the protocol therefore requires **measured runs**.

## Arms

| Arm | Who | What is recorded |
| --- | --- | --- |
| **A** | A fresh LLM agent using ordinary tools | `participant.kind: "llm-agent"`, provider, model and prompt version. Run records are ingested from the operator's run directory with `--arm-a`. |
| **B** | A hand-written independent implementation | `pilot/arm-b.mjs`; a separate implementation of the contract that does not import the candidate hooks. |
| **C** | The candidate routine | Executed through the engine's runtime path (`invokeRoutine`) with the manifest's guard, binding, execution and fallbacks. |

B and C are **scripted** arms: `cost.basis: "local-script"`, `perRequestUsd: 0`,
and latency measured with `process.hrtime.bigint()`. A is the **agent** arm and
defaults to `cost.basis: "unmetered"` unless the operator attaches a cost meter;
its provider, model and prompt version are recorded so the comparison is
attributable.

## Run layout

Arm records live under the registry root, one directory per run:

```
arms/<runId>/arm-a-r1.json  arm-a-r2.json  arm-a-r3.json
               arm-b-r1.json  arm-b-r2.json  arm-b-r3.json
               arm-c-r1.json  arm-c-r2.json  arm-c-r3.json
```

`<repeat>` is `1..3`. Repeat 1 is the **primary** comparison; repeats 2 and 3
are diagnostic and drive the repeatability statistic.

## What a raw arm record contains

```json
{
  "schemaVersion": 2,
  "kind": "arm-run",
  "runId": "pilot-real-1",
  "arm": "A",
  "repeat": 1,
  "provenance": "measured",
  "participant": {"kind": "llm-agent", "provider": "deepseek-account", "model": "deepseek-flash", "promptVersion": "pilot-agent-arm-v1"},
  "conditions": {"contractRevision": "normalize_detuning/v1", "fallbackModel": "ask-user", "perRequestBudgetMs": 60000},
  "cost": {"basis": "unmetered", "perRequestUsd": null, "setupUsd": null, "maintenanceUsd": null, "authoringHours": null},
  "workload": {"cases": 100, "requests": 100, "horizonDays": 30},
  "cases": [
    {"caseId": "audit-001", "decision": "accept", "reason": null, "fieldId": "probe_detuning", "sourceUnit": "rad/s", "valueHz": -248.86, "latencyMs": null, "costUsd": null}
  ]
}
```

Rules:

- The record carries **decisions, bound field, converted value, measured latency
  and per-case cost only**. It contains no `correct` and no `expected` —
  correctness is not knowable to the arm. `routine_compare` computes it
  in-process from the protected labels.
- `provenance` must be `"measured"` for a record to be evidence. Anything else
  is a demonstration and is excluded from scoring; a comparison run with no
  measured records is refused with `no measured arm runs found`, and no
  generated record can advance.
- Every case records its first route (`firstRoute`, equal to `decision`) and its
  final outcome (`finalOutcome`): `resolved` (accepted and within budget),
  `deferred` (deferred with a reason), or `fallback-unresolved` (the fallback
  asked the user).

## Fair conditions

Arms are only comparable if all of the following hold:

- **Same inputs** — all arms run the same `audit.inputs.json` case ids.
- **Same contract revision** — `conditions.contractRevision` identifies the
  interface both baselines implement.
- **Same budget** — `conditions.perRequestBudgetMs` matches the preregistered
  `workload.perRequestBudgetMs`.
- **Same fallback** — `conditions.fallbackModel` matches the candidate's
  declared fallback (`ask-user` for the example).
- **Same workload and horizon** — `workload` carries the same case/request
  count and `horizonDays` for every arm.
- **No post-hoc selection** — all three repeats are recorded; the primary
  repeat is fixed in advance (repeat 1).
- **Measured, not simulated** — latency and cost are observed on the run;
  values are not filled in from a cost table after the fact.

## Cost accounting

Each arm declares a `cost` block with a `basis`:

| Basis | Meaning | Projection |
| --- | --- | --- |
| `metered` | A meter or invoice observed the per-request / setup / maintenance spend; `perRequestUsd` is a real measured amount | Total is complete |
| `local-script` | Scripted local run (arms B and C); marginal cost is genuinely 0 | Total is complete (setup/maintenance only) |
| `unmetered` | No cost meter attached (default for arm A) | Projection is `null` and **incomplete** |

The projected total is `setupUsd + maintenanceUsd + requests × perRequestUsd`.
A `null`/missing `perRequestUsd` makes the arm's projection `null` and the
overall `pilotDecision.costComplete` `false`, whatever the declared basis — so
even a `metered` arm needs a numeric per-request amount to count. An incomplete
cost picture can at best be `inconclusive` and never advances. Do not fabricate
a number to "fill in" an unmetered arm.

## How to run

The runner needs a seeded registry root and the protected labels in place:

```bash
# 1) scripted arms B and C, repeats 1..3 (arm A is optional)
node pilot/run.mjs --root "$DSH_HOME/routine-registry" --run-id pilot-real-1 \
  --routine normalize_detuning --version 1 --repeats 3 \
  --arm-a /path/to/arm-a-records

# 2) score the run in-process against the protected labels
routine_compare {runId: "pilot-real-1", routine: "normalize_detuning", version: "1"}
# or the tool wrapper from an agent session
```

`pilot/run.mjs` reads only `fixtures/<id>/<version>/audit.inputs.json` to drive
the arms; it never opens `blind/`. If `--arm-a` is given, the runner validates
and copies the agent records into `arms/<runId>/` without rescoring or reading
labels; if arm A is absent it says so and continues with B and C. Repeats
default to 3 (the protocol value); the CLI accepts `1..10`, and every repeat you
record is treated as evidence (1 primary, the rest diagnostic), so do not run
extra repeats selectively.

`pilot/selftest.mjs` is a plumbing test of the runner in a temporary root — it
is not pilot evidence.

## The decision

`routine_compare` writes a public comparison report (aggregates only) and a
protected per-case detail file (mode `0600`, under `blind/runs/`), and returns:

```json
"pilotDecision": {
  "decision": "advance-to-shadow",
  "advance": true,
  "gatesOk": true,
  "beatsBaselines": true,
  "costComplete": true,
  "cheaper": true,
  "reasons": [],
  "rule": "…"
}
```

| `decision` | Meaning |
| --- | --- |
| `advance-to-shadow` | A fresh passing report, C's e2e success ≥ each baseline's, and a complete measured cost projection lower than both baselines. Continue in shadow; this is **not** a release. |
| `do-not-advance` | A required condition failed (gates, baseline success, or a complete but not-cheaper cost projection). |
| `inconclusive` | The comparison cannot decide — typically cost is incomplete because at least one arm has no numeric per-request cost. Collect more data; incomplete evidence never advances. |

Additional reported facts:

- success and correct rates with denominators, discordant pair counts against
  each baseline, a deterministic case-level bootstrap interval and a
  zero-discordance bound;
- p50/p95 latency per arm;
- per-arm **repeatability** — the number of case ids whose decision or route
  disagrees across repeats 1..3;
- per-case cost alongside `cost.basis` and the projected total.

A synthetic-input pilot can still reach `advance-to-shadow` — that is a shadow
decision about the comparison, not about production. The [release
eligibility](framework.md) check stays blocked while `realDeploymentData` is
`false`, regardless of the pilot decision.

## Related

- [Blind evidence](blind-evidence.md) — where labels live and how scoring is
  exposed.
- [Preregistration](preregistration.md) — the workload, budget and thresholds
  the pilot must follow.
- [Review](review.md) — who signs off on candidate code and reference outcomes.
- `pilot/README.md` in the repository — runner-level protocol details.


## Metering and cost model (v0.3)

Arm A is metered from its durable session log with
`pilot/meter-session.mjs`: the fold reads the provider-reported
`usage` fields (`inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`) that the DSH token-meter projects as `tokenUsage`, together
with the session start/end times for a batch wall clock. The runner attaches
those numbers and the prompt-file hash to the raw arm record; the agent's
decisions stay unchanged and label-free.

USD costs come from the declared `pilot/cost-model.json`: model prices (input,
cached input, output), a labor rate, and per-arm setup/maintenance hours with a
component breakdown. Every value is a declared assumption with its basis in the
record; a complete comparison requires numeric per-request, setup and
maintenance costs for all three arms. Per-case latency is reported for the
scripted arms; arm A reports a session wall clock and marks per-case percentiles
unavailable because the agent batches the cases.

The pilot decision uses the complete projected total: `advance-to-shadow`
requires a fresh passing report, end-to-end success at least equal to both
baselines, and a lower projected total than both. Partial or assumed-only cost
data yields `inconclusive`.


## Per-request latency sample

Batch arm-A sessions only support attempt-level percentiles. To report
per-request p50/p95, run one fresh agent per sampled request (the shipped
protocol uses 20 sampled cases × 3 repeats), record the wall clock per call,
and meter the child sessions with `pilot/meter-percase.mjs`. The runner attaches
the sample with `--arm-a-latency`; the arm record states the sample size and
basis, and the full-run cost still comes from the batch metering.

## Fresh evidence cycles

When a candidate's label set has been consumed (or a repair is informed by
blind failures), create a new candidate and a new label set; do not reuse the
old labels. `pilot/fresh-audit.mjs` generates a deterministic fresh set from a
different seed, `pilot/propose-v2.mjs` records observed-request derivation
traces, and the cross-reset ledger proves the first use of the new labels.
