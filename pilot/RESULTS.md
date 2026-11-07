# Measured pilot evidence — `pilot-real-1`

This directory ships the raw records of one **measured** three-arm pilot run, so a
reader can inspect the evidence instead of trusting a summary. It is not a
production deployment claim.

- Date: 2026-11-07
- Routine: `normalize_detuning/v1` (synthetic audit inputs; labels in
  `seed/blind/normalize_detuning/v1/`)
- Inputs: the 100 audit requests, labels never read by any arm
- Repeats: 1 (primary) plus 2–3 (diagnostic)
- Arm A: a fresh LLM agent (`deepseek-account/deepseek-flash`, prompt version
  `pilot-agent-arm-v1`, ordinary tools, no `routine_*` tools, no registry access)
- Arm B: `pilot/arm-b.mjs` (hand-written independent implementation)
- Arm C: the candidate routine through `lib/engine.js#invokeRoutine`
- Cost: A `unmetered` (no token meter attached to the agent run; the record
  carries `cost.basis:"unmetered"`), B/C `local-script` (zero marginal cost,
  measured `hrtime` latency)

Raw records: `pilot/evidence/pilot-real-1/arm-{a,b,c}-r{1,2,3}.json`.
They contain decisions, bound fields and converted values only — no `correct`,
no `expected`.

## Result

| Arm | e2e success | correct | coverage | silent errors | latency p50 | cost basis |
| --- | --- | --- | --- | --- | --- | --- |
| A fresh agent | 100/100 | 100 | 78/100 | 0 | not metered | unmetered |
| B hand-written | 100/100 | 100 | 78/100 | 0 | 0.003 ms | local-script |
| C routine | 100/100 | 100 | 78/100 | 0 | 1.99 ms | local-script |

- Paired discordance: C vs A **0/100**, C vs B **0/100** (zero-discordance bound
  2.95% for n = 100).
- Repeatability: all three arms agree with themselves on 100/100 cases across
  repeats (1.0 agreement).
- Candidate gates: passed; audit fresh (first blind run); release ineligible
  (synthetic data, no independent reviewer).
- Pilot decision: **`inconclusive`** — the outcome comparison is complete and
  shows no difference, but the cost comparison is incomplete because arm A's
  cost is unmetered. `advance: false`; reasons recorded in the comparison report.

## Honest reading

- The audit set is synthetic and the model solved the contract fully; this run
  shows the measurement pipeline works and produces no false advance, not that
  a routine beats a fresh agent in production.
- Zero discordance on 100 paired cases bounds the discordance rate at 2.95%
  (one-sided 95%), not zero; collect more shadow data before drawing a
  deployment-rate conclusion.
- Arm A's wall-clock cost and token cost were not metered. A metered arm-A run
  (provider usage or a token meter) is required before the pilot can advance,
  which is exactly why the decision is `inconclusive` rather than
  `advance-to-shadow`.
- Arm A latency is not recorded (`null`): the agent run was asynchronous and no
  per-request wall time was captured.

## Reproduce

```bash
# 1. seed a registry root (synthetic example incl. protected labels)
node -e "import('./lib/store.js').then((s) => s.seedExample(process.env.DSH_HOME + '/routine-registry'))"

# 2. evaluate once (consumes the first blind run)
#    via the agent tool: routine_evaluate routine=normalize_detuning version=1

# 3. run the scripted arms and ingest the shipped arm-A records
node pilot/run.mjs --root "$DSH_HOME/routine-registry" --run-id pilot-real-1 \
  --routine normalize_detuning --version 1 --repeats 3 \
  --arm-a pilot/evidence/pilot-real-1

# 4. score and compare
#    via the agent tool: routine_compare runId=pilot-real-1 routine=normalize_detuning version=1
#    protected per-case scoring detail: <root>/blind/runs/compare-pilot-real-1-*.json
```

## Artifact hashes

Run `shasum -a 256 pilot/evidence/pilot-real-1/arm-*.json` to verify the shipped
records. The local run also produced (not committed, protected or runtime data):

- evaluation report `reports/normalize_detuning-v1-20261107T212705Z.json`
- protected evaluation scoring `blind/runs/normalize_detuning-v1-20261107T212705Z.json`
- comparison report `reports/compare-normalize_detuning-20261107T212807Z.json`
- protected comparison scoring `blind/runs/compare-pilot-real-1-20261107T212807Z.json`
