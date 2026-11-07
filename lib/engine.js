// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Evaluation and runtime engine (v0.2).
//
// Runtime path (framework page 3): resolve the field and its provenance, check
// applicability, run the conversion, then validate the output against the
// declared output schema. A failed check discards the provisional result and
// invokes the declared fallback. A deferral has a reason, and both the route and
// the reason are logged.
//
// Evaluation path (framework pages 4-6): preregistration must be frozen first,
// blind labels live outside the readable evidence tree, the first run per audit
// label set is the only one that may gate a release, and reports keep
// denominators before averages. Per-case scoring detail is written to a
// protected file; the public report never carries blind labels or correctness.

import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import * as stats from './stats.js'
import * as store from './store.js'

const DEFAULT_COVERAGE_FLOOR = 0.6
const DEFAULT_SILENT_ERROR_CEILING = 0.05
const DEFAULT_CHALLENGE_SIZE = 40
const DECISION_SETS = ['dev', 'audit', 'challenge']
const BLIND_SETS = ['audit', 'challenge']
const REPORT_SCHEMA_VERSION = 2
const DATA_CLASSES = ['synthetic', 'contract-derived', 'trace-derived', 'deployment']

const POSTCONDITIONS = {
  'finite-output': (context) => ({
    ok: Number.isFinite(context.output.valueHz),
    detail: Number.isFinite(context.output.valueHz) ? 'valueHz is finite' : 'valueHz is not a finite number',
  }),
  'preserve-field-id': (context) => ({
    ok: typeof context.output.fieldId === 'string' && context.output.fieldId === context.bound.fieldId,
    detail: `bound field ${context.bound.fieldId} echoed as ${context.output.fieldId}`,
  }),
  'unit-hz': (context) => ({
    ok: context.output.unit === 'Hz',
    detail: `output unit is ${context.output.unit}`,
  }),
  'sign-preserved': (context) => ({
    ok: Math.sign(context.output.valueHz) === Math.sign(context.bound.value) || context.output.valueHz === 0,
    detail: `sign(${context.bound.value}) vs sign(${context.output.valueHz})`,
  }),
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validation (the subset manifests may use)
// ---------------------------------------------------------------------------

export function validateJsonSchema(schema, value) {
  const errors = []
  function check(node, current, pointer) {
    if (!node || typeof node !== 'object') return
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type]
      const actual = current === null ? 'null' : Array.isArray(current) ? 'array' : Number.isInteger(current) ? 'integer' : typeof current
      const matches = types.some((type) => {
        if (type === 'integer') return Number.isInteger(current)
        if (type === 'number') return typeof current === 'number' && Number.isFinite(current)
        if (type === 'object') return current !== null && typeof current === 'object' && !Array.isArray(current)
        return type === actual
      })
      if (!matches) {
        errors.push(`${pointer}: expected ${types.join('|')}, got ${actual}`)
        return
      }
    }
    if (Array.isArray(node.enum)) {
      const serialized = JSON.stringify(current)
      if (!node.enum.some((candidate) => JSON.stringify(candidate) === serialized)) {
        errors.push(`${pointer}: value is not in enum`)
      }
    }
    if (node.const !== undefined && JSON.stringify(node.const) !== JSON.stringify(current)) {
      errors.push(`${pointer}: value does not equal const`)
    }
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      for (const required of node.required ?? []) {
        if (!(required in current)) errors.push(`${pointer}.${required}: required property is missing`)
      }
      const properties = node.properties ?? {}
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in current) check(subSchema, current[key], `${pointer}.${key}`)
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) {
          if (!(key in properties)) errors.push(`${pointer}.${key}: unexpected property`)
        }
      }
    }
    if (Array.isArray(current) && node.items) {
      current.forEach((item, index) => check(node.items, item, `${pointer}[${index}]`))
    }
  }
  check(schema, value, '$')
  return errors
}

function outputSchemaOf(manifest) {
  const declared = manifest.execution?.outputSchema
  if (!declared || typeof declared !== 'object') return null
  if (Array.isArray(declared.requiredFields) && declared.type === undefined) {
    return { type: 'object', required: declared.requiredFields }
  }
  return declared
}

// ---------------------------------------------------------------------------
// Manifest and preregistration validation
// ---------------------------------------------------------------------------

export function validateManifest(manifest) {
  const issues = []
  const requireField = (condition, message) => {
    if (!condition) issues.push(message)
  }
  requireField(manifest && typeof manifest === 'object', 'manifest must be an object')
  if (!manifest || typeof manifest !== 'object') return issues
  requireField(manifest.schemaVersion === 1, 'schemaVersion must be 1')
  requireField(typeof manifest.id === 'string' && manifest.id.length > 0, 'id is required')
  requireField(typeof manifest.version === 'string' || typeof manifest.version === 'number', 'version is required')
  requireField(typeof manifest.contractRevision === 'string', 'contractRevision is required')
  requireField(typeof manifest.title === 'string', 'title is required')
  requireField(Array.isArray(manifest.allowedEffects), 'allowedEffects must be an array')
  requireField(manifest.allowedEffects?.includes('read-only'), 'the pilot contract is read-only; allowedEffects must include "read-only"')
  requireField(typeof manifest.admission?.predicate === 'string', 'admission.predicate is required')
  requireField(typeof manifest.binding?.entry === 'string', 'binding.entry is required')
  requireField(typeof manifest.execution?.entry === 'string', 'execution.entry is required')
  requireField(manifest.execution?.outputSchema && typeof manifest.execution.outputSchema === 'object', 'execution.outputSchema is required')
  requireField(Array.isArray(manifest.postconditions) && manifest.postconditions.length > 0, 'postconditions must be a non-empty array')
  for (const postcondition of manifest.postconditions ?? []) {
    requireField(typeof postcondition.id === 'string', 'each postcondition needs an id')
    requireField(POSTCONDITIONS[postcondition.id] !== undefined, `unknown postcondition id: ${postcondition.id}`)
  }
  const evidence = manifest.evidence
  const fixtureSets = evidence?.fixtureSets
  requireField(fixtureSets && DECISION_SETS.every((set) => typeof fixtureSets[set] === 'string'), 'evidence.fixtureSets must define dev, audit and challenge')
  requireField(typeof evidence?.evaluator === 'string', 'evidence.evaluator is required')
  requireField(typeof evidence?.preregistration === 'string', 'evidence.preregistration is required')
  requireField(DATA_CLASSES.includes(evidence?.dataClass), `evidence.dataClass must be one of ${DATA_CLASSES.join(', ')}`)
  requireField(typeof evidence?.realDeploymentData === 'boolean', 'evidence.realDeploymentData must be a boolean')
  requireField(Array.isArray(evidence?.derivationTraces), 'evidence.derivationTraces must be an array')
  if (evidence?.dataClass === 'trace-derived' && (evidence?.derivationTraces ?? []).length === 0) {
    issues.push('a trace-derived routine must record at least one derivation trace with its source trace id')
  }
  for (const set of BLIND_SETS) {
    requireField(typeof evidence?.blindLabels?.[set] === 'string', `evidence.blindLabels.${set} is required (labels must be separate from inputs)`)
  }
  requireField(manifest.fallback && typeof manifest.fallback === 'object', 'fallback is required')
  requireField(manifest.errorPolicy && typeof manifest.errorPolicy === 'object', 'errorPolicy is required')
  return issues
}

function validatePreregistration(value, manifest) {
  const issues = []
  const requireField = (condition, message) => {
    if (!condition) issues.push(message)
  }
  requireField(value && typeof value === 'object', 'preregistration must be an object')
  if (!value || typeof value !== 'object') return issues
  requireField(value.schemaVersion === 1, 'preregistration.schemaVersion must be 1')
  requireField(value.routine === manifest.id, 'preregistration.routine must match manifest.id')
  requireField(String(value.version) === String(manifest.version), 'preregistration.version must match manifest.version')
  for (const field of ['frozenAt', 'population', 'samplingUnit', 'exclusions', 'decisionDate', 'nextReviewTrigger']) {
    requireField(typeof value[field] === 'string' && value[field].trim() !== '', `preregistration.${field} is required`)
  }
  const thresholds = value.thresholds
  requireField(thresholds && typeof thresholds === 'object', 'preregistration.thresholds is required')
  if (thresholds && typeof thresholds === 'object') {
    requireField(Number.isFinite(thresholds.coverageFloor), 'thresholds.coverageFloor must be a number')
    requireField(Number.isFinite(thresholds.silentErrorCeiling), 'thresholds.silentErrorCeiling must be a number')
    requireField(Number.isFinite(thresholds.challengeSize), 'thresholds.challengeSize must be a number')
    if (thresholds.challengeIncorrectAutomatic !== undefined) {
      requireField(Number.isFinite(thresholds.challengeIncorrectAutomatic), 'thresholds.challengeIncorrectAutomatic must be a number')
    }
  }
  const workload = value.workload
  requireField(workload && typeof workload === 'object', 'preregistration.workload is required')
  if (workload && typeof workload === 'object') {
    requireField(Number.isFinite(workload.requests), 'workload.requests must be a number')
    requireField(Number.isFinite(workload.horizonDays), 'workload.horizonDays must be a number')
    requireField(Number.isFinite(workload.perRequestBudgetMs), 'workload.perRequestBudgetMs must be a number')
  }
  requireField(typeof value.realDataAttested === 'boolean', 'preregistration.realDataAttested must be a boolean')
  requireField(Array.isArray(value.reviewers) && value.reviewers.length > 0, 'preregistration.reviewers must be a non-empty array')
  for (const reviewer of value.reviewers ?? []) {
    requireField(reviewer && typeof reviewer === 'object', 'each reviewer must be an object')
    if (!reviewer || typeof reviewer !== 'object') continue
    requireField(typeof reviewer.name === 'string' && reviewer.name.trim() !== '', 'reviewer.name is required')
    requireField(['author', 'domain-reviewer'].includes(reviewer.role), 'reviewer.role must be author or domain-reviewer')
    requireField(typeof reviewer.signedAt === 'string' && reviewer.signedAt.trim() !== '', 'reviewer.signedAt is required')
    requireField(typeof reviewer.independent === 'boolean', 'reviewer.independent must be a boolean')
    requireField(typeof reviewer.sawLabels === 'boolean', 'reviewer.sawLabels must be a boolean')
  }
  return issues
}

async function readPreregistration(root, routineDirectory, manifest) {
  const declared = manifest.evidence?.preregistration
  const relative = typeof declared === 'string' ? declared : 'preregistration.json'
  const resolved = path.resolve(routineDirectory, relative)
  try {
    const value = JSON.parse(await fsp.readFile(resolved, 'utf8'))
    const sha256 = await store.sha256File(resolved)
    const issues = validatePreregistration(value, manifest)
    return { path: relative, resolved, value, sha256, issues, ok: issues.length === 0 }
  } catch (error) {
    return { path: relative, resolved, value: null, sha256: null, issues: [`preregistration is unreadable: ${error.message}`], ok: false }
  }
}

function thresholdsOf(preregistration) {
  const thresholds = preregistration?.value?.thresholds ?? {}
  return {
    coverageFloor: Number.isFinite(thresholds.coverageFloor) ? thresholds.coverageFloor : DEFAULT_COVERAGE_FLOOR,
    silentErrorCeiling: Number.isFinite(thresholds.silentErrorCeiling) ? thresholds.silentErrorCeiling : DEFAULT_SILENT_ERROR_CEILING,
    challengeSize: Number.isFinite(thresholds.challengeSize) ? thresholds.challengeSize : DEFAULT_CHALLENGE_SIZE,
    challengeIncorrectAutomatic: Number.isFinite(thresholds.challengeIncorrectAutomatic) ? thresholds.challengeIncorrectAutomatic : 0,
  }
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

function evidenceHashOf({ manifestSha256, hookHashes, fixtureHashes, labelHashes, preregistrationSha256 }) {
  return store.sha256Value({ manifestSha256, hookHashes, fixtureHashes, labelHashes, preregistrationSha256 })
}

async function collectEvidence(root, routineDirectory, manifest) {
  const manifestPath = path.join(routineDirectory, 'manifest.json')
  const manifestSha256 = await store.sha256File(manifestPath)
  const hooks = {}
  for (const [label, entry] of [
    ['admission', manifest.admission?.predicate],
    ['binding', manifest.binding?.entry],
    ['execution', manifest.execution?.entry],
  ]) {
    if (typeof entry !== 'string') continue
    const [relative] = entry.split('#')
    hooks[label] = { file: relative, sha256: await store.sha256File(path.resolve(routineDirectory, relative)) }
  }
  const fixtureSets = {}
  for (const set of DECISION_SETS) {
    const relative = manifest.evidence?.fixtureSets?.[set]
    const resolved = await store.resolveEvidencePath(root, routineDirectory, relative)
    fixtureSets[set] = { path: relative, resolved, sha256: await store.sha256File(resolved) }
  }
  const blindLabels = {}
  for (const set of BLIND_SETS) {
    const relative = manifest.evidence?.blindLabels?.[set]
    if (typeof relative !== 'string') {
      blindLabels[set] = { path: null, resolved: null, sha256: null }
      continue
    }
    try {
      const resolved = await store.resolveEvidencePath(root, routineDirectory, relative)
      blindLabels[set] = { path: relative, resolved, sha256: await store.sha256File(resolved) }
    } catch {
      blindLabels[set] = { path: relative, resolved: null, sha256: null }
    }
  }
  let preregistration = { path: null, resolved: null, sha256: null }
  if (typeof manifest.evidence?.preregistration === 'string') {
    try {
      const resolved = path.resolve(routineDirectory, manifest.evidence.preregistration)
      await fsp.access(resolved)
      preregistration = { path: manifest.evidence.preregistration, resolved, sha256: await store.sha256File(resolved) }
    } catch {
      // recorded as missing above
    }
  }
  let evaluator = null
  if (typeof manifest.evidence?.evaluator === 'string') {
    try {
      const resolved = await store.resolveEvidencePath(root, routineDirectory, manifest.evidence.evaluator)
      evaluator = { path: manifest.evidence.evaluator, resolved, sha256: await store.sha256File(resolved) }
    } catch {
      evaluator = { path: manifest.evidence.evaluator, resolved: null, sha256: null }
    }
  }
  const caseSetHash = store.sha256Value({
    fixtures: Object.fromEntries(Object.entries(fixtureSets).map(([set, value]) => [set, value.sha256])),
    labels: Object.fromEntries(Object.entries(blindLabels).map(([set, value]) => [set, value.sha256])),
  })
  const evidenceHash = evidenceHashOf({
    manifestSha256,
    hookHashes: hooks,
    fixtureHashes: fixtureSets,
    labelHashes: blindLabels,
    preregistrationSha256: preregistration.sha256,
  })
  return { schemaVersion: 2, manifestSha256, hooks, fixtureSets, blindLabels, preregistration, evaluator, caseSetHash, evidenceHash }
}

// ---------------------------------------------------------------------------
// Case execution (shared by runtime and evaluation; evaluation does not log)
// ---------------------------------------------------------------------------

function deferReasonOf(error, manifest) {
  const message = String(error?.code ?? error?.message ?? '')
  const [head] = message.split(':')
  const known = manifest.admission?.deferReasons ?? {}
  if (Object.keys(known).includes(head)) return head
  return null
}

export async function runCase({ root, id, version, input, manifest, hooks, routineDirectory }) {
  const startedAt = process.hrtime.bigint()
  const finish = (fields) => {
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    return { latencyMs, input, ...fields }
  }
  let bound
  try {
    bound = await hooks.binding.fn(input)
    if (!bound || typeof bound !== 'object') throw Object.assign(new Error('invalid-binding'), { code: 'invalid-binding' })
  } catch (error) {
    const reason = deferReasonOf(error, manifest)
    if (reason) return finish({ decision: 'defer', reason, disposition: 'deferred', bound: null, output: null, checks: null, error: reason })
    return finish({ decision: 'fallback', reason: 'binding-error', disposition: 'fallback', bound: null, output: null, checks: null, error: String(error?.message ?? error) })
  }

  let admission
  try {
    admission = await hooks.guard.fn(input)
  } catch (error) {
    const reason = deferReasonOf(error, manifest)
    if (reason) return finish({ decision: 'defer', reason, disposition: 'deferred', bound, output: null, checks: null, error: reason })
    return finish({ decision: 'fallback', reason: 'guard-error', disposition: 'fallback', bound, output: null, checks: null, error: String(error?.message ?? error) })
  }
  if (admission?.decision !== 'accept') {
    const reason = typeof admission?.reason === 'string' ? admission.reason : 'deferred'
    return finish({ decision: 'defer', reason, disposition: 'deferred', bound, output: null, checks: null, error: null })
  }

  let provisional
  try {
    provisional = await hooks.execution.fn(bound)
  } catch (error) {
    return finish({ decision: 'fallback', reason: 'execution-error', disposition: 'fallback', bound, output: null, checks: null, error: String(error?.message ?? error) })
  }

  const output = {
    fieldId: provisional?.fieldId ?? bound.fieldId,
    unit: provisional?.unit ?? 'Hz',
    sourceUnit: provisional?.sourceUnit ?? bound.unit,
    valueHz: provisional?.valueHz,
    contractRevision: manifest.contractRevision,
  }
  const checks = []
  for (const postcondition of manifest.postconditions ?? []) {
    const evaluate = POSTCONDITIONS[postcondition.id]
    if (!evaluate) {
      checks.push({ id: postcondition.id, ok: false, detail: 'unknown postcondition' })
      continue
    }
    checks.push({ id: postcondition.id, ...evaluate({ output, bound }) })
  }
  const schema = outputSchemaOf(manifest)
  if (schema) {
    const schemaErrors = validateJsonSchema(schema, output)
    checks.push({ id: 'output-schema', ok: schemaErrors.length === 0, detail: schemaErrors.length === 0 ? 'output matches declared schema' : schemaErrors.join('; ') })
  }
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    return finish({ decision: 'fallback', reason: `postcondition:${failed[0].id}`, disposition: 'fallback', bound, output: null, checks, error: failed[0].detail })
  }
  return finish({ decision: 'accept', reason: null, disposition: 'served-auto', bound, output, checks, error: null })
}

// ---------------------------------------------------------------------------
// Expected-vs-actual scoring
// ---------------------------------------------------------------------------

function toleranceOf(expected) {
  const checks = expected?.checks ?? {}
  const absolute = Number.isFinite(checks.absToleranceHz) ? checks.absToleranceHz : 1e-9
  const relative = Number.isFinite(checks.relTolerance) ? checks.relTolerance : 1e-12
  return { absolute, relative }
}

export function scoreCase(expected, actual) {
  const expectedDecision = expected?.decision
  if (expectedDecision === 'accept') {
    if (actual.decision === 'accept') {
      const checks = expected.checks ?? {}
      const tolerance = toleranceOf(expected)
      const reference = checks.valueHz
      const difference = Math.abs(actual.output.valueHz - reference)
      const allowed = tolerance.absolute + tolerance.relative * Math.abs(reference)
      const fieldOk = actual.output.fieldId === checks.fieldId
      const unitOk = actual.output.unit === (checks.unit ?? 'Hz')
      const valueOk = Number.isFinite(actual.output.valueHz) && difference <= allowed
      const correct = fieldOk && unitOk && valueOk
      return {
        expected: 'accept',
        decision: actual.decision,
        correct,
        e2eSuccess: correct,
        silentError: !correct,
        challengeIncorrectAutomatic: !correct,
        reasonMatch: null,
        fieldOk,
        unitOk,
        valueOk,
        difference,
        allowed,
      }
    }
    return {
      expected: 'accept',
      decision: actual.decision,
      correct: false,
      e2eSuccess: false,
      silentError: false,
      challengeIncorrectAutomatic: false,
      needlessDeferral: actual.decision === 'defer',
      reasonMatch: null,
    }
  }
  if (actual.decision === 'accept') {
    return {
      expected: 'defer',
      decision: actual.decision,
      correct: false,
      e2eSuccess: false,
      silentError: true,
      challengeIncorrectAutomatic: true,
      needlessDeferral: false,
      reasonMatch: false,
    }
  }
  if (actual.decision === 'defer') {
    const reasonMatch = expected.reason === null || expected.reason === undefined || actual.reason === expected.reason
    return {
      expected: 'defer',
      decision: actual.decision,
      correct: reasonMatch,
      e2eSuccess: reasonMatch,
      silentError: false,
      challengeIncorrectAutomatic: false,
      needlessDeferral: false,
      reasonMatch,
      expectedReason: expected.reason ?? null,
      actualReason: actual.reason,
    }
  }
  return {
    expected: 'defer',
    decision: actual.decision,
    correct: false,
    e2eSuccess: false,
    silentError: false,
    challengeIncorrectAutomatic: false,
    needlessDeferral: false,
    reasonMatch: false,
  }
}

/** Score one raw arm decision (no output object) against an expectation. */
export function scoreRawDecision(expected, raw) {
  if (!raw || typeof raw !== 'object') {
    return { correct: false, e2eSuccess: false, silentError: false, challengeIncorrectAutomatic: false, needlessDeferral: false, reasonMatch: false }
  }
  if (expected?.decision === 'accept') {
    if (raw.decision === 'accept') {
      const checks = expected.checks ?? {}
      const tolerance = toleranceOf(expected)
      const reference = Number(checks.valueHz)
      const value = Number(raw.valueHz)
      const difference = Number.isFinite(value) && Number.isFinite(reference) ? Math.abs(value - reference) : NaN
      const allowed = tolerance.absolute + tolerance.relative * Math.abs(reference)
      const fieldOk = raw.fieldId === checks.fieldId
      const valueOk = Number.isFinite(value) && Number.isFinite(reference) && difference <= allowed
      const correct = fieldOk && valueOk
      return {
        correct,
        e2eSuccess: correct,
        silentError: !correct,
        challengeIncorrectAutomatic: !correct,
        needlessDeferral: false,
        reasonMatch: null,
        fieldOk,
        valueOk,
        difference,
        allowed,
      }
    }
    return {
      correct: false,
      e2eSuccess: false,
      silentError: false,
      challengeIncorrectAutomatic: false,
      needlessDeferral: raw.decision === 'defer',
      reasonMatch: null,
    }
  }
  if (raw.decision === 'accept') {
    return { correct: false, e2eSuccess: false, silentError: true, challengeIncorrectAutomatic: true, needlessDeferral: false, reasonMatch: false }
  }
  if (raw.decision === 'defer') {
    const reasonMatch = expected?.reason === null || expected?.reason === undefined || raw.reason === expected.reason
    return { correct: reasonMatch, e2eSuccess: reasonMatch, silentError: false, challengeIncorrectAutomatic: false, needlessDeferral: false, reasonMatch }
  }
  return { correct: false, e2eSuccess: false, silentError: false, challengeIncorrectAutomatic: false, needlessDeferral: false, reasonMatch: false }
}

function summarizeSet(setName, outcomes, options = {}) {
  const budgetMs = Number.isFinite(options.perRequestBudgetMs) ? options.perRequestBudgetMs : null
  const automatic = outcomes.filter((outcome) => outcome.scored.decision === 'accept')
  const deferred = outcomes.filter((outcome) => outcome.scored.decision === 'defer')
  const fallback = outcomes.filter((outcome) => outcome.scored.decision === 'fallback')
  const acceptedCorrect = automatic.filter((outcome) => outcome.scored.correct)
  const acceptedWrong = automatic.filter((outcome) => !outcome.scored.correct)
  const overBudget = automatic.filter((outcome) => budgetMs !== null && outcome.scored.latencyMs > budgetMs)
  const e2eSuccess = outcomes.filter((outcome) => {
    if (!outcome.scored.e2eSuccess) return false
    if (budgetMs !== null && outcome.scored.decision === 'accept' && outcome.scored.latencyMs > budgetMs) return false
    return true
  })
  const challengeIncorrectAutomatic = outcomes.filter((outcome) => outcome.scored.challengeIncorrectAutomatic)
  return {
    set: setName,
    total: outcomes.length,
    automatic: automatic.length,
    deferred: deferred.length,
    fallback: fallback.length,
    acceptedCorrect: acceptedCorrect.length,
    acceptedWrong: acceptedWrong.length,
    silentErrors: acceptedWrong.length,
    incorrectAutomatic: acceptedWrong.length,
    challengeIncorrectAutomatic: challengeIncorrectAutomatic.length,
    coverage: stats.ratio(automatic.length, outcomes.length),
    e2eSuccess: stats.ratio(e2eSuccess.length, outcomes.length),
    e2eSuccessCount: e2eSuccess.length,
    overBudgetCases: overBudget.length,
    needlessDeferrals: outcomes.filter((outcome) => outcome.scored.needlessDeferral).length,
    fallbackResolved: outcomes.filter((outcome) => outcome.scored.decision === 'fallback' && outcome.scored.e2eSuccess).length,
    deferralReasons: stats.histogram(deferred.map((outcome) => outcome.scored.actualReason ?? outcome.scored.reason ?? 'unclassified')),
    latency: stats.latencySummary(outcomes.map((outcome) => outcome.scored.latencyMs)),
  }
}

// ---------------------------------------------------------------------------
// Fixture loading (v2 blind layout, with legacy inline compatibility)
// ---------------------------------------------------------------------------

async function loadFixtureSet(root, routineDirectory, manifest, set) {
  const relative = manifest.evidence?.fixtureSets?.[set]
  if (!relative) throw new Error(`manifest does not declare the ${set} fixture set`)
  const resolvedInputs = await store.resolveEvidencePath(root, routineDirectory, relative)
  const inputsDoc = JSON.parse(await fsp.readFile(resolvedInputs, 'utf8'))
  if (!Array.isArray(inputsDoc.cases)) throw new Error(`${relative} has no cases array`)
  const inputsSha256 = await store.sha256File(resolvedInputs)
  const provenance = inputsDoc.provenance ?? 'unknown'
  const frozenAt = inputsDoc.frozenAt ?? null
  const inlineLabels = inputsDoc.cases.every((fixtureCase) => fixtureCase.expect !== undefined)

  if (set === 'dev' || inlineLabels) {
    for (const fixtureCase of inputsDoc.cases) {
      if (typeof fixtureCase.id !== 'string' || !fixtureCase.input || !fixtureCase.expect) {
        throw new Error(`${relative} case ${fixtureCase.id ?? '<unknown>'} needs id, input and expect`)
      }
      if (!['accept', 'defer'].includes(fixtureCase.expect.decision)) {
        throw new Error(`${relative} case ${fixtureCase.id} expect.decision must be accept or defer`)
      }
    }
    return {
      set,
      cases: inputsDoc.cases,
      provenance,
      frozenAt,
      labelMode: set === 'dev' ? 'inline' : 'inline-legacy',
      labelProtection: set === 'dev' ? 'not-applicable' : 'missing',
      resolvedInputs,
      inputsSha256,
      resolvedLabels: null,
      labelsSha256: null,
    }
  }

  const labelsRelative = manifest.evidence?.blindLabels?.[set]
  if (typeof labelsRelative !== 'string') {
    throw new Error(`${set} labels are not declared under evidence.blindLabels; blind labels must live outside the readable fixture tree`)
  }
  const resolvedLabels = await store.resolveEvidencePath(root, routineDirectory, labelsRelative)
  const labelsDoc = JSON.parse(await fsp.readFile(resolvedLabels, 'utf8'))
  if (!Array.isArray(labelsDoc.cases)) throw new Error(`${labelsRelative} has no cases array`)
  const labelMap = new Map()
  for (const labelCase of labelsDoc.cases) {
    if (typeof labelCase.id !== 'string' || !labelCase.expect) throw new Error(`${labelsRelative} case ${labelCase.id ?? '<unknown>'} needs id and expect`)
    if (!['accept', 'defer'].includes(labelCase.expect.decision)) throw new Error(`${labelsRelative} case ${labelCase.id} expect.decision must be accept or defer`)
    labelMap.set(labelCase.id, labelCase.expect)
  }
  const cases = inputsDoc.cases.map((fixtureCase) => {
    const expect = labelMap.get(fixtureCase.id)
    if (!expect) throw new Error(`${set} input ${fixtureCase.id} has no matching label`)
    labelMap.delete(fixtureCase.id)
    return { id: fixtureCase.id, description: fixtureCase.description, input: fixtureCase.input, expect }
  })
  if (labelMap.size > 0) throw new Error(`${set} labels contain cases without inputs: ${[...labelMap.keys()].join(', ')}`)
  const labelsSha256 = await store.sha256File(resolvedLabels)
  const labelsStat = await fsp.stat(resolvedLabels)
  const labelsWorldReadable = (labelsStat.mode & 0o077) !== 0
  return {
    set,
    cases,
    provenance,
    frozenAt,
    labelMode: 'protected',
    labelProtection: labelsWorldReadable ? 'world-readable' : 'protected',
    resolvedInputs,
    inputsSha256,
    resolvedLabels,
    labelsSha256,
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function reviewerChecks(preregistration, manifest) {
  const reviewers = preregistration?.value?.reviewers ?? []
  const author = reviewers.find((reviewer) => reviewer.role === 'author')
  const independent = reviewers.find(
    (reviewer) =>
      reviewer.role === 'domain-reviewer' &&
      reviewer.independent === true &&
      reviewer.sawLabels === false &&
      reviewer.name !== manifest?.owner,
  )
  return { author: author ?? null, independent: independent ?? null, ok: Boolean(independent) }
}

export async function evaluateRoutine(rootInput, id, version, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const manifest = await store.readManifest(root, id, version)
    const routineDirectory = await store.resolveRoutineDir(root, id, version)
    const issues = validateManifest(manifest)

    let hooks = null
    try {
      hooks = await store.loadHooks(routineDirectory, manifest)
    } catch (error) {
      issues.push(`hooks failed to load: ${String(error?.message ?? error)}`)
    }

    const preregistration = await readPreregistration(root, routineDirectory, manifest)
    issues.push(...preregistration.issues.map((issue) => `preregistration: ${issue}`))
    const thresholds = thresholdsOf(preregistration)
    const reviewers = reviewerChecks(preregistration, manifest)

    const evidence = await collectEvidence(root, routineDirectory, manifest).catch((error) => {
      issues.push(`evidence collection failed: ${error.message}`)
      return null
    })

    const registryBefore = await store.readRegistry(root)
    const versionEntryBefore = registryBefore.routines?.[id]?.versions?.[String(version)] ?? {}
    const approvedContract = versionEntryBefore?.approvedRelease?.contractRevision ?? null
    if (approvedContract && approvedContract !== manifest.contractRevision) {
      issues.push(`schema drift: approved contract revision ${approvedContract} but manifest declares ${manifest.contractRevision}`)
    }

    const metrics = {}
    const publicCases = {}
    const protectedCases = {}
    const fixtureSets = {}
    const { perRequestBudgetMs } = preregistration?.value?.workload ?? {}
    const budgetMs = Number.isFinite(perRequestBudgetMs) ? perRequestBudgetMs : null

    if (hooks) {
      for (const set of DECISION_SETS) {
        let fixtureSet = null
        try {
          fixtureSet = await loadFixtureSet(root, routineDirectory, manifest, set)
        } catch (error) {
          issues.push(`fixture set ${set} failed to load: ${error.message}`)
          continue
        }
        fixtureSets[set] = fixtureSet
        if (BLIND_SETS.includes(set) && fixtureSet.labelMode !== 'protected') {
          issues.push(`${set} labels are not separated from the readable inputs; blind evidence requires evidence.blindLabels.${set}`)
        }
        const outcomes = []
        for (const fixtureCase of fixtureSet.cases) {
          const actual = await runCase({ root, id, version, input: fixtureCase.input, manifest, hooks, routineDirectory })
          const scored = {
            ...scoreCase(fixtureCase.expect, actual),
            decision: actual.decision,
            reason: actual.reason,
            latencyMs: actual.latencyMs,
            output: actual.output,
          }
          outcomes.push({ id: fixtureCase.id, expect: fixtureCase.expect, actual, scored })
        }
        metrics[set] = summarizeSet(set, outcomes, { perRequestBudgetMs: budgetMs })
        protectedCases[set] = outcomes.map((outcome) => ({
          id: outcome.id,
          expected: outcome.expect,
          decision: outcome.actual.decision,
          reason: outcome.actual.reason,
          disposition: outcome.actual.disposition,
          correct: outcome.scored.correct,
          e2eSuccess: outcome.scored.e2eSuccess,
          silentError: outcome.scored.silentError,
          challengeIncorrectAutomatic: outcome.scored.challengeIncorrectAutomatic,
          needlessDeferral: Boolean(outcome.scored.needlessDeferral),
          difference: outcome.scored.difference ?? null,
          allowed: outcome.scored.allowed ?? null,
          latencyMs: outcome.scored.latencyMs,
          costUsd: null,
          costBasis: 'unmetered-runtime',
        }))
        publicCases[set] = BLIND_SETS.includes(set)
          ? outcomes.map((outcome) => ({
              id: outcome.id,
              decision: outcome.actual.decision,
              reason: outcome.actual.reason,
              disposition: outcome.actual.disposition,
              firstRoute: outcome.actual.decision,
              latencyMs: outcome.scored.latencyMs,
            }))
          : protectedCases[set]
      }
    }

    const dev = metrics.dev ?? null
    const audit = metrics.audit ?? null
    const challenge = metrics.challenge ?? null
    const labelIsolationOk =
      fixtureSets.audit?.labelMode === 'protected' &&
      fixtureSets.challenge?.labelMode === 'protected' &&
      fixtureSets.audit?.labelProtection === 'protected' &&
      fixtureSets.challenge?.labelProtection === 'protected'

    const gates = {
      contract: { ok: issues.length === 0, issues },
      preregistration: {
        ok: preregistration.ok,
        path: preregistration.path,
        sha256: preregistration.sha256,
        frozenAt: preregistration.value?.frozenAt ?? null,
        issues: preregistration.issues,
        reviewers: {
          author: reviewers.author?.name ?? null,
          independentReviewer: reviewers.independent?.name ?? null,
        },
        thresholds,
      },
      blindIsolation: {
        ok: labelIsolationOk,
        auditLabelMode: fixtureSets.audit?.labelMode ?? null,
        challengeLabelMode: fixtureSets.challenge?.labelMode ?? null,
        auditLabelsFile: fixtureSets.audit?.resolvedLabels ? 'protected' : null,
      },
      dev: {
        ok: Boolean(dev) && dev.total > 0 && (publicCases.dev ?? []).every((record) => record.correct === true),
        total: dev?.total ?? 0,
        deferred: dev?.deferred ?? 0,
        failures: (publicCases.dev ?? []).filter((record) => record.correct !== true).map((record) => record.id),
      },
      coverage: {
        ok: Boolean(audit) && stats.ratio(audit.automatic, audit.total) >= thresholds.coverageFloor,
        automatic: audit?.automatic ?? 0,
        total: audit?.total ?? 0,
        value: audit?.coverage ?? 0,
        floor: thresholds.coverageFloor,
        deferralReasons: audit?.deferralReasons ?? {},
      },
      silentError: {
        ok: Boolean(audit) && audit.silentErrors === 0 && stats.exactUpperBound95(audit.automatic) < thresholds.silentErrorCeiling,
        automatic: audit?.automatic ?? 0,
        wrong: audit?.silentErrors ?? 0,
        upperBound95: audit ? stats.exactUpperBound95(audit.automatic) : 1,
        ceiling: thresholds.silentErrorCeiling,
      },
      challenge: {
        ok:
          Boolean(challenge) &&
          challenge.total >= thresholds.challengeSize &&
          challenge.challengeIncorrectAutomatic <= thresholds.challengeIncorrectAutomatic,
        total: challenge?.total ?? 0,
        required: thresholds.challengeSize,
        incorrectAutomatic: challenge?.challengeIncorrectAutomatic ?? 0,
      },
      referenceCheck: await runReferenceCheck(root, routineDirectory, manifest),
    }
    gates.e2eSuccess = {
      ok: Boolean(audit) && audit.e2eSuccess > 0,
      value: audit?.e2eSuccess ?? 0,
      count: audit?.e2eSuccessCount ?? 0,
      total: audit?.total ?? 0,
    }

    const passed =
      gates.contract.ok &&
      gates.preregistration.ok &&
      gates.blindIsolation.ok &&
      gates.dev.ok &&
      gates.coverage.ok &&
      gates.silentError.ok &&
      gates.challenge.ok &&
      gates.referenceCheck.ok

    const dataClass = manifest.evidence?.dataClass ?? 'unknown'
    const realDeploymentData = manifest.evidence?.realDeploymentData === true
    const synthetic = dataClass === 'synthetic' || realDeploymentData === false

    const auditLabelsSha256 = evidence?.blindLabels?.audit?.sha256 ?? evidence?.fixtureSets?.audit?.sha256 ?? null
    const previousAuditUse = versionEntryBefore?.auditUse ?? null
    const auditFresh = !previousAuditUse || previousAuditUse.labelsSha256 !== auditLabelsSha256
    const preregHash = preregistration.sha256
    const preregUnchanged = !previousAuditUse?.preregHash || previousAuditUse.preregHash === preregHash

    const generatedAt = new Date().toISOString()
    const reportFile = store.reportPath(root, id, version, new Date(generatedAt), 'evaluation')
    const blindRunPath = store.blindRunFile(root, id, version, new Date(generatedAt))

    const blockers = []
    if (!passed) blockers.push({ code: 'gates-failed', message: 'one or more promotion gates did not pass' })
    if (!auditFresh) {
      blockers.push({
        code: 'audit-reused',
        message: 'the same blind audit label set was already used for a gated run; only the first prespecified run counts',
      })
    }
    if (!preregistration.ok) blockers.push({ code: 'preregistration-invalid', message: preregistration.issues.join('; ') })
    if (!preregUnchanged) blockers.push({ code: 'preregistration-changed', message: 'the preregistration changed after the first blind run' })
    if (synthetic) blockers.push({ code: 'synthetic-data', message: 'the evidence is synthetic (or not attested as real deployment data); the pilot must stay in shadow' })
    if (!realDeploymentData) blockers.push({ code: 'real-data-not-attested', message: 'evidence.realDeploymentData must be true and preregistration.realDataAttested must be true' })
    if (!reviewers.ok) blockers.push({ code: 'independent-reviewer-missing', message: 'release requires an independent domain-reviewer signature with sawLabels:false' })
    const releaseEligible = blockers.length === 0

    const auditUse = {
      labelsSha256: auditLabelsSha256,
      inputsSha256: evidence?.fixtureSets?.audit?.sha256 ?? null,
      preregHash,
      firstRunAt: auditFresh ? generatedAt : previousAuditUse?.firstRunAt ?? generatedAt,
      lastRunAt: generatedAt,
      runs: auditFresh ? 1 : (previousAuditUse?.runs ?? 0) + 1,
      fresh: auditFresh,
    }

    const protectedDetail = {
      schemaVersion: 2,
      kind: 'blind-run',
      routine: id,
      version,
      contractRevision: manifest.contractRevision,
      generatedAt,
      labels: {
        audit: evidence?.blindLabels?.audit?.sha256 ?? null,
        challenge: evidence?.blindLabels?.challenge?.sha256 ?? null,
      },
      cases: protectedCases,
      metrics,
      gates,
    }
    await store.writeProtectedJson(blindRunPath, protectedDetail, 0o600)
    const blindRunSha256 = await store.sha256File(blindRunPath)

    const report = {
      kind: 'evaluation',
      schemaVersion: REPORT_SCHEMA_VERSION,
      routine: id,
      version,
      contractRevision: manifest.contractRevision,
      dataClass,
      realDeploymentData,
      generatedAt,
      engine: { name: store.ENGINE_NAME, version: store.ENGINE_VERSION },
      passed,
      gates,
      metrics,
      cases: publicCases,
      blindRun: { path: blindRunPath, sha256: blindRunSha256, protected: true },
      auditUse,
      eligibility: { releaseEligible, blockers, dataClass, synthetic },
      budget: {
        perRequestMs: budgetMs,
        overBudgetCases: audit?.overBudgetCases ?? 0,
        withinBudgetRate: audit ? stats.ratio(audit.total - (audit.overBudgetCases ?? 0), audit.total) : 0,
      },
      evidence,
      reproducibility: {
        engine: { name: store.ENGINE_NAME, version: store.ENGINE_VERSION },
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: root,
        environment: options.environment ?? {},
        modelSnapshot: options.modelSnapshot ?? null,
        promptVersions: options.promptVersions ?? {},
        toolVersions: options.toolVersions ?? {},
        codeRevision: options.codeRevision ?? null,
        sourceRevision: await resolveSourceRevision(),
        caseSetHash: evidence?.caseSetHash ?? null,
        evidenceHash: evidence?.evidenceHash ?? null,
        generatedAt,
      },
      notes: options.notes ?? [],
    }
    const storedReport = { ...report, reportPath: reportFile }
    await store.writeJsonFile(reportFile, storedReport)
    report.reportPath = reportFile
    report.reportSha256 = await store.sha256File(reportFile)

    const currentRegistry = await store.readRegistry(root)
    const routine = (currentRegistry.routines[id] ??= { title: manifest.title, versions: {} })
    routine.title = manifest.title
    const versionEntry = (routine.versions[String(version)] ??= { status: 'candidate', createdAt: generatedAt })
    versionEntry.lastReport = {
      at: generatedAt,
      path: reportFile,
      sha256: report.reportSha256,
      passed,
      releaseEligible,
      evidenceHash: evidence?.evidenceHash ?? null,
      gatesSummary: {
        coverage: gates.coverage.value,
        silentErrorUpperBound: gates.silentError.upperBound95,
        challengeIncorrectAutomatic: gates.challenge.incorrectAutomatic,
        e2eSuccess: gates.e2eSuccess.value,
      },
      eligibilitySummary: { releaseEligible, blockers: blockers.map((blocker) => blocker.code) },
    }
    versionEntry.auditUse = auditUse
    versionEntry.dataClass = dataClass
    versionEntry.preregistration = { path: preregistration.path, sha256: preregHash, reviewers: gates.preregistration.reviewers }
    if (approvedContract && approvedContract !== manifest.contractRevision && versionEntry.status === 'active') {
      versionEntry.status = 'suspended'
      versionEntry.suspendedAt = generatedAt
      versionEntry.suspendReason = 'schema-drift detected during re-evaluation'
    }
    await store.writeRegistry(root, currentRegistry)
    return report
  })
}

async function resolveSourceRevision() {
  const output = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: store.PACKAGE_DIR, encoding: 'utf8', timeout: 5000 })
  if (output.status !== 0) return { available: false, commit: null, dirty: null, packageVersion: null, reason: 'git metadata is unavailable' }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: store.PACKAGE_DIR, encoding: 'utf8', timeout: 5000 })
  const packageJson = JSON.parse(await fsp.readFile(path.join(store.PACKAGE_DIR, 'package.json'), 'utf8').catch(() => '{}'))
  return {
    available: true,
    commit: (output.stdout ?? '').trim(),
    dirty: status.status === 0 ? (status.stdout ?? '').trim() !== '' : null,
    packageVersion: packageJson.version ?? null,
  }
}

async function runReferenceCheck(root, routineDirectory, manifest) {
  const relative = manifest.evidence?.evaluator
  if (typeof relative !== 'string') return { ok: false, exitCode: null, output: 'no evaluator declared' }
  let resolved
  try {
    resolved = await store.resolveEvidencePath(root, routineDirectory, relative)
  } catch (error) {
    return { ok: false, exitCode: null, output: error.message }
  }
  const result = spawnSync(process.execPath, [resolved], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ROUTINE_ROOT: root, ROUTINE_ID: manifest.id, ROUTINE_VERSION: String(manifest.version) },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    ok: result.status === 0,
    exitCode: result.status,
    path: relative,
    output: output.split('\n').slice(-20).join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Public runtime entry (logs every decision; suspends on production errors)
// ---------------------------------------------------------------------------

export async function invokeRoutine(rootInput, id, version, input, options = {}) {
  const root = await store.ensureRoot(rootInput)
  const manifest = await store.readManifest(root, id, version)
  const routineDirectory = await store.resolveRoutineDir(root, id, version)
  const hooks = await store.loadHooks(routineDirectory, manifest)
  const result = await runCase({ root, id, version, input, manifest, hooks, routineDirectory })
  const registry = await store.readRegistry(root)
  const statusBefore = registry.routines?.[id]?.versions?.[String(version)]?.status ?? 'unknown'
  let autoSuspended = false
  let suspendedReason = null
  if (statusBefore === 'active' && result.decision === 'fallback' && options.autoSuspend !== false) {
    suspendedReason = `production ${result.reason}`
    await suspendRoutine(root, id, version, suspendedReason, { by: 'system' })
    autoSuspended = true
  }
  if (options.log !== false) {
    await store.appendRouteLog(root, {
      routine: id,
      version,
      status: autoSuspended ? 'suspended' : statusBefore,
      contractRevision: manifest.contractRevision,
      decision: result.decision,
      reason: result.reason,
      disposition: result.disposition,
      fieldId: result.bound?.fieldId ?? null,
      unit: result.bound?.unit ?? null,
      inputHash: store.sha256Value(input),
      autoSuspended,
      checks: result.checks?.map((check) => ({ id: check.id, ok: check.ok })) ?? null,
    })
  }
  return {
    routine: id,
    version,
    contractRevision: manifest.contractRevision,
    registryStatus: autoSuspended ? 'suspended' : statusBefore,
    decision: result.decision,
    reason: result.reason,
    disposition: result.disposition,
    bound: result.bound,
    output: result.output,
    checks: result.checks,
    latencyMs: result.latencyMs,
    autoSuspended,
    suspendedReason,
  }
}

async function writeDecision(root, decision, manifest, report, preregistration, options) {
  const reviewers = reviewerChecks(preregistration, manifest)
  return store.writeDecisionRecord(root, {
    schemaVersion: 2,
    ...decision,
    at: decision.at ?? new Date().toISOString(),
    by: decision.by ?? options.by ?? 'user',
    owner: manifest?.owner ?? null,
    dataClass: manifest?.evidence?.dataClass ?? null,
    costHorizon: preregistration?.value?.workload ?? null,
    nextReviewTrigger: preregistration?.value?.nextReviewTrigger ?? null,
    reviewers: { author: reviewers.author?.name ?? null, independentReviewer: reviewers.independent?.name ?? null },
    evidence: {
      reportPath: report?.reportPath ?? null,
      reportSha256: report?.reportSha256 ?? null,
      evidenceHash: report?.evidence?.evidenceHash ?? null,
      preregistrationSha256: preregistration?.sha256 ?? null,
    },
  })
}

export async function suspendRoutine(rootInput, id, version, reason, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const registry = await store.readRegistry(root)
    const target = registry.routines?.[id]?.versions?.[String(version)]
    if (!target) throw new Error(`routine ${id}/${version} is not registered`)
    if (target.status !== 'active') return registry
    const manifest = await store.readManifest(root, id, version).catch(() => null)
    const routineDirectory = await store.resolveRoutineDir(root, id, version).catch(() => null)
    const preregistration = manifest && routineDirectory ? await readPreregistration(root, routineDirectory, manifest) : null
    const report = await store.latestReport(root, id, version)
    target.status = 'suspended'
    target.suspendedAt = new Date().toISOString()
    target.suspendReason = String(reason)
    await store.writeRegistry(root, registry)
    await writeDecision(root, { kind: 'suspend', routine: id, version: String(version), by: options.by ?? 'system', reason: String(reason) }, manifest, report, preregistration, options)
    return registry
  })
}

// ---------------------------------------------------------------------------
// Registry state for the UI and the status tool
// ---------------------------------------------------------------------------

export async function registryState(rootInput) {
  const root = await store.ensureRoot(rootInput)
  const registry = await store.readRegistry(root)
  const entries = await store.listRoutineEntries(root)
  const routines = []
  const ids = new Set([...Object.keys(registry.routines ?? {}), ...entries.map((entry) => entry.id)])
  const entryVersions = new Map()
  for (const entry of entries) {
    let label = entry.version
    let dataClass = null
    try {
      const manifest = JSON.parse(await fsp.readFile(entry.manifestPath, 'utf8'))
      label = String(manifest.version ?? entry.version)
      dataClass = manifest.evidence?.dataClass ?? null
    } catch {
      // keep the directory label when the manifest is unreadable
    }
    if (!entryVersions.has(entry.id)) entryVersions.set(entry.id, new Map())
    entryVersions.get(entry.id).set(label, { dataClass })
  }
  for (const id of [...ids].sort()) {
    const routineEntry = registry.routines?.[id] ?? { versions: {} }
    const versionMap = entryVersions.get(id) ?? new Map()
    const versions = new Set([...Object.keys(routineEntry.versions ?? {}), ...versionMap.keys()])
    const versionViews = []
    for (const version of [...versions].sort()) {
      const versionEntry = routineEntry.versions?.[version] ?? { status: 'candidate' }
      versionViews.push({
        version,
        status: versionEntry.status ?? 'candidate',
        createdAt: versionEntry.createdAt ?? null,
        approvedRelease: versionEntry.approvedRelease ?? null,
        lastReport: versionEntry.lastReport ?? null,
        auditUse: versionEntry.auditUse ?? null,
        dataClass: versionEntry.dataClass ?? versionMap.get(version)?.dataClass ?? null,
        preregistration: versionEntry.preregistration ?? null,
      })
    }
    const active = versionViews.find((view) => view.status === 'active') ?? null
    routines.push({
      id,
      title: routineEntry.title ?? id,
      versions: versionViews,
      active: active ? { version: active.version } : null,
      fallback: registry.fallback && registry.fallback.id === id ? registry.fallback : null,
    })
  }
  return {
    root,
    seeded: entries.length > 0,
    engine: { name: store.ENGINE_NAME, version: store.ENGINE_VERSION },
    fallback: registry.fallback ?? null,
    routines,
    updatedAt: registry.updatedAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// Proposal, preregistration, release, withdrawal
// ---------------------------------------------------------------------------

export async function proposeRoutine(rootInput, proposal) {
  const root = await store.ensureRoot(rootInput)
  const { id, version, manifest, files = {}, fixtures = {}, preregistration, overwrite = false } = proposal ?? {}
  store.assertSafeSegment(id, store.ID_PATTERN, 'routine id')
  store.assertSafeSegment(String(version), store.VERSION_PATTERN, 'routine version')
  if (!manifest || typeof manifest !== 'object') throw new Error('proposal.manifest is required')
  if (manifest.id !== id || String(manifest.version) !== String(version)) {
    throw new Error('proposal.manifest.id/version must match the proposal id/version')
  }
  const issues = validateManifest(manifest)
  if (issues.length > 0) throw new Error(`candidate manifest is invalid: ${issues.join('; ')}`)
  if (!preregistration || typeof preregistration !== 'object') {
    throw new Error('candidate.preregistration is required and must be frozen before any blind evaluation')
  }
  const preregistrationIssues = validatePreregistration(preregistration, manifest)
  if (preregistrationIssues.length > 0) throw new Error(`preregistration is invalid: ${preregistrationIssues.join('; ')}`)
  const allowedFiles = new Set(['guard.js', 'binding.js', 'execution.js'])
  for (const name of Object.keys(files)) {
    if (!allowedFiles.has(name)) throw new Error(`files.${name} is not an allowed hook file`)
    if (typeof files[name] !== 'string') throw new Error(`files.${name} must be JavaScript source text`)
  }
  for (const hook of ['admission.predicate', 'binding.entry', 'execution.entry']) {
    const entry = hook === 'admission.predicate' ? manifest.admission.predicate : hook === 'binding.entry' ? manifest.binding.entry : manifest.execution.entry
    const [file] = entry.split('#')
    if (!allowedFiles.has(file) || files[file] === undefined) {
      throw new Error(`${hook} must reference a hook file supplied in files (got ${entry})`)
    }
  }

  return store.withLock(root, async () => {
    const registry = await store.readRegistry(root)
    const versionEntry = registry.routines?.[id]?.versions?.[String(version)]
    if (versionEntry && versionEntry.status !== 'candidate' && !overwrite) {
      throw new Error(`version ${id}/${version} is ${versionEntry.status}; a released version is immutable, propose a new version`)
    }
    if (versionEntry?.status === 'candidate' && !overwrite) {
      throw new Error(`candidate ${id}/${version} already exists; pass overwrite:true to replace it`)
    }
    const directory = store.routineDir(root, id, String(version))
    await fsp.mkdir(directory, { recursive: true })
    for (const [name, source] of Object.entries(files)) {
      await fsp.writeFile(path.join(directory, name), source, 'utf8')
    }
    const fixtureDirectory = path.join(root, 'fixtures', id, String(version))
    const blindDirectory = path.join(root, 'blind', id, String(version))
    await fsp.mkdir(fixtureDirectory, { recursive: true })
    await fsp.mkdir(blindDirectory, { recursive: true, mode: 0o700 })
    await fsp.chmod(blindDirectory, 0o700)

    const fixtureSets = {}
    const blindLabels = {}
    for (const set of DECISION_SETS) {
      const cases = fixtures[set]
      if (!Array.isArray(cases)) throw new Error(`fixtures.${set} must be an array of cases`)
      for (const fixtureCase of cases) {
        if (typeof fixtureCase.id !== 'string' || !fixtureCase.input || !fixtureCase.expect) {
          throw new Error(`fixtures.${set} case ${fixtureCase.id ?? '<unknown>'} needs id, input and expect`)
        }
      }
      if (set === 'dev') {
        const file = path.join(fixtureDirectory, 'dev.json')
        await store.writeJsonFile(file, { schemaVersion: 2, set, provenance: manifest.evidence?.dataClass ?? 'trace-derived', frozenAt: new Date().toISOString(), cases })
        fixtureSets.dev = path.relative(root, file).split(path.sep).join('/')
        continue
      }
      const inputsFile = path.join(fixtureDirectory, `${set}.inputs.json`)
      const labelsFile = path.join(blindDirectory, `${set}.labels.json`)
      await store.writeJsonFile(inputsFile, {
        schemaVersion: 2,
        set,
        provenance: manifest.evidence?.dataClass ?? 'trace-derived',
        frozenAt: new Date().toISOString(),
        cases: cases.map((fixtureCase) => ({ id: fixtureCase.id, description: fixtureCase.description, input: fixtureCase.input })),
      })
      await store.writeProtectedJson(labelsFile, {
        schemaVersion: 2,
        set,
        frozenAt: new Date().toISOString(),
        cases: cases.map((fixtureCase) => ({ id: fixtureCase.id, expect: fixtureCase.expect })),
      })
      fixtureSets[set] = path.relative(root, inputsFile).split(path.sep).join('/')
      blindLabels[set] = path.relative(root, labelsFile).split(path.sep).join('/')
    }

    const preregistrationFile = path.join(directory, 'preregistration.json')
    await store.writeJsonFile(preregistrationFile, preregistration)
    const preregistrationSha256 = await store.sha256File(preregistrationFile)

    const candidateManifest = {
      ...manifest,
      version,
      evidence: {
        ...manifest.evidence,
        fixtureSets,
        blindLabels,
        preregistration: 'preregistration.json',
      },
    }
    await fsp.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(candidateManifest, null, 2), 'utf8')

    registry.routines[id] ??= { title: candidateManifest.title, versions: {} }
    registry.routines[id].title = candidateManifest.title
    registry.routines[id].versions[String(version)] = {
      ...(versionEntry ?? {}),
      status: 'candidate',
      createdAt: versionEntry?.createdAt ?? new Date().toISOString(),
      contractRevision: candidateManifest.contractRevision,
      dataClass: candidateManifest.evidence?.dataClass ?? null,
      preregistration: { path: 'preregistration.json', sha256: preregistrationSha256 },
      evidenceHash: null,
      approvedRelease: null,
    }
    await store.writeRegistry(root, registry)
    return {
      routine: id,
      version: String(version),
      directory,
      files: Object.keys(files),
      fixtureSets,
      blindLabels,
      dataClass: candidateManifest.evidence?.dataClass ?? null,
      sourceTraces: candidateManifest.evidence?.derivationTraces ?? [],
      preregistrationSha256,
    }
  })
}

export async function writePreregistration(rootInput, id, version, preregistration, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const manifest = await store.readManifest(root, id, version)
    const directory = await store.resolveRoutineDir(root, id, version)
    for (const reviewer of preregistration?.reviewers ?? []) {
      if (reviewer?.role === 'domain-reviewer' && options.by === 'agent') {
        throw new Error('an agent may not sign as an independent domain-reviewer; add that signature yourself before release')
      }
    }
    if (String(preregistration?.routine) !== id || String(preregistration?.version) !== String(version)) {
      throw new Error('preregistration.routine/version must match the target routine')
    }
    const issues = validatePreregistration(preregistration, manifest)
    if (issues.length > 0) throw new Error(`preregistration is invalid: ${issues.join('; ')}`)
    const registry = await store.readRegistry(root)
    const versionEntry = registry.routines?.[id]?.versions?.[String(version)]
    if (!versionEntry) throw new Error(`routine ${id}/${version} is not registered`)
    const serialized = JSON.stringify(preregistration, null, 2)
    const sha256 = store.sha256Text(serialized)
    if (versionEntry.auditUse && versionEntry.auditUse.preregHash !== sha256) {
      throw new Error('the blind audit already ran against a different preregistration; a changed preregistration requires a fresh audit set')
    }
    const file = store.preregistrationFile(directory)
    await fsp.writeFile(file, serialized, 'utf8')
    versionEntry.preregistration = { path: path.basename(file), sha256, frozenAt: preregistration.frozenAt ?? null }
    await store.writeRegistry(root, registry)
    return { routine: id, version: String(version), path: file, sha256 }
  })
}

async function assertFreshEvidence(root, id, version) {
  const manifest = await store.readManifest(root, id, version)
  const routineDirectory = await store.resolveRoutineDir(root, id, version)
  const evidence = await collectEvidence(root, routineDirectory, manifest)
  const report = await store.latestReport(root, id, version)
  if (!report) throw new Error('release requires an evaluation report; run routine_evaluate first')
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) throw new Error('release requires a v0.2 evaluation report; re-run routine_evaluate')
  if (!report.passed) throw new Error('release blocked: the latest evaluation did not pass every gate')
  if (!report.eligibility?.releaseEligible) {
    const blockers = (report.eligibility?.blockers ?? []).map((blocker) => `${blocker.code}: ${blocker.message}`)
    throw new Error(`release blocked: ${blockers.join(' | ') || 'release eligibility was not established'}`)
  }
  if (report.auditUse?.fresh === false) throw new Error('release blocked: the latest report reused an already-consumed blind audit set')
  if (report.evidence?.manifestSha256 !== evidence.manifestSha256) {
    throw new Error('release blocked: the manifest changed after the last evaluation; re-run routine_evaluate')
  }
  for (const set of DECISION_SETS) {
    if (report.evidence.fixtureSets?.[set]?.sha256 !== evidence.fixtureSets?.[set]?.sha256) {
      throw new Error(`release blocked: the ${set} fixture set changed after the last evaluation`)
    }
  }
  for (const set of BLIND_SETS) {
    if (report.evidence.blindLabels?.[set]?.sha256 !== evidence.blindLabels?.[set]?.sha256) {
      throw new Error(`release blocked: the ${set} blind labels changed after the last evaluation`)
    }
  }
  if (report.evidence.preregistration?.sha256 !== evidence.preregistration?.sha256) {
    throw new Error('release blocked: the preregistration changed after the last evaluation')
  }
  if (report.evidence.hooks && evidence.hooks) {
    for (const key of Object.keys(evidence.hooks)) {
      if (report.evidence.hooks[key]?.sha256 !== evidence.hooks[key].sha256) {
        throw new Error(`release blocked: the ${key} hook changed after the last evaluation`)
      }
    }
  }
  return { manifest, evidence, report }
}

export async function releaseRoutine(rootInput, id, version, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const { manifest, evidence, report } = await assertFreshEvidence(root, id, version)
    const registry = await store.readRegistry(root)
    const routine = registry.routines[id]
    const target = routine?.versions?.[String(version)]
    if (!target) throw new Error(`routine ${id}/${version} is not registered`)
    if (target.status === 'active') return registry
    const preregistration = await readPreregistration(root, await store.resolveRoutineDir(root, id, version), manifest)
    const previousActive = Object.entries(routine.versions).find(([, entry]) => entry.status === 'active')
    if (previousActive) previousActive[1].status = 'superseded'
    target.status = 'active'
    target.approvedRelease = {
      at: new Date().toISOString(),
      by: options.by ?? 'user',
      reportPath: report.reportPath ?? null,
      reportSha256: report.reportSha256 ?? null,
      evidenceHash: evidence.evidenceHash,
      contractRevision: manifest.contractRevision,
      dataClass: manifest.evidence?.dataClass ?? null,
    }
    registry.fallback = previousActive ? { id, version: previousActive[0] } : registry.fallback ?? null
    await store.writeRegistry(root, registry)
    await writeDecision(
      root,
      {
        kind: 'release',
        routine: id,
        version: String(version),
        by: options.by ?? 'user',
        reportPath: report.reportPath,
        reportSha256: report.reportSha256,
        evidenceHash: evidence.evidenceHash,
        fallback: registry.fallback,
      },
      manifest,
      report,
      preregistration,
      options,
    )
    return registry
  })
}

export async function withdrawRoutine(rootInput, id, version, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const registry = await store.readRegistry(root)
    const target = registry.routines?.[id]?.versions?.[String(version)]
    if (!target) throw new Error(`routine ${id}/${version} is not registered`)
    const reason = typeof options.reason === 'string' && options.reason.trim() !== '' ? options.reason.trim() : 'withdrawn by user'
    target.status = 'withdrawn'
    target.withdrawnAt = new Date().toISOString()
    target.withdrawalReason = reason
    if (registry.fallback?.id === id && String(registry.fallback.version) === String(version)) {
      registry.fallback = null
    }
    await store.writeRegistry(root, registry)
    const manifest = await store.readManifest(root, id, version).catch(() => null)
    const routineDirectory = manifest ? await store.resolveRoutineDir(root, id, version).catch(() => null) : null
    const preregistration = manifest && routineDirectory ? await readPreregistration(root, routineDirectory, manifest) : null
    const report = await store.latestReport(root, id, version)
    await writeDecision(
      root,
      { kind: 'withdraw', routine: id, version: String(version), by: options.by ?? 'user', reason, fallback: registry.fallback },
      manifest,
      report,
      preregistration,
      options,
    )
    return registry
  })
}

// ---------------------------------------------------------------------------
// Paired arm comparison (framework page 6)
// ---------------------------------------------------------------------------

function canonicalCase(candidate) {
  const value = Number.isFinite(Number(candidate?.valueHz)) ? Number(Number(candidate.valueHz).toFixed(6)) : null
  return JSON.stringify([candidate?.decision ?? null, candidate?.reason ?? null, candidate?.fieldId ?? null, value])
}

function armGroup(records) {
  const byArm = new Map()
  for (const record of records) {
    const arm = String(record.arm ?? '').toUpperCase()
    if (!['A', 'B', 'C'].includes(arm)) continue
    if (record.kind !== 'arm-run' || record.schemaVersion !== 2 || record.provenance !== 'measured') continue
    const repeat = Number(record.repeat)
    if (!Number.isInteger(repeat) || repeat < 1) continue
    if (!byArm.has(arm)) byArm.set(arm, new Map())
    const previous = byArm.get(arm).get(repeat)
    if (!previous || record.mtimeMs > previous.mtimeMs) byArm.get(arm).set(repeat, record)
  }
  return byArm
}

function assertRawArm(record) {
  for (const armCase of record.cases ?? []) {
    if ('expected' in armCase || 'correct' in armCase) {
      throw new Error(`arm record ${record.relative ?? record.file ?? '<inline>'} leaks labels or correctness; raw arms may only carry decisions`)
    }
  }
}

function armMetrics(scoredCases, perRequestBudgetMs) {
  const total = scoredCases.length
  const automatic = scoredCases.filter((entry) => entry.decision === 'accept')
  const overBudget = automatic.filter((entry) => Number.isFinite(perRequestBudgetMs) && entry.latencyMs > perRequestBudgetMs)
  const e2e = scoredCases.filter((entry) => entry.scored.e2eSuccess)
  return {
    total,
    automatic: automatic.length,
    deferred: scoredCases.filter((entry) => entry.decision === 'defer').length,
    fallback: scoredCases.filter((entry) => entry.decision === 'fallback').length,
    e2eSuccess: stats.ratio(e2e.length, total),
    e2eSuccessCount: e2e.length,
    correct: scoredCases.filter((entry) => entry.scored.correct).length,
    silentErrors: automatic.filter((entry) => !entry.scored.correct).length,
    needlessDeferrals: scoredCases.filter((entry) => entry.scored.needlessDeferral).length,
    overBudgetCases: overBudget.length,
    coverage: stats.ratio(automatic.length, total),
    routeReasons: stats.histogram(scoredCases.filter((entry) => entry.decision === 'defer').map((entry) => entry.reason ?? 'deferred')),
    latency: stats.latencySummary(scoredCases.map((entry) => entry.latencyMs)),
  }
}

function armCost(record, requests) {
  const cost = record.cost ?? {}
  const perRequestUsd = Number.isFinite(cost.perRequestUsd) ? cost.perRequestUsd : null
  const setupUsd = Number.isFinite(cost.setupUsd) ? cost.setupUsd : null
  const maintenanceUsd = Number.isFinite(cost.maintenanceUsd) ? cost.maintenanceUsd : null
  const complete = perRequestUsd !== null && setupUsd !== null && maintenanceUsd !== null
  const projection = complete
    ? stats.costProjection({
        setupCostUsd: setupUsd,
        maintenanceCostUsd: maintenanceUsd,
        perRequestCostUsd: perRequestUsd,
        requests,
      })
    : null
  return {
    basis: cost.basis ?? 'unmetered',
    perRequestUsd,
    setupUsd,
    maintenanceUsd,
    authoringHours: Number.isFinite(cost.authoringHours) ? cost.authoringHours : null,
    laborRateUsdPerHour: Number.isFinite(cost.laborRateUsdPerHour) ? cost.laborRateUsdPerHour : null,
    laborBasis: cost.laborBasis ?? null,
    components: cost.components ?? null,
    tokens: cost.tokens ?? null,
    modelPrices: cost.modelPrices ?? null,
    tokenCostUsd: Number.isFinite(cost.tokenCostUsd) ? cost.tokenCostUsd : null,
    reviewCostUsd: Number.isFinite(cost.reviewCostUsd) ? cost.reviewCostUsd : null,
    priceBasis: cost.priceBasis ?? null,
    totalCostUsd: projection?.totalCostUsd ?? null,
    costPerCorrectResolutionUsd: null,
    complete,
  }
}

export async function compareArms(rootInput, options = {}) {
  const root = await store.ensureRoot(rootInput)
  const records = await store.listArmRecords(root)
  const group = armGroup(records)
  const measured = [...group.values()].reduce((total, repeats) => total + repeats.size, 0)
  if (measured === 0) {
    throw new Error('no measured arm runs found; run pilot/run.mjs (A must be an LLM-agent run, never a generated record)')
  }
  let runId = options.runId ?? null
  if (!runId) {
    const latest = records
      .filter((record) => record.kind === 'arm-run' && record.provenance === 'measured')
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    runId = latest?.runId ?? null
  }
  const selected = records.filter(
    (record) =>
      record.kind === 'arm-run' &&
      record.provenance === 'measured' &&
      (runId === null || record.runId === runId),
  )
  for (const record of selected) assertRawArm(record)
  const selectedGroup = armGroup(selected)
  for (const arm of ['A', 'B', 'C']) {
    if (!selectedGroup.get(arm)?.get(1)) {
      throw new Error(`comparison requires a measured ${arm} arm repeat 1 for run ${JSON.stringify(runId)}`)
    }
  }

  if (!options.routine || options.version === undefined) {
    throw new Error('a scored comparison requires routine and version: the labels are only read here, never in the raw arms')
  }
  const version = String(options.version)
  const manifest = await store.readManifest(root, options.routine, version)
  const routineDirectory = await store.resolveRoutineDir(root, options.routine, version)
  const operation = options.routine
  const fixtureSet = await loadFixtureSet(root, routineDirectory, manifest, 'audit').catch(async (error) => {
    throw new Error(`cannot load the audit label set for scoring: ${error.message}`)
  })
  if (fixtureSet.labelMode !== 'protected') throw new Error('audit labels are not separated; measured comparison requires protected labels')
  const labels = new Map(fixtureSet.cases.map((fixtureCase) => [fixtureCase.id, fixtureCase.expect]))
  const preregistration = await readPreregistration(root, routineDirectory, manifest)
  const perRequestBudgetMs = Number.isFinite(preregistration?.value?.workload?.perRequestBudgetMs)
    ? preregistration.value.workload.perRequestBudgetMs
    : null

  const caseIds = [...labels.keys()].sort()
  const arms = {}
  const repeatability = {}
  const primaryFlags = {}
  for (const arm of ['A', 'B', 'C']) {
    const repeats = selectedGroup.get(arm)
    const scoredRepeats = {}
    for (const repeat of [...repeats.keys()].sort((a, b) => a - b)) {
      const record = repeats.get(repeat)
      const cases = new Map()
      for (const armCase of record.cases ?? []) cases.set(armCase.caseId, armCase)
      const scoredCases = []
      for (const caseId of caseIds) {
        const raw = cases.get(caseId)
        const expected = labels.get(caseId)
        scoredCases.push({
          caseId,
          decision: raw?.decision ?? 'fallback',
          reason: raw?.reason ?? null,
          fieldId: raw?.fieldId ?? null,
          valueHz: Number.isFinite(Number(raw?.valueHz)) ? Number(raw.valueHz) : null,
          latencyMs: Number.isFinite(Number(raw?.latencyMs)) ? Number(raw.latencyMs) : null,
          costUsd: Number.isFinite(Number(raw?.costUsd)) ? Number(raw.costUsd) : null,
          scored: raw ? scoreRawDecision(expected, raw) : { correct: false, e2eSuccess: false, silentError: false, challengeIncorrectAutomatic: false, needlessDeferral: false },
        })
      }
      const requests = record.workload?.requests ?? caseIds.length
      const metrics = armMetrics(scoredCases, perRequestBudgetMs)
      const cost = armCost(record, requests)
      cost.costPerCorrectResolutionUsd =
        cost.totalCostUsd === null ? null : cost.totalCostUsd / Math.max(1, Math.round(requests * (metrics.e2eSuccessCount / Math.max(1, metrics.total))))
      scoredRepeats[repeat] = {
        repeat,
        file: record.relative ?? record.file ?? null,
        participant: record.participant ?? null,
        conditions: record.conditions ?? null,
        workload: record.workload ?? null,
        requests,
        cost,
        metrics,
        recordLatency: record.latency ?? null,
        cases: scoredCases,
      }
    }
    const primary = scoredRepeats[1]
    arms[arm] = {
      arm,
      primaryRepeat: 1,
      repeats: scoredRepeats,
      metrics: primary.metrics,
      cost: primary.cost,
      participant: primary.participant,
      conditions: primary.conditions,
    }
    primaryFlags[arm] = primary.cases.map((entry) => (entry.scored.e2eSuccess ? 1 : 0))
    if (Object.keys(scoredRepeats).length > 1) {
      let compared = 0
      let disagreements = 0
      const disagreementIds = []
      const signatures = new Map()
      for (const repeat of Object.keys(scoredRepeats).map(Number)) {
        for (const entry of scoredRepeats[repeat].cases) {
          if (!signatures.has(entry.caseId)) signatures.set(entry.caseId, [])
          signatures.get(entry.caseId).push(canonicalCase(entry))
        }
      }
      for (const [caseId, values] of signatures) {
        compared += 1
        if (new Set(values).size > 1) {
          disagreements += 1
          disagreementIds.push(caseId)
        }
      }
      repeatability[arm] = {
        repeats: Object.keys(scoredRepeats).length,
        comparedCases: compared,
        disagreementCases: disagreements,
        agreementRate: stats.ratio(compared - disagreements, compared),
        disagreementIds,
      }
    }
  }

  const comparisons = {}
  for (const baseline of ['A', 'B']) {
    const discordant = stats.discordantPairs(primaryFlags.C, primaryFlags[baseline])
    comparisons[baseline] = {
      discordant,
      bootstrap: stats.bootstrapPairedDiff(primaryFlags.C, primaryFlags[baseline], { iterations: 2000, seed: 20261104 }),
      zeroDiscordance: discordant.discordant === 0 ? stats.zeroDiscordanceBound(caseIds.length) : null,
      e2eSuccess: { candidate: arms.C.metrics.e2eSuccess, baseline: arms[baseline].metrics.e2eSuccess },
    }
  }

  const report = await store.latestReport(root, options.routine, version)
  const gatesOk = report ? report.passed === true && report.auditUse?.fresh !== false : false
  const costComplete = ['A', 'B', 'C'].every((arm) => arms[arm].cost.complete)
  const beatsBaselines =
    arms.C.metrics.e2eSuccess >= arms.A.metrics.e2eSuccess && arms.C.metrics.e2eSuccess >= arms.B.metrics.e2eSuccess
  const cheaper =
    costComplete &&
    Number.isFinite(arms.C.cost.totalCostUsd) &&
    Number.isFinite(arms.A.cost.totalCostUsd) &&
    Number.isFinite(arms.B.cost.totalCostUsd) &&
    arms.C.cost.totalCostUsd < arms.A.cost.totalCostUsd &&
    arms.C.cost.totalCostUsd < arms.B.cost.totalCostUsd
  const reasons = []
  if (!gatesOk) reasons.push(report ? 'the candidate has no fresh passing evaluation' : 'the candidate has no evaluation report')
  if (!beatsBaselines) reasons.push('the candidate does not reach the end-to-end success of every baseline')
  if (!costComplete) reasons.push('the cost comparison is incomplete: at least one arm lacks a numeric per-request, setup or maintenance cost')
  if (costComplete && !cheaper) reasons.push('the candidate is not projected cheaper than both baselines')
  const decision = !gatesOk || !beatsBaselines ? 'do-not-advance' : !costComplete ? 'inconclusive' : cheaper ? 'advance-to-shadow' : 'do-not-advance'

  const publicComparison = {
    kind: 'compare',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runId: runId ?? null,
    dataClass: manifest.evidence?.dataClass ?? null,
    routine: operation,
    version,
    pairedCases: caseIds.length,
    arms: Object.fromEntries(
      Object.entries(arms).map(([arm, value]) => [
        arm,
        {
          arm: value.arm,
          participant: value.participant,
          conditions: value.conditions,
          requests: value.repeats[value.primaryRepeat]?.requests ?? null,
          metrics: value.metrics,
          cost: value.cost,
          latency:
            value.repeats[value.primaryRepeat]?.recordLatency ??
            { basis: 'per-case-measured', p50Ms: value.metrics.latency.p50, p95Ms: value.metrics.latency.p95, meanMsPerRequest: value.metrics.latency.mean, totalMs: null },
        },
      ]),
    ),
    comparisons,
    repeatability,
    candidateGates: report
      ? {
          passed: report.passed,
          releaseEligible: report.eligibility?.releaseEligible ?? false,
          auditFresh: report.auditUse?.fresh ?? null,
          reportPath: report.reportPath ?? null,
          reportSha256: report.reportSha256 ?? null,
          blockers: report.eligibility?.blockers ?? [],
          summary: {
            coverage: report.gates?.coverage?.value ?? null,
            silentErrorUpperBound: report.gates?.silentError?.upperBound95 ?? null,
            challengeIncorrectAutomatic: report.gates?.challenge?.incorrectAutomatic ?? null,
            e2eSuccess: report.gates?.e2eSuccess?.value ?? null,
          },
        }
      : { passed: null, releaseEligible: null, auditFresh: null, blockers: [], reason: 'no evaluation report for this routine/version' },
    pilotDecision: {
      decision,
      advance: decision === 'advance-to-shadow',
      gatesOk,
      beatsBaselines,
      costComplete,
      cheaper,
      reasons,
      rule: 'advance to shadow only if the candidate has a fresh passing evaluation, reaches at least the observed end-to-end success of every baseline, and has a complete measured cost projection lower than both baselines',
    },
    notes: options.notes ?? [],
  }
  const comparisonFile = await store.writeReport(root, publicComparison)
  const protectedDetail = {
    schemaVersion: 2,
    kind: 'compare-scoring',
    generatedAt: publicComparison.generatedAt,
    runId,
    routine: operation,
    version,
    labels: { audit: fixtureSet.labelsSha256 },
    arms: Object.fromEntries(
      Object.entries(arms).map(([arm, value]) => [
        arm,
        Object.fromEntries(
          Object.entries(value.repeats).map(([repeat, payload]) => [
            repeat,
            {
              cases: payload.cases.map((entry) => ({
                caseId: entry.caseId,
                expected: labels.get(entry.caseId),
                decision: entry.decision,
                reason: entry.reason,
                correct: entry.scored.correct,
                e2eSuccess: entry.scored.e2eSuccess,
                silentError: entry.scored.silentError,
                needlessDeferral: Boolean(entry.scored.needlessDeferral),
              })),
            },
          ]),
        ),
      ]),
    ),
  }
  const protectedFile = store.compareBlindRunFile(root, runId ?? 'run', new Date(publicComparison.generatedAt))
  await store.writeProtectedJson(protectedFile, protectedDetail, 0o600)
  publicComparison.reportPath = comparisonFile
  publicComparison.reportSha256 = await store.sha256File(comparisonFile)
  publicComparison.blindRun = { path: protectedFile, sha256: await store.sha256File(protectedFile), protected: true }
  return publicComparison
}
