#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Independent reference check for the built-in `normalize_detuning/v1` seed (v2).
 *
 * This script intentionally does NOT import guard.js, binding.js or execution.js
 * (and never imports lib/engine.js). It re-implements the admission policy,
 * re-derives every expected accepted value from the raw fixture input with the
 * analytic conversion formula, and checks:
 *
 *   - the v2 manifest evidence block (fixtureSets / blindLabels / preregistration);
 *   - dev (inline labels), audit.inputs + blind labels, challenge.inputs + blind labels;
 *   - that the readable inputs contain no labels and the blind labels contain no inputs;
 *   - ids, counts, the attachment page-5 anchors, defer reasons and tolerances;
 *   - the preregistration (author-only reviewers, realDataAttested:false => the
 *     shipped example is mechanically ineligible for release);
 *   - a frozen sha256 for every data file, so regenerating the seed cannot change
 *     frozen evidence unnoticed.
 *
 * All paths are resolved relative to this script (import.meta.url), never to
 * process.cwd(), so the check behaves identically when run as
 *   node seed/evals/normalize_detuning/v1/reference_check.mjs
 * from any cwd and after the seed tree has been copied to a registry root.
 *
 * Exit code 0 on success; process.exit(1) on the first failed assertion.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_URL = import.meta.url;
const ROOT_URL = new URL('../../../', SCRIPT_URL);
const ROUTINE_URL = new URL('routines/normalize_detuning/v1/', ROOT_URL);
const MANIFEST_URL = new URL('manifest.json', ROUTINE_URL);

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

const FIXTURE_PATHS = {
  dev: 'fixtures/normalize_detuning/v1/dev.json',
  audit: 'fixtures/normalize_detuning/v1/audit.inputs.json',
  challenge: 'fixtures/normalize_detuning/v1/challenge.inputs.json',
};
const BLIND_LABEL_PATHS = {
  audit: 'blind/normalize_detuning/v1/audit.labels.json',
  challenge: 'blind/normalize_detuning/v1/challenge.labels.json',
};
const PREREGISTRATION_PATH = 'routines/normalize_detuning/v1/preregistration.json';
const EVALUATOR_PATH = 'evals/normalize_detuning/v1/reference_check.mjs';

// Frozen sha256 of every data file the seed ships. A mismatch means the seed was
// changed after the freeze: regenerate deliberately and update this table in the
// same review, otherwise the check must fail.
const FROZEN_SHA256 = {
  'fixtures/normalize_detuning/v1/dev.json':
    '753a40156d4f8cdb5cd8555f1e4d18ed8f6a982d81f6ad91937c2f307fb86e86',
  'fixtures/normalize_detuning/v1/audit.inputs.json':
    '9326fac60d23fe0e8085f67c3fd4f5da8c3d2cb430d077b69fad1486637b69e8',
  'fixtures/normalize_detuning/v1/challenge.inputs.json':
    '511f403f54435073bd08f42a0ee03b5c117d7bd34949ebb575a98c58c3eea113',
  'blind/normalize_detuning/v1/audit.labels.json':
    '33790a55b9a1ffab635dd70336747b92836f54f21a7a53054bba4c99f0a1f39d',
  'blind/normalize_detuning/v1/challenge.labels.json':
    '199c8f08fec89bd5918f95a2f5e0af746c1f808e093b2b9314210d4c9f886574',
  'routines/normalize_detuning/v1/preregistration.json':
    '71d03641d3ae12b026a6e1229aa02d3bea7b26e80f7aa827ca4a11b000c53199',
};

const EXPECTED_COUNTS = { dev: 30, audit: 100, challenge: 40 };
const DEV_ACCEPT = 16;
const DEV_DEFER = 14;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(url) {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function sha256File(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function closeTo(actual, expected, absTolerance, relTolerance) {
  return Math.abs(actual - expected) <= absTolerance + relTolerance * Math.abs(expected);
}

function pathExists(url) {
  return existsSync(fileURLToPath(url));
}

function resolveRootRelative(relative) {
  return new URL(relative, ROOT_URL);
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
    const matched = candidates.filter((candidate) => candidate && candidate.fieldId === input.fieldId);
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
  assert(typeof manifest.summary === 'string' && manifest.summary.length > 0, 'manifest.summary missing');
  assert(typeof manifest.owner === 'string' && manifest.owner.length > 0, 'manifest.owner missing');
  assert(
    manifest.contractRevision === 'normalize_detuning/v1',
    'manifest.contractRevision must be normalize_detuning/v1',
  );
  assert(
    JSON.stringify(manifest.allowedEffects) === JSON.stringify(['read-only']),
    'manifest.allowedEffects must be read-only',
  );
  assert(
    Array.isArray(manifest.dependencies) && manifest.dependencies.length === 0,
    'manifest.dependencies must be empty',
  );

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
  assert(
    manifest.binding.preservesOriginalInput === true,
    'manifest.binding.preservesOriginalInput must be true',
  );
  assert(
    manifest.execution && manifest.execution.entry === 'execution.js#run',
    'manifest.execution.entry must be execution.js#run',
  );
  checkOutputSchema(manifest.execution.outputSchema);

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
    manifest.fallback &&
      manifest.fallback.mode === 'ask-user' &&
      typeof manifest.fallback.description === 'string' &&
      manifest.fallback.description.length > 0,
    'manifest.fallback mismatch',
  );

  checkFixturePathsArePublic();
  checkEvidence(manifest.evidence);

  for (const hook of ['guard.js', 'binding.js', 'execution.js', 'manifest.json']) {
    assert(pathExists(new URL(hook, ROUTINE_URL)), `routine hook missing: ${hook}`);
  }
}

function checkOutputSchema(schema) {
  assert(schema && typeof schema === 'object', 'manifest.execution.outputSchema missing');
  assert(schema.type === 'object', 'outputSchema.type must be object');
  assert(schema.additionalProperties === false, 'outputSchema.additionalProperties must be false');
  const required = ['fieldId', 'unit', 'sourceUnit', 'valueHz', 'contractRevision'];
  for (const key of required) {
    assert(
      Array.isArray(schema.required) && schema.required.includes(key),
      `outputSchema.required missing ${key}`,
    );
  }
  assert(
    schema.required.length === required.length,
    'outputSchema.required must be exactly fieldId/unit/sourceUnit/valueHz/contractRevision',
  );
  const properties = schema.properties ?? {};
  assert(properties.unit && properties.unit.const === 'Hz', 'outputSchema.properties.unit must be const Hz');
  assert(
    properties.sourceUnit && JSON.stringify(properties.sourceUnit.enum) === JSON.stringify(UNIT_ENUM),
    'outputSchema.properties.sourceUnit enum mismatch',
  );
  assert(
    properties.valueHz && properties.valueHz.type === 'number',
    'outputSchema.properties.valueHz must be a number',
  );
  assert(
    properties.contractRevision && properties.contractRevision.const === 'normalize_detuning/v1',
    'outputSchema.properties.contractRevision must be const normalize_detuning/v1',
  );
  assert(
    properties.fieldId && properties.fieldId.type === 'string',
    'outputSchema.properties.fieldId must be a string',
  );
  assert(schema.requiredFields === undefined, 'outputSchema must not use the legacy requiredFields form');
}

// The readable fixture tree must not point into the protected blind tree.
function checkFixturePathsArePublic() {
  // Cheap structural check: fixture paths must not point at blind/.
  for (const [set, relative] of Object.entries(FIXTURE_PATHS)) {
    assert(!relative.includes('blind/'), `fixtures.${set} must not point into blind/`);
  }
}

function checkEvidence(evidence) {
  assert(evidence && typeof evidence === 'object', 'manifest.evidence missing');

  assert(
    JSON.stringify(evidence.fixtureSets) === JSON.stringify(FIXTURE_PATHS),
    'evidence.fixtureSets must use fixtures/normalize_detuning/v1/{dev,audit.inputs,challenge.inputs}.json',
  );
  assert(
    JSON.stringify(evidence.blindLabels) === JSON.stringify(BLIND_LABEL_PATHS),
    'evidence.blindLabels must use blind/normalize_detuning/v1/{audit,challenge}.labels.json',
  );

  assert(evidence.dataClass === 'synthetic', "evidence.dataClass must be 'synthetic'");
  assert(evidence.provenance === 'synthetic', "evidence.provenance must be 'synthetic'");
  assert(evidence.realDeploymentData === false, 'evidence.realDeploymentData must be false for the synthetic example');

  assert(Array.isArray(evidence.derivationTraces), 'evidence.derivationTraces must be an array');
  assert(evidence.derivationTraces.length >= 4, 'evidence.derivationTraces needs at least 4 design notes');
  const frameworkSections = [
    'Promotion gates',
    'Blind data discipline',
    'Paired comparison and the pilot decision',
    'Reproducibility',
  ];
  for (const trace of evidence.derivationTraces) {
    assert(trace && typeof trace === 'object', 'derivationTrace must be an object');
    assert(trace.kind === 'design-note', 'derivationTrace.kind must be design-note');
    assert(typeof trace.ref === 'string' && trace.ref.trim() !== '', 'derivationTrace.ref missing');
    assert(trace.recordedAt === FROZEN_AT, `derivationTrace.recordedAt must be ${FROZEN_AT}`);
  }
  for (const section of frameworkSections) {
    assert(
      evidence.derivationTraces.some((trace) => trace.ref.includes(section)),
      `evidence.derivationTraces must reference docs/framework.md section: ${section}`,
    );
  }

  assert(
    evidence.evaluator === EVALUATOR_PATH,
    `evidence.evaluator must be ${EVALUATOR_PATH}`,
  );
  assert(
    evidence.preregistration === 'preregistration.json',
    "evidence.preregistration must be 'preregistration.json'",
  );
  assert(evidence.approvedRelease === null, 'evidence.approvedRelease must be null before release');
  assert(
    typeof evidence.withdrawalTrigger === 'string' && evidence.withdrawalTrigger.length > 0,
    'evidence.withdrawalTrigger missing',
  );

  // Every manifest-root-relative path must resolve under the registry root, both
  // in the seed tree and after the seed tree is copied to the registry root.
  for (const [setName, relativePath] of Object.entries(FIXTURE_PATHS)) {
    const url = resolveRootRelative(relativePath);
    assert(pathExists(url), `evidence.fixtureSets.${setName} does not resolve: ${relativePath}`);
    const scriptRelativeUrl = new URL(`../../../${relativePath}`, SCRIPT_URL);
    assert(
      fileURLToPath(url) === fileURLToPath(scriptRelativeUrl),
      `fixture set ${setName} resolved via manifest and via script differ`,
    );
  }
  for (const [setName, relativePath] of Object.entries(BLIND_LABEL_PATHS)) {
    const url = resolveRootRelative(relativePath);
    assert(pathExists(url), `evidence.blindLabels.${setName} does not resolve: ${relativePath}`);
    const scriptRelativeUrl = new URL(`../../../${relativePath}`, SCRIPT_URL);
    assert(
      fileURLToPath(url) === fileURLToPath(scriptRelativeUrl),
      `blind labels ${setName} resolved via manifest and via script differ`,
    );
  }
  assert(pathExists(resolveRootRelative(EVALUATOR_PATH)), 'evidence.evaluator does not resolve');
  assert(
    pathExists(new URL(PREREGISTRATION_PATH, ROOT_URL)),
    `evidence.preregistration does not resolve: ${PREREGISTRATION_PATH}`,
  );
}

// ---------------------------------------------------------------------------
// Fixture / label validation
// ---------------------------------------------------------------------------

function registerId(counters, id, setName) {
  assert(typeof id === 'string' && id.length > 0, `${setName}: case id missing`);
  assert(!counters.ids.has(id), `duplicate case id ${id} across fixture sets`);
  counters.ids.set(id, setName);
}

function checkCaseExpectation(setName, id, input, expect, counters) {
  assert(expect && typeof expect === 'object', `${setName}/${id}: expect missing`);
  assert(
    expect.decision === 'accept' || expect.decision === 'defer',
    `${setName}/${id}: expect.decision must be accept or defer`,
  );

  const reference = referenceDecide(input);
  assert(
    reference.decision === expect.decision,
    `${setName}/${id}: expected decision ${expect.decision}, independent reference says ${reference.decision}` +
      (reference.reason ? ` (${reference.reason})` : ''),
  );

  if (expect.decision === 'defer') {
    assert(
      typeof expect.reason === 'string' && DEFER_REASONS.includes(expect.reason),
      `${setName}/${id}: defer must carry a reason from the manifest vocabulary`,
    );
    assert(
      reference.reason === expect.reason,
      `${setName}/${id}: expected reason ${expect.reason}, independent reference says ${reference.reason}`,
    );
    assert(expect.checks === null, `${setName}/${id}: defer checks must be null`);
    counters.defer += 1;
    counters.deferReasons[expect.reason] = (counters.deferReasons[expect.reason] || 0) + 1;
    return;
  }

  const checks = expect.checks;
  assert(checks && typeof checks === 'object', `${setName}/${id}: accept checks must be an object`);
  assert(
    checks.fieldId === input.fieldId,
    `${setName}/${id}: checks.fieldId must equal input.fieldId (preserve-field-id)`,
  );
  assert(checks.unit === 'Hz', `${setName}/${id}: checks.unit must be Hz`);
  assert(Number.isFinite(checks.valueHz), `${setName}/${id}: checks.valueHz must be finite`);
  assert(
    checks.absToleranceHz === ABS_TOLERANCE_HZ,
    `${setName}/${id}: absToleranceHz must be ${ABS_TOLERANCE_HZ}`,
  );
  assert(checks.relTolerance === REL_TOLERANCE, `${setName}/${id}: relTolerance must be ${REL_TOLERANCE}`);

  const recomputed = parseValueToHz(input);
  assert(
    closeTo(checks.valueHz, recomputed, ABS_TOLERANCE_HZ, REL_TOLERANCE),
    `${setName}/${id}: expected valueHz ${checks.valueHz} != analytic ${recomputed}`,
  );
  if (input.value !== 0) {
    assert(
      Math.sign(checks.valueHz) === Math.sign(input.value),
      `${setName}/${id}: sign not preserved (value ${input.value} -> valueHz ${checks.valueHz})`,
    );
  }
  counters.accept += 1;
}

function checkDev(dev, counters) {
  assert(dev.schemaVersion === 2, 'dev: schemaVersion must be 2');
  assert(dev.set === 'dev', 'dev: set must be "dev"');
  assert(dev.provenance === 'synthetic', 'dev: provenance must be synthetic');
  assert(dev.frozenAt === FROZEN_AT, `dev: frozenAt must be ${FROZEN_AT}`);
  assert(Array.isArray(dev.cases), 'dev: cases must be an array');
  assert(
    dev.cases.length === EXPECTED_COUNTS.dev,
    `dev: expected ${EXPECTED_COUNTS.dev} cases, got ${dev.cases.length}`,
  );

  const seen = new Set();
  let accept = 0;
  let defer = 0;
  for (const fixtureCase of dev.cases) {
    assert(fixtureCase && typeof fixtureCase === 'object', 'dev: case must be an object');
    const id = fixtureCase.id;
    assert(typeof id === 'string' && id.length > 0, 'dev: case id missing');
    assert(!seen.has(id), `dev: duplicate case id ${id}`);
    seen.add(id);
    registerId(counters, id, 'dev');
    assert(
      typeof fixtureCase.description === 'string' && fixtureCase.description.length > 0,
      `dev/${id}: description missing`,
    );
    assert(fixtureCase.input && typeof fixtureCase.input === 'object', `dev/${id}: input missing`);
    assert(fixtureCase.expect && typeof fixtureCase.expect === 'object', `dev/${id}: expect missing`);

    const before = counters.accept + counters.defer;
    checkCaseExpectation('dev', id, fixtureCase.input, fixtureCase.expect, counters);
    assert(counters.accept + counters.defer === before + 1, `dev/${id}: not counted`);
    if (fixtureCase.expect.decision === 'accept') accept += 1;
    else defer += 1;
  }
  assert(accept === DEV_ACCEPT, `dev: expected ${DEV_ACCEPT} accept cases, got ${accept}`);
  assert(defer === DEV_DEFER, `dev: expected ${DEV_DEFER} defer cases, got ${defer}`);
}

function checkInputs(name, doc, counters) {
  const expectedCount = EXPECTED_COUNTS[name];
  assert(doc.schemaVersion === 2, `${name}: schemaVersion must be 2`);
  assert(doc.set === name, `${name}: set must be "${name}"`);
  assert(doc.provenance === 'synthetic', `${name}: provenance must be synthetic`);
  assert(doc.frozenAt === FROZEN_AT, `${name}: frozenAt must be ${FROZEN_AT}`);
  assert(Array.isArray(doc.cases), `${name}: cases must be an array`);
  assert(
    doc.cases.length === expectedCount,
    `${name}: expected ${expectedCount} input cases, got ${doc.cases.length}`,
  );
  const inputs = new Map();
  for (const fixtureCase of doc.cases) {
    assert(fixtureCase && typeof fixtureCase === 'object', `${name}: case must be an object`);
    const id = fixtureCase.id;
    registerId(counters, id, name);
    assert(!inputs.has(id), `${name}: duplicate input id ${id}`);
    inputs.set(id, fixtureCase);
    assert(
      typeof fixtureCase.description === 'string' && fixtureCase.description.length > 0,
      `${name}/${id}: description missing`,
    );
    assert(fixtureCase.input && typeof fixtureCase.input === 'object', `${name}/${id}: input missing`);
    assert(
      fixtureCase.expect === undefined,
      `${name}/${id}: readable inputs must not contain expect (labels are blind)`,
    );
    assert(
      Object.keys(fixtureCase).sort().join(',') === 'description,id,input',
      `${name}/${id}: inputs-only case must contain exactly id, description, input`,
    );
  }
  return inputs;
}

function checkLabels(name, doc, inputs, counters) {
  assert(doc.schemaVersion === 2, `${name}.labels: schemaVersion must be 2`);
  assert(doc.set === name, `${name}.labels: set must be "${name}"`);
  assert(doc.frozenAt === FROZEN_AT, `${name}.labels: frozenAt must be ${FROZEN_AT}`);
  assert(Array.isArray(doc.cases), `${name}.labels: cases must be an array`);
  assert(
    doc.cases.length === inputs.size,
    `${name}.labels: expected ${inputs.size} labels, got ${doc.cases.length}`,
  );

  const seen = new Set();
  const ids = [...inputs.keys()];
  doc.cases.forEach((labelCase, index) => {
    assert(labelCase && typeof labelCase === 'object', `${name}.labels: case must be an object`);
    const id = labelCase.id;
    assert(typeof id === 'string' && id.length > 0, `${name}.labels: case id missing`);
    assert(!seen.has(id), `${name}.labels: duplicate label id ${id}`);
    seen.add(id);
    assert(
      id === ids[index],
      `${name}.labels: labels must follow input order (expected ${ids[index]} at ${index}, got ${id})`,
    );
    assert(
      Object.keys(labelCase).sort().join(',') === 'expect,id',
      `${name}.labels/${id}: label case must contain exactly id and expect`,
    );
    assert(labelCase.input === undefined, `${name}.labels/${id}: labels must not contain inputs`);
    const input = inputs.get(id).input;
    checkCaseExpectation(name, id, input, labelCase.expect, counters);
  });
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

  // Anchor 4: header Hz vs schema rad/s conflict must defer, no numeric answer.
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
// Preregistration
// ---------------------------------------------------------------------------

function checkPreregistration(preregistration) {
  assert(preregistration && typeof preregistration === 'object', 'preregistration must be an object');
  assert(preregistration.schemaVersion === 1, 'preregistration.schemaVersion must be 1');
  assert(preregistration.routine === 'normalize_detuning', 'preregistration.routine mismatch');
  assert(String(preregistration.version) === '1', 'preregistration.version must be "1"');
  assert(preregistration.frozenAt === FROZEN_AT, `preregistration.frozenAt must be ${FROZEN_AT}`);
  for (const field of ['population', 'samplingUnit', 'exclusions', 'decisionDate', 'nextReviewTrigger']) {
    assert(
      typeof preregistration[field] === 'string' && preregistration[field].trim() !== '',
      `preregistration.${field} missing`,
    );
  }
  assert(
    JSON.stringify(preregistration.thresholds) ===
      JSON.stringify({
        coverageFloor: 0.6,
        silentErrorCeiling: 0.05,
        challengeSize: 40,
        challengeIncorrectAutomatic: 0,
      }),
    'preregistration.thresholds mismatch',
  );
  assert(
    JSON.stringify(preregistration.workload) ===
      JSON.stringify({ requests: 100, horizonDays: 30, perRequestBudgetMs: 60000 }),
    'preregistration.workload mismatch',
  );
  assert(preregistration.realDataAttested === false, 'preregistration.realDataAttested must be false');

  assert(Array.isArray(preregistration.reviewers), 'preregistration.reviewers must be an array');
  const reviewers = preregistration.reviewers;
  assert(reviewers.length === 1, 'the synthetic example must ship exactly one reviewer (author only)');
  const author = reviewers[0];
  assert(author.role === 'author', 'the only reviewer must be the contract author');
  assert(author.independent !== true, 'the author reviewer must not claim independence');
  assert(author.sawLabels === false, 'the author reviewer must not have seen labels');
  const independentReviewer = reviewers.find(
    (reviewer) =>
      reviewer.role === 'domain-reviewer' && reviewer.independent === true && reviewer.sawLabels === false,
  );
  assert(
    independentReviewer === undefined,
    'the synthetic example intentionally has no independent domain-reviewer, so release is ineligible',
  );
}

// ---------------------------------------------------------------------------
// Frozen hashes
// ---------------------------------------------------------------------------

function checkFrozenHashes() {
  assert(FROZEN_SHA256[FIXTURE_PATHS.dev], 'FROZEN_SHA256 missing dev entry');
  assert(FROZEN_SHA256[FIXTURE_PATHS.audit], 'FROZEN_SHA256 missing audit entry');
  assert(FROZEN_SHA256[FIXTURE_PATHS.challenge], 'FROZEN_SHA256 missing challenge entry');
  assert(FROZEN_SHA256[BLIND_LABEL_PATHS.audit], 'FROZEN_SHA256 missing audit labels entry');
  assert(FROZEN_SHA256[BLIND_LABEL_PATHS.challenge], 'FROZEN_SHA256 missing challenge labels entry');
  assert(FROZEN_SHA256[PREREGISTRATION_PATH], 'FROZEN_SHA256 missing preregistration entry');

  const verified = [];
  for (const [relative, expected] of Object.entries(FROZEN_SHA256)) {
    const absolute = fileURLToPath(resolveRootRelative(relative));
    assert(existsSync(absolute), `frozen file missing: ${relative}`);
    const actual = sha256File(absolute);
    assert(
      actual === expected,
      `${relative}: sha256 ${actual} does not match the frozen hash ${expected}; ` +
        'regenerate the seed deliberately and update FROZEN_SHA256 in the same review',
    );
    verified.push({ relative, sha256: actual });
  }
  return verified;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifest = readJson(MANIFEST_URL);
  checkManifest(manifest);

  const counters = { ids: new Map(), accept: 0, defer: 0, deferReasons: {} };

  const dev = readJson(resolveRootRelative(FIXTURE_PATHS.dev));
  checkDev(dev, counters);

  const auditInputs = checkInputs('audit', readJson(resolveRootRelative(FIXTURE_PATHS.audit)), counters);
  const challengeInputs = checkInputs(
    'challenge',
    readJson(resolveRootRelative(FIXTURE_PATHS.challenge)),
    counters,
  );
  const auditLabels = readJson(resolveRootRelative(BLIND_LABEL_PATHS.audit));
  const challengeLabels = readJson(resolveRootRelative(BLIND_LABEL_PATHS.challenge));
  checkLabels('audit', auditLabels, auditInputs, counters);
  checkLabels('challenge', challengeLabels, challengeInputs, counters);

  const anchorsVerified = checkAnchors(dev);

  const auditAccept = auditLabels.cases.filter(
    (labelCase) => labelCase.expect.decision === 'accept',
  ).length;
  assert(
    auditAccept >= 59,
    `audit accept count ${auditAccept} must be >= 59 for the one-sided silent-error upper bound gate`,
  );

  const challengeDefer = challengeLabels.cases.filter(
    (labelCase) => labelCase.expect.decision === 'defer',
  ).length;
  assert(
    challengeDefer > challengeLabels.cases.length - challengeDefer,
    'challenge set must be defer-majority',
  );

  const preregistration = readJson(resolveRootRelative(PREREGISTRATION_PATH));
  checkPreregistration(preregistration);

  const frozenHashes = checkFrozenHashes();

  console.log('REFERENCE CHECK (v2 blind evidence)');
  console.log(`  root resolved from script URL: ${fileURLToPath(ROOT_URL)}`);
  console.log(`  manifest: OK (${manifest.contractRevision}, v2 evidence paths resolve)`);
  console.log(
    `  fixture sets: dev ${dev.cases.length} (inline labels), audit ${auditInputs.size} inputs, ` +
      `challenge ${challengeInputs.size} inputs`,
  );
  console.log(
    `  blind labels: audit ${auditInputs.size}, challenge ${challengeInputs.size} ` +
      '(readable inputs carry no expect; labels carry no input)',
  );
  console.log(
    `  decisions: accept ${counters.accept}, defer ${counters.defer} ` +
      `(${Object.entries(counters.deferReasons)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ')})`,
  );
  console.log(`  dev: ${DEV_ACCEPT} accept / ${DEV_DEFER} defer (30 cases, labels inline)`);
  console.log(`  audit expected accept: ${auditAccept} (>=59)`);
  console.log(`  challenge expected defer: ${challengeDefer}/${challengeLabels.cases.length} (defer-majority)`);
  console.log(`  attachment page-5 anchors: ${anchorsVerified}/5 verified`);
  console.log('  anchor values: -3.25 kHz -> -3250 Hz; 2*pi*150 rad/s -> 150 Hz;');
  console.log('                 dual kHz explicit detuning 0.8 kHz -> 800 Hz;');
  console.log('                 dual kHz without id -> defer competing-fields;');
  console.log('                 header Hz vs schema rad/s -> defer metadata-conflict');
  console.log(
    '  preregistration: author-only reviewer, realDataAttested=false ' +
      '=> release intentionally ineligible (no independent domain-reviewer)',
  );
  console.log(`  frozen sha256: ${frozenHashes.length} files verified`);
  for (const entry of frozenHashes) console.log(`    ${entry.sha256}  ${entry.relative}`);
  console.log('REFERENCE CHECK PASSED');
}

try {
  main();
} catch (error) {
  console.error('REFERENCE CHECK FAILED');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
