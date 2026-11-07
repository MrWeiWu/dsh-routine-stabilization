#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Create the v2 candidate: same read-only contract, but a NEW evidence cycle
// (fresh audit and challenge label sets) and observed-request derivation traces.
//
// Usage:
//   node pilot/propose-v2.mjs --root <registry-root> --trace-ids obs-...,obs-...
//
// The trace ids must already exist in the observation ledger
// (routine_observe). v1's blind labels are consumed and are never reused.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { generateFreshAudit } from './fresh-audit.mjs'

const PILOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PILOT_DIR, '..')
const ENGINE_PATH = path.join(REPO_ROOT, 'lib', 'engine.js')
const SEED_V1 = path.join(REPO_ROOT, 'seed', 'routines', 'normalize_detuning', 'v1')
const EVALUATOR_TEMPLATE = path.join(PILOT_DIR, 'v2-reference-check.mjs')
const EVALUATOR_RELATIVE = path.join('evals', 'normalize_detuning', 'v2', 'reference_check.mjs')

function parseArgs(argv) {
  const options = { root: null, traceIds: [], overwrite: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--root') options.root = argv[++index]
    else if (value === '--trace-ids') options.traceIds = String(argv[++index] ?? '').split(',').filter(Boolean)
    else if (value === '--overwrite') options.overwrite = true
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`unknown argument ${JSON.stringify(value)}`)
  }
  return options
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node pilot/propose-v2.mjs --root <registry-root> --trace-ids <id1,id2,...> [--overwrite]')
    return
  }
  if (!options.root) throw new Error('--root is required')
  if (options.traceIds.length === 0) throw new Error('--trace-ids is required (record observations with routine_observe first)')
  const root = path.resolve(options.root)

  const engine = await import(pathToFileURL(ENGINE_PATH).href)
  const generated = generateFreshAudit({ repoRoot: REPO_ROOT })
  const seedManifest = await readJson(path.join(SEED_V1, 'manifest.json'))
  const seedPrereg = await readJson(path.join(SEED_V1, 'preregistration.json'))
  const hooks = {}
  for (const name of ['guard.js', 'binding.js', 'execution.js']) {
    hooks[name] = await fsp.readFile(path.join(SEED_V1, name), 'utf8')
  }

  const manifest = {
    ...seedManifest,
    version: '2',
    execution: {
      ...seedManifest.execution,
      outputSchema: {
        ...seedManifest.execution.outputSchema,
        properties: {
          ...seedManifest.execution.outputSchema.properties,
          contractRevision: { const: 'normalize_detuning/v2' },
        },
      },
    },
    title: 'Normalize detuning to Hz (fresh evidence cycle v2)',
    summary:
      'Same read-only detuning normalization contract as v1, proposed as a new candidate with a fresh blind evidence cycle derived from observation-ledger traces.',
    contractRevision: 'normalize_detuning/v2',
    evidence: {
      ...seedManifest.evidence,
      dataClass: 'synthetic',
      realDeploymentData: false,
      routineProvenance: 'trace-derived',
      derivationTraces: [],
      evaluator: EVALUATOR_RELATIVE,
      preregistration: 'preregistration.json',
    },
  }
  delete manifest.evidence.fixtureSets
  delete manifest.evidence.blindLabels

  const preregistration = {
    ...seedPrereg,
    version: '2',
    frozenAt: '2026-11-07T23:45:00.000Z',
    decisionDate: '2026-12-15',
    nextReviewTrigger: 'model, schema or dependency change; any production fallback; 90 days; or the next evidence cycle',
    realDataAttested: false,
    reviewers: [
      {
        name: 'contract-author',
        role: 'author',
        signedAt: '2026-11-07T23:45:00.000Z',
        independent: false,
        sawLabels: false,
      },
    ],
  }

  const proposal = await engine.proposeRoutine(root, {
    id: 'normalize_detuning',
    version: '2',
    manifest,
    files: hooks,
    fixtures: { dev: generated.dev, audit: generated.audit, challenge: generated.challenge },
    preregistration,
    sourceTraceIds: options.traceIds,
    overwrite: options.overwrite,
  })

  const evaluatorPath = path.join(root, EVALUATOR_RELATIVE)
  await fsp.mkdir(path.dirname(evaluatorPath), { recursive: true })
  await fsp.copyFile(EVALUATOR_TEMPLATE, evaluatorPath)
  await fsp.chmod(evaluatorPath, 0o755)

  const candidateManifest = await readJson(path.join(proposal.directory, 'manifest.json'))
  const auditLabels = await readJson(path.join(root, candidateManifest.evidence.blindLabels.audit))
  console.log(
    JSON.stringify(
      {
        routine: proposal.routine,
        version: proposal.version,
        directory: proposal.directory,
        provenance: candidateManifest.evidence.routineProvenance,
        sourceTraces: (candidateManifest.evidence.derivationTraces ?? []).map((trace) => trace.ref),
        fixtureSets: proposal.fixtureSets,
        blindLabels: proposal.blindLabels,
        counts: {
          dev: generated.dev.length,
          audit: generated.audit.length,
          auditAccept: auditLabels.cases.filter((entry) => entry.expect.decision === 'accept').length,
          challenge: generated.challenge.length,
          challengeDefer: generated.challenge.filter((entry) => entry.expect.decision === 'defer').length,
        },
        evaluator: evaluatorPath,
        next: 'routine_evaluate routine=normalize_detuning version=2 (first blind run of the fresh label set)',
      },
      null,
      2,
    ),
  )
}

try {
  await main()
} catch (error) {
  console.error(`propose-v2: ${error?.message ?? error}`)
  process.exitCode = 1
}
