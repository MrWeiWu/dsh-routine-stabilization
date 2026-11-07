// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Runtime-registration form of the `routine-stabilization` agent preset.
//
// `preset/routine-stabilization.yml` is the Loader-YAML reference declaration;
// this module is the same PresetDefinition as a plain object so the bundle's
// Host half can register it without a second Loader row:
//
//   import { preset } from './preset/definition.js'
//   ctx.agentPresets.register(preset)   // inside a plugin that injects
//                                       // 'agentPresets' (see README.md)
//
// Both forms declare the SAME preset id. Enabling them together fails
// declaration loading with a duplicate-id error; pick one install path.
//
// The plugin list mounts the bundle's own `skills/` directory through the
// filesystem skill provider. Paths resolve from this module's installed
// location, so the bundle must be installed under the profile's node_modules.
//
// The routine_* tools and the Settings panel come from this bundle's
// profile-level Host row (`cordis.patch.yml`), not from this preset: naming
// `dsh-routine-stabilization` here as well would create a second active
// Loader entry for the same package, which the client-modules registry rejects
// (UI half unpublished) and which would register every routine tool twice. The
// preset therefore contributes only persona, skills and the standard tools.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
export const skillsDir = join(bundleDir, 'skills')

export const preset = {
  id: 'routine-stabilization',
  name: 'Routine stabilization / 例程稳定化',
  description:
    'Maintain versioned LLM routines end to end: observe recurring requests, ' +
    'propose guard/binding/execution hooks, prove candidates with CI evidence gates ' +
    '(coverage, zero silent errors with a one-sided 95% upper bound, blind challenge), ' +
    'keep candidates in shadow, and leave release and withdrawal to the user.',
  order: 10,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix:
          'You are a routine stabilization agent. You observe recurring requests, propose ' +
          'versioned routines, prove them with recorded CI evidence, and keep candidates in ' +
          'shadow until the user releases them. Never release or withdraw a routine yourself. ' +
          'Never answer a routine request from intuition: call the routine tools and cite the ' +
          'recorded result, including denominators. Blind labels are inaccessible; use only ' +
          'the scoring command.',
      },
    },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    {
      id: 'tool-bash',
      name: '@deepseek-ai/dsh-tool-bash',
      // Platform is fixed for the Host process; the YAML mirror uses !!js.
      disabled: process.platform === 'win32',
    },
    {
      id: 'tool-pwsh',
      name: '@deepseek-ai/dsh-tool-pwsh',
      disabled: process.platform !== 'win32',
    },
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { applyPatch: false },
    },
    {
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    {
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    // Do not add `dsh-routine-stabilization` here: the bundle's profile-level
    // Host row already provides the routine_* tools and the Settings panel.
    {
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
      config: { customSkillDirs: [skillsDir] },
    },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  ],
}

export default preset
