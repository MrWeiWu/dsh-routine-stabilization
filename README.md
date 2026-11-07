# dsh-routine-stabilization

A DeepSeek Harness (DSH) plugin that turns recurring LLM work into **versioned,
testable, revertible routines** — and refuses to let a routine serve results it
cannot prove.

It implements a routine-stabilization framework: a small registry of read-only
task routines, an LLM-facing proposal path, CI evidence gates, a blind challenge
set, a shadow/paired cost comparison, and a runtime admission decision that can
defer instead of guessing.

```
observe ──▶ propose candidate ──▶ evaluate gates ──▶ shadow / paired arms ──▶ release (user) ──▶ serve or defer
                                        │                                        │
                                        └── failing gate blocks promotion ◀──────┴── withdraw on drift / mismatch
```

## What you get

| Piece | Description |
| --- | --- |
| **Versioned registry** | `routines/<id>/<version>/` holds a manifest, a guard, a binding and an execution module. Released versions are immutable. |
| **Runtime admission** | For every request: resolve the field and its provenance → check applicability → execute → validate postconditions. A failed check discards the provisional result and takes the declared fallback. Deferrals carry a reason. |
| **CI evidence gates** | Development cases must all pass, coverage ≥ 60 %, **zero** observed silent errors with an exact one-sided 95 % upper bound below 5 %, zero incorrect automatic results on 40 constructed near-misses, and an independent reference check must exit 0. |
| **Blind discipline** | Fixture sets are split into `dev` (derive and tune), `audit` (representative, previously unseen) and `challenge` (constructed near-misses). Labels are frozen with their own hash. |
| **Paired cost comparison** | A / B / C arm records are paired by case: success rates, discordant counts, deterministic case-level bootstrap, zero-discordance bound, p50/p95 latency, projected total cost and cost per correctly resolved request. |
| **User-only authority** | Release and withdrawal are reachable only from the Settings panel (two-step confirmation); no agent tool can release or withdraw. A release requires a passing evaluation whose evidence hashes still match the current manifest, hooks and fixtures. |
| **Agent tools** | `routine_status`, `routine_seed`, `routine_evaluate`, `routine_run`, `routine_propose`, `routine_report`, `routine_compare`. |
| **Agent preset + skill** | A `routine-stabilization` preset (persona, skill, base tools) that teaches an agent the observe → propose → prove → shadow → withdraw workflow. |
| **Settings panel** | A `Routine stabilization` page in Harness Settings: registry table, gate chips, evaluation report, routing log, Evaluate / Release / Withdraw / Seed actions, English and Chinese UI. |

## Requirements

- **DeepSeek Harness** desktop/web profile (this is a DSH bundle: Host half plus
  a static `dsh.client` half).
- **Node.js ≥ 20** for the repository checks and the built-in example's
  independent reference calculation. The plugin itself has **no runtime
  dependencies** (Node built-ins only).

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

## Registry layout

```
$DSH_HOME/routine-registry/
  registry/registry.json          version states (candidate/active/superseded/withdrawn/suspended),
                                  the active version and the fallback pointer
  routines/<id>/<version>/        manifest.json + guard.js + binding.js + execution.js
  fixtures/<id>/<version>/        dev.json, audit.json, challenge.json (frozen labeled cases)
  evals/<id>/<version>/           independent reference checks (exit code is the gate)
  reports/                        evaluation reports, comparison reports, release/withdrawal decisions
  logs/routes.jsonl               runtime decisions, payload-minimized (input hash only)
  arms/                           paired A/B/C arm records
```

Everything is plain JSON and JavaScript, with SHA-256 evidence hashes recorded per
report (manifest, hooks, fixture sets, evaluator) plus a reproducibility block:
engine/node/platform, model snapshot, prompt and tool versions, code revision and
case-set hash.

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
- `errorPolicy`, `fallback`, and `evidence` (fixture sets, evaluator, provenance,
  approval, withdrawal trigger).

A plausible numeric result alone never validates *which field* supplied it: field
identity, sign convention, unit and deferral reason are separate checks.

## Evaluation gates

`routine_evaluate` runs the frozen sets and computes:

| Gate | Rule |
| --- | --- |
| Contract | manifest valid, hooks load, postconditions known, evidence hashable, no schema drift |
| Dev | all development cases reach the expected decision and output (deliberate deferrals included) |
| Coverage | automatic results / representative audit requests ≥ 60 % |
| Silent error | zero observed wrong automatic results, and `1 − 0.05^(1/n) < 0.05` for `n` automatic results (n = 59 → 4.95 %) |
| Challenge | zero incorrect automatic results on the 40 near-misses; a case that requires deferral fails if accepted |
| Reference check | the independent evaluator under `evals/` exits 0 (run as a subprocess and recorded) |
| End-to-end success | correct resolution or correct metadata request, within the shared budget; reported with its denominator |

Reports record per-case outcomes, never only aggregates. A release requires a
fresh passing report; changing a hook, fixture set or the manifest invalidates
it. Re-evaluation that detects schema drift suspends an active version.

## Built-in example

`seed/` ships the read-only `normalize_detuning/v1` routine (convert an explicitly
identified detuning value to Hz):

- 30 dev cases including four anchor cases (signed kHz, angular rad/s, a
  drive/detuning dual-column case with and without an unambiguous field id, and a
  header/schema unit conflict that must defer);
- 100 synthetic representative audit requests (78 solvable);
- 40 constructed near-misses;
- an independent reference calculation that imports none of the runtime hooks;
- three paired arm records (A, B, C) for the cost comparison.

The example data is synthetic (provenance declared in each fixture file); the
framework's blind-audit protocol needs real unseen requests before any
deployment-rate inference.

## Development

```bash
bash scripts/check.sh     # the consistency check; exit code 0 is the definition of done
```

It runs, in order:

1. `node --check` on every `.js`/`.mjs` file;
2. JSON parse of every manifest, locale and seed data file;
3. `node preset/validate.mjs` (preset declaration ↔ definition equivalence, skill
   limits);
4. `node lib/selfcheck.mjs` — seed, evaluate, gates, release, stale-evidence
   rejection, paired comparison, proposal validation, withdrawal;
5. the seed example's independent reference calculation.

There are no dependencies and no build step. To work on the example alone:

```bash
npm run reference        # independent reference calculation
npm run test             # engine self-check
npm run preset:validate  # preset/skill validation
```

Pull requests are expected to keep `scripts/check.sh` green and to add a
regression case for every fixed failure (fixtures are evidence, not samples).

## Repository layout

```
index.js                 Host half: tools, operations, HTTP routes, preset registration
client.js                Client half: settings.section page + icon
lib/
  engine.js              runtime path, evaluation, comparison, registry mutations
  store.js               registry layout, atomic writes, hashing, seeding
  stats.js               exact upper bound, coverage, bootstrap, cost model
  tools.js               agent tool definitions
  selfcheck.mjs          engine self-check used by CI
seed/                    built-in normalize_detuning/v1 example
preset/                  agent preset (runtime definition + YAML reference)
skills/                  the routine-stabilization skill
locale/                  plugin metadata (en, zh) for the Plugin Manager
scripts/check.sh         repository consistency check
```

## Settings panel transport

The panel is a static `dsh.client` module, so it has no package-private host
bridge. It calls the Host's operations over same-origin fetch on exact Connection
Fetch routes under `/api/routine-stabilization` — the Connection service admits
the owner browser request before the route runs. Release and withdrawal reject a
non-owner principal; no agent tool calls them.

## Known limitations

- The example's audit set is synthetic; it demonstrates the gates but cannot
  estimate a real deployment error rate.
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
