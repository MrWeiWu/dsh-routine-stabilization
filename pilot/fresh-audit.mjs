#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Deterministic generator for a FRESH audit/challenge label set (candidate v2).
//
// v1 already consumed its blind labels. A new candidate needs a new,
// previously unseen label set, so this generator derives one from a different
// seed. Expectations are computed by an independent reference implementation
// written here (not imported from the routine hooks or arm B), and the accept
// values are re-derived analytically by the v2 reference check.
//
// Usage:
//   node pilot/fresh-audit.mjs [--json] [--out <file>]
//
// Exports generateFreshAudit() for pilot/propose-v2.mjs.

import fs from 'node:fs'
import path from 'node:path'

const SEED = 20261110
const DEV_VERSION = 1
const UNITS = ['Hz', 'kHz', 'rad/s']
const FACTOR = { Hz: 1, kHz: 1000, 'rad/s': 1 / (2 * Math.PI) }

function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function round(value, digits = 9) {
  return Number(value.toFixed(digits))
}

function unitOf(random) {
  return UNITS[Math.floor(random() * UNITS.length)]
}

function acceptCase(random, id) {
  const unit = unitOf(random)
  const magnitude = round(0.001 + random() * 5000, 6)
  const value = round((random() < 0.5 ? -1 : 1) * magnitude, 6)
  const fieldId = ['detuning', 'probe_detuning', 'detuning_khz', 'spectroscopy_detuning'][Math.floor(random() * 4)]
  const declaredUnit = random() < 0.5 ? { header: unit, schema: unit } : { header: unit }
  const candidates =
    random() < 0.5
      ? null
      : [
          { fieldId: `drive_${fieldId}`, unit, role: 'drive' },
          { fieldId, unit, role: 'detuning' },
        ]
  const input = { value, unit, fieldId, declaredUnit, metadataSource: 'trusted-schema' }
  if (candidates) input.candidates = candidates
  const checks = {
    fieldId,
    unit: 'Hz',
    valueHz: round(value * FACTOR[unit], 12),
    absToleranceHz: 1e-9,
    relTolerance: 1e-12,
  }
  return {
    id,
    description: `fresh accept: ${unit} detuning on ${fieldId}${candidates ? ' with a drive candidate' : ''}`,
    input,
    expect: { decision: 'accept', reason: null, checks },
  }
}

function deferCase(random, id, reason) {
  const unit = unitOf(random)
  const value = round((random() < 0.5 ? -1 : 1) * (0.001 + random() * 500), 6)
  let input
  if (reason === 'invalid-value') {
    input = { value: null, unit, fieldId: 'detuning', declaredUnit: { header: unit, schema: unit }, metadataSource: 'trusted-schema' }
  } else if (reason === 'unsupported-unit') {
    input = {
      value,
      unit: ['GHz', 'MHz', 'rpm'][Math.floor(random() * 3)],
      fieldId: 'detuning',
      declaredUnit: { header: unit, schema: unit },
      metadataSource: 'trusted-schema',
    }
  } else if (reason === 'metadata-conflict') {
    const other = unit === 'Hz' ? 'kHz' : 'Hz'
    input = { value, unit, fieldId: 'detuning', declaredUnit: { header: unit, schema: other }, metadataSource: 'trusted-schema' }
  } else if (reason === 'competing-fields') {
    input = {
      value,
      unit,
      fieldId: '',
      declaredUnit: { header: unit, schema: unit },
      metadataSource: 'trusted-schema',
      candidates: [
        { fieldId: 'detuning_a', unit, role: 'detuning' },
        { fieldId: 'detuning_b', unit, role: 'detuning' },
      ],
    }
  } else {
    // missing-metadata variants
    const variant = Math.floor(random() * 4)
    if (variant === 0) input = { value, unit, fieldId: 'detuning', metadataSource: 'unverified' }
    else if (variant === 1) input = { value, unit, fieldId: 'detuning', declaredUnit: {}, metadataSource: 'trusted-schema' }
    else if (variant === 2) input = { value, unit, fieldId: '', declaredUnit: { header: unit, schema: unit }, metadataSource: 'trusted-schema' }
    else input = { value, unit: '', fieldId: 'detuning', declaredUnit: { header: unit, schema: unit }, metadataSource: 'trusted-schema' }
  }
  return {
    id,
    description: `fresh defer: ${reason}`,
    input,
    expect: { decision: 'defer', reason, checks: null },
  }
}

/** Independent reference for the fresh labels (used by the v2 evaluator too). */
export function expectedFor(input) {
  if (!input || typeof input !== 'object') return { decision: 'defer', reason: 'missing-metadata', checks: null }
  if (input.metadataSource !== 'trusted-schema') return { decision: 'defer', reason: 'missing-metadata', checks: null }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) return { decision: 'defer', reason: 'invalid-value', checks: null }
  if (typeof input.unit !== 'string' || input.unit.trim() === '') return { decision: 'defer', reason: 'missing-metadata', checks: null }
  if (!UNITS.includes(input.unit)) return { decision: 'defer', reason: 'unsupported-unit', checks: null }
  const declared = input.declaredUnit
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return { decision: 'defer', reason: 'missing-metadata', checks: null }
  const header = typeof declared.header === 'string' && declared.header.trim() !== '' ? declared.header.trim().toLowerCase() : null
  const schema = typeof declared.schema === 'string' && declared.schema.trim() !== '' ? declared.schema.trim().toLowerCase() : null
  if (header === null && schema === null) return { decision: 'defer', reason: 'missing-metadata', checks: null }
  if (header !== null && schema !== null && header !== schema) return { decision: 'defer', reason: 'metadata-conflict', checks: null }
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() !== '' ? input.fieldId : null
  const candidates = Array.isArray(input.candidates) ? input.candidates : null
  if (candidates && candidates.length > 0) {
    if (fieldId === null) return { decision: 'defer', reason: 'competing-fields', checks: null }
    const matched = candidates.filter((candidate) => candidate && candidate.fieldId === fieldId)
    if (matched.length === 0) return { decision: 'defer', reason: 'competing-fields', checks: null }
    const roles = new Set(matched.map((candidate) => candidate.role))
    if (roles.has('drive') || !roles.has('detuning')) return { decision: 'defer', reason: 'competing-fields', checks: null }
  } else if (fieldId === null) {
    return { decision: 'defer', reason: 'missing-metadata', checks: null }
  }
  return {
    decision: 'accept',
    reason: null,
    checks: {
      fieldId,
      unit: 'Hz',
      valueHz: round(input.value * FACTOR[input.unit], 12),
      absToleranceHz: 1e-9,
      relTolerance: 1e-12,
    },
  }
}

const DEFER_PLAN = [
  'missing-metadata',
  'missing-metadata',
  'missing-metadata',
  'invalid-value',
  'unsupported-unit',
  'metadata-conflict',
  'competing-fields',
  'competing-fields',
]

/** Generate dev (reused v1 development cases), a fresh 100-case audit and a
 *  fresh 40-case near-miss challenge set. */
export function generateFreshAudit({ repoRoot }) {
  const random = lcg(SEED)
  const dev = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'seed', 'fixtures', 'normalize_detuning', DEV_VERSION === 1 ? 'v1' : `v${DEV_VERSION}`, 'dev.json'), 'utf8'),
  ).cases
  const audit = []
  const challenge = []
  for (let index = 1; index <= 100; index += 1) {
    const id = `audit2-${String(index).padStart(3, '0')}`
    if (random() < 0.78) {
      audit.push(acceptCase(random, id))
    } else {
      const reason = DEFER_PLAN[Math.floor(random() * DEFER_PLAN.length)]
      audit.push(deferCase(random, id, reason))
    }
  }
  for (let index = 1; index <= 40; index += 1) {
    const id = `challenge2-${String(index).padStart(3, '0')}`
    if (index <= 6) {
      // A few tricky-but-solvable near-misses must still be accepted correctly.
      challenge.push(acceptCase(random, id))
    } else {
      const reason = DEFER_PLAN[Math.floor(random() * DEFER_PLAN.length)]
      challenge.push(deferCase(random, id, reason))
    }
  }
  // Cross-check every generated expectation with the independent reference.
  for (const fixtureCase of [...audit, ...challenge]) {
    const reference = expectedFor(fixtureCase.input)
    if (reference.decision !== fixtureCase.expect.decision || reference.reason !== fixtureCase.expect.reason) {
      throw new Error(`${fixtureCase.id}: generator expectation disagrees with the independent reference`)
    }
  }
  const acceptCount = audit.filter((entry) => entry.expect.decision === 'accept').length
  if (acceptCount < 59) throw new Error(`fresh audit has only ${acceptCount} accept cases; the zero-event gate needs >= 59 automatic results`)
  return { seed: SEED, dev, audit, challenge, acceptCount }
}

function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const generated = generateFreshAudit({ repoRoot })
  const summary = {
    seed: generated.seed,
    dev: generated.dev.length,
    audit: generated.audit.length,
    auditAccept: generated.acceptCount,
    challenge: generated.challenge.length,
    challengeDefer: generated.challenge.filter((entry) => entry.expect.decision === 'defer').length,
  }
  const outIndex = process.argv.indexOf('--out')
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[outIndex + 1]), JSON.stringify({ ...generated, summary }, null, 2))
    console.log(`wrote fresh audit set to ${process.argv[outIndex + 1]}`)
  } else {
    console.log(JSON.stringify(summary, null, 2))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(`fresh-audit: ${error.message}`)
    process.exitCode = 1
  }
}
