#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Independent reference check for the built-in `normalize_detuning/v1` seed.
 *
 * This script intentionally does NOT import guard.js, binding.js or execution.js.
 * It re-implements the admission policy and re-derives every expected accepted
 * value from the raw fixture input with the analytic conversion formula, then
 * checks the frozen expectations and the attachment page-5 anchors.
 *
 * All paths are resolved relative to this script (import.meta.url), never to
 * process.cwd(), so the check behaves identically when run as
 *   node seed/evals/normalize_detuning/v1/reference_check.mjs
 * from any cwd and after the seed tree has been copied to a registry root.
 *
 * Exit code 0 on success; process.exit(1) on the first failed assertion.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_URL = import.meta.url;
const ROOT_URL = new URL('../../../', SCRIPT_URL);
const ROUTINE_URL = new URL('routines/normalize_detuning/v1/', ROOT_URL);
const FIXTURE_URL = (name) =>
  new URL(`../../../fixtures/normalize_detuning/v1/${name}.json`, SCRIPT_URL);
const ARM_URL = (name) => new URL(`arms/${name}.json`, ROOT_URL);
const MANIFEST_URL = new URL('manifest.json', ROUTINE_URL);
const EVALUATOR_URL = new URL('evals/normalize_detuning/v1/reference_check.mjs', ROOT_URL);

const FROZEN_AT = '2026-11-04T00:00:00Z';
const UNIT_ENUM = ['Hz', 'kHz', 'rad/s'];
const DEFER_REASONS = [
  'competing-fields',
  'invalid-value',
  'metadata-conflict',
  'missing-metadata',
  'unsupported-unit',
];
const POSTCONDITIONS = ['finite-output', 'preserve-field-id', 'unit-hz', 'sign-preserved'];
const ABS_TOLERANCE_HZ = 1e-9;
const REL_TOLERANCE = 1e-12;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(url) {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function closeTo(actual, expected, absTolerance, relTolerance) {
  return Math.abs(actual - expected) <= absTolerance + relTolerance * Math.abs(expected);
}

function pathExists(url) {
  return existsSync(fileURLToPath(url));
}

// ---------------------------------------------------------------------------
// Independent reference policy (mirror of the documented decision order,
// written from the specification rather than imported from the runtime hooks).
// ---------------------------------------------------------------------------

function normalizeUnit(unit) {
  return typeof unit === 'string' ? unit.trim().toLowerCase() : '';
}

function referenceDecide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  if (input.metadataSource !== 'trusted-schema') {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    return { decision: 'defer', reason: 'invalid-value' };
  }
  if (typeof input.unit !== 'string' || input.unit.trim() === '') {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  if (!UNIT_ENUM.includes(input.unit)) {
    return { decision: 'defer', reason: 'unsupported-unit' };
  }
  const declared = input.declaredUnit;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  const header =
    typeof declared.header === 'string' && declared.header.trim() !== '' ? declared.header : null;
  const schema =
    typeof declared.schema === 'string' && declared.schema.trim() !== '' ? declared.schema : null;
  if (!header && !schema) {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  if (header && schema && normalizeUnit(header) !== normalizeUnit(schema)) {
    return { decision: 'defer', reason: 'metadata-conflict' };
  }

  const fieldIdOk = typeof input.fieldId === 'string' && input.fieldId.trim() !== '';
  const candidates = Array.isArray(input.candidates) ? input.candidates : null;
  if (candidates && candidates.length > 0) {
    if (!fieldIdOk) {
      return { decision: 'defer', reason: 'competing-fields' };
    }
    const matched = candidates.filter(
      (candidate) => candidate && candidate.fieldId === input.fieldId,
    );
    if (matched.length === 0) {
      return { decision: 'defer', reason: 'competing-fields' };
    }
    const roles = [...new Set(matched.map((candidate) => candidate.role))];
    if (roles.includes('drive') || !roles.includes('detuning')) {
      return { decision: 'defer', reason: 'competing-fields' };
    }
    return { decision: 'accept', resolvedBy: 'candidates' };
  }
  if (!fieldIdOk) {
    return { decision: 'defer', reason: 'missing-metadata' };
  }
  return { decision: 'accept', resolvedBy: 'declared-unit' };
}

function parseValueToHz(input) {
  if (input.unit === 'Hz') return input.value;
  if (input.unit === 'kHz') return input.value * 1000;
  if (input.unit === 'rad/s') return input.value / (2 * Math.PI);
  throw new Error(`cannot parse unsupported unit ${input.unit} to Hz`);
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

function checkManifest(manifest) {
  assert(manifest.schemaVersion === 1, 'manifest.schemaVersion must be 1');
  assert(manifest.id === 'normalize_detuning', 'manifest.id must be normalize_detuning');
  assert(manifest.version === '1', 'manifest.version must be "1"');
  assert(typeof manifest.title === 'string' && manifest.title.length > 0, 'manifest.title missing');
  assert(
    typeof manifest.summary === 'string' && manifest.summary.length > 0,
    'manifest.summary missing',
  );
  assert(typeof manifest.owner === 'string' && manifest.owner.length > 0, 'manifest.owner missing');
  assert(
    manifest.contractRevision === 'normalize_detuning/v1',
    'manifest.contractRevision must be normalize_detuning/v1',
  );
  assert(
    JSON.stringify(manifest.allowedEffects) === JSON.stringify(['read-only']),
    'manifest.allowedEffects must be read-only',
  );
  assert(Array.isArray(manifest.dependencies) && manifest.dependencies.length === 0,
    'manifest.dependencies must be empty');

  const metadata = manifest.inputs && manifest.inputs.metadata;
  assert(metadata, 'manifest.inputs.metadata missing');
  assert(
    JSON.stringify(metadata.unitEnum) === JSON.stringify(UNIT_ENUM),
    'manifest.inputs.metadata.unitEnum mismatch',
  );
  for (const required of ['fieldId', 'unit', 'declaredUnit', 'metadataSource']) {
    assert(metadata.requires.includes(required), `manifest.inputs.metadata.requires missing ${required}`);
  }
  assert(
    manifest.inputs.schema && manifest.inputs.schema.type === 'object',
    'manifest.inputs.schema must describe an object',
  );

  assert(
    manifest.admission && manifest.admission.predicate === 'guard.js#decide',
    'manifest.admission.predicate must be guard.js#decide',
  );
  for (const reason of DEFER_REASONS) {
    assert(
      manifest.admission.deferReasons &&
        typeof manifest.admission.deferReasons[reason] === 'string' &&
        manifest.admission.deferReasons[reason].length > 0,
      `manifest.admission.deferReasons missing ${reason}`,
    );
  }

  assert(
    manifest.binding && manifest.binding.entry === 'binding.js#bind',
    'manifest.binding.entry must be binding.js#bind',
  );
  assert(manifest.binding.preservesOriginalInput === true,
    'manifest.binding.preservesOriginalInput must be true');
  assert(
    manifest.execution && manifest.execution.entry === 'execution.js#run',
    'manifest.execution.entry must be execution.js#run',
  );
  const outputSchema = manifest.execution.outputSchema;
  assert(outputSchema && outputSchema.type === 'object', 'manifest.execution.outputSchema missing');
  for (const key of ['fieldId', 'sourceUnit', 'valueHz']) {
    assert(outputSchema.required.includes(key), `outputSchema.required missing ${key}`);
  }

  assert(Array.isArray(manifest.postconditions), 'manifest.postconditions must be an array');
  for (const id of POSTCONDITIONS) {
    const entry = manifest.postconditions.find((postcondition) => postcondition.id === id);
    assert(entry, `manifest.postconditions missing ${id}`);
    assert(
      typeof entry.description === 'string' && entry.description.length > 0,
      `manifest.postconditions ${id} has no description`,
    );
  }

  assert(
    manifest.errorPolicy &&
      manifest.errorPolicy.onCheckFailure === 'discard-and-fallback' &&
      manifest.errorPolicy.onUnavailable === 'ask-user',
    'manifest.errorPolicy mismatch',
  );
  assert(
    manifest.fallback && manifest.fallback.mode === 'ask-user' &&
      typeof manifest.fallback.description === 'string' &&
      manifest.fallback.description.length > 0,
    'manifest.fallback mismatch',
  );

  const evidence = manifest.evidence;
  assert(evidence, 'manifest.evidence missing');
  assert(Array.isArray(evidence.derivationTraces), 'evidence.derivationTraces must be an array');
  assert(evidence.provenance === 'synthetic', 'evidence.provenance must be synthetic');
  assert(evidence.approvedRelease === null, 'evidence.approvedRelease must be null before release');
  assert(
    typeof evidence.withdrawalTrigger === 'string' && evidence.withdrawalTrigger.length > 0,
    'evidence.withdrawalTrigger missing',
  );

  const expectedFixtureSets = {
    dev: 'fixtures/normalize_detuning/v1/dev.json',
    audit: 'fixtures/normalize_detuning/v1/audit.json',
    challenge: 'fixtures/normalize_detuning/v1/challenge.json',
  };
  assert(
    JSON.stringify(evidence.fixtureSets) === JSON.stringify(expectedFixtureSets),
    'evidence.fixtureSets must use root-relative fixtures/normalize_detuning/v1/*.json paths',
  );
  assert(
    evidence.evaluator === 'evals/normalize_detuning/v1/reference_check.mjs',
    'evidence.evaluator path mismatch',
  );

  // Every manifest-root-relative path must resolve under the registry root, both
  // in the seed tree and after the seed tree is copied to the registry root.
  for (const [setName, relativePath] of Object.entries(expectedFixtureSets)) {
    const url = new URL(relativePath, ROOT_URL);
    assert(pathExists(url), `evidence.fixtureSets.${setName} does not resolve: ${relativePath}`);
    const scriptRelativeUrl = FIXTURE_URL(setName);
    assert(
      fileURLToPath(url) === fileURLToPath(scriptRelativeUrl),
      `fixture set ${setName} resolved via manifest and via script differ`,
    );
  }
  assert(pathExists(EVALUATOR_URL), 'evidence.evaluator does not resolve');

  for (const hook of ['guard.js', 'binding.js', 'execution.js', 'manifest.json']) {
    assert(pathExists(new URL(hook, ROUTINE_URL)), `routine hook missing: ${hook}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture validation
// ---------------------------------------------------------------------------

function checkFixtureSet(name, data, counters) {
  assert(data.schemaVersion === 1, `${name}: schemaVersion must be 1`);
  assert(data.set === name, `${name}: set must be "${name}"`);
  assert(
    typeof data.provenance === 'string' && data.provenance.length > 0,
    `${name}: provenance missing`,
  );
  assert(data.provenance === 'synthetic', `${name}: provenance must be synthetic`);
  assert(data.frozenAt === FROZEN_AT, `${name}: frozenAt must be ${FROZEN_AT}`);
  assert(Array.isArray(data.cases) && data.cases.length > 0, `${name}: cases must be a non-empty array`);

  const expectedCounts = { dev: 24, audit: 100, challenge: 40 };
  if (name === 'dev') {
    assert(data.cases.length >= expectedCounts.dev, `dev: expected >= 24 cases, got ${data.cases.length}`);
  } else {
    assert(
      data.cases.length === expectedCounts[name],
      `${name}: expected ${expectedCounts[name]} cases, got ${data.cases.length}`,
    );
  }

  const seenIds = new Set();
  for (const fixtureCase of data.cases) {
    assert(fixtureCase && typeof fixtureCase === 'object', `${name}: case must be an object`);
    const id = fixtureCase.id;
    assert(typeof id === 'string' && id.length > 0, `${name}: case id missing`);
    assert(!seenIds.has(id), `${name}: duplicate case id ${id}`);
    seenIds.add(id);
    assert(
      counters.ids.get(id) === undefined,
      `duplicate case id ${id} across fixture sets`,
    );
    counters.ids.set(id, name);
    assert(
      typeof fixtureCase.description === 'string' && fixtureCase.description.length > 0,
      `${name}/${id}: description missing`,
    );

    const input = fixtureCase.input;
    const expect = fixtureCase.expect;
    assert(input && typeof input === 'object', `${name}/${id}: input missing`);
    assert(expect && typeof expect === 'object', `${name}/${id}: expect missing`);
    assert(
      expect.decision === 'accept' || expect.decision === 'defer',
      `${name}/${id}: expect.decision must be accept or defer`,
    );

    const reference = referenceDecide(input);
    assert(
      reference.decision === expect.decision,
      `${name}/${id}: expected decision ${expect.decision}, independent reference says ${reference.decision}` +
        (reference.reason ? ` (${reference.reason})` : ''),
    );

    if (expect.decision === 'defer') {
      assert(
        typeof expect.reason === 'string' && DEFER_REASONS.includes(expect.reason),
        `${name}/${id}: defer must carry a reason from the manifest vocabulary`,
      );
      assert(
        reference.reason === expect.reason,
        `${name}/${id}: expected reason ${expect.reason}, independent reference says ${reference.reason}`,
      );
      assert(expect.checks === null, `${name}/${id}: defer checks must be null`);
      counters.defer += 1;
      counters.deferReasons[expect.reason] = (counters.deferReasons[expect.reason] || 0) + 1;
      continue;
    }

    const checks = expect.checks;
    assert(checks && typeof checks === 'object', `${name}/${id}: accept checks must be an object`);
    // field identity and numeric value are asserted separately.
    assert(
      checks.fieldId === input.fieldId,
      `${name}/${id}: checks.fieldId must equal input.fieldId (preserve-field-id)`,
    );
    assert(checks.unit === 'Hz', `${name}/${id}: checks.unit must be Hz`);
    assert(
      Number.isFinite(checks.valueHz),
      `${name}/${id}: checks.valueHz must be finite`,
    );
    assert(
      checks.absToleranceHz === ABS_TOLERANCE_HZ,
      `${name}/${id}: absToleranceHz must be ${ABS_TOLERANCE_HZ}`,
    );
    assert(checks.relTolerance === REL_TOLERANCE, `${name}/${id}: relTolerance must be ${REL_TOLERANCE}`);

    const recomputed = parseValueToHz(input);
    assert(
      closeTo(checks.valueHz, recomputed, ABS_TOLERANCE_HZ, REL_TOLERANCE),
      `${name}/${id}: expected valueHz ${checks.valueHz} != analytic ${recomputed}`,
    );
    if (input.value !== 0) {
      assert(
        Math.sign(checks.valueHz) === Math.sign(input.value),
        `${name}/${id}: sign not preserved (value ${input.value} -> valueHz ${checks.valueHz})`,
      );
    }
    counters.accept += 1;
  }
}

// ---------------------------------------------------------------------------
// Attachment page-5 anchors
// ---------------------------------------------------------------------------

function checkAnchors(dev) {
  const byId = new Map(dev.cases.map((fixtureCase) => [fixtureCase.id, fixtureCase]));
  const required = [
    'anchor-neg-khz',
    'anchor-rad-s',
    'anchor-dual-khz-explicit',
    'anchor-dual-khz-no-id',
    'anchor-metadata-conflict',
  ];
  for (const id of required) {
    assert(byId.has(id), `dev anchor missing: ${id}`);
  }
  const anchor = (id) => byId.get(id);

  // Anchor 1: -3.25 kHz -> -3250 Hz, field id preserved.
  const a1 = anchor('anchor-neg-khz');
  assert(a1.expect.decision === 'accept', 'anchor-neg-khz must accept');
  assert(a1.input.value === -3.25 && a1.input.unit === 'kHz', 'anchor-neg-khz input mismatch');
  assert(a1.expect.checks.fieldId === 'detuning_khz', 'anchor-neg-khz field id not preserved');
  assert(
    closeTo(a1.expect.checks.valueHz, -3250, ABS_TOLERANCE_HZ, REL_TOLERANCE),
    'anchor-neg-khz must normalize -3.25 kHz to -3250 Hz',
  );

  // Anchor 2: +2*pi*150 rad/s -> +150 Hz.
  const a2 = anchor('anchor-rad-s');
  assert(a2.expect.decision === 'accept', 'anchor-rad-s must accept');
  assert(a2.input.unit === 'rad/s', 'anchor-rad-s input unit mismatch');
  assert(
    Math.abs(a2.input.value - 2 * Math.PI * 150) <= ABS_TOLERANCE_HZ,
    'anchor-rad-s input must be 2*pi*150 rad/s',
  );
  assert(a2.expect.checks.fieldId === 'detuning_rad', 'anchor-rad-s field id not preserved');
  assert(
    closeTo(a2.expect.checks.valueHz, 150, ABS_TOLERANCE_HZ, REL_TOLERANCE),
    'anchor-rad-s must normalize 2*pi*150 rad/s to 150 Hz',
  );

  // Anchor 3a: drive + detuning both kHz; accept only the explicit detuning id.
  const a3 = anchor('anchor-dual-khz-explicit');
  assert(a3.expect.decision === 'accept', 'anchor-dual-khz-explicit must accept');
  const driveColumn = a3.input.candidates.find((candidate) => candidate.role === 'drive');
  const detuningColumn = a3.input.candidates.find((candidate) => candidate.role === 'detuning');
  assert(driveColumn && detuningColumn, 'anchor-dual-khz-explicit needs drive and detuning columns');
  assert(
    driveColumn.unit === 'kHz' && detuningColumn.unit === 'kHz',
    'anchor-dual-khz-explicit columns must both be kHz',
  );
  // Field identity asserted separately from the numeric value.
  assert(
    a3.input.fieldId === detuningColumn.fieldId,
    'anchor-dual-khz-explicit must identify the detuning field',
  );
  assert(
    a3.expect.checks.fieldId === detuningColumn.fieldId &&
      a3.expect.checks.fieldId !== driveColumn.fieldId,
    'anchor-dual-khz-explicit bound the wrong field id',
  );
  assert(
    closeTo(a3.expect.checks.valueHz, a3.input.value * 1000, ABS_TOLERANCE_HZ, REL_TOLERANCE),
    'anchor-dual-khz-explicit valueHz must be input.value * 1000',
  );

  // Anchor 3b: the same dual columns without an explicit id must defer.
  const a3b = anchor('anchor-dual-khz-no-id');
  assert(a3b.expect.decision === 'defer', 'anchor-dual-khz-no-id must defer');
  assert(
    a3b.expect.reason === 'competing-fields',
    'anchor-dual-khz-no-id must defer with competing-fields',
  );
  assert(a3b.expect.checks === null, 'anchor-dual-khz-no-id must not produce a numeric answer');

  // Anchor 4: header Hz vs schema rad/s conflict must defer, in any numeric answer.
  const a4 = anchor('anchor-metadata-conflict');
  assert(a4.expect.decision === 'defer', 'anchor-metadata-conflict must defer');
  assert(
    a4.input.declaredUnit.header === 'Hz' && a4.input.declaredUnit.schema === 'rad/s',
    'anchor-metadata-conflict declaration mismatch',
  );
  assert(
    a4.expect.reason === 'metadata-conflict',
    'anchor-metadata-conflict must defer with metadata-conflict',
  );
  assert(a4.expect.checks === null, 'anchor-metadata-conflict must not produce a numeric answer');

  return required.length;
}

// ---------------------------------------------------------------------------
// Three-arm pilot data
// ---------------------------------------------------------------------------

function armMetrics(arm) {
  const requests = arm.workload.requests;
  const horizonDays = arm.workload.horizonDays;
  const resolved = arm.cases.filter((entry) => entry.resolved).length;
  const correct = arm.cases.filter((entry) => entry.correct).length;
  const resolvedCorrect = arm.cases.filter((entry) => entry.resolved && entry.correct).length;
  const silentErrors = arm.cases.filter((entry) => entry.resolved && !entry.correct).length;
  const caseCost = arm.cases.reduce((sum, entry) => sum + entry.costUsd, 0);
  const totalCostUsd =
    arm.setupCostUsd + arm.maintenanceCostUsd * (horizonDays / 30) + caseCost;
  const avgLatencyMs =
    arm.cases.reduce((sum, entry) => sum + entry.latencyMs, 0) / requests;
  return {
    requests,
    resolved,
    correct,
    resolvedCorrect,
    silentErrors,
    coverage: resolved / requests,
    e2e: correct / requests,
    strictE2e: resolvedCorrect / requests,
    totalCostUsd,
    avgLatencyMs,
  };
}

function checkArms(audit, manifest) {
  const auditIds = audit.cases.map((fixtureCase) => fixtureCase.id);
  const files = [
    ['A', 'arm-a'],
    ['B', 'arm-b'],
    ['C', 'arm-c'],
  ];
  const arms = new Map();

  for (const [arm, file] of files) {
    const data = readJson(ARM_URL(file));
    assert(data.schemaVersion === 1, `${file}: schemaVersion must be 1`);
    assert(data.runId === 'example', `${file}: runId must be "example"`);
    assert(data.arm === arm, `${file}: arm must be ${arm}`);
    assert(typeof data.label === 'string' && data.label.length > 0, `${file}: label missing`);
    assert(
      data.workload && data.workload.requests === 100 && data.workload.horizonDays === 30,
      `${file}: workload must be requests=100, horizonDays=30`,
    );
    assert(Number.isFinite(data.setupCostUsd) && data.setupCostUsd >= 0,
      `${file}: setupCostUsd invalid`);
    assert(Number.isFinite(data.maintenanceCostUsd) && data.maintenanceCostUsd >= 0,
      `${file}: maintenanceCostUsd invalid`);
    assert(Array.isArray(data.cases) && data.cases.length === 100,
      `${file}: cases must contain 100 entries`);
    const seen = new Set();
    data.cases.forEach((entry, index) => {
      assert(entry.caseId === auditIds[index],
        `${file}: case ${index} is not paired with audit case ${auditIds[index]}`);
      assert(!seen.has(entry.caseId), `${file}: duplicate paired case ${entry.caseId}`);
      seen.add(entry.caseId);
      assert(typeof entry.resolved === 'boolean', `${file}/${entry.caseId}: resolved must be boolean`);
      assert(typeof entry.correct === 'boolean', `${file}/${entry.caseId}: correct must be boolean`);
      assert(Number.isFinite(entry.costUsd) && entry.costUsd >= 0,
        `${file}/${entry.caseId}: costUsd invalid`);
      assert(Number.isFinite(entry.latencyMs) && entry.latencyMs > 0,
        `${file}/${entry.caseId}: latencyMs invalid`);
    });
    arms.set(arm, { data, metrics: armMetrics(data) });
  }

  const A = arms.get('A').metrics;
  const B = arms.get('B').metrics;
  const C = arms.get('C').metrics;
  const cData = arms.get('C').data;
  const cUnresolved = C.requests - C.resolved;

  // C must satisfy the release gates used by the plugin.
  assert(C.coverage >= 0.6, `arm C coverage ${C.coverage} must be >= 60%`);
  assert(C.silentErrors === 0, `arm C has ${C.silentErrors} silent errors`);
  assert(
    C.e2e >= A.e2e && C.e2e >= B.e2e,
    `arm C e2e ${C.e2e} must be >= A (${A.e2e}) and B (${B.e2e})`,
  );
  assert(
    C.strictE2e >= A.strictE2e && C.strictE2e >= B.strictE2e,
    `arm C resolved-and-correct rate ${C.strictE2e} must be >= A (${A.strictE2e}) and B (${B.strictE2e})`,
  );
  assert(
    C.totalCostUsd < A.totalCostUsd && C.totalCostUsd < B.totalCostUsd,
    `arm C horizon cost ${C.totalCostUsd} must be below A (${A.totalCostUsd}) and B (${B.totalCostUsd})`,
  );
  assert(
    C.avgLatencyMs < A.avgLatencyMs && C.avgLatencyMs < B.avgLatencyMs,
    'arm C must have the lowest average latency',
  );
  assert(
    cUnresolved >= 1 && cUnresolved <= Math.ceil(C.requests * 0.4),
    `arm C should keep a small number of deliberate defers, got ${cUnresolved}`,
  );
  assert(
    A.totalCostUsd > B.totalCostUsd && B.totalCostUsd > C.totalCostUsd,
    'arm ranking must be A (most expensive) > B > C (cheapest)',
  );
  assert(
    cData.cases.filter((entry) => entry.correct).length === C.correct,
    'arm C correct count mismatch',
  );

  return { arms, metrics: { A, B, C } };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifest = readJson(MANIFEST_URL);
  checkManifest(manifest);

  const counters = { ids: new Map(), accept: 0, defer: 0, deferReasons: {} };
  const sets = {};
  for (const name of ['dev', 'audit', 'challenge']) {
    sets[name] = readJson(FIXTURE_URL(name));
    checkFixtureSet(name, sets[name], counters);
  }

  const anchorsVerified = checkAnchors(sets.dev);

  const auditAccept = sets.audit.cases.filter(
    (fixtureCase) => fixtureCase.expect.decision === 'accept',
  ).length;
  assert(
    auditAccept >= 59,
    `audit accept count ${auditAccept} must be >= 59 for the one-sided silent-error upper bound gate`,
  );
  const challengeDefer = sets.challenge.cases.filter(
    (fixtureCase) => fixtureCase.expect.decision === 'defer',
  ).length;
  assert(
    challengeDefer > sets.challenge.cases.length - challengeDefer,
    'challenge set must be defer-majority',
  );
  for (const fixtureCase of sets.challenge.cases) {
    if (fixtureCase.expect.decision === 'defer') {
      assert(
        typeof fixtureCase.expect.reason === 'string' &&
          DEFER_REASONS.includes(fixtureCase.expect.reason),
        `challenge/${fixtureCase.id}: defer reason missing or outside vocabulary`,
      );
    }
  }

  const { metrics } = checkArms(sets.audit, manifest);

  console.log('REFERENCE CHECK');
  console.log(`  root resolved from script URL: ${fileURLToPath(ROOT_URL)}`);
  console.log(`  manifest: OK (${manifest.contractRevision}, evidence paths resolve)`);
  console.log(
    `  fixture sets: dev ${sets.dev.cases.length} (>=24), audit ${sets.audit.cases.length}, challenge ${sets.challenge.cases.length}`,
  );
  console.log(
    `  decisions: accept ${counters.accept}, defer ${counters.defer} ` +
      `(${Object.entries(counters.deferReasons)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')})`,
  );
  console.log(`  audit expected accept: ${auditAccept} (>=59)`);
  console.log(`  challenge expected defer: ${challengeDefer}/40 (defer-majority)`);
  console.log(`  attachment page-5 anchors: ${anchorsVerified}/5 verified`);
  console.log('  anchor values: -3.25 kHz -> -3250 Hz; 2*pi*150 rad/s -> 150 Hz;');
  console.log('                 dual kHz explicit detuning 0.8 kHz -> 800 Hz;');
  console.log('                 dual kHz without id -> defer competing-fields;');
  console.log('                 header Hz vs schema rad/s -> defer metadata-conflict');
  for (const arm of ['A', 'B', 'C']) {
    const M = metrics[arm];
    console.log(
      `  arm ${arm}: coverage ${(M.coverage * 100).toFixed(1)}%, silentErrors ${M.silentErrors}, ` +
        `e2e ${(M.e2e * 100).toFixed(1)}%, resolved+e2e ${(M.strictE2e * 100).toFixed(1)}%, ` +
        `horizonCost $${M.totalCostUsd.toFixed(2)}, avgLatency ${M.avgLatencyMs.toFixed(0)}ms`,
    );
  }
  console.log('REFERENCE CHECK PASSED');
}

try {
  main();
} catch (error) {
  console.error('REFERENCE CHECK FAILED');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
