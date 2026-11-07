// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Minimal, dependency-free validator for the routine-stabilization preset and
// its skill. `python3` has no PyYAML in this environment, so this script parses
// the small YAML subset used by routine-stabilization.yml itself and checks:
//
//   1. file/indentation hygiene (no tabs, two-space indentation);
//   2. the Loader patch shape: one `insert` row, `@deepseek-ai/dsh-agent-preset`
//      config with id/name/description/order/plugins;
//   3. required plugin rows: exactly 12 rows, the bundle skills dir mounted
//      through skill-filesystem, and NO second entry for the bundle package
//      (the profile-level Host row owns the routine tools and the panel);
//   4. YAML/definition.js equivalence for identity, description, persona and
//      the plugin id/name sequence;
//   5. SKILL.md frontmatter (name/description), the mandatory workflow
//      vocabulary and gate numbers, and the 8192-character skill budget.
//
// Usage: node preset/validate.mjs            (exit 0 = valid)
//        node preset/validate.mjs --verbose  (also prints the parsed summary)

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { preset } from './definition.js'
import { registerPreset } from './register.js'

const PRESET_DIR = dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = dirname(PRESET_DIR)
const YAML_FILE = join(PRESET_DIR, 'routine-stabilization.yml')
const SKILL_FILE = join(BUNDLE_DIR, 'skills', 'routine-stabilization', 'SKILL.md')

const EXPECTED_ID = 'routine-stabilization'
const EXPECTED_NAME = 'Routine stabilization / 例程稳定化'
const EXPECTED_ROW_ID = 'preset-routine-stabilization'
const EXPECTED_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const EXPECTED_BUNDLE = 'dsh-routine-stabilization'
const EXPECTED_PLUGIN_COUNT = 12
const SKILL_BUDGET = 8192

const issues = []
const fail = (message) => issues.push(message)

// ---------------------------------------------------------------------------
// YAML subset parser: block mappings, block sequences, block scalars, quoted
// and plain scalars, `!!js` scalars, comments, two-space indentation.
// ---------------------------------------------------------------------------

function normalizeLines(text) {
  if (text.includes('\t')) fail('YAML contains a tab character; use spaces')
  const raw = text.replace(/\r\n/g, '\n').split('\n')
  const lines = []
  for (const [index, line] of raw.entries()) {
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const content = line.slice(indent)
    if (content.startsWith('#')) continue
    if (indent % 2 !== 0) fail(`line ${index + 1}: indentation ${indent} is not a multiple of 2`)
    lines.push({ indent, content, line: index + 1 })
  }
  return lines
}

function stripTrailingComment(value) {
  if (value.startsWith('#')) return ''
  const match = value.match(/^(.*?)(?:\s+#\s.*)$/)
  return match ? match[1].trim() : value.trim()
}

function scalarValue(raw, lineNumber) {
  const value = stripTrailingComment(raw)
  if (value === '') return ''
  if (value.startsWith('!!js ')) {
    const expression = value.slice('!!js '.length).trim()
    if (expression === '') fail(`line ${lineNumber}: empty !!js expression`)
    return { kind: 'js', expression }
  }
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) return value.slice(1, -1)
  }
  if (value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

const blockScalarIndicator = (value) => (/^[>|][+-]?$/.test(stripTrailingComment(value)) ? stripTrailingComment(value) : null)
const isMappingEntry = (content) => /^[A-Za-z0-9_."'-][^:]*:(?:\s|$)/.test(content)
const isSequenceEntry = (content) => content === '-' || content.startsWith('- ')

function blockScalarFrom(slice, indicator, lineNumber) {
  if (slice.length === 0) fail(`line ${lineNumber}: block scalar has no content`)
  const parts = slice.map((entry) => entry.content)
  const joined = indicator.startsWith('>') ? parts.join(' ') : parts.join('\n')
  return indicator.endsWith('-') ? joined.replace(/\n+$/, '') : joined.trim()
}

function parseDocs(lines) {
  function parseBlock(subLines, cursor, indent) {
    const first = subLines[cursor.i]
    if (first === undefined || first.indent !== indent) return null
    return isSequenceEntry(first.content) ? parseSequence(subLines, cursor, indent) : parseMapping(subLines, cursor, indent)
  }

  function sliceDeeper(subLines, cursor, indent) {
    const start = cursor.i
    while (cursor.i < subLines.length && subLines[cursor.i].indent > indent) cursor.i += 1
    return subLines.slice(start, cursor.i)
  }

  function parseSequence(subLines, cursor, indent) {
    const items = []
    while (cursor.i < subLines.length) {
      const line = subLines[cursor.i]
      if (line.indent !== indent || !isSequenceEntry(line.content)) break
      const rest = line.content.slice(1).replace(/^ /, '')
      cursor.i += 1
      if (rest === '') {
        const nested = sliceDeeper(subLines, cursor, indent)
        items.push(nested.length === 0 ? null : parseBlock(nested, { i: 0 }, nested[0].indent))
        continue
      }
      if (!isMappingEntry(rest) && !rest.startsWith('- ')) {
        items.push(scalarValue(rest, line.line))
        continue
      }
      const itemLines = [{ indent: indent + 2, content: rest, line: line.line }, ...sliceDeeper(subLines, cursor, indent)]
      items.push(parseBlock(itemLines, { i: 0 }, indent + 2))
    }
    return items
  }

  function parseMapping(subLines, cursor, indent) {
    const mapping = {}
    while (cursor.i < subLines.length) {
      const line = subLines[cursor.i]
      if (line.indent !== indent || isSequenceEntry(line.content)) break
      const colon = line.content.indexOf(':')
      if (colon < 0) {
        fail(`line ${line.line}: expected "key: value"`)
        cursor.i += 1
        continue
      }
      const key = line.content.slice(0, colon).trim()
      const raw = line.content.slice(colon + 1).trim()
      cursor.i += 1
      const indicator = blockScalarIndicator(raw)
      if (raw === '') {
        const nested = sliceDeeper(subLines, cursor, indent)
        mapping[key] = nested.length === 0 ? null : parseBlock(nested, { i: 0 }, nested[0].indent)
      } else if (indicator !== null) {
        mapping[key] = blockScalarFrom(sliceDeeper(subLines, cursor, indent), indicator, line.line)
      } else {
        mapping[key] = scalarValue(raw, line.line)
      }
    }
    return mapping
  }

  const cursor = { i: 0 }
  const value = parseBlock(lines, cursor, lines[0]?.indent ?? 0)
  if (cursor.i < lines.length) fail(`line ${lines[cursor.i].line}: trailing content could not be parsed`)
  return value
}

const parseYaml = (text) => parseDocs(normalizeLines(text))
const normalizeWhitespace = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkYamlShape() {
  if (!existsSync(YAML_FILE)) throw new Error(`missing ${YAML_FILE}`)
  const document = parseYaml(readFileSync(YAML_FILE, 'utf8'))
  if (!Array.isArray(document) || document.length === 0) throw new Error('top level must be a non-empty patch array')
  const patch = document[0]
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.insert) || patch.insert.length === 0) {
    throw new Error('first patch entry must be "- insert: [...]"')
  }
  if (patch.insert.length !== 1) throw new Error('the preset patch must insert exactly one row')
  const row = patch.insert[0]
  if (!row || typeof row !== 'object') throw new Error('insert row must be a mapping')
  if (row.id !== EXPECTED_ROW_ID) fail(`insert row id must be ${EXPECTED_ROW_ID}, got ${JSON.stringify(row.id)}`)
  if (row.name !== EXPECTED_PRESET_PLUGIN) fail(`insert row name must be ${EXPECTED_PRESET_PLUGIN}`)
  const config = row.config
  if (!config || typeof config !== 'object') throw new Error('insert row has no config mapping')
  if (config.id !== EXPECTED_ID) fail(`config.id must be ${EXPECTED_ID}, got ${JSON.stringify(config.id)}`)
  if (config.name !== EXPECTED_NAME) fail(`config.name must be ${EXPECTED_NAME}, got ${JSON.stringify(config.name)}`)
  if (typeof config.description !== 'string' || config.description.trim() === '') fail('config.description must be a non-empty string')
  if (typeof config.order !== 'number') fail('config.order must be a number')
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) throw new Error('config.plugins must be a non-empty array')

  const seen = new Set()
  for (const [index, plugin] of config.plugins.entries()) {
    if (!plugin || typeof plugin !== 'object') {
      fail(`plugins[${index}] is not a mapping`)
      continue
    }
    if (typeof plugin.name !== 'string' || plugin.name.trim() === '') fail(`plugins[${index}] needs a name`)
    if (plugin.id !== undefined) {
      if (seen.has(plugin.id)) fail(`duplicate plugin row id ${plugin.id}`)
      seen.add(plugin.id)
    }
  }
  const names = config.plugins.map((plugin) => plugin?.name)
  if (config.plugins.length !== EXPECTED_PLUGIN_COUNT) {
    fail(`plugins must declare exactly ${EXPECTED_PLUGIN_COUNT} rows, got ${config.plugins.length}`)
  }
  if (names.includes(EXPECTED_BUNDLE)) {
    fail(
      `plugins must NOT mount ${EXPECTED_BUNDLE}: the bundle's profile-level Host row already provides ` +
        'the routine tools and Settings panel, and a second active Loader entry breaks client modules',
    )
  }
  const skillRow = config.plugins.find((plugin) => plugin?.name === '@deepseek-ai/dsh-skill-filesystem')
  if (!skillRow) fail('plugins must mount @deepseek-ai/dsh-skill-filesystem for the bundle skills directory')
  else {
    const dirs = skillRow.config?.customSkillDirs
    const first = Array.isArray(dirs) ? dirs[0] : undefined
    if (!Array.isArray(dirs) || dirs.length === 0) fail('skill-filesystem needs config.customSkillDirs with the bundle skills path')
    else if (!(typeof first === 'string' || first?.kind === 'js')) fail('customSkillDirs[0] must be a path or a !!js expression')
    else if (first?.kind === 'js' && !String(first.expression).includes("'skills'")) {
      fail('the skills-dir expression must end in the package "skills" directory')
    }
  }
  return config
}

function checkDefinition(yamlConfig) {
  if (typeof registerPreset !== 'function') fail('register.js must export `registerPreset(agentPresets, ctx)` for index.js')
  if (!preset || typeof preset !== 'object') throw new Error('definition.js must export `preset` as an object')
  if (preset.id !== EXPECTED_ID) fail(`definition.id must be ${EXPECTED_ID}`)
  if (preset.name !== EXPECTED_NAME) fail(`definition.name must be ${EXPECTED_NAME}`)
  if (preset.order !== yamlConfig.order) fail('definition.order must match the YAML order')
  if (normalizeWhitespace(preset.description) !== normalizeWhitespace(yamlConfig.description)) {
    fail('definition.description must match the YAML description')
  }
  if (!Array.isArray(preset.plugins) || preset.plugins.length === 0) throw new Error('definition.plugins must be non-empty')
  const yamlPlugins = yamlConfig.plugins.map((plugin) => `${plugin?.id ?? ''}:${plugin?.name ?? ''}`)
  const jsPlugins = preset.plugins.map((plugin) => `${plugin?.id ?? ''}:${plugin?.name ?? ''}`)
  if (yamlPlugins.join('|') !== jsPlugins.join('|')) {
    fail('YAML plugins and definition.js plugins must declare the same id/name sequence')
    fail(`  yaml: ${yamlPlugins.join(', ')}`)
    fail(`  node: ${jsPlugins.join(', ')}`)
  }
  const yamlPersona = yamlConfig.plugins.find((plugin) => plugin?.id === 'persona')?.config?.prefix
  const jsPersona = preset.plugins.find((plugin) => plugin?.id === 'persona')?.config?.prefix
  if (normalizeWhitespace(yamlPersona) !== normalizeWhitespace(jsPersona)) fail('persona prefix must match between YAML and definition.js')
  const jsSkillRow = preset.plugins.find((plugin) => plugin?.name === '@deepseek-ai/dsh-skill-filesystem')
  const jsDirs = jsSkillRow?.config?.customSkillDirs
  if (!Array.isArray(jsDirs) || !String(jsDirs[0] ?? '').endsWith(join('skills'))) {
    fail('definition.js skill-filesystem customSkillDirs[0] must resolve to the bundle skills/ directory')
  }
}

function checkSkill() {
  if (!existsSync(SKILL_FILE)) throw new Error(`missing ${SKILL_FILE}`)
  const text = readFileSync(SKILL_FILE, 'utf8')
  if (text.includes('\t')) fail('SKILL.md contains a tab character')
  if (!text.startsWith('---\n')) fail('SKILL.md must start with YAML frontmatter (---)')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed by ---')
  const frontmatter = text.slice(4, end)
  const body = text.slice(end + 5)
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m)
  if (!nameMatch) fail('SKILL.md frontmatter needs a name')
  else if (normalizeWhitespace(nameMatch[1]) !== basename(dirname(SKILL_FILE))) {
    fail(`SKILL.md name must equal its directory (${basename(dirname(SKILL_FILE))})`)
  }
  if (!descriptionMatch || normalizeWhitespace(descriptionMatch[1]) === '') fail('SKILL.md frontmatter needs a description')
  if (body.trim() === '') fail('SKILL.md body must not be empty')
  if (body.trim().length > SKILL_BUDGET) {
    fail(`SKILL.md body is ${body.trim().length} chars; the shipped budget is ${SKILL_BUDGET} (tool-result pruner threshold)`)
  }
  const required = [
    'routine_status',
    'routine_evaluate',
    'routine_run',
    'routine_propose',
    'routine_compare',
    'routine_report',
    'coverage',
    'silent error',
    'shadow',
    'release',
    'withdraw',
    'guard',
    'binding',
    'execution',
    'postcondition',
    'reproducibility',
    'blind',
    '60%',
    '5%',
    '4.95%',
    '59',
    '40',
    '100',
  ]
  for (const needle of required) {
    if (!body.includes(needle)) fail(`SKILL.md body is missing required term: ${needle}`)
  }
  return body.trim()
}

// ---------------------------------------------------------------------------

try {
  const config = checkYamlShape()
  checkDefinition(config)
  const body = checkSkill()
  if (issues.length > 0) {
    for (const issue of issues) console.error(`FAIL ${issue}`)
    console.error(`\n${issues.length} issue(s); preset and skill are NOT valid.`)
    process.exit(1)
  }
  if (process.argv.includes('--verbose')) {
    console.log(
      JSON.stringify(
        {
          preset: { id: config.id, name: config.name, order: config.order, plugins: config.plugins.map((plugin) => plugin.name) },
          skill: { file: SKILL_FILE, bodyChars: body.length, budget: SKILL_BUDGET },
        },
        null,
        2,
      ),
    )
  }
  console.log(`OK preset ${config.id} (${config.plugins.length} plugin rows); SKILL.md body ${body.length}/${SKILL_BUDGET} chars.`)
  process.exit(0)
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`)
  process.exit(1)
}
