# Contributing

Thanks for helping improve `dsh-routine-stabilization`.

## Ground rules

1. **`bash scripts/check.sh` must exit 0.** It is the repository's definition of
   done: syntax checks, JSON parses, preset validation, engine self-check and the
   independent reference calculation. A change that leaves it red is not ready.
2. **Do not weaken checks to go green.** Do not delete tests, skip assertions,
   loosen gate thresholds or edit the checker to accept a failure. Fix the code
   or, if the rule itself is wrong, explain why in the pull request first.
3. **Fixtures are evidence.** Every fixed failure gets a regression case in the
   appropriate fixture set (dev for behavior, challenge for near-misses). Never
   copy `audit` or `challenge` labels into `dev` to tune a routine.
4. **No new runtime dependencies** without a discussion in an issue first. The
   plugin deliberately uses Node built-ins only.

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
   version=1` and confirm every gate passes;
3. check `routine_status` for `preset: { status: "registered" }` and the Settings
   panel registration.

## Pull requests

- One concern per pull request; keep the diff small.
- Describe behavior changes, the evidence you ran, and any gate or schema change.
- If you touch the manifest schema, fixture format or report format, update the
  README and say in the pull request how you kept old reports readable.
- AGPL-3.0-or-later: contribute only code you have the right to license under it,
  and keep the SPDX headers.

## Reporting bugs

Use the issue templates. Include:

- what you ran (tool call, panel action, or command) and the exact output;
- the routine id/version and the relevant `reports/` or `logs/` entry;
- DSH version, OS, and the plugin version from `package.json`.
