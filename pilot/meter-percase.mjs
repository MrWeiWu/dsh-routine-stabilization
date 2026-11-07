#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Meter the per-request arm-A probe sessions.
//
// Each probe child session contains a unique "PERCASE:<caseId>:<repeat>"
// marker in its prompt, one JSON answer as the final assistant text, and the
// same provider-reported usage fields the DSH token-meter projects. This script
// scans recent session logs, extracts the marker, the decision JSON, the token
// usage and the session wall clock, and writes a latency/cost sample file.
//
// Usage:
//   node pilot/meter-percase.mjs --out <file> [--since-hours 6] [--cost-model pilot/cost-model.json]

import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { meterSessionLog } from './meter-session.mjs'

const MARKER = /PERCASE:(audit-[A-Za-z0-9-]+):(\d+)/

function parseArgs(argv) {
  const options = { out: null, sinceHours: 6, costModel: 'pilot/cost-model.json', root: null, routine: null, version: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--out') options.out = argv[++index]
    else if (value === '--since-hours') options.sinceHours = Number(argv[++index])
    else if (value === '--cost-model') options.costModel = argv[++index]
    else if (value === '--root') options.root = argv[++index]
    else if (value === '--routine') options.routine = argv[++index]
    else if (value === '--version') options.version = argv[++index]
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`unknown argument ${JSON.stringify(value)}`)
  }
  return options
}

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

function decodeLog(file) {
  const result = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  if (result.status === 0) return result.stdout.toString('utf8')
  throw new Error(`cannot decode ${file}`)
}

function extractDecision(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const blocks = event.data?.message?.content ?? []
    const texts = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    const start = texts.lastIndexOf('{')
    const end = texts.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(texts.slice(start, end + 1))
      if (parsed && typeof parsed.caseId === 'string' && ['accept', 'defer'].includes(parsed.decision)) {
        return parsed
      }
    } catch {
      // keep looking
    }
  }
  return null
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node pilot/meter-percase.mjs --out <file> [--since-hours 6] [--cost-model pilot/cost-model.json]')
    return
  }
  if (!options.out) throw new Error('--out is required')
  const costModel = JSON.parse(fs.readFileSync(path.resolve(options.costModel), 'utf8'))
  const since = Date.now() - options.sinceHours * 3600 * 1000
  const sessionsRoot = path.join(dshHome(), 'sessions')
  const rawSamples = []
  for (const workspaceDirectory of fs.readdirSync(sessionsRoot)) {
    const workspacePath = path.join(sessionsRoot, workspaceDirectory)
    let sessionDirectories = []
    try {
      sessionDirectories = fs.readdirSync(workspacePath, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const entry of sessionDirectories) {
      const sessionDirectory = path.join(workspacePath, entry.name)
      const logs = fs
        .readdirSync(sessionDirectory)
        .filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
      if (logs.length !== 1) continue
      const file = path.join(sessionDirectory, logs[0])
      const stat = fs.statSync(file)
      if (stat.mtimeMs < since) continue
      let text
      try {
        text = decodeLog(file)
      } catch {
        continue
      }
      const match = MARKER.exec(text)
      if (!match) continue
      const usage = meterSessionLog(text, entry.name)
      const events = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
      const decision = extractDecision(events)
      const prices = costModel.modelPrices[`${usage.model.provider}/${usage.model.model}`] ?? null
      const tokenCostUsd =
        prices === null
          ? null
          : (usage.tokens.inputTokens / 1e6) * prices.inputPerMTokensUsd +
            (usage.tokens.cacheReadTokens / 1e6) * prices.cachedInputPerMTokensUsd +
            (usage.tokens.outputTokens / 1e6) * prices.outputPerMTokensUsd
      rawSamples.push({
        caseId: match[1],
        repeat: Number(match[2]),
        sessionId: entry.name,
        decision: decision?.decision ?? null,
        reason: decision?.reason ?? null,
        fieldId: decision?.fieldId ?? null,
        sourceUnit: decision?.sourceUnit ?? null,
        valueHz: decision?.valueHz ?? null,
        attempts: usage.attempts,
        tokens: usage.tokens,
        tokenCostUsd: tokenCostUsd === null ? null : Math.round(tokenCostUsd * 1e9) / 1e9,
        latencyMs: usage.timing.wallClockMs,
        attemptLatenciesMs: usage.attemptLatenciesMs,
      })
    }
  }
  // One request is one child session; drop duplicates/retries that reuse the
  // marker and any session whose wall clock is implausible (resumed logs).
  const MAX_PLAUSIBLE_MS = 10 * 60 * 1000
  const byRequest = new Map()
  let discarded = 0
  for (const sample of rawSamples) {
    const plausible = Number.isFinite(sample.latencyMs) && sample.latencyMs > 0 && sample.latencyMs <= MAX_PLAUSIBLE_MS
    const key = `${sample.caseId}:${sample.repeat}`
    const previous = byRequest.get(key)
    if (!plausible || sample.decision === null) {
      discarded += 1
      if (previous === undefined && sample.decision !== null) byRequest.set(key, { ...sample, plausible: false })
      continue
    }
    if (previous === undefined || previous.plausible === false) byRequest.set(key, { ...sample, plausible: true })
    else discarded += 1
  }
  const samples = [...byRequest.values()].sort(
    (left, right) => left.repeat - right.repeat || left.caseId.localeCompare(right.caseId),
  )
  if (options.root && options.routine && options.version) {
    const engine = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'engine.js')).href)
    const root = path.resolve(options.root)
    const versionDirectory = [String(options.version), `v${options.version}`].find((candidate) =>
      fs.existsSync(path.join(root, 'routines', options.routine, candidate, 'manifest.json')),
    )
    if (!versionDirectory) throw new Error(`routine ${options.routine}/${options.version} not found under ${root}`)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'routines', options.routine, versionDirectory, 'manifest.json'), 'utf8'),
    )
    const inputs = JSON.parse(fs.readFileSync(path.join(root, manifest.evidence.fixtureSets.audit), 'utf8'))
    const labels = JSON.parse(fs.readFileSync(path.join(root, manifest.evidence.blindLabels.audit), 'utf8'))
    const expectById = new Map(labels.cases.map((entry) => [entry.id, entry.expect]))
    const expectedById = new Map(inputs.cases.map((entry) => [entry.id, entry.input]))
    for (const sample of samples) {
      const expect = expectById.get(sample.caseId)
      if (!expect) {
        sample.correct = null
        sample.e2eSuccess = null
        sample.silentError = null
        continue
      }
      const scored = engine.scoreRawDecision(expect, {
        decision: sample.decision,
        reason: sample.reason,
        fieldId: sample.fieldId,
        sourceUnit: sample.sourceUnit,
        valueHz: sample.valueHz,
      })
      sample.correct = scored.correct
      sample.e2eSuccess = scored.e2eSuccess
      sample.silentError = scored.silentError
      sample.inputHash = expectedById.has(sample.caseId) ? 'present' : 'missing'
    }
  }
  const latencies = samples.map((sample) => sample.latencyMs).filter(Number.isFinite)
  const tokenCosts = samples.map((sample) => sample.tokenCostUsd).filter(Number.isFinite)
  const summary = {
    schemaVersion: 1,
    kind: 'arm-a-per-request-sample',
    generatedAt: new Date().toISOString(),
    samples: samples.length,
    cases: new Set(samples.map((sample) => sample.caseId)).size,
    repeats: new Set(samples.map((sample) => sample.repeat)).size,
    model: samples[0]?.tokens ? 'deepseek-account/deepseek-flash (DeepSeek-V4.1-Flash)' : null,
    latency: {
      basis: 'per-request-sampled',
      n: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      meanMs: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      minMs: latencies.length > 0 ? Math.min(...latencies) : null,
      maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
    },
    tokenCostUsd: {
      n: tokenCosts.length,
      mean: tokenCosts.length > 0 ? tokenCosts.reduce((sum, value) => sum + value, 0) / tokenCosts.length : null,
      total: tokenCosts.length > 0 ? tokenCosts.reduce((sum, value) => sum + value, 0) : null,
    },
    decisions: {
      accept: samples.filter((sample) => sample.decision === 'accept').length,
      defer: samples.filter((sample) => sample.decision === 'defer').length,
      missing: samples.filter((sample) => sample.decision === null).length,
    },
    correctness:
      samples.some((sample) => sample.correct !== undefined)
        ? {
            correct: samples.filter((sample) => sample.correct === true).length,
            silentErrors: samples.filter((sample) => sample.silentError === true).length,
            e2eSuccess: samples.filter((sample) => sample.e2eSuccess === true).length,
            scored: samples.filter((sample) => sample.correct !== undefined).length,
          }
        : null,
    discarded,
    perSessions: samples,
  }
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
  fs.writeFileSync(options.out, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ samples: summary.samples, cases: summary.cases, repeats: summary.repeats, latency: summary.latency, tokenCostUsd: summary.tokenCostUsd, decisions: summary.decisions }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error(`meter-percase: ${error?.message ?? error}`)
  process.exitCode = 1
}
