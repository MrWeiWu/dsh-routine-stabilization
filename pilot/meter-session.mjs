#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Meter one archived DSH agent session for the pilot arm accounting.
//
// The durable session log already carries the provider-reported usage fields the
// DSH token-meter projects (`tokenUsage`: uncachedInputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens). This tool folds those same records for a
// finished subagent session, so an arm record can carry measured token usage
// without re-running the model.
//
// Usage:
//   node pilot/meter-session.mjs --session <id|dir> [--out <file>] [--json]
//
// Resolution: a session id is looked up under $DSH_HOME/sessions/*/; a directory
// may be given directly. The zstd log is decoded with the system `zstd` binary
// (falling back to Node's zstd support for single-frame logs).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TOKEN_USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

function parseArgs(argv) {
  const args = { session: null, out: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--session') args.session = argv[++index]
    else if (value === '--out') args.out = argv[++index]
    else if (value === '--json') args.json = true
    else if (value === '--help' || value === '-h') args.help = true
    else throw new Error(`unknown argument ${JSON.stringify(value)}`)
  }
  return args
}

function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

function resolveSessionDirectory(target) {
  const direct = path.resolve(target)
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct
  const sessionsRoot = path.join(dshHome(), 'sessions')
  if (!fs.existsSync(sessionsRoot)) throw new Error(`session root not found: ${sessionsRoot}`)
  for (const workspaceDirectory of fs.readdirSync(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, workspaceDirectory, target)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
  }
  throw new Error(`session ${JSON.stringify(target)} not found under ${sessionsRoot}`)
}

function readSessionLog(directory) {
  const candidates = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))
  if (candidates.length !== 1) throw new Error(`expected exactly one session log in ${directory}, found ${candidates.length}`)
  const file = path.join(directory, candidates[0])
  if (file.endsWith('.jsonl')) return fs.readFileSync(file, 'utf8')
  const zstd = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  if (zstd.status === 0) return zstd.stdout.toString('utf8')
  if (typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  }
  throw new Error(`cannot decode ${file}: ${zstd.error?.message ?? 'zstd is unavailable'}`)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function meterSessionLog(text, sessionId) {
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn tail line is ignored like the durable reader does.
    }
  }
  if (events.length === 0) throw new Error('session log is empty')
  const header = events.find((event) => event.type === 'session') ?? {}
  const descriptor = events.find((event) => event.type === 'subagent/descriptor')?.data ?? {}
  const requestHeader = events.find((event) => event.type === 'request/header')?.data?.header
  const attempts = []
  const totals = Object.fromEntries(TOKEN_USAGE_KEYS.map((key) => [key, 0]))
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    let attempt = null
    for (const key of TOKEN_USAGE_KEYS) {
      if (!isFiniteNumber(usage[key])) {
        attempt = null
        break
      }
      attempt = attempt ?? {}
      attempt[key] = usage[key]
    }
    if (attempt === null) continue
    attempt.time = event.time ?? null
    attempt.step = event.data?.step ?? null
    attempts.push(attempt)
    for (const key of TOKEN_USAGE_KEYS) totals[key] += attempt[key]
  }
  const times = events.map((event) => event.time).filter(isFiniteNumber)
  const startedAt = isFiniteNumber(header.createdAt) ? header.createdAt : times[0] ?? null
  const endedAt = times.length > 0 ? Math.max(...times) : null
  return {
    schemaVersion: 1,
    kind: 'session-usage',
    sessionId: header.id ?? sessionId,
    parentSession: header.parentSession ?? null,
    origin: header.origin ?? null,
    agentPreset: header.agentPreset ?? null,
    model: {
      provider: descriptor.agentProvider ?? requestHeader?.config?.provider ?? null,
      model: descriptor.agentModel ?? requestHeader?.config?.model ?? null,
      reasoningEffort: descriptor.agentReasoningEffort ?? requestHeader?.config?.reasoningEffort ?? null,
      maxTokens: requestHeader?.config?.maxTokens ?? null,
    },
    source: 'durable session log (provider-reported usage, same fields as the DSH token-meter tokenUsage projection)',
    attempts: attempts.length,
    tokens: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    },
    timing: {
      startedAt,
      endedAt,
      wallClockMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: node pilot/meter-session.mjs --session <id|dir> [--out <file>] [--json]')
    return
  }
  if (!args.session) throw new Error('--session is required')
  const directory = resolveSessionDirectory(args.session)
  const usage = meterSessionLog(readSessionLog(directory), path.basename(directory))
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    fs.writeFileSync(args.out, JSON.stringify(usage, null, 2))
  }
  if (args.json || !args.out) console.log(JSON.stringify(usage, null, 2))
  else console.log(`wrote ${args.out}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(`meter-session: ${error.message}`)
    process.exitCode = 1
  }
}
