// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Statistical helpers for the Routine Stabilization framework.
//
// Every function here is deterministic: no clock, no global RNG. The bootstrap
// uses an explicit seed so a report can be reproduced byte-for-byte from the
// same inputs (see the reproducibility record in engine.js).

/** Exact one-sided 95% upper confidence bound for zero observed events in n
 *  independent trials: the p for which (1 - p)^n = 0.05.
 *  n = 59 -> 4.95% (Hanley & Lippman-Hand 1983, cited by the framework). */
export function exactUpperBound95(n) {
  if (!Number.isFinite(n) || n <= 0) return 1
  return 1 - Math.pow(0.05, 1 / n)
}

/** One-sided 95% upper bound on the rate of events observed count times in n. */
export function upperBound95(events, n) {
  if (!Number.isFinite(n) || n <= 0) return 1
  if (events <= 0) return exactUpperBound95(n)
  return Math.min(1, events / n)
}

export function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

export function mean(values) {
  return values.length > 0 ? sum(values) / values.length : 0
}

/** Sorted copy plus linear-interpolated percentile (p in [0, 1]). */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * Math.min(Math.max(p, 0), 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function latencySummary(values) {
  const present = values.filter((value) => Number.isFinite(value))
  return {
    n: present.length,
    p50: percentile(present, 0.5),
    p95: percentile(present, 0.95),
    mean: mean(present),
  }
}

/** Count occurrences, returned as an object sorted by descending count. */
export function histogram(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]))
}

/** Deterministic 32-bit LCG; returns a function yielding floats in [0, 1). */
export function lcg(seed) {
  let state = seed >>> 0
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** Paired case-level bootstrap of mean(a) - mean(b), where a and b are per-case
 *  0/1 arrays aligned by index. Returns a percentile interval. */
export function bootstrapPairedDiff(a, b, { iterations = 2000, seed = 20261104 } = {}) {
  const length = Math.min(a.length, b.length)
  if (length === 0) return { n: 0, meanDiff: 0, lo: null, hi: null, iterations }
  const diffs = []
  const random = lcg(seed)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0
    for (let draw = 0; draw < length; draw += 1) {
      const index = Math.floor(random() * length)
      total += (a[index] ?? 0) - (b[index] ?? 0)
    }
    diffs.push(total / length)
  }
  const meanDiff = mean(a.slice(0, length)) - mean(b.slice(0, length))
  return {
    n: length,
    meanDiff,
    lo: percentile(diffs, 0.025),
    hi: percentile(diffs, 0.975),
    iterations,
  }
}

/** Discordant pair counts for paired 0/1 outcomes. b = a succeeds / b fails,
 *  c = a fails / b succeeds. */
export function discordantPairs(a, b) {
  const length = Math.min(a.length, b.length)
  let both = 0
  let aOnly = 0
  let bOnly = 0
  let neither = 0
  for (let index = 0; index < length; index += 1) {
    const left = a[index] === 1
    const right = b[index] === 1
    if (left && right) both += 1
    else if (left) aOnly += 1
    else if (right) bOnly += 1
    else neither += 1
  }
  return { n: length, both, aOnly, bOnly, neither, discordant: aOnly + bOnly }
}

/** Total cost at N requests: setup + maintenance + N * mean cost per request. */
export function costProjection({ setupCostUsd = 0, maintenanceCostUsd = 0, perRequestCostUsd = 0, requests }) {
  const usage = requests * perRequestCostUsd
  return {
    setupCostUsd,
    maintenanceCostUsd,
    perRequestCostUsd,
    requests,
    usageCostUsd: usage,
    totalCostUsd: setupCostUsd + maintenanceCostUsd + usage,
  }
}

/** One-sided 95% upper bound on the discordance rate when no pair is
 *  discordant; reports the denominator so a reader sees the evidence size. */
export function zeroDiscordanceBound(pairs) {
  return { pairs, bound: exactUpperBound95(pairs) }
}
