// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Self-check for the built-in example and the engine.
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
const checkRoot = path.join(workspace, '.routine-selfcheck')

function line(title) {
  console.log(`\n== ${title}`)
}

async function main() {
  await fsp.rm(checkRoot, { recursive: true, force: true })

  line('seed the built-in example')
  const seeded = await store.seedExample(checkRoot)
  assert.equal(seeded.seeded, true, 'seedExample should report seeded')
  assert.ok(seeded.copied.includes('routines/normalize_detuning/v1/manifest.json'), 'routine manifest copied')
  assert.ok(seeded.copied.includes('fixtures/normalize_detuning/v1/dev.json'), 'dev fixtures copied')
  assert.ok(seeded.seededRegistry, 'seed registry document installed')
  console.log(`copied ${seeded.copied.length} files into ${checkRoot}`)

  line('zero-event bound formula')
  const bound59 = stats.exactUpperBound95(59)
  assert.ok(Math.abs(bound59 - 0.0495) < 0.0001, `n=59 bound should be 4.95%, got ${bound59}`)
  assert.equal(stats.exactUpperBound95(0), 1)
  console.log(`n=59 -> ${(bound59 * 100).toFixed(4)}%`)

  line('registry state before evaluation')
  const before = await engine.registryState(checkRoot)
  const routine = before.routines.find((entry) => entry.id === 'normalize_detuning')
  assert.ok(routine, 'normalize_detuning should be listed')
  assert.equal(routine.versions[0].status, 'candidate', 'seeded version starts as candidate')
  assert.equal(routine.active, null, 'nothing is active before release')
  console.log(`root=${before.root} candidate=${routine.versions[0].version}`)

  line('evaluate candidate (dev + audit + challenge + independent reference check)')
  const report = await engine.evaluateRoutine(checkRoot, 'normalize_detuning', '1', {
    modelSnapshot: 'selfcheck/static',
    codeRevision: 'selfcheck',
  })
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        gates: {
          contract: report.gates.contract.ok,
          dev: report.gates.dev.ok,
          coverage: `${(report.gates.coverage.value * 100).toFixed(1)}% (${report.gates.coverage.automatic}/${report.gates.coverage.total})`,
          silentError: `${report.gates.silentError.wrong} wrong / ${report.gates.silentError.automatic} automatic, upper95=${(report.gates.silentError.upperBound95 * 100).toFixed(3)}%`,
          challenge: `${report.gates.challenge.incorrectAutomatic} incorrect automatic / ${report.gates.challenge.total}`,
          e2e: `${(report.gates.e2eSuccess.value * 100).toFixed(1)}%`,
          referenceCheck: `exit ${report.gates.referenceCheck.exitCode}`,
        },
        evidenceHash: report.evidence.evidenceHash?.slice(0, 12),
      },
      null,
      2,
    ),
  )
  assert.equal(report.gates.contract.ok, true, `contract gate failed: ${report.gates.contract.issues.join('; ')}`)
  assert.equal(report.gates.dev.total, 30)
  assert.equal(report.gates.dev.ok, true, 'all dev cases must pass')
  assert.equal(report.gates.coverage.total, 100)
  assert.ok(report.gates.coverage.value >= 0.6, 'coverage floor 60%')
  assert.equal(report.gates.silentError.wrong, 0)
  assert.ok(report.gates.silentError.upperBound95 < 0.05, 'zero-event bound must be below 5%')
  assert.equal(report.gates.challenge.total, 40)
  assert.equal(report.gates.challenge.incorrectAutomatic, 0)
  assert.equal(report.gates.referenceCheck.ok, true, `reference check failed: ${report.gates.referenceCheck.output}`)
  assert.equal(report.passed, true, 'seeded example must pass every gate')
  assert.ok(report.reportPath, 'report path recorded')
  assert.ok(await store.pathExists(report.reportPath), 'report file exists')

  line('runtime anchors from the framework (page 5)')
  const anchors = [
    { input: { value: -3.25, unit: 'kHz', fieldId: 'detuning_khz', declaredUnit: { header: 'kHz', schema: 'kHz' }, metadataSource: 'trusted-schema' }, expect: 'accept', output: { fieldId: 'detuning_khz', valueHz: -3250 } },
    { input: { value: 2 * Math.PI * 150, unit: 'rad/s', fieldId: 'angular_detuning', declaredUnit: { header: 'rad/s', schema: 'rad/s' }, metadataSource: 'trusted-schema' }, expect: 'accept', output: { fieldId: 'angular_detuning', valueHz: 150 } },
    { input: { value: 1, unit: 'kHz', fieldId: 'detuning', declaredUnit: { header: 'kHz', schema: 'kHz' }, candidates: [{ fieldId: 'drive', unit: 'kHz', role: 'drive' }, { fieldId: 'detuning', unit: 'kHz', role: 'detuning' }], metadataSource: 'trusted-schema' }, expect: 'accept', output: { fieldId: 'detuning', valueHz: 1000 } },
    { input: { value: 1, unit: 'kHz', fieldId: 'detuning', declaredUnit: { header: 'Hz', schema: 'rad/s' }, metadataSource: 'trusted-schema' }, expect: 'defer', reason: 'metadata-conflict' },
  ]
  for (const anchor of anchors) {
    const result = await engine.invokeRoutine(checkRoot, 'normalize_detuning', '1', anchor.input)
    console.log(`${anchor.expect}: decision=${result.decision} reason=${result.reason} valueHz=${result.output?.valueHz ?? '-'}`)
    assert.equal(result.decision, anchor.expect)
    if (anchor.expect === 'accept') {
      assert.equal(result.output.fieldId, anchor.output.fieldId)
      assert.ok(Math.abs(result.output.valueHz - anchor.output.valueHz) <= 1e-9 + 1e-12 * Math.abs(anchor.output.valueHz))
    } else {
      assert.equal(result.reason, anchor.reason)
    }
  }
  const log = await store.readRouteLog(checkRoot, 10)
  assert.equal(log.length, anchors.length, 'every runtime decision is logged')
  assert.ok(log[0].inputHash && log[0].inputHash.length === 64, 'log keeps a payload-minimized input hash')

  line('release requires fresh evidence (user authority)')
  const released = await engine.releaseRoutine(checkRoot, 'normalize_detuning', '1', { by: 'test' })
  assert.equal(released.routines.normalize_detuning.versions['1'].status, 'active')
  assert.ok(released.routines.normalize_detuning.versions['1'].approvedRelease, 'approval record stored')
  const decisionRecords = (await store.listReports(checkRoot)).filter((entry) => entry.kind === 'release')
  assert.equal(decisionRecords.length, 1, 'release decision written to reports/')
  console.log(`active=normalize_detuning/1 report=${decisionRecords[0].kind}`)

  line('stale evidence blocks a second release')
  const hookPath = path.join(await store.resolveRoutineDir(checkRoot, 'normalize_detuning', '1'), 'execution.js')
  const original = await fsp.readFile(hookPath, 'utf8')
  await fsp.writeFile(hookPath, original + '\n// tampered\n', 'utf8')
  await assert.rejects(
    engine.releaseRoutine(checkRoot, 'normalize_detuning', '1', { by: 'test' }),
    /changed after the last evaluation|already active/,
  )
  await fsp.writeFile(hookPath, original, 'utf8')

  line('paired arm comparison and pilot decision')
  const comparison = await engine.compareArms(checkRoot, { runId: 'example', routine: 'normalize_detuning', version: '1' })
  console.log(
    JSON.stringify(
      {
        pairedCases: comparison.pairedCases,
        arms: Object.fromEntries(
          Object.entries(comparison.arms).map(([arm, summary]) => [
            arm,
            {
              successRate: summary.successRate,
              totalCostUsd: Number(summary.totalCostUsd.toFixed(2)),
              costPerCorrectResolutionUsd: Number(summary.costPerCorrectResolutionUsd.toFixed(2)),
              latencyP50: Math.round(summary.latency.p50 ?? 0),
            },
          ]),
        ),
        discordant: Object.fromEntries(
          Object.entries(comparison.comparisons).map(([arm, value]) => [arm, value.discordant]),
        ),
        pilotDecision: comparison.pilotDecision,
      },
      null,
      2,
    ),
  )
  assert.equal(comparison.pairedCases, 100)
  assert.equal(comparison.pilotDecision.gatesPassed, true)
  assert.equal(comparison.pilotDecision.beatsBaselines, true)
  assert.equal(comparison.pilotDecision.cheaper, true)
  assert.equal(comparison.pilotDecision.advance, true)
  assert.ok(comparison.arms.C.totalCostUsd < comparison.arms.A.totalCostUsd)
  assert.ok(comparison.arms.C.latency.p50 < comparison.arms.A.latency.p50)

  line('proposal validation rejects a bad candidate')
  await assert.rejects(
    engine.proposeRoutine(checkRoot, {
      id: 'bad_routine',
      version: '1',
      manifest: { schemaVersion: 1, id: 'bad_routine', version: '1' },
      files: { 'guard.js': 'export function decide() { return { decision: "accept" } }' },
      fixtures: { dev: [], audit: [], challenge: [] },
    }),
    /candidate manifest is invalid/,
  )
  console.log('invalid manifest rejected as expected')

  line('withdrawal disables automatic use')
  const withdrawn = await engine.withdrawRoutine(checkRoot, 'normalize_detuning', '1', { by: 'test', reason: 'self-check withdrawal' })
  assert.equal(withdrawn.routines.normalize_detuning.versions['1'].status, 'withdrawn')
  const afterWithdraw = await engine.registryState(checkRoot)
  assert.equal(afterWithdraw.routines.find((entry) => entry.id === 'normalize_detuning').active, null)
  console.log('withdrawn; active pointer cleared')

  line('done')
  await fsp.rm(checkRoot, { recursive: true, force: true })
  console.log('SELF-CHECK PASSED')
}

main().catch(async (error) => {
  console.error('\nSELF-CHECK FAILED')
  console.error(error)
  process.exitCode = 1
})
