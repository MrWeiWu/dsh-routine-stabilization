// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Independent reference check for a fresh (v2) evidence cycle.
//
// Run by the engine as a subprocess with ROUTINE_ROOT set. It imports no
// runtime hooks: it re-derives every expected accept value from the raw input
// and verifies that the readable fixture inputs carry no labels, that the blind
// labels carry no inputs, and that the case counts match the preregistration.
//
// Exit code 0 = passed. Any mismatch exits 1 with a message.

import fs from 'node:fs'
import path from 'node:path'

const UNITS = ['Hz', 'kHz', 'rad/s']
const FACTOR = { Hz: 1, kHz: 1000, 'rad/s': 1 / (2 * Math.PI) }
const FAILURES = []

function fail(message) {
  FAILURES.push(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function resolve(root, relative) {
  const direct = path.resolve(root, relative)
  if (fs.existsSync(direct)) return direct
  throw new Error(`evidence file not found: ${relative}`)
}

function expectedFor(input) {
  if (!input || typeof input !== 'object') return { decision: 'defer', reason: 'missing-metadata' }
  if (input.metadataSource !== 'trusted-schema') return { decision: 'defer', reason: 'missing-metadata' }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) return { decision: 'defer', reason: 'invalid-value' }
  if (typeof input.unit !== 'string' || input.unit.trim() === '') return { decision: 'defer', reason: 'missing-metadata' }
  if (!UNITS.includes(input.unit)) return { decision: 'defer', reason: 'unsupported-unit' }
  const declared = input.declaredUnit
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return { decision: 'defer', reason: 'missing-metadata' }
  const header = typeof declared.header === 'string' && declared.header.trim() !== '' ? declared.header.trim().toLowerCase() : null
  const schema = typeof declared.schema === 'string' && declared.schema.trim() !== '' ? declared.schema.trim().toLowerCase() : null
  if (header === null && schema === null) return { decision: 'defer', reason: 'missing-metadata' }
  if (header !== null && schema !== null && header !== schema) return { decision: 'defer', reason: 'metadata-conflict' }
  const fieldId = typeof input.fieldId === 'string' && input.fieldId.trim() !== '' ? input.fieldId : null
  const candidates = Array.isArray(input.candidates) ? input.candidates : null
  if (candidates && candidates.length > 0) {
    if (fieldId === null) return { decision: 'defer', reason: 'competing-fields' }
    const matched = candidates.filter((candidate) => candidate && candidate.fieldId === fieldId)
    if (matched.length === 0) return { decision: 'defer', reason: 'competing-fields' }
    const roles = new Set(matched.map((candidate) => candidate.role))
    if (roles.has('drive') || !roles.has('detuning')) return { decision: 'defer', reason: 'competing-fields' }
  } else if (fieldId === null) {
    return { decision: 'defer', reason: 'missing-metadata' }
  }
  return { decision: 'accept', reason: null, valueHz: input.value * FACTOR[input.unit], fieldId }
}

function checkSet(root, manifest, set, expectedCount) {
  const inputs = readJson(resolve(root, manifest.evidence.fixtureSets[set]))
  const blind = set !== 'dev'
  const labels = blind ? readJson(resolve(root, manifest.evidence.blindLabels[set])) : null
  assert(inputs.cases.length === expectedCount, `${set}: expected ${expectedCount} cases, got ${inputs.cases.length}`)
  assert(inputs.cases.every((entry) => entry.input), `${set}: every case needs an input`)
  if (blind) assert(inputs.cases.every((entry) => entry.expect === undefined), `${set}: readable inputs must not carry expectations`)
  const labelById = new Map((labels?.cases ?? []).map((entry) => [entry.id, entry.expect]))
  if (labels) {
    assert(labels.cases.every((entry) => entry.expect && entry.input === undefined), `${set}: labels must not carry inputs`)
    assert(labels.cases.length === inputs.cases.length, `${set}: label and input counts differ`)
  }
  for (const fixtureCase of inputs.cases) {
    const expect = labels ? labelById.get(fixtureCase.id) : fixtureCase.expect
    assert(Boolean(expect), `${set}/${fixtureCase.id}: missing expectation`)
    if (!expect) continue
    const reference = expectedFor(fixtureCase.input)
    assert(reference.decision === expect.decision, `${set}/${fixtureCase.id}: decision ${expect.decision} != reference ${reference.decision}`)
    assert(reference.reason === expect.reason, `${set}/${fixtureCase.id}: reason ${expect.reason} != reference ${reference.reason}`)
    if (expect.decision === 'accept') {
      const checks = expect.checks ?? {}
      assert(reference.fieldId === checks.fieldId, `${set}/${fixtureCase.id}: field id mismatch`)
      const difference = Math.abs(reference.valueHz - checks.valueHz)
      const allowed = (checks.absToleranceHz ?? 1e-9) + (checks.relTolerance ?? 1e-12) * Math.abs(checks.valueHz)
      assert(difference <= allowed, `${set}/${fixtureCase.id}: value ${reference.valueHz} outside tolerance of ${checks.valueHz}`)
      assert((checks.unit ?? 'Hz') === 'Hz', `${set}/${fixtureCase.id}: expected unit must be Hz`)
    }
  }
  return inputs.cases.length
}

function main() {
  const root = process.env.ROUTINE_ROOT
  if (!root) throw new Error('ROUTINE_ROOT is required')
  const routineDirectory = path.join(root, 'routines', process.env.ROUTINE_ID ?? '', process.env.ROUTINE_VERSION ?? '')
  const manifest = readJson(path.join(routineDirectory, 'manifest.json'))
  const prereg = readJson(path.join(routineDirectory, 'preregistration.json'))
  assert(manifest.id === process.env.ROUTINE_ID, 'manifest id does not match ROUTINE_ID')
  assert(String(manifest.version) === String(process.env.ROUTINE_VERSION), 'manifest version does not match ROUTINE_VERSION')
  assert(manifest.evidence.routineProvenance === 'trace-derived', 'v2 evidence must be trace-derived')
  const observed = (manifest.evidence.derivationTraces ?? []).filter((trace) => trace.kind === 'observed-request')
  assert(observed.length > 0, 'v2 must record observed-request derivation traces')
  const audit = checkSet(root, manifest, 'audit', 100)
  const challenge = checkSet(root, manifest, 'challenge', 40)
  checkSet(root, manifest, 'dev', 30)
  const auditLabels = readJson(resolve(root, manifest.evidence.blindLabels.audit))
  const accept = auditLabels.cases.filter((entry) => entry.expect.decision === 'accept').length
  assert(accept >= 59, `audit: expected at least 59 accept cases, got ${accept}`)
  assert(challenge === 40, 'challenge count mismatch')
  assert(Number.isFinite(prereg.thresholds?.challengeSize), 'preregistration thresholds missing')
  if (FAILURES.length > 0) {
    console.error('V2 REFERENCE CHECK FAILED')
    for (const failure of FAILURES) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log(`V2 REFERENCE CHECK PASSED (audit ${audit}, challenge ${challenge}, accept ${accept}, observed traces ${observed.length})`)
}

try {
  main()
} catch (error) {
  console.error(`V2 REFERENCE CHECK FAILED: ${error.message}`)
  process.exit(1)
}
