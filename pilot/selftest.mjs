#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * `pilot/selftest.mjs` — end-to-end self-check for the pilot harness.
 *
 * It builds a throwaway registry root from `seed/**` (routines, fixtures,
 * evals, registry), guarantees a readable inputs-only audit fixture, optionally
 * stubs a measured arm-A set, and then executes `pilot/run.mjs` for real.
 *
 * Asserted properties:
 *   1. arm record schema v2 (fields, participant, cost basis, workload,
 *      condition block, per-case fields, firstRoute/finalOutcome mapping);
 *   2. full case coverage and unique caseIds for B and C, repeats 1..3;
 *   3. determinism: every arm repeats the same decision/values across repeats;
 *   4. arm-B contract parity with the engine (arm C) on the same inputs;
 *   5. blind discipline: generated records carry no correct/expected labels,
 *      the input fixture stays inputs-only, and the runner never touches
 *      `blind/**`, `*.labels.json` or the legacy label-bearing `audit.json`;
 *   6. `--arm-a <dir>` ingest: validated, verbatim-copied measured records.
 *
 * Exits 0 when everything passes, 1 otherwise. The temporary root is removed on
 * success and kept (path printed) on failure.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { solve } from './arm-b.mjs'

const PILOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PILOT_DIR, '..')
const RUNNER = path.join(PILOT_DIR, 'run.mjs')
const ROUTINE = 'normalize_detuning'
const VERSION = '1'
const VERSION_DIR = 'v1'
const AUDIT_SUBDIR = path.join('fixtures', ROUTINE, VERSION_DIR)
const PER_CASE_KEYS = [
  'caseId',
  'decision',
  'reason',
  'fieldId',
  'sourceUnit',
  'valueHz',
  'latencyMs',
  'costUsd',
  'firstRoute',
  'finalOutcome',
]
const LABEL_FIELD_PATTERN = /"(correct|expected|expect)"\s*:/g

function log(message) {
  console.log(`[selftest] ${message}`)
}

async function exists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'))
}

async function copySeedTree(root) {
  for (const directory of ['routines', 'fixtures', 'evals', 'registry']) {
    const source = path.join(REPO_ROOT, 'seed', directory)
    if (!(await exists(source))) continue
    await fsp.cp(source, path.join(root, directory), { recursive: true })
  }
}

/**
 * The v2 layout ships `audit.inputs.json`. Until the fixture split lands, derive
 * an inputs-only projection from the legacy `audit.json` so the pilot harness can
 * still be exercised. The projection drops every label field.
 */
async function ensureAuditInputs(root) {
  const target = path.join(root, AUDIT_SUBDIR, 'audit.inputs.json')
  if (await exists(target)) return { file: target, derived: false }

  const legacy = path.join(root, AUDIT_SUBDIR, 'audit.json')
  if (!(await exists(legacy))) {
    throw new Error(
      `seed has neither ${AUDIT_SUBDIR}/audit.inputs.json nor ${AUDIT_SUBDIR}/audit.json; cannot build a selftest registry`,
    )
  }
  const parsed = await readJson(legacy)
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, 'legacy audit fixture has cases')
  const cases = parsed.cases.map((entry) => {
    assert.ok(entry && typeof entry.id === 'string', 'legacy audit case has an id')
    assert.ok(entry.input && typeof entry.input === 'object', `legacy audit case ${entry.id} has input`)
    return { id: entry.id, description: entry.description ?? '', input: entry.input }
  })
  await fsp.writeFile(
    target,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        set: 'audit',
        provenance: 'synthetic',
        note: 'Inputs projected by pilot/selftest.mjs from the pre-split audit fixture; every label field was removed.',
        frozenAt: parsed.frozenAt ?? null,
        cases,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return { file: target, derived: true }
}

async function writeArmAStub(directory, cases, runId) {
  await fsp.mkdir(directory, { recursive: true })
  const files = []
  for (let repeat = 1; repeat <= 3; repeat += 1) {
    const record = {
      schemaVersion: 2,
      kind: 'arm-run',
      runId,
      arm: 'A',
      repeat,
      provenance: 'measured',
      participant: {
        kind: 'llm-agent',
        provider: 'selftest-stub',
        model: 'selftest-stub',
        promptVersion: 'selftest-stub-v1',
      },
      conditions: {
        contractRevision: `${ROUTINE}/v${VERSION}`,
        fallbackModel: 'ask-user',
        perRequestBudgetMs: 60000,
      },
      cost: {
        basis: 'unmetered',
        perRequestUsd: null,
        setupUsd: null,
        maintenanceUsd: null,
        authoringHours: null,
      },
      workload: { cases: cases.length, requests: cases.length, horizonDays: 30 },
      // Mimic the raw LLM-agent arm shape: six decision fields per case and
      // no latencyMs/costUsd; the runner must supplement those as null.
      cases: cases.map((entry) => {
        const result = solve(entry.input)
        return {
          caseId: entry.id,
          decision: result.decision,
          reason: result.reason,
          fieldId: result.fieldId,
          sourceUnit: result.sourceUnit,
          valueHz: result.valueHz,
        }
      }),
    }
    const file = path.join(directory, `arm-a-r${repeat}.json`)
    await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    files.push({ file, repeat })
  }
  return files
}

const CONTRACT_CASES = [
  {
    name: 'Hz accept',
    input: { value: 3, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz', schema: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'Hz', valueHz: 3 },
  },
  {
    name: 'kHz accept',
    input: { value: 1.5, unit: 'kHz', fieldId: 'x_detuning', declaredUnit: { header: 'kHz', schema: 'kHz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'kHz', valueHz: 1500 },
  },
  {
    name: 'rad/s accept',
    input: { value: 2 * Math.PI, unit: 'rad/s', fieldId: 'x_detuning', declaredUnit: { header: 'rad/s', schema: 'rad/s' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'rad/s', valueHz: 1 },
  },
  {
    name: 'header-only accept',
    input: { value: 2, unit: 'kHz', fieldId: 'x_detuning', declaredUnit: { header: 'kHz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'kHz', valueHz: 2000 },
  },
  {
    name: 'schema-only accept, sign preserved',
    input: { value: -2 * Math.PI, unit: 'rad/s', fieldId: 'x_detuning', declaredUnit: { schema: 'rad/s' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'rad/s', valueHz: -1 },
  },
  {
    name: 'empty candidates accept via declared fieldId',
    input: { value: 5, unit: 'Hz', fieldId: 'x_detuning', candidates: [], declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'accept', sourceUnit: 'Hz', valueHz: 5 },
  },
  {
    name: 'candidates resolve a single detuning field',
    input: {
      value: 1,
      unit: 'Hz',
      fieldId: 'probe_detuning',
      candidates: [
        { fieldId: 'modulation_drive', unit: 'Hz', role: 'drive' },
        { fieldId: 'probe_detuning', unit: 'Hz', role: 'detuning' },
      ],
      declaredUnit: { header: 'Hz', schema: 'Hz' },
      metadataSource: 'trusted-schema',
    },
    expected: { decision: 'accept', sourceUnit: 'Hz', valueHz: 1 },
  },
  {
    name: 'missing metadataSource',
    input: { value: 1, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' } },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'unverified metadataSource',
    input: { value: 1, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'unverified' },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'NaN value',
    input: { value: Number.NaN, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'invalid-value' },
  },
  {
    name: 'infinite value',
    input: { value: Number.POSITIVE_INFINITY, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'invalid-value' },
  },
  {
    name: 'string value',
    input: { value: '1', unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'invalid-value' },
  },
  {
    name: 'missing unit',
    input: { value: 1, fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'unsupported unit',
    input: { value: 1, unit: 'm/s', fieldId: 'x_detuning', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'unsupported-unit' },
  },
  {
    name: 'unit with whitespace is not silently normalized',
    input: { value: 1, unit: ' kHz ', fieldId: 'x_detuning', declaredUnit: { header: 'kHz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'unsupported-unit' },
  },
  {
    name: 'missing declaredUnit',
    input: { value: 1, unit: 'Hz', fieldId: 'x_detuning', metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'empty declaredUnit strings',
    input: { value: 1, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: '  ', schema: '' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'header/schema conflict',
    input: { value: 1, unit: 'Hz', fieldId: 'x_detuning', declaredUnit: { header: 'Hz', schema: 'kHz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'metadata-conflict' },
  },
  {
    name: 'candidates present without explicit fieldId',
    input: {
      value: 1,
      unit: 'Hz',
      candidates: [
        { fieldId: 'probe_detuning', unit: 'Hz', role: 'detuning' },
        { fieldId: 'modulation_drive', unit: 'Hz', role: 'drive' },
      ],
      declaredUnit: { header: 'Hz' },
      metadataSource: 'trusted-schema',
    },
    expected: { decision: 'defer', reason: 'competing-fields' },
  },
  {
    name: 'candidate fieldId not in the table',
    input: {
      value: 1,
      unit: 'Hz',
      fieldId: 'other_detuning',
      candidates: [{ fieldId: 'probe_detuning', unit: 'Hz', role: 'detuning' }],
      declaredUnit: { header: 'Hz' },
      metadataSource: 'trusted-schema',
    },
    expected: { decision: 'defer', reason: 'competing-fields' },
  },
  {
    name: 'candidate resolves to a drive field',
    input: {
      value: 1,
      unit: 'Hz',
      fieldId: 'modulation_drive',
      candidates: [{ fieldId: 'modulation_drive', unit: 'Hz', role: 'drive' }],
      declaredUnit: { header: 'Hz' },
      metadataSource: 'trusted-schema',
    },
    expected: { decision: 'defer', reason: 'competing-fields' },
  },
  {
    name: 'no candidates and no explicit fieldId',
    input: { value: 1, unit: 'Hz', declaredUnit: { header: 'Hz' }, metadataSource: 'trusted-schema' },
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
  {
    name: 'non-object input',
    input: null,
    expected: { decision: 'defer', reason: 'missing-metadata' },
  },
]

function assertArmBContract() {
  for (const entry of CONTRACT_CASES) {
    const result = solve(entry.input)
    assert.equal(result.decision, entry.expected.decision, `arm B contract: ${entry.name} decision`)
    if (entry.expected.decision === 'defer') {
      assert.equal(result.reason, entry.expected.reason, `arm B contract: ${entry.name} reason`)
      assert.equal(result.fieldId, null, `arm B contract: ${entry.name} fieldId`)
      assert.equal(result.sourceUnit, null, `arm B contract: ${entry.name} sourceUnit`)
      assert.equal(result.valueHz, null, `arm B contract: ${entry.name} valueHz`)
    } else {
      assert.equal(result.reason, null, `arm B contract: ${entry.name} reason`)
      assert.equal(result.sourceUnit, entry.expected.sourceUnit, `arm B contract: ${entry.name} sourceUnit`)
      assert.ok(
        Math.abs(result.valueHz - entry.expected.valueHz) <= 1e-9,
        `arm B contract: ${entry.name} valueHz ${result.valueHz} != ${entry.expected.valueHz}`,
      )
    }
  }
  log(`arm B contract table: ${CONTRACT_CASES.length} cases pass`)
}

function runPilot(args) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
  })
  assert.equal(
    result.status,
    0,
    `pilot/run.mjs exited ${result.status}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
  )
  return result
}

function assertNoLabelFields(record, label) {
  const text = JSON.stringify(record)
  for (const forbidden of ['correct', 'expected', 'expect']) {
    assert.ok(
      !new RegExp(`"${forbidden}"\\s*:`).test(text),
      `${label} must not contain a "${forbidden}" field`,
    )
  }
}

function assertArmRecord(record, { arm, repeat, caseIds }) {
  const label = `arm ${arm} repeat ${repeat}`
  assert.equal(record.schemaVersion, 2, `${label} schemaVersion`)
  assert.equal(record.kind, 'arm-run', `${label} kind`)
  assert.equal(record.arm, arm, `${label} arm`)
  assert.equal(record.repeat, repeat, `${label} repeat`)
  assert.equal(record.provenance, 'measured', `${label} provenance`)
  assert.equal(record.participant.kind, 'script', `${label} participant.kind`)
  assert.ok(typeof record.participant.model === 'string' && record.participant.model !== '', `${label} participant.model`)
  assert.equal(record.cost.basis, 'local-script', `${label} cost.basis`)
  assert.equal(record.cost.perRequestUsd, 0, `${label} cost.perRequestUsd`)
  assert.ok(record.conditions && typeof record.conditions.contractRevision === 'string', `${label} conditions.contractRevision`)
  assert.equal(record.conditions.fallbackModel, 'ask-user', `${label} conditions.fallbackModel`)
  assert.ok(Number.isFinite(record.conditions.perRequestBudgetMs), `${label} conditions.perRequestBudgetMs`)
  assert.equal(record.workload.cases, caseIds.length, `${label} workload.cases`)
  assert.ok(record.workload.requests >= caseIds.length, `${label} workload.requests`)
  assert.ok(Number.isFinite(record.workload.horizonDays) && record.workload.horizonDays > 0, `${label} workload.horizonDays`)

  assert.ok(Array.isArray(record.cases), `${label} cases array`)
  assert.equal(record.cases.length, caseIds.length, `${label} case count`)
  const seen = new Set()
  for (const armCase of record.cases) {
    for (const key of PER_CASE_KEYS) {
      assert.ok(key in armCase, `${label} case is missing "${key}"`)
    }
    assert.ok(typeof armCase.caseId === 'string' && armCase.caseId !== '', `${label} caseId`)
    assert.ok(['accept', 'defer', 'fallback'].includes(armCase.decision), `${label} decision`)
    assert.ok(Number.isFinite(armCase.latencyMs) && armCase.latencyMs >= 0, `${label} latencyMs`)
    assert.equal(armCase.costUsd, 0, `${label} costUsd`)
    assert.equal(armCase.firstRoute, armCase.decision, `${label} firstRoute`)
    const expectedOutcome =
      armCase.decision === 'accept'
        ? 'resolved'
        : armCase.decision === 'defer'
          ? 'deferred'
          : 'fallback-unresolved'
    assert.equal(armCase.finalOutcome, expectedOutcome, `${label} finalOutcome mapping`)
    if (armCase.decision === 'accept') {
      assert.ok(typeof armCase.fieldId === 'string' && armCase.fieldId !== '', `${label} accepted fieldId`)
      assert.ok(['Hz', 'kHz', 'rad/s'].includes(armCase.sourceUnit), `${label} accepted sourceUnit`)
      assert.ok(Number.isFinite(armCase.valueHz), `${label} accepted valueHz`)
    } else {
      assert.equal(armCase.fieldId, null, `${label} deferred fieldId`)
      assert.equal(armCase.sourceUnit, null, `${label} deferred sourceUnit`)
      assert.equal(armCase.valueHz, null, `${label} deferred valueHz`)
    }
    if (seen.has(armCase.caseId)) assert.fail(`${label} duplicate caseId ${armCase.caseId}`)
    seen.add(armCase.caseId)
  }
  for (const caseId of caseIds) {
    assert.ok(seen.has(caseId), `${label} missing case ${caseId}`)
  }
  assertNoLabelFields(record, label)
}

async function loadArmRecords(outDir, arm, repeats) {
  const records = []
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const file = path.join(outDir, `arm-${arm}-r${repeat}.json`)
    assert.ok(await exists(file), `expected ${path.relative(REPO_ROOT, file)}`)
    const text = await fsp.readFile(file, 'utf8')
    assert.ok(
      !LABEL_FIELD_PATTERN.test(text),
      `${file} must not contain correct/expected/expect label fields`,
    )
    LABEL_FIELD_PATTERN.lastIndex = 0
    records.push(await readJson(file))
  }
  return records
}

function sameDecision(left, right) {
  return (
    left.decision === right.decision &&
    left.reason === right.reason &&
    left.fieldId === right.fieldId &&
    left.sourceUnit === right.sourceUnit &&
    (left.valueHz === right.valueHz ||
      (Number.isFinite(left.valueHz) &&
        Number.isFinite(right.valueHz) &&
        Math.abs(left.valueHz - right.valueHz) <= 1e-9 + 1e-12 * Math.abs(right.valueHz)))
  )
}

function assertDeterministic(records, arm, caseIds) {
  const base = records[0]
  for (const record of records.slice(1)) {
    assert.equal(record.cases.length, base.cases.length, `arm ${arm} repeat ${record.repeat} case count`)
    const byCase = new Map(record.cases.map((entry) => [entry.caseId, entry]))
    for (const baseCase of base.cases) {
      const other = byCase.get(baseCase.caseId)
      assert.ok(other, `arm ${arm} repeat ${record.repeat} missing ${baseCase.caseId}`)
      assert.ok(
        sameDecision(baseCase, other),
        `arm ${arm} is not deterministic for ${baseCase.caseId}: ` +
          `${JSON.stringify(baseCase)} vs ${JSON.stringify(other)}`,
      )
    }
  }
  assert.equal(records.length, 3, `arm ${arm} repeat count`)
  assert.equal(base.cases.length, caseIds.length, `arm ${arm} primary case count`)
}

function assertArmParity(armB, armC) {
  const bByCase = new Map(armB.cases.map((entry) => [entry.caseId, entry]))
  let acceptCount = 0
  for (const candidateCase of armC.cases) {
    const baselineCase = bByCase.get(candidateCase.caseId)
    assert.ok(baselineCase, `arm C has a case arm B does not: ${candidateCase.caseId}`)
    assert.equal(
      candidateCase.decision,
      baselineCase.decision,
      `arm B/C decision mismatch for ${candidateCase.caseId}`,
    )
    assert.equal(
      candidateCase.reason,
      baselineCase.reason,
      `arm B/C reason mismatch for ${candidateCase.caseId}`,
    )
    if (candidateCase.decision === 'accept') {
      acceptCount += 1
      assert.equal(baselineCase.fieldId, candidateCase.fieldId, `arm B/C fieldId for ${candidateCase.caseId}`)
      assert.equal(baselineCase.sourceUnit, candidateCase.sourceUnit, `arm B/C sourceUnit for ${candidateCase.caseId}`)
      const difference = Math.abs(baselineCase.valueHz - candidateCase.valueHz)
      const allowed = 1e-9 + 1e-12 * Math.abs(candidateCase.valueHz)
      assert.ok(difference <= allowed, `arm B/C valueHz mismatch for ${candidateCase.caseId}`)
    }
  }
  assert.ok(acceptCount > 0, 'the audit projection must contain at least one auto-accepted case')
  return acceptCount
}

async function assertNoLabelFallback(root, auditInputsFile) {
  assert.ok(!(await exists(path.join(root, 'blind'))), 'selftest registry must not copy blind labels')
  const backup = `${auditInputsFile}.selftest-backup`
  await fsp.rename(auditInputsFile, backup)
  try {
    const result = spawnSync(
      process.execPath,
      [RUNNER, '--root', root, '--run-id', 'selftest-no-inputs', '--repeats', '1'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 },
    )
    assert.equal(result.status, 1, 'run.mjs must fail when audit.inputs.json is absent')
    assert.ok(
      `${result.stderr ?? ''}`.includes('audit inputs not found'),
      `run.mjs must refuse to run without inputs-only fixtures; stderr:\n${result.stderr ?? ''}`,
    )
    assert.ok(
      !(await exists(path.join(root, 'arms', 'selftest-no-inputs', 'arm-b-r1.json'))),
      'run.mjs must not write arm records when audit inputs are unavailable',
    )
  } finally {
    await fsp.rename(backup, auditInputsFile)
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pilot-selftest-'))
  log(`temporary registry root: ${root}`)
  try {
    await copySeedTree(root)
    const auditInputs = await ensureAuditInputs(root)
    log(
      `audit inputs: ${path.relative(root, auditInputs.file)}` +
        (auditInputs.derived ? ' (projected from pre-split audit fixture)' : ' (from seed v2 layout)'),
    )
    const auditSet = await readJson(auditInputs.file)
    const caseIds = auditSet.cases.map((entry) => entry.id)
    log(`audit cases: ${caseIds.length}`)
    assertArmBContract()

    // The runner must refuse to fall back to label-bearing fixtures at all.
    await assertNoLabelFallback(root, auditInputs.file)

    // --- Run 1: scripted arms only (B and C), 3 repeats. ---
    const runId = 'selftest'
    const runOne = runPilot(['--root', root, '--run-id', runId, '--repeats', '3'])
    const outDir = path.join(root, 'arms', runId)
    const armB = await loadArmRecords(outDir, 'b', 3)
    const armC = await loadArmRecords(outDir, 'c', 3)
    for (const record of [...armB, ...armC]) {
      assertArmRecord(record, { arm: record.arm, repeat: record.repeat, caseIds })
    }
    assertDeterministic(armB, 'B', caseIds)
    assertDeterministic(armC, 'C', caseIds)
    const acceptCount = assertArmParity(armB[0], armC[0])
    log(`arm B/C agree on all ${caseIds.length} cases (${acceptCount} accepted, ${caseIds.length - acceptCount} deferred)`)

    // The runner must print the observable summary required by the protocol.
    for (const needle of ['arm B:', 'arm C:', 'routes', 'p50=', 'p95=', 'wrote', 'routine_compare']) {
      assert.ok(runOne.stdout.includes(needle), `run.mjs stdout should mention ${needle}`)
    }
    assert.ok(
      !/expected|correct/i.test(
        JSON.stringify([...armB, ...armC].map((record) => record.cases)),
      ),
      'generated arm cases must not mention expected/correct',
    )

    // --- Run 2: optional arm-A ingest, validated and copied verbatim. ---
    const runIdWithA = 'selftest-a'
    const stubDir = path.join(root, 'arm-a-stub')
    const stubFiles = await writeArmAStub(stubDir, auditSet.cases, runIdWithA)
    runPilot([
      '--root',
      root,
      '--run-id',
      runIdWithA,
      '--repeats',
      '3',
      '--arm-a',
      stubDir,
    ])
    const outDirWithA = path.join(root, 'arms', runIdWithA)
    for (const stub of stubFiles) {
      const copied = path.join(outDirWithA, `arm-a-r${stub.repeat}.json`)
      assert.ok(await exists(copied), `arm A ingest should write ${path.basename(copied)}`)
      const source = await readJson(stub.file)
      const ingested = await readJson(copied)
      assert.equal(ingested.schemaVersion, 2, `arm A r${stub.repeat} schemaVersion`)
      assert.equal(ingested.kind, 'arm-run', `arm A r${stub.repeat} kind`)
      assert.equal(ingested.arm, 'A', `arm A r${stub.repeat} arm`)
      assert.equal(ingested.repeat, stub.repeat, `arm A r${stub.repeat} repeat`)
      assert.equal(ingested.provenance, 'measured', `arm A r${stub.repeat} provenance`)
      // Metadata must be preserved exactly; only absent latency/cost are filled.
      assert.deepEqual(ingested.participant, source.participant, `arm A r${stub.repeat} participant`)
      assert.equal(ingested.participant.model, 'selftest-stub', 'arm A model must not be rewritten')
      assert.deepEqual(ingested.conditions, source.conditions, `arm A r${stub.repeat} conditions`)
      assert.equal(ingested.runId, runIdWithA, `arm A r${stub.repeat} runId is normalized to the pilot run`)
      assert.equal(ingested.cost.basis, 'unmetered', `arm A r${stub.repeat} without usage stays unmetered`)
      assert.equal(ingested.cost.perRequestUsd, null, `arm A r${stub.repeat} cost is not fabricated`)
      assert.equal(ingested.cost.setupUsd, null, `arm A r${stub.repeat} setup cost is not fabricated`)
      assert.equal(ingested.latency.basis, 'unavailable', `arm A r${stub.repeat} latency is not fabricated`)
      assert.deepEqual(ingested.workload, source.workload, `arm A r${stub.repeat} workload`)
      assert.equal(ingested.cases.length, source.cases.length, `arm A r${stub.repeat} case count`)
      const ingestedById = new Map(ingested.cases.map((entry) => [entry.caseId, entry]))
      for (const sourceCase of source.cases) {
        const ingestedCase = ingestedById.get(sourceCase.caseId)
        assert.ok(ingestedCase, `arm A r${stub.repeat} missing ${sourceCase.caseId}`)
        for (const key of ['decision', 'reason', 'fieldId', 'sourceUnit', 'valueHz']) {
          assert.deepEqual(
            ingestedCase[key],
            sourceCase[key],
            `arm A r${stub.repeat} ${sourceCase.caseId} ${key} must be preserved`,
          )
        }
        assert.equal(ingestedCase.latencyMs, null, `arm A r${stub.repeat} ${sourceCase.caseId} latencyMs`)
        assert.equal(ingestedCase.costUsd, null, `arm A r${stub.repeat} ${sourceCase.caseId} costUsd`)
      }
      assertNoLabelFields(ingested, `arm A repeat ${stub.repeat}`)
    }
    const namesWithA = (await fsp.readdir(outDirWithA)).sort()
    assert.deepEqual(
      namesWithA,
      [
        'arm-a-r1.json',
        'arm-a-r2.json',
        'arm-a-r3.json',
        'arm-b-r1.json',
        'arm-b-r2.json',
        'arm-b-r3.json',
        'arm-c-r1.json',
        'arm-c-r2.json',
        'arm-c-r3.json',
      ],
      'run with --arm-a must write all nine arm records',
    )
    log('arm A ingest: 3 raw measured records validated; metadata preserved, latencyMs/costUsd filled null')

    await fsp.rm(root, { recursive: true, force: true })
    log('PASS (schema, coverage, determinism, B/C parity, no labels, arm-A ingest)')
  } catch (error) {
    console.error(`[selftest] FAIL: ${error?.stack ?? error}`)
    console.error(`[selftest] temporary root kept for inspection: ${root}`)
    process.exitCode = 1
  }
}

await main()
