# dsh-routine-stabilization

A DeepSeek Harness (DSH) plugin that turns recurring LLM work into **versioned,
testable, revertible routines** — and refuses to let a routine serve results it
cannot prove.

It implements a routine-stabilization framework: a small registry of read-only
task routines, an LLM-facing proposal path, CI evidence gates over a frozen
preregistered protocol, blind audit/challenge evidence that the routine never
sees, a real paired A/B/C pilot, and a runtime admission decision that can defer
instead of guessing. Synthetic evidence is mechanically unable to release a
routine.

```
observe ─▶ preregister ─▶ propose candidate ─▶ blind evaluation ─▶ real pilot ─▶ eligibility ─▶ release (user) ─▶ serve or defer
                                               │                 │            │
                                               └── failing gate/eligibility blocks promotion ◀┘
                                                                                └── production binding error → suspend / withdraw
```

## What you get

| Piece | Description |
| --- | --- |
| **Versioned registry** | `routines/<id>/<version>/` holds a manifest, a guard, a binding, an execution module and a frozen preregistration. Released versions are immutable. |
| **Runtime admission** | For every request: resolve the field and its provenance → check applicability → execute → validate postconditions. A failed check discards the provisional result and takes the declared fallback. Deferrals carry a reason; an unexpected error or a failed check on an **active** version's production request suspends that version and serves only the fallback. |
| **CI evidence gates** | Development cases must all pass, coverage ≥ 60 %, **zero** observed silent errors with an exact one-sided 95 % upper bound below 5 %, zero incorrect automatic results on 40 constructed near-misses, complete output-schema validation, and an independent reference check must exit 0. |
| **Blind evidence** | Fixture sets split into `dev` (derive and tune), `audit` (representative, previously unseen) and `challenge` (constructed near-misses). Audit/challenge **labels live in `blind/`** (dirs 0700, files 0600) and are exposed only through the scoring command; a label set may gate a release only on its first run. |
| **Preregistration** | Thresholds, workload, cost horizon, exclusions and reviewers are frozen in `preregistration.json` before the labels are opened. A changed or missing protocol blocks release. |
| **Real paired pilot** | Measured A/B/C runs at `arms/<runId>/` for repeats 1..3: raw records carry decisions only, `routine_compare` scores them in-process against protected labels, reports repeatability and a cost projection, and returns a `pilotDecision`. |
| **Release eligibility** | A release needs passing gates, a fresh audit use, an unchanged preregistration, an independent domain reviewer and attested real deployment data. Synthetic evidence cannot be released. |
| **User-only authority** | Release and withdrawal are reachable only from the Settings panel (two-step confirmation); no agent tool can release or withdraw. |
| **Agent tools** | `routine_status`, `routine_seed`, `routine_evaluate`, `routine_run`, `routine_propose`, `routine_preregister`, `routine_report`, `routine_compare`. Reference outcomes are opened with the `scripts/score.mjs` CLI (release reviewer), not an agent tool. |
| **Agent preset + skill** | A `routine-stabilization` preset (persona, skill, base tools) that teaches an agent the observe → preregister → propose → prove → shadow → withdraw workflow. |
| **Settings panel** | A `Routine stabilization` page in Harness Settings: registry table, gate chips, evaluation report aggregates, routing log, Evaluate / Release / Withdraw / Seed actions, English and Chinese UI. A refused release reports the `eligibility` blockers. |

## Requirements

- **DeepSeek Harness** desktop/web profile (this is a DSH bundle: Host half plus
  a static `dsh.client` half).
- **Node.js ≥ 20** for the repository checks, the scoring CLI, the pilot runner
  and the built-in example's independent reference calculation. The plugin
  itself has **no runtime dependencies** (Node built-ins only).

## Install

Clone this repository, then install the bundle into the current DSH profile
through the Harness plugin manager — either from an agent session:

```
plugin_manager install_bundle target=/absolute/path/to/dsh-routine-stabilization
```

or from **Settings → Plugins → install from a local directory**.

On first use, seed the built-in example from **Settings → Routine stabilization →
Seed example**, or call the `routine_seed` tool. The registry is created at
`$DSH_HOME/routine-registry` (override it with the bundle row's `config.root`).

> The plugin's own row is profile-level, so the tools and the Settings panel are
> available to every agent in the profile. The preset adds the persona and the
> skill and intentionally does **not** mount the package a second time.

After seeding, the registry root contains the readable fixture **inputs** and the
protected label files. The supported way to inspect reference outcomes is:

```bash
node scripts/score.mjs --root "$DSH_HOME/routine-registry"
```

See [Blind evidence](docs/blind-evidence.md) for permissions and the first-run
rule.

## Registry layout

```
$DSH_HOME/routine-registry/
  registry/registry.json          version states (candidate/active/superseded/withdrawn/suspended),
                                  the active version and the fallback pointer
  routines/<id>/<version>/        manifest.json + guard.js + binding.js + execution.js
                                  + preregistration.json (frozen protocol)
  fixtures/<id>/<version>/        dev.json (inline expected values)
                                  + audit.inputs.json + challenge.inputs.json
  blind/<id>/<version>/           audit.labels.json + challenge.labels.json
                                  (directories 0700, files 0600 — scoring only)
  blind/runs/                     protected per-case scoring detail (files 0600)
  evals/<id>/<version>/           independent reference checks (exit code is the gate)
  reports/                        public evaluation/comparison reports, release/withdrawal decisions
  logs/routes.jsonl               runtime decisions, payload-minimized (input hash only)
  arms/<runId>/                   raw measured arm records (A/B/C × repeats 1..3), never labels
```

Everything is plain JSON and JavaScript, with SHA-256 evidence hashes recorded
per report (manifest, hooks, fixture sets, blind labels, evaluator) plus a
reproducibility block: engine/node/platform, model snapshot, prompt and tool
versions, environment, source revision (`commit`, `dirty`, `packageVersion`) and
a real case-set hash.

## Runtime contract

A routine manifest declares:

- `inputs` — typed arguments, units and required metadata;
- `admission.predicate` — the guard (`guard.js#decide`) returning `accept` or
  `defer` with a reason from `deferReasons`;
- `binding.entry` — field and provenance resolution (`binding.js#bind`), which
  preserves the original input;
- `execution.entry` — the pure conversion (`execution.js#run`);
- `postconditions` — checks the runtime validates; a failed check forces the
  declared `fallback`;
- `errorPolicy`, `fallback`, and `evidence` — fixture sets, **blind labels**,
  evaluator, `dataClass`/`provenance`/`realDeploymentData`, derivation traces,
  preregistration, approved release and withdrawal trigger.

A plausible numeric result alone never validates *which field* supplied it: field
identity, sign convention, unit and deferral reason are separate checks.

## Evaluation gates

`routine_evaluate` runs the frozen sets and computes:

| Gate | Rule |
| --- | --- |
| Contract | manifest valid, hooks load, postconditions known, evidence paths resolvable and hashable, no schema drift |
| Preregistration | the frozen protocol exists, parses, matches the routine id/version and declares valid thresholds, workload, budget and reviewers |
| Blind isolation | audit/challenge fixture sets resolve to inputs-only files with labels declared separately under `blind/` (inline blind labels fail) |
| Dev | all development cases reach the expected decision and output (deliberate deferrals included) |
| Coverage | automatic results / representative audit requests ≥ the preregistered floor (60 % default) |
| Silent error | zero observed wrong automatic results, and exact `1 − 0.05^(1/n) < 0.05` for `n` automatic results (n = 59 → 4.95 %) |
| Challenge | zero incorrect automatic results on 40 near-misses; a case that requires deferral fails if accepted |
| Output schema | every automatic result validates against the manifest output schema at runtime (including `additionalProperties` and required fields); a violation forces the fallback and so fails a gate |
| Reference check | the independent evaluator under `evals/` exits 0 (run as a subprocess and recorded) |
| End-to-end success | correct resolution or correct metadata request, within the preregistered per-request budget; reported with its denominator and consumed by the pilot decision |

Reports record per-case outcomes, never only aggregates, plus a
`budget` block (`perRequestMs`, `overBudgetCases`, `withinBudgetRate`) and added
`metrics.<set>` counters `needlessDeferrals` and `fallbackResolved`. Changing a
hook, fixture input, blind label set, preregistration or the manifest invalidates
a release decision; re-evaluation that detects schema drift suspends an active
version. `evidence.dataClass` (in v0.2, the provenance/data-class field —
`synthetic`, `contract-derived`, `trace-derived` or `deployment`) and
`evidence.realDeploymentData` are recorded in the report as the data class.

## Blind evidence and preregistration

The v0.2 evidence layer separates what a routine may be tuned on from what proves
it:

- `fixtures/<id>/<version>/audit.inputs.json` and
  `challenge.inputs.json` hold **inputs only**; `dev.json` keeps inline expected
  values because tuning on dev is intended.
- Audit/challenge **labels** are stored at
  `blind/<id>/<version>/{audit,challenge}.labels.json`, in directories mode
  `0700` with files mode `0600`. The runtime and the candidate never read them;
  the agent-facing preset is not given access to the labels.
- The evaluation scores labels **in-process** and writes a protected blind run
  (`blind/runs/…`, mode `0600`). The **public** report omits `expect`/`correct`
  for audit and challenge cases and exposes only
  `{id, decision, reason, disposition, firstRoute, latencyMs}`; its
  `blindRun {path, sha256, protected: true}` points at the protected detail.
- Release reviewers inspect reference outcomes through the scoring command,
  which reads the protected `blind/runs/` detail plus the stored labels:

  ```bash
  node scripts/score.mjs --root <registry-root> [--routine <id>] [--version <v>] \
    [--run <blind-run.json>] [--json]
  ```

  It prints the aggregate plus per-case `expected`/`decision`/`correct` rows and
  exits non-zero when the labels or run file are unreadable. Ordinary agents
  should not read or be given the blind label files or the scoring output.

**First run only.** Each report records
`auditUse {labelsSha256, inputsSha256, preregHash, firstRunAt, lastRunAt, runs,
fresh}`. The first evaluation that opens a label set makes the audit fresh
(`runs: 1`); a later evaluation against the same labels still reports metrics
but sets `fresh: false`, `runs ≥ 2`, and adds the `audit-reused` blocker. Fresh
evidence means new labels and a new candidate version — not re-running until
green.

**Preregistration.** `routines/<id>/<version>/preregistration.json` freezes the
population, sampling unit, exclusions, gates thresholds, workload and budget,
decision date, next review trigger, `realDataAttested` and reviewer signatures
**before** the first blind run. The evaluator hashes it; a missing or changed
protocol blocks release. An agent may add author signatures only; the
independent `domain-reviewer` signature is added by the user and is required for
release.

Details: [Blind evidence](docs/blind-evidence.md),
[Preregistration](docs/preregistration.md), and
[Review](docs/review.md).

## Real pilot

A generated arm table is not evidence. The v0.2 pilot is a **measured run** with
three arms over the same audit inputs. This repository ships the raw records of
one such run under `pilot/evidence/pilot-real-1/` with its reading in
[`pilot/RESULTS.md`](pilot/RESULTS.md) (result: outcome parity, cost incomplete,
decision `inconclusive`, no release).

- **A** — a fresh LLM agent using ordinary tools (`participant.kind:
  "llm-agent"`, recorded provider/model/prompt version; cost basis `unmetered`
  unless a meter is attached);
- **B** — a hand-written independent implementation (`pilot/arm-b.mjs`);
- **C** — the candidate routine executed through the engine's runtime path.

Arm records live at `arms/<runId>/arm-<a|b|c>-r<repeat>.json` for repeats
`1..3`, and are **raw**: decisions, bound field, converted value, measured
latency and per-case cost, with **no** `correct` and **no** `expected`. B and C
are scripted (`cost.basis: "local-script"`, zero marginal cost,
`process.hrtime.bigint()` latency). `routine_compare {runId, routine, version}`
loads the protected labels and the latest report, scores the records
in-process, and writes a public aggregates-only comparison report plus a
protected per-case detail file (mode `0600`, under `blind/runs/`). Repeat 1 is
the primary comparison; repeats 2–3 are diagnostic and produce the
repeatability statistic (case ids whose decision/route disagrees across
repeats).

Only records with `provenance: "measured"` are evidence. Generated or legacy
arm records are excluded: a comparison with no measured run is refused with
`no measured arm runs found`, and a demonstration record never advances.

The projected total per arm is `setup + maintenance + requests × perRequest`; it
is `null` for an arm without a numeric per-request cost (an unmetered arm), and
the cost picture is then marked incomplete. `pilotDecision` is
`{decision, advance, gatesOk, beatsBaselines, costComplete, cheaper, reasons,
rule}` where `decision` is:

| Value | Meaning |
| --- | --- |
| `advance-to-shadow` | A fresh passing report, e2e success ≥ each baseline, and a complete measured cost projection lower than both baselines. Shadow only — never a release. |
| `do-not-advance` | A required condition failed (gates, baseline success, or a complete but not-cheaper cost projection). |
| `inconclusive` | The comparison cannot decide — typically an incomplete cost picture. Collect more data. |

A synthetic-input pilot may reach `advance-to-shadow`, but release stays blocked
by eligibility. Run the pilot with:

```bash
node pilot/run.mjs --root "$DSH_HOME/routine-registry" --run-id pilot-real-1 \
  --routine normalize_detuning --version 1 --repeats 3 --arm-a /path/to/arm-a-records
```

Full protocol: [Pilot protocol](docs/pilot-protocol.md).

## Release eligibility

A release decision is not just "gates passed". The report carries
`eligibility {releaseEligible, blockers[{code, message}]}` plus `dataClass`;
release is refused with an error listing `code: message` for every blocker, and
`routine_report` exposes the same fields (`eligibility`, `auditUse`,
`blindRun`). The Settings panel shows the gate summary. Release requires **all**
of:

- every promotion gate passes and the report is not stale;
- the audit use is fresh (first run of that label set);
- the preregistration exists and its hash is unchanged;
- the evidence is real (`evidence.dataClass` attested as deployment evidence,
  `realDeploymentData: true` **and** `preregistration.realDataAttested: true`);
- an **independent domain reviewer** has signed the preregistration;
- the runtime output-schema contract holds.

The blocker codes are `gates-failed`, `audit-reused`,
`preregistration-invalid`, `preregistration-changed`, `synthetic-data`,
`real-data-not-attested` and `independent-reviewer-missing`. On top of the
report-level blockers, the release action re-hashes the manifest, hooks, fixture
sets, blind labels and preregistration and refuses a report that has become
stale.

**The built-in example is synthetic, so it is release-ineligible by
construction** — `synthetic-data` plus `independent-reviewer-missing`. This is
expected behavior and a designed demonstration: the example evaluates, scores
and runs the pilot, but cannot be released. Replacing it with a real routine
means a new preregistration, attested real deployment data and an independent
reviewer.

## Built-in example

`seed/` ships the read-only `normalize_detuning/v1` routine (convert an
explicitly identified detuning value to Hz) in the v2 evidence layout:

- 30 dev cases with inline expected values, including four anchor cases (signed
  kHz, angular rad/s, a drive/detuning dual-column case with and without an
  unambiguous field id, and a header/schema unit conflict that must defer);
- 100 synthetic representative audit **input** cases (78 solvable) with their
  expected values split into `seed/blind/normalize_detuning/v1/audit.labels.json`
  (mode 0600, synthetic example data committed on purpose);
- 40 constructed near-miss challenge input cases with a separate label file;
- an independent reference calculation that imports none of the runtime hooks
  and reads inputs plus labels;
- a frozen preregistration with the contract author as the only reviewer and
  `realDataAttested: false` — the honest protocol behind the example's
  release-ineligibility;
- **no arm records**: measured arm data is produced by the pilot runner, not
  shipped as generated evidence.

The example data is synthetic (provenance declared in each fixture file); the
framework's blind-audit protocol needs real unseen requests before any
deployment-rate inference. See `seed/README.md` for the layout and the page-5
anchors.

## Development

```bash
bash scripts/check.sh     # the consistency check; exit code 0 is the definition of done
```

It runs, in order:

1. `node --check` on every `.js`/`.mjs` file;
2. JSON parse of every manifest, fixture, blind label, locale and
   preregistration file, plus a check that audit inputs carry no expectations
   and that labels do;
3. protected blind label permissions: seeding a temporary root must produce
   `0600` label files (`0700` directories), since git does not carry those
   modes;
4. `node preset/validate.mjs` (preset declaration ↔ definition equivalence, skill
   limits);
5. `node lib/selfcheck.mjs` — blind evidence, preregistration, gates,
   eligibility, audit reuse, measured comparison, proposal validation and
   production-fallback suspension;
6. the seed example's independent reference calculation;
7. the pilot runner self-test (`pilot/selftest.mjs`, runner plumbing only — not
   evidence);
8. `scripts/score.mjs` syntax and its empty-root failure behavior (the scoring
   command must refuse an unscored root, not print an empty table).

There are no dependencies and no build step. To work on individual pieces:

```bash
npm run reference        # independent reference calculation
npm run test             # engine self-check
npm run preset:validate  # preset/skill validation
node scripts/score.mjs --root <registry-root>   # release-reviewer scoring
node pilot/run.mjs --root <registry-root> --run-id <id> --repeats 3
```

Pull requests are expected to keep `scripts/check.sh` green and to add a
regression case for every fixed failure (fixtures are evidence, not samples).

## Repository layout

```
index.js                 Host half: tools, operations, HTTP routes, preset registration
client.js                Client half: settings.section page + icon
lib/
  engine.js              runtime path, evaluation, comparison, registry mutations
  store.js               registry layout, atomic writes, permissions, hashing, seeding
  stats.js               exact upper bound, coverage, bootstrap, cost model
  tools.js               agent tool definitions
  selfcheck.mjs          engine self-check used by CI
seed/                    built-in normalize_detuning/v1 example (v2 blind layout)
  blind/                 synthetic audit/challenge labels (committed example data)
pilot/                   real pilot runner, hand-written arm B and pilot self-test
scripts/
  check.sh               repository consistency check
  score.mjs              reference-outcome scoring CLI for reviewers
preset/                  agent preset (runtime definition + YAML reference)
skills/                  the routine-stabilization skill
docs/                    framework, blind evidence, pilot protocol, preregistration, review
locale/                  plugin metadata (en, zh) for the Plugin Manager
```

## Documentation

- [docs/framework.md](docs/framework.md) — the framework rules in context.
- [docs/blind-evidence.md](docs/blind-evidence.md) — label storage,
  permissions, first-run rule and the scoring command.
- [docs/preregistration.md](docs/preregistration.md) — protocol fields, freeze
  timing and reviewer independence.
- [docs/pilot-protocol.md](docs/pilot-protocol.md) — arms, repeats, cost basis,
  decision rules and how to run the pilot.
- [docs/review.md](docs/review.md) — candidate and reference-outcome reviews and
  the signing flow.

## Settings panel transport

The panel is a static `dsh.client` module, so it has no package-private host
bridge. It calls the Host's operations over same-origin fetch on exact Connection
Fetch routes under `/api/routine-stabilization` — the Connection service admits
the owner browser request before the route runs. Release and withdrawal reject a
non-owner principal; no agent tool calls them.

## Known limitations

- The example's audit set is synthetic and its protocol has no independent
  reviewer, so it is release-ineligible by construction; it demonstrates the
  gates and eligibility rules but cannot estimate a real deployment error rate.
- The repository ships one measured pilot run as evidence
  (`pilot/evidence/pilot-real-1/`, read `pilot/RESULTS.md`). B/C records come
  from `pilot/run.mjs`; a three-arm comparison additionally needs a real LLM
  agent run for arm A (`--arm-a`). Generated or legacy records are not evidence
  and a run without measured runs is refused. The shipped run is synthetic and
  cost-incomplete, so it demonstrates the pipeline rather than an advance.
- Label permissions (0700/0600) are a contamination barrier for cooperating
  processes, not a multi-user security boundary: the Host runs as the same OS
  user that can read the registry. The scoring command and its output are for
  the release reviewer, not for an agent under evaluation.
- Browser-side rendering and interaction of the Settings page are verified only
  through live slot registration; visual/UX checks require opening the page.
- DSH plugin APIs evolve; the transport and slot registrations are pinned to the
  APIs cited in `preset/README.md` and the source comments.
- The plugin does not synchronize registries between machines; the registry is
  local to `$DSH_HOME`.

## License

Licensed under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

Because this plugin serves a UI over a network interface, if you modify it and
let others interact with it remotely, AGPL section 13 requires that those users
can obtain the Corresponding Source of your version. Running it unmodified, or
modifying it for private use, does not trigger that obligation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
