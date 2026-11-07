// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Evaluation and runtime engine.
//
// Runtime path (framework page 3): resolve the field and its provenance, check
// applicability, run the conversion, then validate the output. A failed check
// discards the provisional result and invokes the declared fallback. A deferral
// has a reason, and both the route and the reason are logged.
//
// Evaluation path (framework pages 4-6): run the frozen fixture sets, report
// denominators before averages, and decide the gates with an exact one-sided
// 95% upper bound for zero observed silent errors.

import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import * as stats from './stats.js'
import * as store from './store.js'

const COVERAGE_FLOOR = 0.6
const SILENT_ERROR_CEILING = 0.05
const CHALLENGE_SIZE = 40
const AUDIT_SIZE = 100
const DECISION_SETS = ['dev', 'audit', 'challenge']

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
// Manifest validation
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
  requireField(Array.isArray(manifest.postconditions) && manifest.postconditions.length > 0, 'postconditions must be a non-empty array')
  for (const postcondition of manifest.postconditions ?? []) {
    requireField(typeof postcondition.id === 'string', 'each postcondition needs an id')
    requireField(POSTCONDITIONS[postcondition.id] !== undefined, `unknown postcondition id: ${postcondition.id}`)
  }
  const fixtureSets = manifest.evidence?.fixtureSets
  requireField(fixtureSets && DECISION_SETS.every((set) => typeof fixtureSets[set] === 'string'), 'evidence.fixtureSets must define dev, audit and challenge')
  requireField(typeof manifest.evidence?.evaluator === 'string', 'evidence.evaluator is required')
  requireField(manifest.fallback && typeof manifest.fallback === 'object', 'fallback is required')
  requireField(manifest.errorPolicy && typeof manifest.errorPolicy === 'object', 'errorPolicy is required')
  return issues
}

function evidenceHashOf({ manifestSha256, hookHashes, fixtureHashes }) {
  return store.sha256Value({ manifestSha256, hookHashes, fixtureHashes })
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
  let evaluator = null
  if (typeof manifest.evidence?.evaluator === 'string') {
    try {
      const resolved = await store.resolveEvidencePath(root, routineDirectory, manifest.evidence.evaluator)
      evaluator = { path: manifest.evidence.evaluator, resolved, sha256: await store.sha256File(resolved) }
    } catch {
      evaluator = { path: manifest.evidence.evaluator, resolved: null, sha256: null }
    }
  }
  const evidenceHash = evidenceHashOf({ manifestSha256, hookHashes: hooks, fixtureHashes: fixtureSets })
  return { manifestSha256, hooks, fixtureSets, evaluator, evidenceHash }
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

  const requiredFields = manifest.execution?.outputSchema?.requiredFields ?? []
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
  for (const field of requiredFields) {
    const present = output[field] !== undefined && output[field] !== null
    checks.push({ id: `output-field:${field}`, ok: present, detail: present ? `${field} present` : `${field} missing from output` })
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
  // expected defer
  if (actual.decision === 'accept') {
    return {
      expected: 'defer',
      decision: actual.decision,
      correct: false,
      e2eSuccess: false,
      silentError: true,
      challengeIncorrectAutomatic: true,
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
    reasonMatch: false,
  }
}

function summarizeSet(setName, outcomes) {
  const automatic = outcomes.filter((outcome) => outcome.scored.decision === 'accept')
  const deferred = outcomes.filter((outcome) => outcome.scored.decision === 'defer')
  const fallback = outcomes.filter((outcome) => outcome.scored.decision === 'fallback')
  const acceptedCorrect = automatic.filter((outcome) => outcome.scored.correct)
  const acceptedWrong = automatic.filter((outcome) => !outcome.scored.correct)
  const e2eSuccess = outcomes.filter((outcome) => outcome.scored.e2eSuccess)
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
    deferralReasons: stats.histogram(deferred.map((outcome) => outcome.scored.actualReason ?? outcome.scored.reason ?? 'unclassified')),
    latency: stats.latencySummary(outcomes.map((outcome) => outcome.scored.latencyMs)),
  }
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

async function loadFixtureSet(root, routineDirectory, manifest, set) {
  const relative = manifest.evidence?.fixtureSets?.[set]
  if (!relative) throw new Error(`manifest does not declare the ${set} fixture set`)
  const resolved = await store.resolveEvidencePath(root, routineDirectory, relative)
  const parsed = JSON.parse(await fsp.readFile(resolved, 'utf8'))
  if (!Array.isArray(parsed.cases)) throw new Error(`${relative} has no cases array`)
  for (const fixtureCase of parsed.cases) {
    if (typeof fixtureCase.id !== 'string' || !fixtureCase.input || !fixtureCase.expect) {
      throw new Error(`${relative} case ${fixtureCase.id ?? '<unknown>'} needs id, input and expect`)
    }
    if (!['accept', 'defer'].includes(fixtureCase.expect.decision)) {
      throw new Error(`${relative} case ${fixtureCase.id} expect.decision must be accept or defer`)
    }
  }
  return { resolved, relative, set: parsed.set ?? set, provenance: parsed.provenance ?? 'unknown', cases: parsed.cases, sha256: await store.sha256File(resolved) }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export async function evaluateRoutine(rootInput, id, version, options = {}) {
  const root = await store.ensureRoot(rootInput)
  return store.withLock(root, async () => {
    const manifest = await store.readManifest(root, id, version)
    const routineDirectory = await store.resolveRoutineDir(root, id, version)
    const issues = validateManifest(manifest)
    let hooks = null
    let hookError = null
    try {
      hooks = await store.loadHooks(routineDirectory, manifest)
    } catch (error) {
      hookError = String(error?.message ?? error)
      issues.push(`hooks failed to load: ${hookError}`)
    }
    const evidence = await collectEvidence(root, routineDirectory, manifest).catch((error) => {
      issues.push(`evidence collection failed: ${error.message}`)
      return null
    })

    const metrics = {}
    const caseRecords = {}
    if (hooks) {
      for (const set of DECISION_SETS) {
        const fixtureSet = await loadFixtureSet(root, routineDirectory, manifest, set).catch((error) => {
          issues.push(`fixture set ${set} failed to load: ${error.message}`)
          return null
        })
        if (!fixtureSet) continue
        const outcomes = []
        for (const fixtureCase of fixtureSet.cases) {
          const actual = await runCase({
            root,
            id,
            version,
            input: fixtureCase.input,
            manifest,
            hooks,
            routineDirectory,
          })
          const scored = {
            ...scoreCase(fixtureCase.expect, actual),
            decision: actual.decision,
            reason: actual.reason,
            latencyMs: actual.latencyMs,
            output: actual.output,
          }
          outcomes.push({ id: fixtureCase.id, expect: fixtureCase.expect, actual, scored })
        }
        metrics[set] = summarizeSet(set, outcomes)
        caseRecords[set] = outcomes.map((outcome) => ({
          id: outcome.id,
          expected: outcome.expect.decision,
          decision: outcome.actual.decision,
          reason: outcome.actual.reason,
          correct: outcome.scored.correct,
          e2eSuccess: outcome.scored.e2eSuccess,
          silentError: outcome.scored.silentError,
          challengeIncorrectAutomatic: outcome.scored.challengeIncorrectAutomatic,
          latencyMs: outcome.scored.latencyMs,
        }))
      }
    }

    const registry = await store.readRegistry(root)
    const entry = registry.routines?.[id]?.versions?.[version] ?? null
    const approvedContract = entry?.approvedRelease?.contractRevision ?? null
    if (approvedContract && approvedContract !== manifest.contractRevision) {
      issues.push(`schema drift: approved contract revision ${approvedContract} but manifest declares ${manifest.contractRevision}`)
    }

    const dev = metrics.dev ?? null
    const audit = metrics.audit ?? null
    const challenge = metrics.challenge ?? null

    const gates = {
      contract: { ok: issues.length === 0, issues },
      dev: {
        // Development cases include deliberate deferrals; every case must reach
        // the expected decision and output, but deferral itself is not a failure.
        ok: Boolean(dev) && dev.total > 0 && (caseRecords.dev ?? []).every((record) => record.correct === true),
        total: dev?.total ?? 0,
        deferred: dev?.deferred ?? 0,
        failures: (caseRecords.dev ?? []).filter((record) => record.correct !== true).map((record) => record.id),
      },
      coverage: {
        ok: Boolean(audit) && stats.ratio(audit.automatic, audit.total) >= COVERAGE_FLOOR,
        automatic: audit?.automatic ?? 0,
        total: audit?.total ?? 0,
        value: audit?.coverage ?? 0,
        floor: COVERAGE_FLOOR,
        deferralReasons: audit?.deferralReasons ?? {},
      },
      silentError: {
        ok:
          Boolean(audit) &&
          audit.silentErrors === 0 &&
          stats.exactUpperBound95(audit.automatic) < SILENT_ERROR_CEILING,
        automatic: audit?.automatic ?? 0,
        wrong: audit?.silentErrors ?? 0,
        upperBound95: audit ? stats.exactUpperBound95(audit.automatic) : 1,
        ceiling: SILENT_ERROR_CEILING,
      },
      challenge: {
        ok: Boolean(challenge) && challenge.total >= CHALLENGE_SIZE && challenge.challengeIncorrectAutomatic === 0,
        total: challenge?.total ?? 0,
        required: CHALLENGE_SIZE,
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
      gates.dev.ok &&
      gates.coverage.ok &&
      gates.silentError.ok &&
      gates.challenge.ok &&
      gates.referenceCheck.ok &&
      (approvedContract ? approvedContract === manifest.contractRevision : true)

    const report = {
      kind: 'evaluation',
      schemaVersion: 1,
      routine: id,
      version,
      contractRevision: manifest.contractRevision,
      generatedAt: new Date().toISOString(),
      engine: { name: store.ENGINE_NAME, version: store.ENGINE_VERSION },
      passed,
      gates,
      metrics,
      cases: caseRecords,
      evidence,
      reproducibility: {
        engine: { name: store.ENGINE_NAME, version: store.ENGINE_VERSION },
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: root,
        environment: options.environment ?? {},
        modelSnapshot: options.modelSnapshot ?? null,
        promptVersions: options.promptVersions ?? null,
        toolVersions: options.toolVersions ?? null,
        codeRevision: options.codeRevision ?? evidence?.manifestSha256 ?? null,
        caseSetHash: evidence?.fixtureHashes ? store.sha256Value(evidence.fixtureHashes) : null,
        evidenceHash: evidence?.evidenceHash ?? null,
        generatedAt: new Date().toISOString(),
      },
      notes: options.notes ?? [],
    }
    const reportFile = await store.writeReport(root, report)
    report.reportPath = reportFile
    report.reportSha256 = await store.sha256File(reportFile)

    // Already inside the root lock; write the registry document directly so the
    // lock is not re-entered (a re-entrant wait would stall the evaluation).
    const currentRegistry = await store.readRegistry(root)
    const mutateReport = (current) => {
      const routine = (current.routines[id] ??= { title: manifest.title, versions: {} })
      routine.title = manifest.title
      const versionEntry = (routine.versions[version] ??= { status: 'candidate', createdAt: new Date().toISOString() })
      versionEntry.lastReport = {
        at: report.generatedAt,
        path: reportFile,
        sha256: report.reportSha256,
        passed,
        evidenceHash: evidence?.evidenceHash ?? null,
        gatesSummary: {
          coverage: gates.coverage.value,
          silentErrorUpperBound: gates.silentError.upperBound95,
          challengeIncorrectAutomatic: gates.challenge.incorrectAutomatic,
          e2eSuccess: gates.e2eSuccess.value,
        },
      }
      if (approvedContract && approvedContract !== manifest.contractRevision && versionEntry.status === 'active') {
        versionEntry.status = 'suspended'
        versionEntry.suspendedAt = report.generatedAt
        versionEntry.suspendReason = 'schema-drift detected during re-evaluation'
      }
      return current
    }
    await store.writeRegistry(root, mutateReport(currentRegistry))
    return report
  })
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
// Public runtime entry (logs every decision)
// ---------------------------------------------------------------------------

export async function invokeRoutine(rootInput, id, version, input, options = {}) {
  const root = await store.ensureRoot(rootInput)
  const manifest = await store.readManifest(root, id, version)
  const routineDirectory = await store.resolveRoutineDir(root, id, version)
  const hooks = await store.loadHooks(routineDirectory, manifest)
  const result = await runCase({ root, id, version, input, manifest, hooks, routineDirectory })
  const registry = await store.readRegistry(root)
  const active = registry.routines?.[id]?.versions?.[version]?.status
  if (options.log !== false) {
    await store.appendRouteLog(root, {
      routine: id,
      version,
      status: active ?? 'unknown',
      contractRevision: manifest.contractRevision,
      route: 'auto',
      decision: result.decision,
      reason: result.reason,
      disposition: result.disposition,
      fieldId: result.bound?.fieldId ?? null,
      unit: result.bound?.unit ?? null,
      inputHash: store.sha256Value(input),
      checks: result.checks?.map((check) => ({ id: check.id, ok: check.ok })) ?? null,
    })
  }
  return {
    routine: id,
    version,
    contractRevision: manifest.contractRevision,
    registryStatus: active ?? 'unknown',
    decision: result.decision,
    reason: result.reason,
    disposition: result.disposition,
    bound: result.bound,
    output: result.output,
    checks: result.checks,
    latencyMs: result.latencyMs,
  }
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
  // Directory names follow the framework's "v1" convention while the registry
  // keys and manifests carry the numeric label; use the manifest label so one
  // routine version never appears twice.
  const entryVersions = new Map()
  for (const entry of entries) {
    let label = entry.version
    try {
      const manifest = JSON.parse(await fsp.readFile(entry.manifestPath, 'utf8'))
      label = String(manifest.version ?? entry.version)
    } catch {
      // keep the directory label when the manifest is unreadable
    }
    if (!entryVersions.has(entry.id)) entryVersions.set(entry.id, new Set())
    entryVersions.get(entry.id).add(label)
  }
  for (const id of [...ids].sort()) {
    const routineEntry = registry.routines?.[id] ?? { versions: {} }
    const versions = new Set([
      ...Object.keys(routineEntry.versions ?? {}),
      ...(entryVersions.get(id) ?? new Set()),
    ])
    const versionViews = []
    for (const version of [...versions].sort()) {
      const versionEntry = routineEntry.versions?.[version] ?? { status: 'candidate' }
      versionViews.push({
        version,
        status: versionEntry.status ?? 'candidate',
        createdAt: versionEntry.createdAt ?? null,
        approvedRelease: versionEntry.approvedRelease ?? null,
        lastReport: versionEntry.lastReport ?? null,
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
// Proposal, release, withdrawal
// ---------------------------------------------------------------------------

export async function proposeRoutine(rootInput, proposal) {
  const root = await store.ensureRoot(rootInput)
  const { id, version, manifest, files = {}, fixtures = {}, overwrite = false } = proposal ?? {}
  store.assertSafeSegment(id, store.ID_PATTERN, 'routine id')
  store.assertSafeSegment(String(version), store.VERSION_PATTERN, 'routine version')
  if (!manifest || typeof manifest !== 'object') throw new Error('proposal.manifest is required')
  if (manifest.id !== id || String(manifest.version) !== String(version)) {
    throw new Error('proposal.manifest.id/version must match the proposal id/version')
  }
  const issues = validateManifest(manifest)
  if (issues.length > 0) throw new Error(`candidate manifest is invalid: ${issues.join('; ')}`)
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
    await fsp.mkdir(fixtureDirectory, { recursive: true })
    const fixtureSets = {}
    for (const set of DECISION_SETS) {
      const cases = fixtures[set]
      if (!Array.isArray(cases)) throw new Error(`fixtures.${set} must be an array of cases`)
      for (const fixtureCase of cases) {
        if (typeof fixtureCase.id !== 'string' || !fixtureCase.input || !fixtureCase.expect) {
          throw new Error(`fixtures.${set} case ${fixtureCase.id ?? '<unknown>'} needs id, input and expect`)
        }
      }
      const fixturePath = path.join(fixtureDirectory, `${set}.json`)
      await fsp.writeFile(
        fixturePath,
        JSON.stringify({ schemaVersion: 1, set, provenance: 'trace-derived', frozenAt: new Date().toISOString(), cases }, null, 2),
        'utf8',
      )
      fixtureSets[set] = path.relative(root, fixturePath).split(path.sep).join('/')
    }
    const candidateManifest = {
      ...manifest,
      version,
      evidence: { ...manifest.evidence, fixtureSets },
    }
    await fsp.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(candidateManifest, null, 2), 'utf8')

    registry.routines[id] ??= { title: candidateManifest.title, versions: {} }
    registry.routines[id].title = candidateManifest.title
    registry.routines[id].versions[String(version)] = {
      ...(versionEntry ?? {}),
      status: 'candidate',
      createdAt: versionEntry?.createdAt ?? new Date().toISOString(),
      contractRevision: candidateManifest.contractRevision,
      evidenceHash: versionEntry?.evidenceHash ?? null,
      approvedRelease: null,
    }
    await store.writeRegistry(root, registry)
    return {
      routine: id,
      version: String(version),
      directory,
      files: Object.keys(files),
      fixtureSets,
      provenance: candidateManifest.evidence?.provenance ?? 'trace-derived',
      sourceTraces: candidateManifest.evidence?.derivationTraces ?? [],
    }
  })
}

async function assertFreshEvidence(root, id, version) {
  const manifest = await store.readManifest(root, id, version)
  const routineDirectory = await store.resolveRoutineDir(root, id, version)
  const evidence = await collectEvidence(root, routineDirectory, manifest)
  const report = await store.latestReport(root, id, version)
  if (!report) throw new Error('release requires an evaluation report; run routine_evaluate first')
  if (!report.passed) throw new Error('release blocked: the latest evaluation did not pass every gate')
  if (!report.evidence || report.evidence.manifestSha256 !== evidence.manifestSha256) {
    throw new Error('release blocked: the manifest changed after the last evaluation; re-run routine_evaluate')
  }
  for (const set of DECISION_SETS) {
    const recorded = report.evidence.fixtureSets?.[set]?.sha256
    const currentHash = evidence.fixtureSets?.[set]?.sha256
    if (recorded !== currentHash) throw new Error(`release blocked: the ${set} fixture set changed after the last evaluation`)
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
    }
    registry.fallback = previousActive ? { id, version: previousActive[0] } : registry.fallback ?? null
    await store.writeRegistry(root, registry)
    await store.writeDecisionRecord(root, {
      kind: 'release',
      routine: id,
      version: String(version),
      at: new Date().toISOString(),
      by: options.by ?? 'user',
      reportPath: report.reportPath,
      evidenceHash: evidence.evidenceHash,
      fallback: registry.fallback,
    })
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
    await store.writeDecisionRecord(root, {
      kind: 'withdraw',
      routine: id,
      version: String(version),
      at: new Date().toISOString(),
      by: options.by ?? 'user',
      reason,
      fallback: registry.fallback,
    })
    return registry
  })
}

// ---------------------------------------------------------------------------
// Paired arm comparison (framework page 6)
// ---------------------------------------------------------------------------

function orderedArm(record) {
  const arm = String(record.arm ?? '').toUpperCase()
  if (!['A', 'B', 'C'].includes(arm)) throw new Error(`arm record ${record.file ?? '<inline>'} has no A/B/C arm label`)
  return arm
}

function armCaseMap(record) {
  const map = new Map()
  for (const armCase of record.cases ?? []) {
    if (typeof armCase.caseId !== 'string') continue
    map.set(armCase.caseId, armCase)
  }
  return map
}

function armSummary(record, caseIds) {
  const cases = record.cases ?? []
  const present = caseIds.map((id) => (record.cases ?? []).find((entry) => entry.caseId === id)).filter(Boolean)
  const resolved = present.filter((entry) => entry.resolved === true).length
  const correct = present.filter((entry) => entry.correct === true).length
  const costs = present.map((entry) => Number(entry.costUsd)).filter(Number.isFinite)
  const latencies = present.map((entry) => Number(entry.latencyMs)).filter(Number.isFinite)
  const requests = record.workload?.requests ?? caseIds.length
  const perRequest = stats.mean(costs)
  const cost = stats.costProjection({
    setupCostUsd: Number(record.setupCostUsd) || 0,
    maintenanceCostUsd: Number(record.maintenanceCostUsd) || 0,
    perRequestCostUsd: perRequest,
    requests,
  })
  const successRate = stats.ratio(resolved, present.length)
  const correctResolutions = Math.max(1, Math.round(requests * stats.ratio(correct, present.length)))
  return {
    arm: orderedArm(record),
    label: record.label ?? orderedArm(record),
    records: present.length,
    requests,
    resolved,
    correct,
    successRate,
    correctRate: stats.ratio(correct, present.length),
    perRequestCostUsd: perRequest,
    totalCostUsd: cost.totalCostUsd,
    costPerCorrectResolutionUsd: cost.totalCostUsd / correctResolutions,
    authoringHours: Number(record.authoringHours) || null,
    latency: stats.latencySummary(latencies),
  }
}

export async function compareArms(rootInput, options = {}) {
  const root = await store.ensureRoot(rootInput)
  const runId = options.runId
  let records = await store.listArmRecords(root)
  if (records.length === 0) throw new Error('no arm records found under arms/; seed the example or add arm JSON files')
  if (runId) {
    records = records.filter((record) => record.runId === runId || record.fileName.startsWith(`${runId}-`))
    if (records.length === 0) throw new Error(`no arm records matched runId ${runId}`)
  }
  const byArm = new Map()
  for (const record of records) {
    const arm = orderedArm(record)
    const previous = byArm.get(arm)
    if (!previous || record.mtimeMs > previous.mtimeMs) byArm.set(arm, record)
  }
  for (const required of ['A', 'B', 'C']) {
    if (!byArm.has(required)) throw new Error(`comparison requires arm ${required}; found ${[...byArm.keys()].join(', ') || 'none'}`)
  }
  const armA = byArm.get('A')
  const armB = byArm.get('B')
  const armC = byArm.get('C')
  const maps = { A: armCaseMap(armA), B: armCaseMap(armB), C: armCaseMap(armC) }
  const caseIds = [...maps.C.keys()].filter((id) => maps.A.has(id) && maps.B.has(id)).sort()
  if (caseIds.length === 0) throw new Error('arms A, B and C share no paired case ids')

  const summary = {
    A: armSummary(armA, caseIds),
    B: armSummary(armB, caseIds),
    C: armSummary(armC, caseIds),
  }
  const comparisons = {}
  for (const baseline of ['A', 'B']) {
    const baselineFlags = caseIds.map((id) => (maps[baseline].get(id).resolved === true ? 1 : 0))
    const candidateFlags = caseIds.map((id) => (maps.C.get(id).resolved === true ? 1 : 0))
    const discordant = stats.discordantPairs(candidateFlags, baselineFlags)
    comparisons[baseline] = {
      discordant,
      bootstrap: stats.bootstrapPairedDiff(candidateFlags, baselineFlags, { iterations: 2000, seed: 20261104 }),
      zeroDiscordance: discordant.discordant === 0 ? stats.zeroDiscordanceBound(caseIds.length) : null,
    }
  }

  let report = null
  if (options.routine && options.version) {
    report = await store.latestReport(root, options.routine, String(options.version))
  }
  const gatesPassed = report ? report.passed === true : null
  const beatsBaselines = summary.C.successRate >= summary.A.successRate && summary.C.successRate >= summary.B.successRate
  const cheaper = summary.C.totalCostUsd < summary.A.totalCostUsd && summary.C.totalCostUsd < summary.B.totalCostUsd
  const advance = gatesPassed === true && beatsBaselines && cheaper
  const comparison = {
    kind: 'compare',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: runId ?? armC.runId ?? null,
    pairedCases: caseIds.length,
    workload: armC.workload ?? null,
    arms: summary,
    comparisons,
    candidateGates: report
      ? {
          passed: report.passed,
          reportPath: report.reportPath ?? null,
          reportSha256: report.reportSha256 ?? null,
          summary: {
            coverage: report.gates?.coverage?.value ?? null,
            silentErrorUpperBound: report.gates?.silentError?.upperBound95 ?? null,
            challengeIncorrectAutomatic: report.gates?.challenge?.incorrectAutomatic ?? null,
            e2eSuccess: report.gates?.e2eSuccess?.value ?? null,
          },
        }
      : { passed: null, summary: null, reason: 'no routine/version supplied; evaluate the candidate to load its gates' },
    pilotDecision: {
      advance,
      gatesPassed,
      beatsBaselines,
      cheaper,
      rule: 'advance C only if it passes the error, challenge and coverage gates, reaches at least the observed end-to-end success of each baseline, and has a lower projected total cost than both baselines',
    },
    notes: options.notes ?? [],
  }
  const file = await store.writeReport(root, comparison)
  comparison.reportPath = file
  comparison.reportSha256 = await store.sha256File(file)
  return comparison
}
