# The routine-stabilization framework

This document records how the plugin implements the framework it targets, in
this repository's own words. The README is the entry point; this file is the
reference for anyone changing the schema or the gates.

## 1. What persists, and what can be tested

A routine is one versioned operation with three separately reviewable pieces:

| Piece | File | Testable property |
| --- | --- | --- |
| Procedure | `execution.js` | returns the expected result for supported inputs |
| Applicability rule | `guard.js` | accepts exactly the inputs whose assumptions hold, and defers with a reason otherwise |
| Field/provenance binding | `binding.js` | resolves the right field and unit from trusted metadata, and refuses ambiguity |

The manifest is the contract that links them, the fixtures are the evidence that
they behave, and `evals/` is an independent calculation that does not import the
runtime hooks.

## 2. Registry records

| Record | Minimum content |
| --- | --- |
| Identity and scope | routine id and version, owner, contract revision, allowed effects, dependencies, last approved release |
| Inputs and binding | typed arguments, required metadata, units, field identity, source of each bound value; the original input is preserved |
| Admission at runtime | predicate returning `accept` or `defer` with a reason; the manifest names the cases the routine cannot distinguish |
| Execution and checks | entrypoint, output schema, independently checkable postconditions, error policy, fallback |
| Evidence and status | derivation traces, evaluator and fixture versions, coverage, failure counts, approval record, withdrawal trigger |

The registry document (`registry/registry.json`) holds the version state
(`candidate`, `active`, `superseded`, `withdrawn`, `suspended`), the active
version and the fallback pointer. Released versions are immutable: a change
proposes a new version.

## 3. Promotion gates

A candidate is promoted only when the latest evaluation passes every gate:

- **Contract** — manifest valid, hooks load, postconditions known, evidence
  hashable, approved contract revision not drifted.
- **Dev** — every development case reaches the expected decision and output.
  Deliberate deferrals are expected behavior, not failures.
- **Coverage** — automatic results / representative requests ≥ 60 %; deferrals
  are reported by reason.
- **Silent error** — zero observed wrong automatic results, and the exact
  one-sided 95 % upper bound for zero events in `n` automatic results,
  `1 − 0.05^(1/n)`, is below 5 % (n = 59 gives 4.95 %).
- **Challenge** — zero incorrect automatic results on 40 constructed
  near-misses; a case that requires deferral fails if accepted.
- **Reference check** — the independent evaluator exits 0, run as a subprocess
  with its exit code recorded in the report.
- **End-to-end success** — correct resolution, or a correct metadata request,
  within the shared budget; reported with its denominator. The paired comparison
  uses this when deciding whether to advance.

A failed check on a runtime request discards the provisional result and invokes
the declared fallback. A failed gate blocks promotion. A release requires a
passing report whose evidence hashes still match the current manifest, hooks and
fixtures; otherwise it is refused as stale evidence.

## 4. Blind data discipline

Three uses of data stay separate:

1. **dev** — derive and tune the routine, then freeze it;
2. **audit** — representative, previously unseen requests for the blind
   estimate;
3. **challenge** — constructed near-misses whose intended routes are frozen
   before scoring.

Related paraphrases and source files stay in the same partition; whole
acquisition batches are held back where possible. If real deployment data are
unavailable, the data are labeled synthetic and the pilot stays in shadow. The
synthetic example in `seed/` does exactly that.

## 5. Paired comparison and the pilot decision

Three arms run on the same inputs: **A** a fresh agent using ordinary tools,
**B** a hand-written implementation, **C** the trace-derived routine. Pairing is
by case id. The comparison reports:

- success rates and correct rates with denominators;
- discordant pair counts for C against each baseline;
- a deterministic case-level bootstrap interval;
- a zero-discordance bound when no pair differs;
- p50/p95 latency;
- total cost at the declared workload (`setup + maintenance + N × mean request
  cost`), cost per correctly resolved request, and authoring hours.

The pilot decision is prespecified: advance C only if it passes the error,
challenge and coverage gates, reaches at least the observed end-to-end success
of each baseline, and has a lower projected total cost than both baselines. If
the comparison is inconclusive, collect more shadow data: any repair informed by
blind failures creates a new candidate and requires a fresh audit set.

## 6. Reproducibility

Every report carries the engine and Node versions, platform, model snapshot,
prompt/tool versions, code revision, case-set hash and per-case outcomes. Re-run
the affected checks after model, schema or dependency changes; label new
failures for the next development cycle and retain past regression cases.
