# Agent preset: Routine stabilization / 例程稳定化

This directory owns the `routine-stabilization` agent preset for the bundle
`dsh-routine-stabilization`, plus the runtime-registration hook `index.js`
imports and a dependency-free validator.

## Files

| File | Role |
|---|---|
| `routine-stabilization.yml` | Loader-YAML declaration of the preset: one `- insert:` row for `@deepseek-ai/dsh-agent-preset` whose `config` is the `PresetDefinition`. Audited reference source and the **manual-install** form. |
| `definition.js` | The same declaration as an exported JavaScript object (`PresetDefinition`) used by runtime registration. |
| `register.js` | `export async function registerPreset(agentPresets, ctx)`; called by the bundle Host half (`index.js`). Idempotent, attaches its disposer to `ctx.effect`, throws an actionable error when runtime registration is unavailable. |
| `validate.mjs` | Minimal, dependency-free structural validator (no PyYAML in this environment): parses the YAML subset, checks the preset/plugin shape, asserts YAML↔`definition.js` equivalence and checks `SKILL.md`. |

## Which file is the installation source of truth

There are two equivalent declarations of **one** preset id; exactly one may be
active at a time.

- **Bundled install (`plugin_manager install_bundle` on this bundle): the runtime
  registration path is effective** — `index.js` calls `registerPreset`, which
  registers `definition.js`'s object with the Host `agentPresets` registry. This
  is the path a user gets from installing the bundle.
- **`routine-stabilization.yml` is the reference source of truth for the
  declaration itself and the manual-install source of truth** (the Loader-YAML
  mechanism documented by `editing-cordis-compositions`). `validate.mjs` asserts
  that both forms declare the same identity, description, persona and plugin
  id/name sequence, so the YAML stays an auditable mirror of the runtime object.
- Do **not** install both forms: duplicate preset ids fail declaration loading.
  `registerPreset` already no-ops when the roster contains `routine-stabilization`
  (i.e. the YAML row is active).

## Select the preset after installing

1. Install the bundle (Plugins page or `plugin_manager` `install_bundle`), then
   restart the Host / DeepSeek Harness desktop so the profile composition and
   preset registry re-load. Preset revisions are eagerly loaded and existing
   sessions keep the composition they started with.
2. Start a **new session** and pick `Routine stabilization / 例程稳定化` in the
   session preset selector above the composer (provided by
   `@deepseek-ai/dsh-client-ui-agent-preset`), or make it the new-session
   default in Settings → **Agent presets** (same plugin owns the
   `settings.section` with id `agent-presets`). Preset selection must happen
   before the session's first turn; an existing session keeps the composition
   it started with.
3. Verify:
   - `agentPresets.list()` (or Settings → Agent presets / the roster UI)
     contains id `routine-stabilization`; with the YAML fallback the Loader row
     id is `preset-routine-stabilization`;
   - the new session's tool catalog contains `routine_status`,
     `routine_evaluate`, `routine_run`, `routine_propose`, `routine_report`,
     `routine_compare` (provided by the bundle's Host row; the preset does not
     mount the package again);
   - the skill catalog contains `routine-stabilization` (bundle `skills/`
     directory mounted through `@deepseek-ai/dsh-skill-filesystem`);
   - the Web `Settings → Routine stabilization` panel (the bundle's
     `dsh.client` half) renders for every session.

## Runtime registration contract (consumed by `index.js`)

```js
import { registerPreset } from './preset/register.js'
const agentPresets = ctx.get('agentPresets')   // optional service
await registerPreset(agentPresets, ctx)        // → Promise<Disposer>
```

- `agentPresets` is the Host `agentPresets` service; `ctx` is the plugin
  context. `registerPreset` awaits `agentPresets.register(definition)` and
  returns the disposer (`() => void | Promise<void>`).
- When `ctx.effect` exists the disposer is also attached to it, so Cordis tears
  the definition down with the plugin. A caller that passed `ctx` must not
  dispose the returned value a second time; without `ctx` the caller owns it.
- Unknown id on the roster, or a failed `register`, rejects with an error that
  names the manual-install fallback; `index.js` catches and logs it.
- Service absent / no `register` method → rejects with the same actionable
  message (never silently skips the preset).

Basis: `cordis_inspect_query` host `Service.listService` for `agentPresets`
(`register(definition: PresetDefinition): Promise<() => Promise<void>>`,
`list(): Promise<AgentPreset[]>`) and
`@deepseek-ai/dsh-agent-preset/lib/index.js` (Config fields `id`+`plugins`
required, `name`/`description`/`order` optional; `Service.init` registers the
parsed config).

## Fallback: install the preset from YAML

Use this when runtime registration is unavailable (no `agentPresets` service,
`register` throws) or when the Web roster should own the declaration.

1. Make `dsh-routine-stabilization` resolvable from the profile: install the
   bundle so it lands in the profile's `node_modules` (the bundle patch also
   adds its profile-level Host row).
2. Append the single `- insert:` row from
   `preset/routine-stabilization.yml` to
   `~/.dsh/profiles/<profile>/cordis.patch.yml` (that file is a top-level YAML
   array of patch entries; keep the file's indentation and order). If you
   prefer an overlay, pass `--patch <bundle>/preset/routine-stabilization.yml`
   on a launcher that supports `--patch`; this requires the bundle to be
   installed because the skill-directory expression resolves
   `dsh-routine-stabilization` from the loader's `baseUrl`.
3. Restart the Host. `agentPresets.list()` then shows the id; `registerPreset`
   becomes a no-op; select the preset in a new session as above.
4. The YAML path does not need `definition.js`/`register.js`.

## Wiring note (maintainers): one active Loader entry per package

The bundle package must appear as **exactly one active Loader entry**. This
repository uses **mode B**:

- the bundle's profile-level Host row (`cordis.patch.yml`, row id
  `routine-stabilization`) is the single entry: it registers the `routine_*`
  tools on the Host tool registry, serves the `dsh.client` Settings panel, and
  calls `registerPreset` to declare this preset;
- the preset therefore contributes only persona, instructions/context, the
  standard tools and the bundle's skills directory. It must **not** name
  `dsh-routine-stabilization` again: a second active Loader entry for the
  same package is rejected by the client-modules registry (the UI half is not
  published) and would register every routine tool twice.

Consequence: the `routine_*` tools are Host-global (available to any session),
while the `routine-stabilization` skill and the preset persona appear only in
sessions that selected this preset. The alternative wiring (preset entry only,
preset-scoped tools) is documented as rejected: it makes the panel and tools
disappear whenever no session has the preset selected.

`routine-stabilization.yml` and `definition.js` deliberately contain no
`dsh-routine-stabilization` row; `node preset/validate.mjs` fails if one is
re-added.

## Validation

```sh
node --check preset/definition.js
node --check preset/register.js
node --check preset/validate.mjs
node preset/validate.mjs          # exit 0 = valid
node preset/validate.mjs --verbose
```
