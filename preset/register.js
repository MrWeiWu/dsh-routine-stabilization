// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Runtime registration of the `routine-stabilization` agent preset.
//
// index.js (the bundle's Host half) imports this module statically and calls
//
//   registerPreset(agentPresets, ctx)
//
// where `agentPresets` is the Host `agentPresets` service (an optional
// `ctx.get('agentPresets')`, see the `AgentPresetsService` contract from
// cordis_inspect_query host Service listService agentPresets) and `ctx` is the
// plugin context.
//
// Contract:
//   - async function registerPreset(agentPresets, ctx): Promise<Disposer>
//       Disposer = () => void | Promise<void>
//   - Rejects (with a fixed, actionable message) when the service is absent or
//     has no `register` method; index.js already catches and logs the failure.
//   - Calls `agentPresets.register(preset)` (returns Promise<Disposer>) exactly
//     once per Host lifetime unless the roster already declares the id.
//   - Idempotent: when the same preset id is already on the roster (for example
//     the Loader-YAML declaration `preset/routine-stabilization.yml` is active
//     in the profile patch), it returns a no-op disposer instead of failing the
//     whole `agentPresets` composition on a duplicate id.
//   - When `ctx` has `effect`, the disposer is ALSO attached to `ctx.effect` so
//     Cordis tears the definition down with the plugin. A caller that supplied
//     `ctx` must not dispose the returned value a second time; callers without
//     `ctx` own the returned disposer.
//
// Manual-install fallback when this path is unavailable is documented in
// preset/README.md: install the bundle (so `dsh-routine-stabilization`
// resolves from the profile) and add the insert row from
// preset/routine-stabilization.yml to the profile cordis.patch.yml.

import { preset } from './definition.js'

const FALLBACK_HINT =
  'The routine-stabilization preset could not be registered at runtime. ' +
  'Install the preset from preset/routine-stabilization.yml: install the bundle ' +
  '(dsh-routine-stabilization) so it resolves from the profile node_modules, then add that ' +
  'file\'s `insert` row to the profile cordis.patch.yml (or a --patch overlay) and restart dsh. ' +
  'See preset/README.md for the exact steps.'

/** Register the routine-stabilization preset with the Host agent-preset registry. */
export async function registerPreset(agentPresets, ctx) {
  if (!agentPresets || typeof agentPresets.register !== 'function') {
    throw new Error(
      `agentPresets.register is unavailable in this composition. ${FALLBACK_HINT}`,
    )
  }

  // A Loader-YAML declaration (preset/routine-stabilization.yml) and this runtime
  // registration describe the same preset id; declaring both fails loading with a
  // duplicate-id error, so detect the existing row first and stay a no-op.
  try {
    const roster = await agentPresets.list()
    if (Array.isArray(roster) && roster.some((entry) => entry && entry.id === preset.id)) {
      return async () => {}
    }
  } catch {
    // `list` is optional for older revisions; fall through to register and let
    // the real duplicate-id diagnostic surface if the id is already declared.
  }

  let dispose
  try {
    dispose = await agentPresets.register(preset)
  } catch (error) {
    throw new Error(`agentPresets.register(${preset.id}) failed: ${error?.message ?? error}. ${FALLBACK_HINT}`)
  }
  if (typeof dispose !== 'function') {
    throw new Error(
      `agentPresets.register(${preset.id}) did not return a disposer; refusing to leak the definition. ${FALLBACK_HINT}`,
    )
  }

  if (ctx !== undefined && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose)
  }
  return dispose
}

export default registerPreset
