// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Durable storage for the routine registry.
//
// Layout under the configured root (see README):
//   registry/registry.json              active versions and fallback pointer
//   routines/<id>/<version>/            manifest + hook modules
//   fixtures/<id>/<version>/*.json      labeled case sets (dev/audit/challenge)
//   evals/<id>/<version>/               independent reference checks
//   reports/                            evaluation and comparison run records
//   logs/routes.jsonl                   runtime route decisions
//   arms/                               paired arm records for cost comparison
//
// Every mutation is atomic (write temp + rename) and serialized per root, so
// the agent tools and the Web UI can share one registry in one process.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_DIR = path.resolve(LIB_DIR, '..')
export const SEED_DIR = path.join(PACKAGE_DIR, 'seed')
export const ENGINE_NAME = 'routine-stabilization'
export const ENGINE_VERSION = '0.2.0'
export const REGISTRY_SCHEMA_VERSION = 1

const LAYOUT_DIRS = ['registry', 'routines', 'fixtures', 'evals', 'reports', 'logs', 'arms', 'blind', 'blind/runs']
const ROUTE_LOG_FILE = 'logs/routes.jsonl'
const ROUTE_LOG_ROTATE_BYTES = 5 * 1024 * 1024

export function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

export function defaultRoot() {
  return path.join(dshHome(), 'routine-registry')
}

export function resolveRoot(root) {
  if (typeof root === 'string' && root.trim() !== '') return path.resolve(root)
  return defaultRoot()
}

export function registryFile(root) {
  return path.join(root, 'registry', 'registry.json')
}

export function routineDir(root, id, version) {
  return path.join(root, 'routines', id, version)
}

export function emptyRegistry() {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    fallback: null,
    routines: {},
  }
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

export async function pathExists(candidate) {
  try {
    await fsp.access(candidate)
    return true
  } catch {
    return false
  }
}

function atomicWrite(file, text, mode) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(temporary, text, 'utf8')
  if (typeof mode === 'number') fs.chmodSync(temporary, mode)
  fs.renameSync(temporary, file)
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key])
    return sorted
  }
  return value
}

export function sha256Value(value) {
  return sha256Text(canonicalJson(value))
}

export async function sha256File(file) {
  try {
    const bytes = await fsp.readFile(file)
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

// One in-process lock per registry root; operations from tools and RPC queue up.
const locks = new Map()

export async function withLock(root, operation) {
  const key = resolveRoot(root)
  const previous = locks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  locks.set(key, previous.then(() => current))
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Registry root and registry document
// ---------------------------------------------------------------------------

export async function ensureRoot(rootInput) {
  const root = resolveRoot(rootInput)
  await fsp.mkdir(root, { recursive: true })
  for (const directory of LAYOUT_DIRS) {
    await fsp.mkdir(path.join(root, directory), { recursive: true })
  }
  if (!(await pathExists(registryFile(root)))) {
    atomicWrite(registryFile(root), JSON.stringify(emptyRegistry(), null, 2))
  }
  return root
}

export async function readRegistry(rootInput) {
  const root = await ensureRoot(rootInput)
  const text = await fsp.readFile(registryFile(root), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`registry/registry.json is not valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.routines !== 'object' || parsed.routines === null) {
    throw new Error('registry/registry.json has no routines object')
  }
  if (typeof parsed.schemaVersion !== 'number') parsed.schemaVersion = REGISTRY_SCHEMA_VERSION
  if (!('fallback' in parsed)) parsed.fallback = null
  return parsed
}

export async function writeRegistry(rootInput, registry) {
  const root = await ensureRoot(rootInput)
  const next = {
    ...registry,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  }
  atomicWrite(registryFile(root), JSON.stringify(next, null, 2))
  return next
}

export async function updateRegistry(rootInput, mutate) {
  return withLock(rootInput, async () => {
    const registry = await readRegistry(rootInput)
    const next = await mutate(registry)
    return writeRegistry(rootInput, next ?? registry)
  })
}

// ---------------------------------------------------------------------------
// Seeding the built-in example
// ---------------------------------------------------------------------------

async function listFilesRecursive(directory) {
  const found = []
  const entries = await fsp.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await listFilesRecursive(absolute)) found.push(path.join(entry.name, child))
    } else if (entry.isFile()) {
      found.push(entry.name)
    }
  }
  return found
}

/** Copy package seed resources into the registry root. Existing files are kept
 *  unless force is true; an existing registry is never overwritten silently. */
export async function seedExample(rootInput, { force = false } = {}) {
  const root = await ensureRoot(rootInput)
  if (!(await pathExists(SEED_DIR))) {
    return { seeded: false, copied: [], root, reason: 'seed directory is missing from the package' }
  }
  const files = await listFilesRecursive(SEED_DIR)
  const copied = []
  const skipped = []
  for (const relative of files) {
    if (relative === 'README.md' || relative === 'registry' || relative.startsWith('registry/')) continue
    const source = path.join(SEED_DIR, relative)
    const target = path.join(root, relative)
    if (!force && (await pathExists(target))) {
      skipped.push(relative)
      continue
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(source, target)
    if (relative.startsWith('blind/')) {
      // Git does not store 0600; enforce protection on every seeded copy so a
      // fresh clone never produces world-readable labels.
      await fsp.chmod(target, 0o600)
      let directory = path.dirname(target)
      while (directory.startsWith(path.join(root, 'blind'))) {
        await fsp.chmod(directory, 0o700)
        directory = path.dirname(directory)
      }
      await fsp.chmod(path.join(root, 'blind'), 0o700)
    } else {
      const sourceStat = await fsp.stat(source)
      await fsp.chmod(target, sourceStat.mode & 0o777)
    }
    copied.push(relative)
  }
  // The registry document is copied only into an empty registry, so a user's
  // release decisions are never reset by re-seeding.
  const seedRegistry = path.join(SEED_DIR, 'registry', 'registry.json')
  let seededRegistry = false
  if (await pathExists(seedRegistry)) {
    const current = await readRegistry(root)
    if (force || Object.keys(current.routines).length === 0) {
      const content = JSON.parse(await fsp.readFile(seedRegistry, 'utf8'))
      if (!force) {
        // keep the layout fields the store owns
        content.updatedAt = new Date().toISOString()
      }
      atomicWrite(registryFile(root), JSON.stringify(content, null, 2))
      seededRegistry = true
    }
  }
  return { seeded: true, copied, skipped, seededRegistry, root }
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/
export const VERSION_PATTERN = /^[0-9][0-9A-Za-z_.-]*$/

export function assertSafeSegment(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) {
    throw new Error(`${label} must match ${pattern} (got ${JSON.stringify(value)})`)
  }
  return value
}

export async function listRoutineEntries(rootInput) {
  const root = await ensureRoot(rootInput)
  const routinesDirectory = path.join(root, 'routines')
  const entries = []
  let ids = []
  try {
    ids = await fsp.readdir(routinesDirectory)
  } catch {
    return entries
  }
  for (const id of ids.sort()) {
    const idDirectory = path.join(routinesDirectory, id)
    let versions = []
    try {
      versions = await fsp.readdir(idDirectory)
    } catch {
      continue
    }
    for (const version of versions.sort()) {
      const directory = path.join(idDirectory, version)
      const manifestPath = path.join(directory, 'manifest.json')
      if (!(await pathExists(manifestPath))) continue
      entries.push({ id, version, directory, manifestPath })
    }
  }
  return entries
}

export async function resolveRoutineDir(rootInput, id, version) {
  assertSafeSegment(id, ID_PATTERN, 'routine id')
  const root = await ensureRoot(rootInput)
  const direct = path.join(root, 'routines', id, String(version))
  if (await pathExists(path.join(direct, 'manifest.json'))) return direct
  // The framework names versions like "v1" while the manifest may carry the
  // number 1; accept a directory whose manifest.version matches the label.
  const idDirectory = path.join(root, 'routines', id)
  let directories = []
  try {
    directories = await fsp.readdir(idDirectory)
  } catch {
    directories = []
  }
  for (const directory of directories) {
    const manifestPath = path.join(idDirectory, directory, 'manifest.json')
    if (!(await pathExists(manifestPath))) continue
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
      if (String(manifest.version) === String(version)) return path.join(idDirectory, directory)
    } catch {
      // ignore unreadable candidate directory
    }
  }
  throw new Error(`routine ${id}/${version} does not exist under ${idDirectory}`)
}

export async function readManifest(rootInput, id, version) {
  assertSafeSegment(id, ID_PATTERN, 'routine id')
  assertSafeSegment(version, VERSION_PATTERN, 'routine version')
  const root = await ensureRoot(rootInput)
  const directory = await resolveRoutineDir(root, id, version)
  const manifestPath = path.join(directory, 'manifest.json')
  let text
  try {
    text = await fsp.readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(`routine ${id}/${version} does not exist at ${manifestPath}`)
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`routine ${id}/${version} manifest is not valid JSON: ${error.message}`)
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`routine ${id}/${version} manifest schemaVersion must be 1`)
  }
  if (manifest.id !== id || String(manifest.version) !== version) {
    throw new Error(`routine ${id}/${version} manifest identity does not match its directory`)
  }
  return manifest
}

/** Load the manifest's guard/binding/execution hooks. Imports are cache-busted
 *  with mtime so an edited routine is picked up without restarting the host. */
export async function loadHooks(routineDirectory, manifest) {
  const cacheBust = Date.now().toString(36)
  async function loadHook(entry, label) {
    if (typeof entry !== 'string' || !entry.includes('#')) {
      throw new Error(`${label} entry must look like "file.js#exportName"`)
    }
    const [relative, exported] = entry.split('#')
    const absolute = path.resolve(routineDirectory, relative)
    if (!absolute.startsWith(path.resolve(routineDirectory) + path.sep)) {
      throw new Error(`${label} entry escapes the routine directory`)
    }
    const stat = await fsp.stat(absolute)
    const module = await import(`${pathToFileURL(absolute).href}?v=${stat.mtimeMs}-${cacheBust}`)
    const fn = module[exported]
    if (typeof fn !== 'function') {
      throw new Error(`${label} entry ${entry} does not export a function named ${exported}`)
    }
    return { fn, file: absolute, exportName: exported }
  }
  const guard = manifest.admission?.predicate ? await loadHook(manifest.admission.predicate, 'admission.predicate') : null
  const binding = manifest.binding?.entry ? await loadHook(manifest.binding.entry, 'binding.entry') : null
  const execution = manifest.execution?.entry ? await loadHook(manifest.execution.entry, 'execution.entry') : null
  return { guard, binding, execution }
}

/** Resolve an evidence path recorded in a manifest: absolute, relative to the
 *  routine directory, relative to the root, or under root/fixtures. */
export async function resolveEvidencePath(rootInput, routineDirectory, relative) {
  const root = resolveRoot(rootInput)
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new Error('evidence path must be a non-empty string')
  }
  const candidates = path.isAbsolute(relative)
    ? [relative]
    : [
        path.resolve(routineDirectory, relative),
        path.resolve(root, relative),
        path.resolve(root, 'fixtures', relative),
        path.resolve(root, 'evals', relative),
      ]
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  throw new Error(`evidence file not found: ${relative} (tried ${candidates.join(', ')})`)
}

// ---------------------------------------------------------------------------
// Route log
// ---------------------------------------------------------------------------

export async function appendRouteLog(rootInput, record) {
  const root = await ensureRoot(rootInput)
  const file = path.join(root, ROUTE_LOG_FILE)
  const line = JSON.stringify({ at: new Date().toISOString(), ...record })
  await withLock(root, async () => {
    try {
      const stat = await fsp.stat(file)
      if (stat.size > ROUTE_LOG_ROTATE_BYTES) {
        await fsp.rename(file, path.join(root, 'logs', `routes-${Date.now()}.jsonl`))
      }
    } catch {
      // no log yet
    }
    await fsp.appendFile(file, line + '\n', 'utf8')
  })
}

export async function readRouteLog(rootInput, limit = 50) {
  const root = await ensureRoot(rootInput)
  const file = path.join(root, ROUTE_LOG_FILE)
  let text = ''
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines
    .slice(-Math.max(1, Math.min(limit, 1000)))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .reverse()
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function reportPath(rootInput, routine, version, at = new Date(), kind) {
  const root = resolveRoot(rootInput)
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const name =
    kind === 'compare' || routine === undefined || version === undefined
      ? `compare-${routine ?? 'all'}-${stamp}.json`
      : `${routine}-v${version}-${stamp}.json`
  return path.join(root, 'reports', name)
}

export async function writeReport(rootInput, report) {
  const root = await ensureRoot(rootInput)
  const file = reportPath(root, report.routine, report.version, new Date(report.generatedAt), report.kind)
  const stored = { ...report, reportPath: file }
  atomicWrite(file, JSON.stringify(stored, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// Blind evidence (protected labels and per-case scoring detail)
// ---------------------------------------------------------------------------

/** Protected per-case scoring detail, readable only by the operating user. */
export function blindRunFile(rootInput, routine, version, at = new Date()) {
  const root = resolveRoot(rootInput)
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return path.join(root, 'blind', 'runs', `${routine}-v${version}-${stamp}.json`)
}

export function compareBlindRunFile(rootInput, runId, at = new Date()) {
  const root = resolveRoot(rootInput)
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return path.join(root, 'blind', 'runs', `compare-${runId}-${stamp}.json`)
}

/** Write a JSON file with an explicit mode (0600 by default). */
export async function writeProtectedJson(file, value, mode = 0o600) {
  atomicWrite(file, JSON.stringify(value, null, 2), mode)
  return file
}

export function preregistrationFile(routineDirectory) {
  return path.join(routineDirectory, 'preregistration.json')
}

export async function listReports(rootInput) {
  const root = await ensureRoot(rootInput)
  const directory = path.join(root, 'reports')
  let names = []
  try {
    names = await fsp.readdir(directory)
  } catch {
    return []
  }
  const reports = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'))
      reports.push({ file: path.join(directory, name), ...parsed })
    } catch {
      // skip unreadable report
    }
  }
  return reports.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
}

export async function latestReport(rootInput, routine, version) {
  const reports = await listReports(rootInput)
  return (
    reports.find(
      (report) =>
        report.kind === 'evaluation' &&
        report.routine === routine &&
        String(report.version) === String(version),
    ) ?? null
  )
}

// ---------------------------------------------------------------------------
// Arms (paired comparison records)
// ---------------------------------------------------------------------------

export async function listArmRecords(rootInput) {
  const root = await ensureRoot(rootInput)
  const directory = path.join(root, 'arms')
  const files = []
  async function walk(current) {
    let entries = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(absolute)
    }
  }
  await walk(directory)
  const records = []
  for (const file of files.sort()) {
    try {
      const stat = await fsp.stat(file)
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      const relative = path.relative(root, file).split(path.sep).join('/')
      records.push({ file, relative, fileName: path.basename(file), mtimeMs: stat.mtimeMs, ...parsed })
    } catch {
      // skip unreadable arm
    }
  }
  return records
}

// ---------------------------------------------------------------------------
// Release and withdrawal decision records (reports/ holds run records AND
// release decisions, per the framework's component list)
// ---------------------------------------------------------------------------

export async function writeDecisionRecord(rootInput, decision) {
  const root = await ensureRoot(rootInput)
  const at = new Date(decision.at ?? Date.now())
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = path.join(root, 'reports', `decision-${decision.kind}-${decision.routine}-v${decision.version}-${stamp}.json`)
  atomicWrite(file, JSON.stringify({ schemaVersion: 1, ...decision }, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// Atomic JSON file helpers used by runtime postcondition evidence
// ---------------------------------------------------------------------------

export async function writeJsonFile(file, value, options = {}) {
  atomicWrite(file, JSON.stringify(value, null, 2), options.mode)
  return file
}

export async function readJsonFile(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}
