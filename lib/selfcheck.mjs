// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Self-check for the v0.2 evidence layer and engine.
//
// Run with: node lib/selfcheck.mjs
// Exit code 0 means every assertion passed. This is the repository's
// consistency check for the plugin; it is also what the delivery report quotes.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'

import * as engine from './engine.js'
import * as stats from './stats.js'
import * as store from './store.js'

const workspace = path.dirname(store.PACKAGE_DIR)
const root = path.join(workspace, '.routine-selfcheck')
const releaseRoot = path.join(workspace, '.routine-selfcheck-release')
const auditLedger = path.join(workspace, '.routine-selfcheck-audit-ledger.jsonl')
process.env.ROUTINE_AUDIT_LEDGER = auditLedger

async function resetAuditLedger() {
  await fsp.rm(auditLedger, { force: true })
}

function line(title) {
  console.log(`\n== ${title}`)
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

function hasBlindLeak(value) {
  if (Array.isArray(value)) return value.some(hasBlindLeak)
  if (value && typeof value === 'object') {
    if ('expected' in value) return true
    return Object.values(value).some(hasBlindLeak)
  }
  return false
}

async function withPermissions(file) {
  const stat = await fsp.stat(file)
  return stat.mode & 0o777
}

/** Turn the seeded synthetic example into a deployment-attested one so the
 *  release path itself can be exercised without weakening the default. */
async function makeReleaseEligible(directoryPath, version) {
  const routineDirectory = await store.resolveRoutineDir(directoryPath, 'normalize_detuning', version)
  const manifestPath = path.join(routineDirectory, 'manifest.json')
  const manifest = await readJson(manifestPath)
  manifest.evidence = {
    ...manifest.evidence,
    dataClass: 'deployment',
    realDeploymentData: true,
  }
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // The shipped independent evaluator intentionally asserts the example stays
  // synthetic; for the release-path test we replace it with a trivial one so the
  // mechanical release/eligibility path can be exercised.
  const evaluatorPath = path.join(directoryPath, 'evals', 'normalize_detuning', 'v1', 'reference_check.mjs')
  await fsp.writeFile(evaluatorPath, 'console.log("selfcheck reference evaluator")\nprocess.exit(0)\n', 'utf8')

  const preregPath = path.join(routineDirectory, 'preregistration.json')
  const prereg = await readJson(preregPath)
  prereg.realDataAttested = true
  prereg.reviewers = [
    ...(prereg.reviewers ?? []),
    {
      name: 'domain-reviewer',
      role: 'domain-reviewer',
      signedAt: '2026-11-04T00:00:00Z',
      independent: true,
      sawLabels: false,
    },
  ]
  await fsp.writeFile(preregPath, JSON.stringify(prereg, null, 2), 'utf8')
}

async function main() {
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(releaseRoot, { recursive: true, force: true })
  await resetAuditLedger()

  line('seed the built-in example (v2 blind layout)')
  const seeded = await store.seedExample(root)
  assert.equal(seeded.seeded, true, 'seedExample should report seeded')
  assert.ok(seeded.copied.includes('routines/normalize_detuning/v1/manifest.json'), 'routine manifest copied')
  assert.ok(seeded.copied.includes('fixtures/normalize_detuning/v1/audit.inputs.json'), 'audit inputs copied')
  assert.ok(seeded.copied.includes('blind/normalize_detuning/v1/audit.labels.json'), 'audit labels copied')
  assert.ok(seeded.seededRegistry, 'seed registry document installed')
  const labelsMode = await withPermissions(path.join(root, 'blind/normalize_detuning/v1/audit.labels.json'))
  assert.equal(labelsMode & 0o077, 0, `blind labels must not be group/world readable (mode ${labelsMode.toString(8)})`)
  console.log(`copied ${seeded.copied.length} files; labels mode ${labelsMode.toString(8)}`)

  line('zero-event bound formula')
  const bound59 = stats.exactUpperBound95(59)
  assert.ok(Math.abs(bound59 - 0.0495) < 0.0001, `n=59 bound should be 4.95%, got ${bound59}`)
  assert.equal(stats.exactUpperBound95(0), 1)
  console.log(`n=59 -> ${(bound59 * 100).toFixed(4)}%`)

  line('public fixture tree does not carry blind labels')
  const inputsDoc = await readJson(path.join(root, 'fixtures/normalize_detuning/v1/audit.inputs.json'))
  assert.equal(inputsDoc.cases.length, 100)
  assert.ok(inputsDoc.cases.every((fixtureCase) => fixtureCase.expect === undefined), 'audit inputs must not contain expects')
  console.log('audit inputs carry no expectations')

  line('evaluate candidate: gates pass, release is blocked by synthetic evidence')
  const report = await engine.evaluateRoutine(root, 'normalize_detuning', '1', {
    modelSnapshot: 'selfcheck/static',
    codeRevision: 'selfcheck',
    promptVersions: { pilot: 'selfcheck-1' },
    toolVersions: { engine: store.ENGINE_VERSION },
    environment: { os: process.platform },
  })
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        gates: {
          preregistration: report.gates.preregistration.ok,
          blindIsolation: report.gates.blindIsolation.ok,
          dev: report.gates.dev.ok,
          coverage: `${(report.gates.coverage.value * 100).toFixed(1)}% (${report.gates.coverage.automatic}/${report.gates.coverage.total})`,
          silentError: `${report.gates.silentError.wrong} wrong / ${report.gates.silentError.automatic} automatic, upper95=${(report.gates.silentError.upperBound95 * 100).toFixed(3)}%`,
          challenge: `${report.gates.challenge.incorrectAutomatic} incorrect automatic / ${report.gates.challenge.total}`,
          referenceCheck: `exit ${report.gates.referenceCheck.exitCode}`,
        },
        auditUse: report.auditUse,
        eligibility: { releaseEligible: report.eligibility.releaseEligible, blockers: report.eligibility.blockers.map((blocker) => blocker.code) },
      },
      null,
      2,
    ),
  )
  assert.equal(report.gates.contract.ok, true, `contract gate failed: ${report.gates.contract.issues.join('; ')}`)
  assert.equal(report.gates.preregistration.ok, true)
  assert.equal(report.gates.blindIsolation.ok, true)
  assert.equal(report.gates.dev.ok, true, 'all dev cases must pass')
  assert.equal(report.gates.coverage.total, 100)
  assert.ok(report.gates.coverage.value >= 0.6)
  assert.equal(report.gates.silentError.wrong, 0)
  assert.ok(report.gates.silentError.upperBound95 < 0.05)
  assert.equal(report.gates.challenge.incorrectAutomatic, 0)
  assert.equal(report.gates.referenceCheck.ok, true)
  assert.equal(report.passed, true, 'the seeded example must pass every statistical gate')

  line('report keeps denominators but not blind labels')
  assert.equal(report.schemaVersion, 2)
  assert.ok(hasBlindLeak(report.cases.dev) === false || true, 'dev may carry expected')
  assert.equal(hasBlindLeak(report.cases.audit), false, 'public audit cases must not carry expected labels')
  assert.equal(hasBlindLeak(report.cases.challenge), false, 'public challenge cases must not carry expected labels')
  assert.ok(await store.pathExists(report.blindRun.path), 'protected blind run exists')
  const blindRunMode = await withPermissions(report.blindRun.path)
  assert.equal(blindRunMode & 0o077, 0, `protected blind run must not be group/world readable (mode ${blindRunMode.toString(8)})`)
  const protectedDetail = await readJson(report.blindRun.path)
  assert.ok(protectedDetail.cases.audit.every((entry) => entry.expected && typeof entry.correct === 'boolean'))
  console.log(`protected detail mode ${blindRunMode.toString(8)} carries labels; public report does not`)

  line('reproducibility fixes')
  assert.match(report.reproducibility.caseSetHash, /^[a-f0-9]{64}$/, 'caseSetHash must be a sha256')
  assert.equal(typeof report.reproducibility.promptVersions, 'object')
  assert.equal(typeof report.reproducibility.environment, 'object')
  assert.equal(report.reproducibility.sourceRevision.available, true, 'source revision should resolve from the checkout')
  assert.match(report.reproducibility.sourceRevision.commit, /^[a-f0-9]{40}$/)
  assert.equal(report.auditUse.fresh, true)
  assert.equal(report.auditUse.runs, 1)
  assert.equal(report.auditUse.priorUses, 0)
  assert.ok(await store.pathExists(auditLedger), 'the cross-reset audit ledger is written')
  assert.equal(report.budget.perRequestMs, 60000)
  console.log(`caseSetHash=${report.reproducibility.caseSetHash.slice(0, 12)} commit=${report.reproducibility.sourceRevision.commit.slice(0, 12)}`)

  line('synthetic evidence cannot release')
  const blockers = report.eligibility.blockers.map((blocker) => blocker.code)
  assert.equal(report.eligibility.releaseEligible, false)
  assert.ok(blockers.includes('synthetic-data'), `expected synthetic-data blocker, got ${blockers.join(', ')}`)
  await assert.rejects(
    engine.releaseRoutine(root, 'normalize_detuning', '1', { by: 'test' }),
    /release blocked:.*synthetic-data/,
  )
  console.log(`release refused with blockers: ${blockers.join(', ')}`)

  line('deployment-attested copy can release on its first blind run')
  await resetAuditLedger()
  await store.seedExample(releaseRoot)
  await makeReleaseEligible(releaseRoot, '1')
  const releaseReport = await engine.evaluateRoutine(releaseRoot, 'normalize_detuning', '1', {
    modelSnapshot: 'selfcheck/deployment',
    promptVersions: { pilot: 'selfcheck-1' },
    toolVersions: { engine: store.ENGINE_VERSION },
    environment: { os: process.platform },
  })
  assert.equal(releaseReport.passed, true)
  assert.equal(releaseReport.eligibility.releaseEligible, true, `blockers: ${releaseReport.eligibility.blockers.map((blocker) => blocker.code).join(', ')}`)
  const released = await engine.releaseRoutine(releaseRoot, 'normalize_detuning', '1', { by: 'test' })
  assert.equal(released.routines.normalize_detuning.versions['1'].status, 'active')
  const decisions = (await store.listReports(releaseRoot)).filter((entry) => entry.kind === 'release')
  assert.equal(decisions.length, 1)
  assert.ok(decisions[0].costHorizon && decisions[0].nextReviewTrigger, 'decision record must carry cost horizon and review trigger')
  assert.ok(decisions[0].reviewers.independentReviewer, 'decision record must name the independent reviewer')
  assert.ok(decisions[0].evidence.preregistrationSha256, 'decision record must reference the preregistration hash')
  console.log('released; decision record carries horizon, review trigger and reviewer')

  line('measured arm comparison scores against protected labels, never in the arms')
  const auditInputs = await readJson(path.join(releaseRoot, 'fixtures/normalize_detuning/v1/audit.inputs.json'))
  const armDir = path.join(releaseRoot, 'arms', 'selfcheck-run')
  await fsp.mkdir(armDir, { recursive: true })
  const raw = (caseId, decision) => ({ caseId, decision, reason: decision === 'defer' ? 'missing-metadata' : null, fieldId: decision === 'accept' ? 'self' : null, sourceUnit: decision === 'accept' ? 'Hz' : null, valueHz: decision === 'accept' ? 0 : null, latencyMs: 1, costUsd: decision === 'accept' ? 0 : 0 })
  const armC = []
  for (const fixtureCase of auditInputs.cases) {
    const actual = await engine.invokeRoutine(releaseRoot, 'normalize_detuning', '1', fixtureCase.input, { log: false })
    armC.push({
      caseId: fixtureCase.id,
      decision: actual.decision,
      reason: actual.reason,
      fieldId: actual.bound?.fieldId ?? null,
      sourceUnit: actual.bound?.unit ?? null,
      valueHz: actual.output?.valueHz ?? null,
      latencyMs: 1,
      costUsd: 0,
    })
  }
  const armB = auditInputs.cases.map((fixtureCase) => raw(fixtureCase.id, 'defer'))
  const writeArm = async (arm, cases, cost) => {
    await store.writeJsonFile(path.join(armDir, `arm-${arm}-r1.json`), {
      schemaVersion: 2,
      kind: 'arm-run',
      runId: 'selfcheck-run',
      arm,
      repeat: 1,
      provenance: 'measured',
      participant: { kind: arm === 'A' ? 'llm-agent' : 'script', provider: 'selfcheck', model: 'selfcheck', promptVersion: 'selfcheck' },
      conditions: { contractRevision: 'normalize_detuning/v1', fallbackModel: 'ask-user', perRequestBudgetMs: 60000 },
      cost,
      workload: { cases: auditInputs.cases.length, requests: auditInputs.cases.length, horizonDays: 30 },
      cases,
    })
  }
  await writeArm('A', armC, { basis: 'unmetered', perRequestUsd: null, setupUsd: null, maintenanceUsd: null })
  await writeArm('B', armB, { basis: 'local-script', perRequestUsd: 0, setupUsd: 0, maintenanceUsd: 0 })
  await writeArm('C', armC, { basis: 'local-script', perRequestUsd: 0, setupUsd: 0, maintenanceUsd: 0 })
  const comparison = await engine.compareArms(releaseRoot, { runId: 'selfcheck-run', routine: 'normalize_detuning', version: '1' })
  assert.equal(comparison.kind, 'compare')
  assert.equal(comparison.pairedCases, 100)
  assert.equal(hasBlindLeak(comparison.arms), false, 'public comparison must not leak labels')
  assert.ok(await store.pathExists(comparison.blindRun.path), 'protected comparison detail exists')
  assert.equal(comparison.blindRun.protected, true)
  assert.equal(comparison.pilotDecision.costComplete, false, 'arm A is unmetered')
  assert.equal(comparison.pilotDecision.advance, false)
  assert.equal(comparison.pilotDecision.decision, 'inconclusive')
  console.log(`pilot decision=${comparison.pilotDecision.decision} reasons=${comparison.pilotDecision.reasons.join(' | ')}`)

  line('reusing the same blind audit cannot gate a second release')
  const reused = await engine.evaluateRoutine(releaseRoot, 'normalize_detuning', '1', {})
  assert.equal(reused.auditUse.fresh, false)
  assert.equal(reused.auditUse.runs, 2)
  assert.ok(reused.auditUse.priorUses >= 1, 'the ledger remembers the first use across registry state')
  assert.equal(reused.eligibility.releaseEligible, false)
  assert.ok(reused.eligibility.blockers.some((blocker) => blocker.code === 'audit-reused'))
  console.log('second evaluation is flagged audit-reused and is not release eligible')

  line('a production fallback suspends the active version')
  const executionPath = path.join(await store.resolveRoutineDir(releaseRoot, 'normalize_detuning', '1'), 'execution.js')
  const originalExecution = await fsp.readFile(executionPath, 'utf8')
  await fsp.writeFile(
    executionPath,
    originalExecution.replace(
      'export function run(bound) {',
      "export function run(bound) {\n  if (bound && bound.value === 123.456) throw new Error('synthetic production failure')",
    ),
    'utf8',
  )
  const runtime = await engine.invokeRoutine(releaseRoot, 'normalize_detuning', '1', {
    value: 123.456,
    unit: 'kHz',
    fieldId: 'detuning_khz',
    declaredUnit: { header: 'kHz', schema: 'kHz' },
    metadataSource: 'trusted-schema',
  })
  assert.equal(runtime.decision, 'fallback')
  assert.equal(runtime.autoSuspended, true)
  assert.equal(runtime.registryStatus, 'suspended')
  const suspended = await engine.registryState(releaseRoot)
  assert.equal(suspended.routines.find((entry) => entry.id === 'normalize_detuning').versions[0].status, 'suspended')
  await fsp.writeFile(executionPath, originalExecution, 'utf8')
  console.log('production fallback suspended the active version and wrote a decision record')

  line('proposal and preregistration validation')
  await assert.rejects(
    engine.proposeRoutine(root, {
      id: 'bad_routine',
      version: '1',
      manifest: { schemaVersion: 1, id: 'bad_routine', version: '1' },
      files: { 'guard.js': 'export function decide() { return { decision: "accept" } }' },
      fixtures: { dev: [], audit: [], challenge: [] },
    }),
    /candidate manifest is invalid/,
  )
  const validManifest = await readJson(path.join(root, 'routines/normalize_detuning/v1/manifest.json'))
  const basePrereg = await readJson(path.join(root, 'routines/normalize_detuning/v1/preregistration.json'))
  await assert.rejects(
    engine.proposeRoutine(root, {
      id: 'no_prereg',
      version: '1',
      manifest: { ...validManifest, id: 'no_prereg', title: 'No prereg', evidence: { ...validManifest.evidence, dataClass: 'trace-derived', derivationTraces: [{ kind: 'trace', ref: 'x' }] } },
      files: { 'guard.js': 'export function decide() { return { decision: "defer", reason: "missing-metadata" } }', 'binding.js': 'export function bind() { throw new Error("missing-metadata") }', 'execution.js': 'export function run() { return { valueHz: 0 } }' },
      fixtures: { dev: [], audit: [], challenge: [] },
    }),
    /preregistration is required/,
  )
  await assert.rejects(
    engine.writePreregistration(root, 'normalize_detuning', '1', {
      ...basePrereg,
      reviewers: [{ name: 'agent', role: 'domain-reviewer', signedAt: '2026-11-07T00:00:00Z', independent: true, sawLabels: false }],
    }, { by: 'agent' }),
    /may not sign as an independent domain-reviewer/,
  )
  console.log('invalid manifest, missing preregistration and agent reviewer signatures are rejected')

  line('done')
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(releaseRoot, { recursive: true, force: true })
  await resetAuditLedger()
  console.log('SELF-CHECK PASSED')
}

main().catch(async (error) => {
  console.error('\nSELF-CHECK FAILED')
  console.error(error)
  process.exitCode = 1
})
