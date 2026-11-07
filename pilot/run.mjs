#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Real three-arm pilot runner (v0.2 arm records).
 *
 *   node pilot/run.mjs --root <registry-root> --run-id <id> [--routine <id>]
 *                      [--version <version>] [--repeats 3] [--arm-a <dir>]
 *
 * Behaviour:
 *   - Reads ONLY `fixtures/<id>/<version>/audit.inputs.json` from the registry
 *     root. It never reads `blind/**` labels and never falls back to a
 *     label-bearing fixture file; correctness is scored later by
 *     `routine_compare` from the protected labels.
 *   - Arm B: the independent hand-written implementation in `pilot/arm-b.mjs`.
 *   - Arm C: the candidate routine executed through `lib/engine.js`
 *     `invokeRoutine(root, id, version, input, { log: false })`.
 *   - Both scripted arms run `--repeats` times (default 3) over the same inputs
 *     and write `arms/<runId>/arm-{b,c}-r<repeat>.json` under the registry root.
 *   - Optional `--arm-a <dir>`: validates measured arm-A records
 *     (`arm-a-r1.json`, `arm-a-run-1.json`, ...) and copies them verbatim to
 *     `arms/<runId>/arm-a-r<repeat>.json`. No re-scoring, no label reads.
 *
 * The written records follow spec v2 §5: raw decisions/values only — no
 * `correct`, no `expected`. Latency is measured with process.hrtime.bigint().
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { solve } from './arm-b.mjs'

const DEFAULT_ROUTINE = 'normalize_detuning'
const DEFAULT_VERSION = '1'
const AUDIT_INPUTS_NAME = 'audit.inputs.json'
const MAX_REPEATS = 10
const HORIZON_DAYS = 30
const DEFAULT_PER_REQUEST_BUDGET_MS = 60000
const FORBIDDEN_CASE_KEYS = Object.freeze(['correct', 'expected', 'expect'])
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const ARM_A_FILE_PATTERN = /^arm-a-(?:r|run)(?:-)?(\d+)\.json$/i

const PILOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(PILOT_DIR, '..')
const ENGINE_PATH = path.join(REPO_ROOT, 'lib', 'engine.js')

function usage() {
  return [
    'Usage: node pilot/run.mjs [options]',
    '',
    '  --root <dir>       registry root (default: $DSH_HOME/routine-registry)',
    '  --run-id <id>      run directory under arms/ (default: pilot-<UTC yyyymmdd>)',
    '  --routine <id>     routine id (default: normalize_detuning)',
    '  --version <label>  routine version (default: 1)',
    '  --repeats <n>      repeats per scripted arm, 1..10 (default: 3)',
    '  --arm-a <dir>      directory containing measured arm-A records',
    '                     (arm-a-r1.json or arm-a-run-1.json, ...)',
    '  --help             show this help',
    '',
    'Writes: <root>/arms/<runId>/arm-{a,b,c}-r<repeat>.json',
  ].join('\n')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function utcDateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

function resolveRoot(argument) {
  if (typeof argument === 'string' && argument.trim() !== '') {
    return path.resolve(argument)
  }
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.resolve(dshHome, 'routine-registry')
}

function parseArgs(argv) {
  const options = {
    root: null,
    runId: null,
    routine: DEFAULT_ROUTINE,
    version: DEFAULT_VERSION,
    repeats: 3,
    armA: null,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (flag) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
      }
      index += 1
      return value
    }
    switch (argument) {
      case '--root':
        options.root = takeValue('--root')
        break
      case '--run-id':
        options.runId = takeValue('--run-id')
        break
      case '--routine':
        options.routine = takeValue('--routine')
        break
      case '--version':
        options.version = takeValue('--version')
        break
      case '--repeats': {
        const raw = takeValue('--repeats')
        const repeats = Number(raw)
        if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
          throw new Error(`--repeats must be an integer between 1 and ${MAX_REPEATS}`)
        }
        options.repeats = repeats
        break
      }
      case '--arm-a':
        options.armA = takeValue('--arm-a')
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
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
  const text = await fsp.readFile(filePath, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`)
  }
}

async function readJsonIfExists(filePath) {
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Locate the routine directory the same way `lib/store.js` does. */
async function resolveRoutineDirectory(root, id, version) {
  const direct = path.join(root, 'routines', id, String(version))
  if (await exists(path.join(direct, 'manifest.json'))) return direct
  const labelled = path.join(root, 'routines', id, `v${version}`)
  if (await exists(path.join(labelled, 'manifest.json'))) return labelled
  const idDirectory = path.join(root, 'routines', id)
  let entries = []
  try {
    entries = await fsp.readdir(idDirectory, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(idDirectory, entry.name)
    const manifestPath = path.join(directory, 'manifest.json')
    if (!(await exists(manifestPath))) continue
    try {
      const manifest = await readJson(manifestPath)
      if (String(manifest.version) === String(version)) return directory
    } catch {
      // ignore unreadable candidate directories
    }
  }
  throw new Error(
    `routine ${id}/${version} not found under ${idDirectory}; seed the registry first (the pilot never creates a registry)`,
  )
}

/** Resolve the readable, inputs-only audit fixture. Never falls back to labels. */
async function resolveAuditInputs(root, id, version) {
  const bases = [
    path.join(root, 'fixtures', id, String(version)),
    path.join(root, 'fixtures', id, `v${version}`),
  ]
  for (const base of bases) {
    const file = path.join(base, AUDIT_INPUTS_NAME)
    if (await exists(file)) return file
  }
  throw new Error(
    `audit inputs not found: expected fixtures/${id}/<version>/${AUDIT_INPUTS_NAME} under ${root}; ` +
      'the pilot reads inputs only and never falls back to label-bearing fixture files',
  )
}

function validateAuditCases(parsed, file) {
  if (!isRecord(parsed) || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`${file} has no non-empty cases array`)
  }
  const cases = []
  const seen = new Set()
  for (const entry of parsed.cases) {
    if (!isRecord(entry)) throw new Error(`${file} contains a non-object case`)
    const id = entry.id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${file} contains a case without a string id`)
    }
    if (seen.has(id)) throw new Error(`${file} contains a duplicate case id: ${id}`)
    if (!isRecord(entry.input)) throw new Error(`${file} case ${id} has no input object`)
    if (FORBIDDEN_CASE_KEYS.some((key) => key in entry)) {
      throw new Error(
        `${file} case ${id} carries a label field (${FORBIDDEN_CASE_KEYS.join('/')}); ` +
          'the pilot only reads inputs-only fixtures',
      )
    }
    seen.add(id)
    cases.push({ id, input: entry.input })
  }
  return cases
}

function finalOutcomeOf(decision) {
  if (decision === 'accept') return 'resolved'
  if (decision === 'defer') return 'deferred'
  return 'fallback-unresolved'
}

function armCase(entry) {
  return {
    caseId: entry.caseId,
    decision: entry.decision,
    reason: entry.reason,
    fieldId: entry.fieldId,
    sourceUnit: entry.sourceUnit,
    valueHz: entry.valueHz,
    latencyMs: entry.latencyMs,
    costUsd: entry.costUsd,
    firstRoute: entry.firstRoute,
    finalOutcome: entry.finalOutcome,
  }
}

function buildArmRecord({ runId, arm, repeat, participant, conditions, cost, workload, cases }) {
  return {
    schemaVersion: 2,
    kind: 'arm-run',
    runId,
    arm,
    repeat,
    provenance: 'measured',
    participant,
    conditions,
    cost,
    workload,
    cases: cases.map(armCase),
  }
}

const PARTICIPANT_B = Object.freeze({
  kind: 'script',
  provider: 'local',
  model: 'pilot/arm-b.mjs',
  promptVersion: null,
})

const PARTICIPANT_C = Object.freeze({
  kind: 'script',
  provider: 'local',
  model: 'lib/engine.js#invokeRoutine',
  promptVersion: null,
})

function scriptCost() {
  return {
    basis: 'local-script',
    perRequestUsd: 0,
    setupUsd: 0,
    maintenanceUsd: 0,
    authoringHours: null,
  }
}

async function runArmB({ cases, repeat, runId, workload, conditions }) {
  const results = []
  for (const fixtureCase of cases) {
    const startedAt = process.hrtime.bigint()
    let decision = 'fallback'
    let reason = null
    let fieldId = null
    let sourceUnit = null
    let valueHz = null
    try {
      const result = solve(fixtureCase.input)
      decision = result.decision
      reason = result.reason ?? null
      fieldId = result.fieldId ?? null
      sourceUnit = result.sourceUnit ?? null
      valueHz = Number.isFinite(result.valueHz) ? result.valueHz : null
    } catch (error) {
      decision = 'fallback'
      reason = 'exception'
    }
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    results.push({
      caseId: fixtureCase.id,
      decision,
      reason,
      fieldId,
      sourceUnit,
      valueHz,
      latencyMs,
      costUsd: 0,
      firstRoute: decision,
      finalOutcome: finalOutcomeOf(decision),
    })
  }
  return buildArmRecord({
    runId,
    arm: 'B',
    repeat,
    participant: PARTICIPANT_B,
    conditions,
    cost: scriptCost(),
    workload,
    cases: results,
  })
}

async function runArmC({ engine, root, routine, version, cases, repeat, runId, workload, conditions }) {
  const results = []
  for (const fixtureCase of cases) {
    const startedAt = process.hrtime.bigint()
    let decision = 'fallback'
    let reason = null
    let fieldId = null
    let sourceUnit = null
    let valueHz = null
    try {
      const result = await engine.invokeRoutine(root, routine, version, fixtureCase.input, {
        log: false,
      })
      decision = result.decision
      reason = result.reason ?? null
      if (decision === 'accept') {
        fieldId = result.output?.fieldId ?? result.bound?.fieldId ?? null
        sourceUnit = result.output?.sourceUnit ?? result.bound?.unit ?? null
        valueHz = Number.isFinite(result.output?.valueHz) ? result.output.valueHz : null
      }
    } catch (error) {
      decision = 'fallback'
      reason = 'exception'
    }
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    results.push({
      caseId: fixtureCase.id,
      decision,
      reason,
      fieldId,
      sourceUnit,
      valueHz,
      latencyMs,
      costUsd: 0,
      firstRoute: decision,
      finalOutcome: finalOutcomeOf(decision),
    })
  }
  return buildArmRecord({
    runId,
    arm: 'C',
    repeat,
    participant: PARTICIPANT_C,
    conditions,
    cost: scriptCost(),
    workload,
    cases: results,
  })
}

function validateArmARecord(record, { file, repeat, caseIdSet }) {
  const fail = (message) => {
    throw new Error(`invalid arm A record ${file}: ${message}`)
  }
  if (!isRecord(record)) fail('not a JSON object')
  if (record.schemaVersion !== 2) fail('schemaVersion must be 2')
  if (record.kind !== 'arm-run') fail('kind must be "arm-run"')
  if (String(record.arm ?? '').toUpperCase() !== 'A') fail('arm must be "A"')
  if (record.repeat !== repeat) {
    fail(`repeat ${JSON.stringify(record.repeat)} does not match file name repeat ${repeat}`)
  }
  if (record.provenance !== 'measured') fail('provenance must be "measured"')
  if (!Array.isArray(record.cases)) fail('cases must be an array')

  const seen = new Set()
  for (const entry of record.cases) {
    if (!isRecord(entry) || typeof entry.caseId !== 'string') {
      fail('every case needs a string caseId')
    }
    if (seen.has(entry.caseId)) fail(`duplicate caseId ${entry.caseId}`)
    for (const key of FORBIDDEN_CASE_KEYS) {
      if (key in entry) {
        fail(`case ${entry.caseId} carries "${key}"; raw arm records must not carry labels`)
      }
    }
    seen.add(entry.caseId)
  }
  const missing = [...caseIdSet].filter((caseId) => !seen.has(caseId))
  if (missing.length > 0) {
    fail(
      `missing caseIds (${missing.length}): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`,
    )
  }
  const extra = [...seen].filter((caseId) => !caseIdSet.has(caseId))
  if (extra.length > 0) {
    fail(`unexpected caseIds not in the audit inputs: ${extra.slice(0, 5).join(', ')}`)
  }
  return record
}

/**
 * Arm A raw records may carry only the decision fields per case:
 * {caseId, decision, reason, fieldId, sourceUnit, valueHz}. The pilot never
 * fabricates measurements, so absent latencyMs/costUsd become null, while
 * participant/conditions/repeat (and the recorded model information) are
 * preserved exactly as the agent runner wrote them.
 */
function normalizeArmARecord(record) {
  return {
    ...record,
    cases: (record.cases ?? []).map((entry) => {
      const normalized = { ...entry }
      if (!('latencyMs' in normalized)) normalized.latencyMs = null
      if (!('costUsd' in normalized)) normalized.costUsd = null
      return normalized
    }),
  }
}

async function ingestArmA({ directory, outDir, runId, caseIds, repeats }) {
  const absolute = path.resolve(directory)
  let names
  try {
    names = await fsp.readdir(absolute)
  } catch {
    throw new Error(`--arm-a directory is not readable: ${absolute}`)
  }
  const caseIdSet = new Set(caseIds)
  const found = []
  for (const name of names.sort()) {
    const match = ARM_A_FILE_PATTERN.exec(name)
    if (!match) continue
    const repeat = Number(match[1])
    if (!Number.isInteger(repeat) || repeat < 1) continue
    const file = path.join(absolute, name)
    const record = validateArmARecord(await readJson(file), { file, repeat, caseIdSet })
    found.push({ file, repeat, record })
  }
  if (found.length === 0) {
    throw new Error(
      `no measured arm A records found in ${absolute}; expected files like arm-a-r1.json or arm-a-run-1.json`,
    )
  }
  const seenRepeats = new Set()
  for (const item of found) {
    if (seenRepeats.has(item.repeat)) {
      throw new Error(`duplicate arm A repeat ${item.repeat} in ${absolute}`)
    }
    seenRepeats.add(item.repeat)
  }
  for (const item of found) {
    const target = path.join(outDir, `arm-a-r${item.repeat}.json`)
    await fsp.writeFile(
      target,
      `${JSON.stringify(normalizeArmARecord(item.record), null, 2)}\n`,
      'utf8',
    )
  }
  const missingRepeats = []
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    if (!seenRepeats.has(repeat)) missingRepeats.push(repeat)
  }
  if (missingRepeats.length > 0) {
    console.warn(
      `warning: arm A has no record for repeat(s) ${missingRepeats.join(', ')}; ` +
        'the comparison uses repeat 1 as primary',
    )
  }
  const runIds = [...new Set(found.map((item) => item.record.runId).filter(Boolean))]
  if (runIds.length > 0 && runIds.some((sourceRunId) => sourceRunId !== runId)) {
    console.warn(
      `warning: arm A record runId(s) ${runIds.map((value) => JSON.stringify(value)).join(', ')} ` +
        `differ from --run-id ${JSON.stringify(runId)}; routine_compare filters selected arms by runId, ` +
        'so either compare with the arm-A runId or re-run with a matching --run-id',
    )
  }
  if (found.some((item) => !isRecord(item.record.cost))) {
    console.warn(
      'warning: at least one arm A record has no cost block; routine_compare treats it as unmetered ' +
        'and the pilot decision will stay "inconclusive" until a measured cost basis is attached',
    )
  }
  return {
    count: found.length,
    repeats: [...seenRepeats].sort((left, right) => left - right),
    runIds,
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]
}

function latencySummary(cases) {
  const values = cases.map((entry) => entry.latencyMs).filter(Number.isFinite)
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  }
}

function formatMilliseconds(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(4)}ms`
}

function countBy(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function formatCounts(counts, order) {
  const keys = order
    ? [...order, ...Object.keys(counts).filter((key) => !order.includes(key))]
    : Object.keys(counts).sort()
  return keys
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key}=${counts[key]}`)
    .join(' ')
}

function summarizeArm(label, record) {
  const { p50, p95 } = latencySummary(record.cases)
  const routes = formatCounts(countBy(record.cases.map((entry) => entry.decision)), ['accept', 'defer', 'fallback'])
  const outcomes = formatCounts(
    countBy(record.cases.map((entry) => entry.finalOutcome)),
    ['resolved', 'deferred', 'fallback-unresolved'],
  )
  return (
    `arm ${label}: routes ${routes} | outcomes ${outcomes} | ` +
    `p50=${formatMilliseconds(p50)} p95=${formatMilliseconds(p95)}`
  )
}

async function writeRecord(file, record) {
  await fsp.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return file
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const root = resolveRoot(options.root)
  const runId = options.runId ?? `pilot-${utcDateStamp()}`
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`--run-id must match ${RUN_ID_PATTERN}`)
  }
  const routine = options.routine
  const version = options.version

  const routineDirectory = await resolveRoutineDirectory(root, routine, version)
  const manifest = await readJson(path.join(routineDirectory, 'manifest.json'))
  const auditFile = await resolveAuditInputs(root, routine, version)
  const auditSet = await readJson(auditFile)
  const cases = validateAuditCases(auditSet, auditFile)

  const preregistration = await readJsonIfExists(
    path.join(routineDirectory, 'preregistration.json'),
  )
  const workload = {
    cases: cases.length,
    requests: Number(preregistration?.workload?.requests) || cases.length,
    horizonDays: Number(preregistration?.workload?.horizonDays) || HORIZON_DAYS,
  }
  const conditions = {
    contractRevision: manifest.contractRevision ?? `${routine}/v${version}`,
    fallbackModel: manifest.fallback?.mode ?? 'ask-user',
    perRequestBudgetMs:
      Number(preregistration?.workload?.perRequestBudgetMs) || DEFAULT_PER_REQUEST_BUDGET_MS,
  }

  const engine = await import(pathToFileURL(ENGINE_PATH).href)
  if (typeof engine.invokeRoutine !== 'function') {
    throw new Error(`${ENGINE_PATH} does not export invokeRoutine`)
  }

  const outDir = path.join(root, 'arms', runId)
  await fsp.mkdir(outDir, { recursive: true })

  const scripted = []
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    const armB = await runArmB({ cases, repeat, runId, workload, conditions })
    const armC = await runArmC({
      engine,
      root,
      routine,
      version,
      cases,
      repeat,
      runId,
      workload,
      conditions,
    })
    await writeRecord(path.join(outDir, `arm-b-r${repeat}.json`), armB)
    await writeRecord(path.join(outDir, `arm-c-r${repeat}.json`), armC)
    scripted.push({ repeat, armB, armC })
  }

  let armAResult = null
  if (options.armA) {
    armAResult = await ingestArmA({
      directory: options.armA,
      outDir,
      runId,
      caseIds: cases.map((entry) => entry.id),
      repeats: options.repeats,
    })
  }

  const primary = scripted[0]
  const files = scripted.length * 2 + (armAResult ? armAResult.count : 0)

  console.log(`== pilot run ${runId} ==`)
  console.log(`root: ${root}`)
  console.log(
    `fixtures: ${path.relative(root, auditFile)} (inputs only; labels are not read)`,
  )
  console.log(
    `cases: ${cases.length} | repeats: ${options.repeats} | ` +
      `contract: ${conditions.contractRevision} | workload: ${workload.requests} requests / ${workload.horizonDays}d`,
  )
  if (armAResult) {
    console.log(
      `arm A: ingested ${armAResult.count} measured record(s) for repeat(s) ${armAResult.repeats.join(', ')}` +
        (armAResult.runIds.length > 0 ? ` | source runId(s): ${armAResult.runIds.join(', ')}` : ''),
    )
  } else {
    console.log('arm A: not supplied (run with --arm-a <dir> to ingest the LLM agent arm)')
  }
  console.log(summarizeArm('B', primary.armB))
  console.log(summarizeArm('C', primary.armC))
  if (options.repeats > 1) {
    console.log(
      `repeats 2..${options.repeats} are diagnostic for repeatability; the comparison uses repeat 1 as primary`,
    )
  }
  console.log(`wrote ${files} arm file(s) under ${outDir}`)
  console.log('next:')
  console.log(
    `  routine_compare {"runId":"${runId}","routine":"${routine}","version":"${version}"}`,
  )
  if (!armAResult) {
    console.log(
      `  node pilot/run.mjs --root ${root} --run-id ${runId} --routine ${routine} --version ${version} --arm-a <dir-with-arm-a-r1..r${options.repeats}.json>`,
    )
  }
}

try {
  await main()
} catch (error) {
  console.error(`pilot/run.mjs: ${error?.message ?? error}`)
  if (/^(unknown argument|--[a-z-]+ requires a value|--repeats)/.test(String(error?.message))) {
    console.error('')
    console.error(usage())
  }
  process.exitCode = 1
}
