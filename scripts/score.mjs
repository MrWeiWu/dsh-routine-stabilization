#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Blind scoring command for the release reviewer.
 *
 *   node scripts/score.mjs --root <registry-root> [--routine <id>] [--version <v>]
 *                          [--run <blind-run.json>] [--json]
 *
 * The candidate agent may read the inputs under `fixtures/`, but the labels live
 * under `blind/` (0700/0600). This command is the only supported way to open the
 * protected per-case scoring detail that `routine_evaluate` wrote. It:
 *
 *   1. loads the committed blind labels (not the less-protected fixture tree);
 *   2. resolves the protected run file: `--run` if given, else the latest
 *      evaluation report's `blindRun.path`, else the newest file under
 *      `blind/runs/`;
 *   3. joins expected labels with the recorded decisions and prints one row per
 *      case plus per-set aggregates;
 *   4. refuses to run (exit 1) when the labels cannot be read, when the run was
 *      produced against different labels, or when the protected detail is
 *      internally inconsistent.
 *
 * It deliberately does NOT import lib/engine.js or re-run the routine: scoring a
 * frozen evaluation reads plain JSON only, so the reviewer's result cannot depend
 * on candidate code changing at review time. Node built-ins only.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DECISION_SETS = ['dev', 'audit', 'challenge'];
const BLIND_SETS = ['audit', 'challenge'];
const DEFAULT_ROUTINE = 'normalize_detuning';
const DEFAULT_VERSION = '1';

function fail(message, exitCode = 1) {
  console.error(`score: ${message}`);
  process.exit(exitCode);
}

function usage() {
  return [
    'usage: node scripts/score.mjs --root <registry-root> [options]',
    '',
    '  --root <path>      registry root that holds routines/, fixtures/, blind/, reports/',
    '  --routine <id>     routine id (default: normalize_detuning)',
    '  --version <v>      routine version (default: 1)',
    '  --run <file>       protected blind-run JSON (default: latest report / blind/runs)',
    '  --json             print machine-readable JSON instead of tables',
    '  --help             show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    root: null,
    routine: DEFAULT_ROUTINE,
    version: DEFAULT_VERSION,
    run: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`missing value for ${arg}`, 2);
      index += 1;
      return value;
    };
    if (arg === '--root') options.root = takeValue();
    else if (arg === '--routine') options.routine = takeValue();
    else if (arg === '--version') options.version = takeValue();
    else if (arg === '--run') options.run = takeValue();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else fail(`unknown argument ${JSON.stringify(arg)} (try --help)`, 2);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Small fs / json helpers
// ---------------------------------------------------------------------------

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    fail(`cannot read ${file} (${reason})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  return null;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function defaultRoot() {
  const home = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'routine-registry');
}

// ---------------------------------------------------------------------------
// Registry records: manifest, labels, reports, protected run
// ---------------------------------------------------------------------------

function resolveRoutine(root, routine, version) {
  const direct = path.join(root, 'routines', routine, String(version));
  if (isFile(path.join(direct, 'manifest.json'))) {
    return { directory: direct, manifest: readJsonFile(path.join(direct, 'manifest.json')) };
  }
  const idDirectory = path.join(root, 'routines', routine);
  if (existsSync(idDirectory)) {
    for (const name of readdirSync(idDirectory).sort()) {
      const candidate = path.join(idDirectory, name, 'manifest.json');
      if (!isFile(candidate)) continue;
      const manifest = readJsonFile(candidate);
      if (String(manifest.version) === String(version)) {
        return { directory: path.dirname(candidate), manifest };
      }
    }
  }
  fail(`routine ${routine}/${version} not found under ${path.join(root, 'routines')}`);
  return null;
}

function resolveEvidencePath(root, routineDirectory, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') return null;
  if (path.isAbsolute(relative)) return relative;
  const candidates = [path.resolve(root, relative), path.resolve(routineDirectory, relative)];
  return candidates.find(isFile) ?? candidates[0];
}

function loadBlindLabels(root, routineDirectory, routine, version, manifest) {
  const declared = manifest.evidence?.blindLabels ?? {};
  const labels = {};
  for (const set of BLIND_SETS) {
    const candidates = [];
    if (typeof declared[set] === 'string') {
      if (path.isAbsolute(declared[set])) candidates.push(declared[set]);
      else {
        candidates.push(path.resolve(root, declared[set]));
        candidates.push(path.resolve(routineDirectory, declared[set]));
      }
    }
    candidates.push(path.join(root, 'blind', routine, String(version), `${set}.labels.json`));
    const file = candidates.find(isFile);
    if (!file) {
      fail(
        `cannot read the blind ${set} labels (looked in ${candidates.join(', ')}). ` +
          'The labels are private to the release reviewer; nothing was scored.',
      );
    }
    const doc = readJsonFile(file);
    if (!doc || !Array.isArray(doc.cases)) {
      fail(`cannot score: ${file} has no cases array (labels are unreadable or malformed)`);
    }
    const map = new Map();
    for (const labelCase of doc.cases) {
      if (typeof labelCase.id !== 'string' || !labelCase.expect) {
        fail(`cannot score: ${file} has a label case without id/expect`);
      }
      map.set(labelCase.id, labelCase.expect);
    }
    labels[set] = { file, sha256: sha256File(file), map };
  }
  return labels;
}

function loadDevLabels(root, routineDirectory, manifest) {
  const file = resolveEvidencePath(
    root,
    routineDirectory,
    manifest.evidence?.fixtureSets?.dev,
  );
  if (!file || !isFile(file)) {
    console.error('score: warning: dev fixture set is missing; dev cases are not scored');
    return null;
  }
  const doc = readJsonFile(file);
  const map = new Map();
  for (const fixtureCase of doc.cases ?? []) {
    if (fixtureCase.expect) map.set(fixtureCase.id, fixtureCase.expect);
  }
  return map.size > 0 ? { file, sha256: sha256File(file), map } : null;
}

function listReports(root) {
  const directory = path.join(root, 'reports');
  if (!existsSync(directory)) return [];
  const reports = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    reports.push({ file, data });
  }
  return reports;
}

function latestEvaluationReport(root, routine, version) {
  const matching = listReports(root).filter(
    (report) =>
      report.data.kind === 'evaluation' &&
      report.data.routine === routine &&
      String(report.data.version) === String(version),
  );
  matching.sort((left, right) =>
    String(right.data.generatedAt ?? '').localeCompare(String(left.data.generatedAt ?? '')),
  );
  return matching[0] ?? null;
}

function resolveRecordedRunPath(root, report) {
  const recorded = report.data.blindRun?.path;
  if (typeof recorded !== 'string' || recorded.trim() === '') return null;
  const candidates = path.isAbsolute(recorded)
    ? [recorded]
    : [
        path.resolve(root, recorded),
        path.resolve(path.dirname(report.file), recorded),
        path.resolve(process.cwd(), recorded),
      ];
  return candidates.find(isFile) ?? null;
}

function latestBlindRunFile(root, routine, version) {
  const directory = path.join(root, 'blind', 'runs');
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  const scoped = names.filter((name) => name.startsWith(`${routine}-v${version}-`));
  // The run filename ends with a sortable UTC stamp: <routine>-v<version>-<stamp>.json
  const preferred = scoped.sort().at(-1) ?? null;
  const fallback = names.sort().at(-1) ?? null;
  const name = preferred ?? fallback;
  return name ? path.join(directory, name) : null;
}

// ---------------------------------------------------------------------------
// Protected run detail
// ---------------------------------------------------------------------------

function resolveRunFile(options, root, routine, version) {
  let report = latestEvaluationReport(root, routine, version);
  if (options.run) {
    const file = path.resolve(process.cwd(), options.run);
    if (!isFile(file)) fail(`--run file not found: ${file}`);
    return { file, report };
  }
  if (report) {
    const file = resolveRecordedRunPath(root, report);
    if (file) return { file, report };
    console.error(
      `score: warning: report ${report.file} records blindRun.path that does not exist; ` +
        'falling back to the newest file under blind/runs/',
    );
  }
  const fallback = latestBlindRunFile(root, routine, version);
  if (fallback) return { file: fallback, report };
  fail(
    `no protected blind run found under ${root}: no evaluation report with a readable ` +
      `blindRun.path and no JSON file under ${path.join(root, 'blind', 'runs')}. ` +
      'Run `routine_evaluate` first (as the release reviewer).',
  );
  return null;
}

function extractRunCases(runDoc) {
  const grouped = { dev: [], audit: [], challenge: [] };
  const push = (set, record) => {
    if (!record || typeof record !== 'object') return;
    const target = Object.hasOwn(grouped, set) ? set : inferSet(record);
    if (target && Object.hasOwn(grouped, target)) grouped[target].push(record);
  };
  if (runDoc.cases && !Array.isArray(runDoc.cases) && typeof runDoc.cases === 'object') {
    for (const [set, list] of Object.entries(runDoc.cases)) {
      if (Array.isArray(list)) list.forEach((record) => push(set, record));
    }
    return grouped;
  }
  const array = Array.isArray(runDoc.cases)
    ? runDoc.cases
    : Array.isArray(runDoc.results)
      ? runDoc.results
      : Array.isArray(runDoc.outcomes)
        ? runDoc.outcomes
        : null;
  if (array) array.forEach((record) => push(record?.set ?? record?.caseSet, record));
  return grouped;
}

function inferSet(record) {
  const id = typeof record?.id === 'string' ? record.id : record?.caseId;
  if (typeof id !== 'string') return null;
  const head = id.split('-')[0];
  return DECISION_SETS.includes(head) ? head : null;
}

function expectedOf(record, set, labels, devLabels) {
  if (record.expected && typeof record.expected === 'object') return record.expected;
  if (record.expect && typeof record.expect === 'object') return record.expect;
  const source = set === 'dev' ? devLabels : labels[set]?.map;
  if (source && typeof source.get === 'function') return source.get(record.id) ?? null;
  return null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scoreRecord(set, record, labels, devLabels) {
  const id = typeof record.id === 'string' ? record.id : record.caseId ?? record.case;
  if (typeof id !== 'string' || id.length === 0) fail(`blind run has a ${set} case without an id`);
  const expected = expectedOf(record, set, labels, devLabels);
  if (!expected || typeof expected !== 'object') {
    fail(`cannot score ${set}/${id}: the run carries no expected value and no committed label matches`);
  }

  // The committed blind labels are the ground truth; a run scored against a
  // different label revision must not be accepted as evidence.
  const committed = set === 'dev' ? devLabels?.map?.get(id) : labels[set]?.map?.get(id);
  if (committed) {
    if (canonical(committed) !== canonical(expected)) {
      fail(
        `integrity: the run's expected value for ${set}/${id} does not match the committed ` +
          'labels; the run is stale or was not scored against these labels',
      );
    }
  } else if (set !== 'dev') {
    fail(`integrity: ${set}/${id} is absent from the committed blind labels`);
  }

  const decision = record.decision ?? record.actual?.decision ?? record.scored?.decision ?? null;
  const reason =
    record.reason ?? record.actual?.reason ?? record.scored?.actualReason ?? record.scored?.reason ?? null;
  const disposition = record.disposition ?? record.actual?.disposition ?? null;
  const difference = finiteOrNull(record.difference ?? record.scored?.difference);
  const allowed = finiteOrNull(record.allowed ?? record.scored?.allowed);

  let correct;
  if (expected.decision === 'accept') {
    if (decision !== 'accept') {
      correct = false;
    } else if (typeof record.correct === 'boolean') {
      correct = record.correct;
      if (correct && difference !== null && allowed !== null && difference > allowed) {
        fail(
          `integrity: ${set}/${id} is marked correct but |valueHz - expected| ` +
            `(${difference}) exceeds the allowed tolerance (${allowed})`,
        );
      }
    } else if (difference !== null && allowed !== null) {
      correct = difference <= allowed;
    } else {
      fail(`cannot score ${set}/${id}: the run has neither a correct flag nor difference/allowed`);
    }
  } else if (decision !== 'defer') {
    correct = false;
  } else {
    const reasonMatch =
      expected.reason === null || expected.reason === undefined || reason === expected.reason;
    if (typeof record.correct === 'boolean' && record.correct !== reasonMatch) {
      fail(`integrity: ${set}/${id} correct flag disagrees with the committed defer reason`);
    }
    correct = typeof record.correct === 'boolean' ? record.correct : reasonMatch;
  }

  return {
    id,
    set,
    expected,
    decision,
    reason,
    disposition,
    difference,
    allowed,
    correct,
  };
}

// ---------------------------------------------------------------------------
// Aggregates and rendering
// ---------------------------------------------------------------------------

function summarize(records) {
  const total = records.length;
  const automatic = records.filter((record) => record.decision === 'accept').length;
  const deferred = records.filter((record) => record.decision === 'defer').length;
  const fallback = records.filter((record) => record.decision === 'fallback').length;
  const correct = records.filter((record) => record.correct).length;
  // Mirrors the engine gates: any automatic result that is not correct is a
  // wrong automatic result (silent error), including an accept on a case the
  // labels say must defer.
  const incorrectAutomatic = records.filter(
    (record) => record.decision === 'accept' && !record.correct,
  ).length;
  const silentErrors = incorrectAutomatic;
  const needlessDeferrals = records.filter(
    (record) => record.expected.decision === 'accept' && record.decision === 'defer',
  ).length;
  return {
    cases: total,
    automatic,
    deferred,
    fallback,
    correct,
    incorrect: total - correct,
    silentErrors,
    incorrectAutomatic,
    needlessDeferrals,
    coverage: ratio(automatic, total),
    e2eSuccess: ratio(correct, total),
  };
}

function formatExpected(expected) {
  if (!expected || expected.decision === undefined) return '?';
  if (expected.decision === 'defer') return expected.reason ? `defer:${expected.reason}` : 'defer';
  return 'accept';
}

function printAggregateTable(summaries) {
  const header = ['set', 'cases', 'auto', 'defer', 'fallback', 'correct', 'silentErr', 'coverage', 'e2e'];
  const rows = summaries.map(({ set, summary }) => [
    set,
    String(summary.cases),
    String(summary.automatic),
    String(summary.deferred),
    String(summary.fallback),
    String(summary.correct),
    String(summary.silentErrors),
    percent(summary.coverage),
    percent(summary.e2eSuccess),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  console.log(render(header));
  for (const row of rows) console.log(render(row));
}

function printCaseTable(records) {
  const header = ['id', 'set', 'expected', 'decision', 'correct', 'difference', 'reason'];
  const rows = records.map((record) => [
    record.id,
    record.set,
    formatExpected(record.expected),
    record.decision ?? '?',
    record.correct ? 'yes' : 'NO',
    record.difference === null ? '-' : `|d|=${record.difference}`,
    record.reason ?? '-',
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  console.log(render(header));
  for (const row of rows) console.log(render(row));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root ?? defaultRoot());
  if (!existsSync(root)) {
    fail(`registry root does not exist: ${root} (pass --root or seed the example first)`);
  }
  const { directory: routineDirectory, manifest } = resolveRoutine(
    root,
    options.routine,
    options.version,
  );
  const labels = loadBlindLabels(root, routineDirectory, options.routine, options.version, manifest);
  const devLabels = loadDevLabels(root, routineDirectory, manifest);

  const { file: runFile, report } = resolveRunFile(
    options,
    root,
    options.routine,
    options.version,
  );
  const runSha256 = sha256File(runFile);
  if (report?.data.blindRun?.sha256) {
    const recordedRunFile = resolveRecordedRunPath(root, report);
    if (recordedRunFile && path.resolve(recordedRunFile) === path.resolve(runFile)) {
      if (report.data.blindRun.sha256 !== runSha256) {
        fail(
          `integrity: ${runFile} does not match the sha256 recorded in ${report.file}; ` +
            'the run file changed after the evaluation',
        );
      }
    }
  }
  const runDoc = readJsonFile(runFile);
  if (runDoc.routine && runDoc.routine !== options.routine) {
    fail(`integrity: run file is for routine ${runDoc.routine}, not ${options.routine}`);
  }
  if (runDoc.version !== undefined && String(runDoc.version) !== String(options.version)) {
    fail(`integrity: run file is for version ${runDoc.version}, not ${options.version}`);
  }

  // A run recorded against different label bytes cannot be evidence for these labels.
  for (const set of BLIND_SETS) {
    const recorded = runDoc.labels?.[set];
    if (typeof recorded === 'string' && recorded !== labels[set].sha256) {
      fail(
        `integrity: the run was scored against a different ${set} label set ` +
          `(run ${recorded.slice(0, 12)}…, current ${labels[set].sha256.slice(0, 12)}…); ` +
          're-run the evaluation',
      );
    }
  }

  const grouped = extractRunCases(runDoc);
  const records = [];
  for (const set of DECISION_SETS) {
    for (const record of grouped[set]) records.push(scoreRecord(set, record, labels, devLabels));
  }
  if (records.length === 0) fail(`the blind run ${runFile} contains no scorable cases`);

  const missingLabels = {};
  for (const set of BLIND_SETS) {
    const scored = new Set(records.filter((record) => record.set === set).map((record) => record.id));
    const missing = [...labels[set].map.keys()].filter((id) => !scored.has(id));
    missingLabels[set] = missing;
  }

  const summaries = DECISION_SETS.filter((set) =>
    records.some((record) => record.set === set),
  ).map((set) => ({
    set,
    summary: summarize(records.filter((record) => record.set === set)),
  }));
  const total = summarize(records);

  if (options.json) {
    const payload = {
      schemaVersion: 1,
      kind: 'blind-score',
      generatedAt: new Date().toISOString(),
      root,
      routine: options.routine,
      version: options.version,
      run: { path: runFile, sha256: runSha256, generatedAt: runDoc.generatedAt ?? null },
      report: report
        ? { path: report.file, generatedAt: report.data.generatedAt ?? null }
        : null,
      labels: Object.fromEntries(
        BLIND_SETS.map((set) => [
          set,
          { path: labels[set].file, sha256: labels[set].sha256, cases: labels[set].map.size },
        ]),
      ),
      aggregate: total,
      sets: Object.fromEntries(summaries.map(({ set, summary }) => [set, summary])),
      missingLabelCases: missingLabels,
      cases: records.map((record) => ({
        id: record.id,
        set: record.set,
        expected:
          record.expected.decision === 'defer'
            ? { decision: 'defer', reason: record.expected.reason ?? null }
            : { decision: 'accept' },
        decision: record.decision,
        reason: record.reason,
        correct: record.correct,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('BLIND SCORE (release reviewer only)');
  console.log(`  root: ${root}`);
  console.log(`  routine: ${options.routine}/v${options.version}`);
  console.log(`  run: ${runFile}`);
  console.log(`       sha256 ${runSha256}  generatedAt ${runDoc.generatedAt ?? 'unknown'}`);
  if (report) {
    console.log(`  report: ${report.file} (evaluation generatedAt ${report.data.generatedAt})`);
  } else {
    console.log('  report: none found (scoring the run file directly)');
  }
  for (const set of BLIND_SETS) {
    console.log(
      `  ${set} labels: ${labels[set].file} (${labels[set].map.size} cases, sha256 ${labels[set].sha256.slice(0, 16)}…)`,
    );
  }
  console.log('');
  console.log('Aggregate');
  printAggregateTable([...summaries, { set: 'TOTAL', summary: total }]);
  console.log('');
  console.log(`Per-case scoring (${records.length} cases)`);
  printCaseTable(records);

  for (const set of BLIND_SETS) {
    const missing = missingLabels[set];
    if (missing.length > 0) {
      console.error(
        `score: warning: ${set} run is missing ${missing.length} labelled case(s): ` +
          `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
      );
    }
  }
  const failures = records.filter((record) => !record.correct);
  console.log('');
  console.log(
    `Result: ${records.length - failures.length}/${records.length} correct, ` +
      `${total.silentErrors} silent error(s), ${total.needlessDeferrals} needless deferral(s).`,
  );
  if (failures.length > 0) {
    console.log(`Incorrect cases: ${failures.map((record) => record.id).join(', ')}`);
  }
}

main();
