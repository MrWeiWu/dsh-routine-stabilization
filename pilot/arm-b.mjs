// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Arm B — independent, hand-written implementation of the
 * `normalize_detuning/v1` contract.
 *
 * Arm B is a scripted baseline for the paired pilot. It is written from the
 * documented contract and deliberately does NOT import:
 *   - `seed/routines/normalize_detuning/v1/{guard,binding,execution}.js`, nor
 *   - `lib/engine.js` (runtime hook loading / dispatch).
 *
 * That independence is the point: agreement between arm B (this file) and arm C
 * (the candidate routine executed through the engine) is evidence about the
 * contract, not about a shared implementation.
 *
 * Contract stages, mirrored from the documented decision order:
 *   1. input must be an object, `metadataSource` must be 'trusted-schema'
 *   2. `value` must be a finite number
 *   3. `unit` must be present and one of Hz / kHz / rad/s
 *   4. `declaredUnit` must carry a non-empty header and/or schema
 *   5. when both header and schema are present they must agree (case/space
 *      insensitive comparison)
 *   6. with a non-empty `candidates` table, `fieldId` must be explicit, must
 *      match a candidate, and the matched candidate roles must resolve to a
 *      single detuning field (never a drive field)
 *   7. without a candidates table, `fieldId` itself must be explicit
 *
 * Execution converts to Hz, sign preserved:
 *   Hz -> 1, kHz -> 1000, rad/s -> 1 / (2 * PI)
 *
 * Public entry point used by `pilot/run.mjs`:
 *   solve(input) -> { decision, reason, fieldId, sourceUnit, valueHz }
 * `decision` is 'accept' or 'defer'. For a deferral the normalized value fields
 * are null. The runner maps outcomes to `resolved` / `deferred` /
 * `fallback-unresolved`; arm B itself never invents a fallback.
 */

const SUPPORTED_UNITS = Object.freeze(['Hz', 'kHz', 'rad/s'])
const ROLE_DETUNING = 'detuning'
const ROLE_DRIVE = 'drive'
const FACTOR_BY_UNIT = Object.freeze({
  Hz: 1,
  kHz: 1000,
  'rad/s': 1 / (2 * Math.PI),
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defer(reason, details) {
  return { decision: 'defer', reason, details }
}

function accept(details) {
  return { decision: 'accept', details }
}

function normalizeUnit(unit) {
  return typeof unit === 'string' ? unit.trim().toLowerCase() : ''
}

function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    fieldId: candidate && typeof candidate.fieldId === 'string' ? candidate.fieldId : null,
    role: candidate && typeof candidate.role === 'string' ? candidate.role : null,
  }))
}

/** Stage 1 — admission guard. Mirrors the documented decision order. */
export function decide(input) {
  if (!isRecord(input)) {
    return defer('missing-metadata', { missing: 'input' })
  }

  if (input.metadataSource !== 'trusted-schema') {
    return defer('missing-metadata', {
      missing: 'metadataSource',
      metadataSource: input.metadataSource ?? null,
    })
  }

  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    return defer('invalid-value', { value: String(input.value) })
  }

  if (typeof input.unit !== 'string' || input.unit.trim() === '') {
    return defer('missing-metadata', { missing: 'unit' })
  }
  if (!SUPPORTED_UNITS.includes(input.unit)) {
    return defer('unsupported-unit', { unit: input.unit, supported: [...SUPPORTED_UNITS] })
  }

  const declared = input.declaredUnit
  if (!isRecord(declared)) {
    return defer('missing-metadata', { missing: 'declaredUnit' })
  }
  const header =
    typeof declared.header === 'string' && declared.header.trim() !== '' ? declared.header : null
  const schema =
    typeof declared.schema === 'string' && declared.schema.trim() !== '' ? declared.schema : null
  if (!header && !schema) {
    return defer('missing-metadata', { missing: 'declaredUnit.header|declaredUnit.schema' })
  }

  if (header && schema && normalizeUnit(header) !== normalizeUnit(schema)) {
    return defer('metadata-conflict', { header, schema })
  }

  const hasExplicitFieldId = typeof input.fieldId === 'string' && input.fieldId.trim() !== ''
  const candidates = Array.isArray(input.candidates) ? input.candidates : null

  if (candidates && candidates.length > 0) {
    if (!hasExplicitFieldId) {
      return defer('competing-fields', {
        fieldId: null,
        candidates: summarizeCandidates(candidates),
      })
    }
    const matched = candidates.filter(
      (candidate) => candidate && candidate.fieldId === input.fieldId,
    )
    if (matched.length === 0) {
      return defer('competing-fields', {
        fieldId: input.fieldId,
        candidates: summarizeCandidates(candidates),
      })
    }
    const roles = [...new Set(matched.map((candidate) => candidate.role))]
    if (roles.includes(ROLE_DRIVE) || !roles.includes(ROLE_DETUNING)) {
      return defer('competing-fields', { fieldId: input.fieldId, roles })
    }
    return accept({
      fieldId: input.fieldId,
      unit: input.unit,
      resolvedBy: 'candidates',
      candidateCount: candidates.length,
    })
  }

  if (!hasExplicitFieldId) {
    return defer('missing-metadata', { missing: 'fieldId' })
  }
  return accept({
    fieldId: input.fieldId,
    unit: input.unit,
    resolvedBy: 'declared-unit',
  })
}

/** Stage 2 — lossless binding of the admitted input. */
export function bind(input) {
  const verdict = decide(input)
  if (verdict.decision !== 'accept') {
    throw new Error(verdict.reason ?? 'missing-metadata')
  }
  const usedCandidates = Array.isArray(input.candidates) && input.candidates.length > 0
  return {
    fieldId: input.fieldId,
    unit: input.unit,
    value: input.value,
    source: usedCandidates ? 'candidates' : 'declared-unit',
    preservedInput: structuredClone(input),
  }
}

/** Stage 3 — convert the bound value to Hz. */
export function execute(bound) {
  if (!isRecord(bound)) {
    throw new Error('missing-metadata')
  }
  const factor = FACTOR_BY_UNIT[bound.unit]
  if (factor === undefined) {
    throw new Error('unsupported-unit')
  }
  if (typeof bound.value !== 'number' || !Number.isFinite(bound.value)) {
    throw new Error('invalid-value')
  }
  const valueHz = bound.value * factor
  if (!Number.isFinite(valueHz)) {
    throw new Error('invalid-value')
  }
  return {
    fieldId: bound.fieldId,
    sourceUnit: bound.unit,
    valueHz,
  }
}

/**
 * Full arm-B decision for one audit input.
 * @returns {{decision:'accept'|'defer', reason:string|null, fieldId:string|null, sourceUnit:string|null, valueHz:number|null}}
 */
export function solve(input) {
  const verdict = decide(input)
  if (verdict.decision !== 'accept') {
    return {
      decision: 'defer',
      reason: verdict.reason ?? 'missing-metadata',
      fieldId: null,
      sourceUnit: null,
      valueHz: null,
    }
  }
  const output = execute(bind(input))
  return {
    decision: 'accept',
    reason: null,
    fieldId: output.fieldId,
    sourceUnit: output.sourceUnit,
    valueHz: output.valueHz,
  }
}
