# Measured pilot evidence — `pilot-metered-1`

This directory ships the raw records of one **measured** three-arm pilot run,
with arm A metered through DSH session usage. A reader can inspect the evidence
instead of trusting a summary. It is not a production deployment claim.

- Date: 2026-11-07
- Routine: `normalize_detuning/v1` (synthetic audit inputs; protected labels in
  `seed/blind/normalize_detuning/v1/`)
- Inputs: the 100 audit requests; labels were never read by any arm
- Repeats: 1 (primary) plus 2–3 (diagnostic)
- Arm A: fresh LLM agent, `deepseek-account/deepseek-flash`
  (DeepSeek-V4.1-Flash), reasoning effort `high`, prompt
  `pilot-agent-arm-v1` (`pilot/arm-a-prompt.md`, hash pinned in the record),
  7 model attempts per run; token usage folded from the durable session log by
  `pilot/meter-session.mjs` (the same provider-reported `usage` fields the DSH
  token-meter `tokenUsage` projection exposes)
- Arm B: `pilot/arm-b.mjs` (hand-written independent implementation)
- Arm C: the candidate routine through `lib/engine.js#invokeRoutine`
- Costs: declared `pilot/cost-model.json` — labor rate $60/h; model prices
  $0.30/M input, $0.03/M cached input, $1.20/M output (`assumed-pilot-rate`;
  replace with the provider contract). B/C setup and maintenance hours are
  declared estimates, broken down into construction/labeling/tests/routing/
  verification components.

Raw records: `pilot/evidence/pilot-metered-1/arm-{a,b,c}-r{1,2,3}.json` plus
`usage-a-r{1,2,3}.json`. They contain decisions, bound fields, converted values,
token counts and declared cost components only — no `correct`, no `expected`.

## Metered arm A (repeat 1)

```text
model:      deepseek-account/deepseek-flash (DeepSeek-V4.1-Flash)
attempts:   7
tokens:     input 31,942 | output 17,733 | cache read 244,224 | cache write 0
wall clock: 120,566 ms for the whole batch
tokens $:   0.0382 (input 0.0096 + cached 0.0073 + output 0.0213)
review $:   50.00 (100 requests × 0.5 min × $60/h)
setup $:    15.00 (0.25 h)
total:      $65.04   |  per request $0.5004
```

Repeats 2 and 3: 210,616 and 201,591 total tokens (~32.4 s and ~43.0 s wall
clock). The three runs' decisions are identical.

## Result at the declared workload (100 requests / 30 days)

| Arm | e2e success | cost basis | setup | maintenance | per request | projected total | $/correct |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A fresh agent | 100/100 | metered tokens + declared review | $15.00 | $0.00 | $0.5004 | **$65.04** | $0.650 |
| B hand-written | 100/100 | local script + declared labor | $45.00 | $6.00 | $0.00 | **$51.00** | $0.510 |
| C routine | 100/100 | local script + declared labor | $255.00 | $30.00 | $0.00 | **$285.00** | $2.850 |

- Paired discordance: C vs A **0/100**, C vs B **0/100** (zero-discordance bound
  2.95 % for n = 100).
- Repeatability: all three arms agree with themselves on 100/100 cases across
  repeats (1.0 agreement).
- Candidate gates: passed; audit fresh (first blind run); release ineligible
  (synthetic data, no independent reviewer).
- Cost comparison: **complete** (`costComplete: true`).
- Pilot decision: **`do-not-advance`**. Reasons: e2e success ties both
  baselines, but C is not projected cheaper than both at 100 requests/30 days
  ($285.00 vs $51.00 and $65.04). The rule refuses to advance. This is the
  framework functioning as intended at this declared horizon, not a failure of
  the pipeline; C only wins on per-request cost after its larger one-time
  setup is amortized over a much larger volume.

## Honest reading

- The audit inputs are synthetic and the model solved the contract fully; this
  run demonstrates the economic comparison, not a production claim.
- Arm A's wall clock is the whole-session time (the agent batched the cases);
  per-case latency percentiles are therefore **unavailable** (`latency.basis:
  "session-wall-clock"`). B and C have real per-case `hrtime` percentiles.
- The token counts are provider-reported and durable; the USD conversion depends
  on the declared model prices, which are assumptions. Replace them before
  trusting the totals. Labor hours for B/C are declared estimates with an
  explicit component breakdown, not time-tracked measurements.
- Zero discordance on 100 paired cases bounds the discordance rate at 2.95 %
  (one-sided 95 %), not zero; collect more shadow data before drawing a
  deployment-rate conclusion.
- Release remains blocked: the evidence is synthetic, no real deployment data is
  attested, and no independent domain reviewer has signed.

## Reproduce

```bash
# 1. seed a registry root (synthetic example incl. protected labels)
node -e "import('./lib/store.js').then((s) => s.seedExample(process.env.DSH_HOME + '/routine-registry'))"

# 2. evaluate once (consumes the first blind run)
#    via the agent tool: routine_evaluate routine=normalize_detuning version=1

# 3. meter the archived arm-A sessions (repeat 1..3) and run the pilot
node pilot/meter-session.mjs --session <session-id-r1> --out pilot/evidence/pilot-metered-1/usage-a-r1.json
node pilot/run.mjs --root "$DSH_HOME/routine-registry" --run-id pilot-metered-1 \
  --routine normalize_detuning --version 1 --repeats 3 \
  --arm-a <arm-a-records-dir> \
  --arm-a-usage pilot/evidence/pilot-metered-1 \
  --cost-model pilot/cost-model.json

# 4. compare (public aggregates; per-case scoring stays protected)
#    via the agent tool: routine_compare runId=pilot-metered-1 routine=normalize_detuning version=1
```

The shipped arm records were produced by exactly this pipeline; the local run
also wrote (not committed) the public comparison report and the protected
per-case scoring detail under `blind/runs/`.
