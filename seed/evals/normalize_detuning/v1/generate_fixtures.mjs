#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Deterministic generator for the built-in `normalize_detuning/v1` seed data.
 *
 * Outputs (resolved relative to this script, so it works from any cwd and also
 * after the seed tree is copied to a registry root):
 *   seed/fixtures/normalize_detuning/v1/{dev,audit,challenge}.json
 *   seed/arms/{arm-a,arm-b,arm-c}.json
 *
 * The evaluator never imports this file. It exists so that the fixture sets are
 * reproducible byte-for-byte from fixed seeds instead of being hand-edited.
 *
 * Non-finite values (used by the invalid-value near-misses) are written as the
 * JSON number tokens 1e999 / -1e999, which JSON.parse turns into +/-Infinity.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEED_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const FIXTURE_DIR = path.join(SEED_ROOT, 'fixtures/normalize_detuning/v1');
const ARM_DIR = path.join(SEED_ROOT, 'arms');

const SCHEMA_VERSION = 1;
const FROZEN_AT = '2026-11-04T00:00:00Z';
const TRUSTED = 'trusted-schema';
const UNVERIFIED = 'unverified';
const UNIT_ENUM = ['Hz', 'kHz', 'rad/s'];

const DETUNING_FIELDS = [
  'detuning_freq',
  'carrier_detuning',
  'trap_detuning',
  'probe_detuning',
  'offset_detuning',
  'laser_detuning',
  'spectroscopy_detuning',
  'aom_detuning',
];
const DRIVE_FIELDS = ['drive_freq', 'rf_drive', 'excitation_drive', 'modulation_drive'];

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toHz(value, unit) {
  if (unit === 'Hz') return value;
  if (unit === 'kHz') return value * 1000;
  if (unit === 'rad/s') return value / (2 * Math.PI);
  throw new Error(`unsupported unit in generator: ${unit}`);
}

function bothUnits(unit) {
  return { header: unit, schema: unit };
}

function acceptCase(id, description, input, valueHz) {
  return {
    id,
    description,
    input,
    expect: {
      decision: 'accept',
      reason: null,
      checks: {
        fieldId: input.fieldId,
        unit: 'Hz',
        valueHz,
        absToleranceHz: 1e-9,
        relTolerance: 1e-12,
      },
    },
  };
}

function deferCase(id, description, input, reason) {
  return {
    id,
    description,
    input,
    expect: { decision: 'defer', reason, checks: null },
  };
}

function serialize(data) {
  const text = JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return `@@NONFINITE:${value}@@`;
      }
      return value;
    },
    2,
  );
  return (
    text
      .replace(/"@@NONFINITE:Infinity@@"/g, '1e999')
      .replace(/"@@NONFINITE:-Infinity@@"/g, '-1e999') + '\n'
  );
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, serialize(data), 'utf8');
}

// ---------------------------------------------------------------------------
// dev: small, hand-curated set. Must contain the four attachment page-5 anchors.
// Anchor 3 is split into two cases (explicit id vs no explicit id) so that the
// field identity and the value can be asserted separately.
// ---------------------------------------------------------------------------

function buildDev() {
  const hz = bothUnits('Hz');
  const khz = bothUnits('kHz');
  const rads = bothUnits('rad/s');

  const cases = [
    acceptCase(
      'anchor-neg-khz',
      'Anchor 1: -3.25 kHz detuning normalizes to -3250 Hz and keeps its field id.',
      {
        value: -3.25,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: khz,
        candidates: [{ fieldId: 'detuning_khz', unit: 'kHz', role: 'detuning' }],
        metadataSource: TRUSTED,
      },
      -3250,
    ),
    acceptCase(
      'anchor-rad-s',
      'Anchor 2: +2*pi*150 rad/s is +150 Hz (angular frequency converted with 1/(2*pi)).',
      {
        value: 2 * Math.PI * 150,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: rads,
        metadataSource: TRUSTED,
      },
      150,
    ),
    acceptCase(
      'anchor-dual-khz-explicit',
      'Anchor 3a: drive and detuning columns are both kHz; accept only the explicitly identified detuning field.',
      {
        value: 0.8,
        unit: 'kHz',
        fieldId: 'detuning_freq',
        declaredUnit: khz,
        candidates: [
          { fieldId: 'drive_freq', unit: 'kHz', role: 'drive' },
          { fieldId: 'detuning_freq', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      800,
    ),
    deferCase(
      'anchor-dual-khz-no-id',
      'Anchor 3b: same dual kHz columns but no explicit field id, so the binding is ambiguous.',
      {
        value: 0.8,
        unit: 'kHz',
        fieldId: '',
        declaredUnit: khz,
        candidates: [
          { fieldId: 'drive_freq', unit: 'kHz', role: 'drive' },
          { fieldId: 'detuning_freq', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      'competing-fields',
    ),
    deferCase(
      'anchor-metadata-conflict',
      'Anchor 4: header declares Hz while schema declares rad/s; no numeric answer is admissible.',
      {
        value: 1.5,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: { header: 'Hz', schema: 'rad/s' },
        metadataSource: TRUSTED,
      },
      'metadata-conflict',
    ),
    acceptCase(
      'dev-hz-positive',
      'Plain positive Hz detuning passes through unchanged.',
      {
        value: 325,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      325,
    ),
    acceptCase(
      'dev-hz-negative',
      'Negative Hz detuning keeps its sign.',
      {
        value: -120,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      -120,
    ),
    acceptCase(
      'dev-hz-zero',
      'Zero detuning is finite and accepted with valueHz 0.',
      {
        value: 0,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      0,
    ),
    acceptCase(
      'dev-khz-positive',
      'Positive kHz detuning scales by 1000.',
      {
        value: 1.25,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: khz,
        metadataSource: TRUSTED,
      },
      1250,
    ),
    acceptCase(
      'dev-khz-negative-fraction',
      'Fractional negative kHz detuning scales by 1000 and keeps its sign.',
      {
        value: -0.0005,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: khz,
        metadataSource: TRUSTED,
      },
      -0.5,
    ),
    acceptCase(
      'dev-rad-s-positive',
      'Positive angular frequency converts with 1/(2*pi).',
      {
        value: 2 * Math.PI * 60,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: rads,
        metadataSource: TRUSTED,
      },
      60,
    ),
    acceptCase(
      'dev-rad-s-negative',
      'Negative angular frequency converts with 1/(2*pi) and keeps its sign.',
      {
        value: -2 * Math.PI * 90,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: rads,
        metadataSource: TRUSTED,
      },
      -90,
    ),
    acceptCase(
      'dev-rad-s-one-cycle',
      'One angular cycle per second converts to 1 Hz.',
      {
        value: 2 * Math.PI,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: rads,
        metadataSource: TRUSTED,
      },
      1,
    ),
    acceptCase(
      'dev-header-only-khz',
      'Only a header declaration is present; equivalent metadata is still sufficient.',
      {
        value: 0.25,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: { header: 'kHz' },
        metadataSource: TRUSTED,
      },
      250,
    ),
    acceptCase(
      'dev-schema-only-rad-s',
      'Only a schema declaration is present; equivalent metadata is still sufficient.',
      {
        value: 2 * Math.PI * 40,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: { schema: 'rad/s' },
        metadataSource: TRUSTED,
      },
      40,
    ),
    acceptCase(
      'dev-multi-detuning-explicit',
      'Two detuning candidates are plausible but the explicit field id selects one unambiguously.',
      {
        value: 0.5,
        unit: 'kHz',
        fieldId: 'detuning_b',
        declaredUnit: khz,
        candidates: [
          { fieldId: 'detuning_a', unit: 'kHz', role: 'detuning' },
          { fieldId: 'detuning_b', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      500,
    ),
    acceptCase(
      'dev-single-detuning-candidate',
      'A single detuning candidate confirms an explicit field id.',
      {
        value: 12,
        unit: 'Hz',
        fieldId: 'probe_detuning',
        declaredUnit: hz,
        candidates: [{ fieldId: 'probe_detuning', unit: 'Hz', role: 'detuning' }],
        metadataSource: TRUSTED,
      },
      12,
    ),
    acceptCase(
      'dev-declared-unit-whitespace',
      'Header/schema comparison is whitespace tolerant.',
      {
        value: 0.25,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: { header: ' kHz ', schema: 'kHz' },
        metadataSource: TRUSTED,
      },
      250,
    ),
    deferCase(
      'dev-unsupported-unit',
      'MHz is outside the supported unit enum.',
      {
        value: 5,
        unit: 'MHz',
        fieldId: 'detuning_mhz',
        declaredUnit: bothUnits('MHz'),
        metadataSource: TRUSTED,
      },
      'unsupported-unit',
    ),
    deferCase(
      'dev-missing-unit',
      'The unit is absent, so required metadata is incomplete.',
      {
        value: 5,
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      'missing-metadata',
    ),
    deferCase(
      'dev-unverified-source',
      'An unverified metadata source is not safe for automatic admission.',
      {
        value: 5,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: UNVERIFIED,
      },
      'missing-metadata',
    ),
    deferCase(
      'dev-missing-declared-unit',
      'No declaredUnit metadata is available.',
      {
        value: 5,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        metadataSource: TRUSTED,
      },
      'missing-metadata',
    ),
    deferCase(
      'dev-empty-declared-unit',
      'declaredUnit is present but carries neither header nor schema.',
      {
        value: 5,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: {},
        metadataSource: TRUSTED,
      },
      'missing-metadata',
    ),
    deferCase(
      'dev-missing-field-id',
      'No candidates and no explicit field id means the detuning field cannot be bound.',
      {
        value: 5,
        unit: 'Hz',
        fieldId: '',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      'missing-metadata',
    ),
    deferCase(
      'dev-invalid-value-inf',
      'Positive infinity is not a finite detuning value.',
      {
        value: Infinity,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: hz,
        metadataSource: TRUSTED,
      },
      'invalid-value',
    ),
    deferCase(
      'dev-invalid-value-neg-inf',
      'Negative infinity is not a finite detuning value.',
      {
        value: -Infinity,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: khz,
        metadataSource: TRUSTED,
      },
      'invalid-value',
    ),
    deferCase(
      'dev-drive-field-id',
      'The explicit field id names the drive column, not the detuning column.',
      {
        value: 0.5,
        unit: 'kHz',
        fieldId: 'drive_freq',
        declaredUnit: khz,
        candidates: [
          { fieldId: 'drive_freq', unit: 'kHz', role: 'drive' },
          { fieldId: 'detuning_freq', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      'competing-fields',
    ),
    deferCase(
      'dev-unknown-role',
      'The matching candidate has an unknown role, so detuning cannot be confirmed.',
      {
        value: 10,
        unit: 'Hz',
        fieldId: 'ambiguous_field',
        declaredUnit: hz,
        candidates: [{ fieldId: 'ambiguous_field', unit: 'Hz', role: 'unknown' }],
        metadataSource: TRUSTED,
      },
      'competing-fields',
    ),
    deferCase(
      'dev-field-not-in-candidates',
      'fieldId does not appear in the candidate table at all.',
      {
        value: 0.5,
        unit: 'kHz',
        fieldId: 'some_other_field',
        declaredUnit: khz,
        candidates: [
          { fieldId: 'drive_freq', unit: 'kHz', role: 'drive' },
          { fieldId: 'detuning_freq', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      'competing-fields',
    ),
    deferCase(
      'dev-conflict-rad-hz',
      'Header declares rad/s while schema declares Hz.',
      {
        value: 100,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: { header: 'rad/s', schema: 'Hz' },
        metadataSource: TRUSTED,
      },
      'metadata-conflict',
    ),
  ];

  return cases;
}

// ---------------------------------------------------------------------------
// audit: 100 synthetic representative cases, 78 expected accept / 22 expected defer.
// ---------------------------------------------------------------------------

function pickUnit(rand) {
  const roll = rand();
  if (roll < 0.4) return 'Hz';
  if (roll < 0.75) return 'kHz';
  return 'rad/s';
}

function randomValue(rand, unit) {
  const sign = rand() < 0.5 ? -1 : 1;
  if (unit === 'Hz') return sign * round(0.1 + rand() * 4999.9, 3);
  if (unit === 'kHz') return sign * round(0.001 + rand() * 4.999, 6);
  return sign * round(0.01 + rand() * 3000 || 0.01, 6);
}

function declaredUnitFor(rand, unit) {
  const roll = rand();
  if (roll < 0.7) return bothUnits(unit);
  if (roll < 0.85) return { header: unit };
  return { schema: unit };
}

function buildAudit() {
  const rand = mulberry32(0x5eed2026);
  const acceptCases = [];
  const deferCases = [];

  for (let i = 0; i < 78; i += 1) {
    const unit = pickUnit(rand);
    const fieldId = DETUNING_FIELDS[Math.floor(rand() * DETUNING_FIELDS.length)];
    const value = randomValue(rand, unit);
    const input = {
      value,
      unit,
      fieldId,
      declaredUnit: declaredUnitFor(rand, unit),
      metadataSource: TRUSTED,
    };
    let columnNote = '';
    if (rand() < 0.35) {
      const driveField = DRIVE_FIELDS[Math.floor(rand() * DRIVE_FIELDS.length)];
      input.candidates = [
        { fieldId: driveField, unit, role: 'drive' },
        { fieldId, unit, role: 'detuning' },
      ];
      columnNote = ` with drive column ${driveField}`;
    }
    acceptCases.push(
      acceptCase(
        '',
        `synthetic accept: ${unit} detuning on ${fieldId}${columnNote}`,
        input,
        toHz(value, unit),
      ),
    );
  }

  // 6 competing-field fails.
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: dual kHz columns but fieldId is empty',
        {
          value: 0.5 + i * 0.25,
          unit: 'kHz',
          fieldId: '',
          declaredUnit: bothUnits('kHz'),
          candidates: [
            { fieldId: DRIVE_FIELDS[i], unit: 'kHz', role: 'drive' },
            { fieldId: DETUNING_FIELDS[i], unit: 'kHz', role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: explicit fieldId names a drive column',
        {
          value: 2.5 + i,
          unit: 'kHz',
          fieldId: DRIVE_FIELDS[i],
          declaredUnit: bothUnits('kHz'),
          candidates: [
            { fieldId: DRIVE_FIELDS[i], unit: 'kHz', role: 'drive' },
            { fieldId: DETUNING_FIELDS[i + 1], unit: 'kHz', role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: matching candidate role is unknown',
        {
          value: 300 + i,
          unit: 'Hz',
          fieldId: DETUNING_FIELDS[i + 2],
          declaredUnit: bothUnits('Hz'),
          candidates: [
            { fieldId: DETUNING_FIELDS[i + 2], unit: 'Hz', role: 'unknown' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  }

  // 6 missing-metadata fails.
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: metadata source is unverified',
        {
          value: 1.5 + i,
          unit: 'Hz',
          fieldId: DETUNING_FIELDS[i + 3],
          declaredUnit: bothUnits('Hz'),
          metadataSource: UNVERIFIED,
        },
        'missing-metadata',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: declaredUnit missing',
        {
          value: -250 - i,
          unit: 'kHz',
          fieldId: DETUNING_FIELDS[i + 4],
          metadataSource: TRUSTED,
        },
        'missing-metadata',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    deferCases.push(
      deferCase(
        '',
        'synthetic defer: no candidates and no explicit fieldId',
        {
          value: 300 + i,
          unit: 'Hz',
          fieldId: '',
          declaredUnit: bothUnits('Hz'),
          metadataSource: TRUSTED,
        },
        'missing-metadata',
      ),
    );
  }

  // 4 metadata-conflict fails.
  const conflictPairs = [
    ['Hz', 'rad/s'],
    ['kHz', 'Hz'],
    ['rad/s', 'kHz'],
    ['Hz', 'kHz'],
  ];
  conflictPairs.forEach((pair, index) => {
    deferCases.push(
      deferCase(
        '',
        `synthetic defer: header ${pair[0]} conflicts with schema ${pair[1]}`,
        {
          value: 123.45 + index,
          unit: pair[0],
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: { header: pair[0], schema: pair[1] },
          metadataSource: TRUSTED,
        },
        'metadata-conflict',
      ),
    );
  });

  // 3 unsupported-unit fails.
  ['MHz', 'GHz', 'rpm'].forEach((unit, index) => {
    deferCases.push(
      deferCase(
        '',
        `synthetic defer: unsupported unit ${unit}`,
        {
          value: 10 + index,
          unit,
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: bothUnits(unit),
          metadataSource: TRUSTED,
        },
        'unsupported-unit',
      ),
    );
  });

  // 3 invalid-value fails.
  const nonFiniteValues = [Infinity, -Infinity, Infinity];
  nonFiniteValues.forEach((value, index) => {
    const unit = UNIT_ENUM[index];
    deferCases.push(
      deferCase(
        '',
        `synthetic defer: non-finite value in ${unit}`,
        {
          value,
          unit,
          fieldId: DETUNING_FIELDS[index + 1],
          declaredUnit: bothUnits(unit),
          metadataSource: TRUSTED,
        },
        'invalid-value',
      ),
    );
  });

  const combined = [...acceptCases, ...deferCases];
  const shuffleRand = mulberry32(0x0a0d17);
  for (let i = combined.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffleRand() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }
  return combined.map((fixtureCase, index) => ({
    ...fixtureCase,
    id: `audit-${String(index + 1).padStart(3, '0')}`,
  }));
}

// ---------------------------------------------------------------------------
// challenge: 40 constructed near-misses, 34 expected defer / 6 tricky accepts.
// Every defer case is unresolvable from its own input alone (no external state).
// ---------------------------------------------------------------------------

function buildChallenge() {
  const cases = [];

  // 4 missing unit.
  ['Hz', 'kHz', 'rad/s', 'kHz'].forEach((declaredUnit, index) => {
    cases.push(
      deferCase(
        '',
        `challenge: unit field omitted (declared ${declaredUnit})`,
        {
          value: [12.5, 1.5, 2 * Math.PI * 80, 0.4][index],
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: bothUnits(declaredUnit),
          metadataSource: TRUSTED,
        },
        'missing-metadata',
      ),
    );
  });

  // 4 unsupported unit / unsupported declared schema units.
  ['MHz', 'GHz', 'rpm', 'T/s'].forEach((unit, index) => {
    cases.push(
      deferCase(
        '',
        `challenge: unsupported declared schema unit ${unit}`,
        {
          value: 3.5 + index,
          unit,
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: bothUnits(unit),
          metadataSource: TRUSTED,
        },
        'unsupported-unit',
      ),
    );
  });

  // 10 competing-field near-misses.
  ['kHz', 'Hz', 'rad/s'].forEach((unit, index) => {
    cases.push(
      deferCase(
        '',
        `challenge: dual ${unit} columns, empty fieldId`,
        {
          value: unit === 'kHz' ? 0.8 : unit === 'Hz' ? 420 : 2 * Math.PI * 75,
          unit,
          fieldId: '',
          declaredUnit: bothUnits(unit),
          candidates: [
            { fieldId: DRIVE_FIELDS[index], unit, role: 'drive' },
            { fieldId: DETUNING_FIELDS[index], unit, role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  });
  ['kHz', 'Hz', 'rad/s'].forEach((unit, index) => {
    cases.push(
      deferCase(
        '',
        `challenge: dual ${unit} columns, fieldId points at the drive column`,
        {
          value: 1.5 + index,
          unit,
          fieldId: DRIVE_FIELDS[index + 1],
          declaredUnit: bothUnits(unit),
          candidates: [
            { fieldId: DRIVE_FIELDS[index + 1], unit, role: 'drive' },
            { fieldId: DETUNING_FIELDS[index + 1], unit, role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  });
  for (let i = 0; i < 2; i += 1) {
    const unit = i === 0 ? 'kHz' : 'Hz';
    cases.push(
      deferCase(
        '',
        'challenge: multiple plausible detuning candidates, no explicit id',
        {
          value: i === 0 ? 0.75 : 880,
          unit,
          fieldId: '',
          declaredUnit: bothUnits(unit),
          candidates: [
            { fieldId: DETUNING_FIELDS[i], unit, role: 'detuning' },
            { fieldId: DETUNING_FIELDS[i + 2], unit, role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    const unit = 'kHz';
    const fieldId = DETUNING_FIELDS[i + 3];
    cases.push(
      deferCase(
        '',
        'challenge: same field id appears as both drive and detuning candidate',
        {
          value: 2 + i,
          unit,
          fieldId,
          declaredUnit: bothUnits(unit),
          candidates: [
            { fieldId, unit, role: 'drive' },
            { fieldId, unit, role: 'detuning' },
          ],
          metadataSource: TRUSTED,
        },
        'competing-fields',
      ),
    );
  }

  // 5 metadata-conflict near-misses.
  [
    ['Hz', 'rad/s'],
    ['kHz', 'Hz'],
    ['rad/s', 'kHz'],
    ['Hz', 'kHz'],
    ['kHz', 'rad/s'],
  ].forEach((pair, index) => {
    cases.push(
      deferCase(
        '',
        `challenge: header ${pair[0]} vs schema ${pair[1]} conflict`,
        {
          value: 100 + index,
          unit: pair[0],
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: { header: pair[0], schema: pair[1] },
          metadataSource: TRUSTED,
        },
        'metadata-conflict',
      ),
    );
  });

  // 7 missing-metadata near-misses.
  for (let i = 0; i < 2; i += 1) {
    cases.push(
      deferCase(
        '',
        'challenge: metadata source is unverified',
        {
          value: 7.5 + i,
          unit: 'kHz',
          fieldId: DETUNING_FIELDS[i + 5],
          declaredUnit: bothUnits('kHz'),
          metadataSource: UNVERIFIED,
        },
        'missing-metadata',
      ),
    );
  }
  for (let i = 0; i < 2; i += 1) {
    cases.push(
      deferCase(
        '',
        'challenge: declaredUnit absent entirely',
        {
          value: 60 + i,
          unit: 'Hz',
          fieldId: DETUNING_FIELDS[i + 2],
          metadataSource: TRUSTED,
        },
        'missing-metadata',
      ),
    );
  }
  cases.push(
    deferCase(
      '',
      'challenge: declaredUnit present but empty',
      {
        value: 2 * Math.PI * 30,
        unit: 'rad/s',
        fieldId: DETUNING_FIELDS[6],
        declaredUnit: {},
        metadataSource: TRUSTED,
      },
      'missing-metadata',
    ),
  );
  for (let i = 0; i < 2; i += 1) {
    cases.push(
      deferCase(
        '',
        'challenge: empty fieldId with no candidates',
        {
          value: 900 + i,
          unit: 'Hz',
          fieldId: '',
          declaredUnit: bothUnits('Hz'),
          metadataSource: TRUSTED,
        },
        'missing-metadata',
      ),
    );
  }

  // 4 non-finite near-misses.
  [Infinity, -Infinity, Infinity, -Infinity].forEach((value, index) => {
    const unit = UNIT_ENUM[index % UNIT_ENUM.length];
    cases.push(
      deferCase(
        '',
        `challenge: non-finite value ${value > 0 ? '+Infinity' : '-Infinity'} in ${unit}`,
        {
          value,
          unit,
          fieldId: DETUNING_FIELDS[index],
          declaredUnit: bothUnits(unit),
          metadataSource: TRUSTED,
        },
        'invalid-value',
      ),
    );
  });

  // 6 tricky accepts: near the same boundaries but genuinely unambiguous.
  cases.push(
    acceptCase(
      '',
      'challenge accept: negative dual-kHz detuning with explicit detuning field id',
      {
        value: -2.5,
        unit: 'kHz',
        fieldId: 'detuning_freq',
        declaredUnit: bothUnits('kHz'),
        candidates: [
          { fieldId: 'drive_freq', unit: 'kHz', role: 'drive' },
          { fieldId: 'detuning_freq', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      -2500,
    ),
    acceptCase(
      '',
      'challenge accept: rad/s with header-only declaration and one detuning candidate',
      {
        value: 2 * Math.PI * 300,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: { header: 'rad/s' },
        candidates: [{ fieldId: 'detuning_rad', unit: 'rad/s', role: 'detuning' }],
        metadataSource: TRUSTED,
      },
      300,
    ),
    acceptCase(
      '',
      'challenge accept: Hz with schema-only declaration',
      {
        value: 245.5,
        unit: 'Hz',
        fieldId: 'detuning_hz',
        declaredUnit: { schema: 'Hz' },
        metadataSource: TRUSTED,
      },
      245.5,
    ),
    acceptCase(
      '',
      'challenge accept: two detuning candidates but explicit id picks one',
      {
        value: 0.75,
        unit: 'kHz',
        fieldId: 'detuning_b',
        declaredUnit: bothUnits('kHz'),
        candidates: [
          { fieldId: 'detuning_a', unit: 'kHz', role: 'detuning' },
          { fieldId: 'detuning_b', unit: 'kHz', role: 'detuning' },
        ],
        metadataSource: TRUSTED,
      },
      750,
    ),
    acceptCase(
      '',
      'challenge accept: very small kHz value with explicit field id',
      {
        value: 0.000125,
        unit: 'kHz',
        fieldId: 'detuning_khz',
        declaredUnit: bothUnits('kHz'),
        metadataSource: TRUSTED,
      },
      0.125,
    ),
    acceptCase(
      '',
      'challenge accept: negative rad/s value',
      {
        value: -2 * Math.PI * 120,
        unit: 'rad/s',
        fieldId: 'detuning_rad',
        declaredUnit: bothUnits('rad/s'),
        metadataSource: TRUSTED,
      },
      -120,
    ),
  );

  const shuffleRand = mulberry32(0x0beef);
  for (let i = cases.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffleRand() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }
  return cases.map((fixtureCase, index) => ({
    ...fixtureCase,
    id: `challenge-${String(index + 1).padStart(3, '0')}`,
  }));
}

// ---------------------------------------------------------------------------
// arms: paired three-arm pilot comparison over the 100 audit case ids.
// A = slow + expensive baseline, B = medium heuristic pipeline, C = target routine.
// C resolves every expected-accept case correctly and defers every expected-defer
// case to the user, so it has coverage 78% and zero silent errors.
// ---------------------------------------------------------------------------

const ARM_CONFIG = {
  A: {
    label: 'A: unversioned manual review (slow, expensive)',
    setupCostUsd: 1500,
    maintenanceCostUsd: 900,
    acceptResolved: 68,
    wrongDeferResolved: 4,
    cost: (resolved, index) =>
      resolved ? round(1.05 + (index % 5) * 0.09, 4) : round(0.3, 4),
    latency: (resolved, index) => (resolved ? 1600 : 1300) + (index % 7) * 170,
  },
  B: {
    label: 'B: medium heuristic pipeline',
    setupCostUsd: 600,
    maintenanceCostUsd: 350,
    acceptResolved: 74,
    wrongDeferResolved: 3,
    cost: (resolved, index) =>
      resolved ? round(0.62 + (index % 4) * 0.05, 4) : round(0.2, 4),
    latency: (resolved, index) => (resolved ? 850 : 700) + (index % 6) * 90,
  },
  C: {
    label: 'C: versioned normalize_detuning/v1 with guard + reference check',
    setupCostUsd: 300,
    maintenanceCostUsd: 120,
    acceptResolved: 78,
    wrongDeferResolved: 0,
    cost: (resolved, index) =>
      resolved ? round(0.33 + (index % 3) * 0.03, 4) : round(0.12, 4),
    latency: (resolved, index) => (resolved ? 380 : 320) + (index % 5) * 45,
  },
};

function buildArm(auditCases, arm) {
  const config = ARM_CONFIG[arm];
  const acceptIds = auditCases
    .filter((fixtureCase) => fixtureCase.expect.decision === 'accept')
    .map((fixtureCase) => fixtureCase.id);
  const deferIds = auditCases
    .filter((fixtureCase) => fixtureCase.expect.decision === 'defer')
    .map((fixtureCase) => fixtureCase.id);

  const resolvedAccept = new Set(acceptIds.slice(0, config.acceptResolved));
  const wrongDefer = new Set(deferIds.slice(0, config.wrongDeferResolved));

  const cases = auditCases.map((fixtureCase, index) => {
    const expectsAccept = fixtureCase.expect.decision === 'accept';
    let resolved;
    let correct;
    if (expectsAccept) {
      resolved = resolvedAccept.has(fixtureCase.id);
      correct = resolved;
    } else if (wrongDefer.has(fixtureCase.id)) {
      resolved = true;
      correct = false;
    } else {
      resolved = false;
      correct = true;
    }
    return {
      caseId: fixtureCase.id,
      resolved,
      correct,
      costUsd: config.cost(resolved, index),
      latencyMs: config.latency(resolved, index),
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: 'example',
    arm,
    label: config.label,
    workload: { requests: 100, horizonDays: 30 },
    setupCostUsd: config.setupCostUsd,
    maintenanceCostUsd: config.maintenanceCostUsd,
    cases,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const dev = { schemaVersion: SCHEMA_VERSION, set: 'dev', provenance: 'synthetic', frozenAt: FROZEN_AT, cases: buildDev() };
const audit = { schemaVersion: SCHEMA_VERSION, set: 'audit', provenance: 'synthetic', frozenAt: FROZEN_AT, cases: buildAudit() };
const challenge = { schemaVersion: SCHEMA_VERSION, set: 'challenge', provenance: 'synthetic', frozenAt: FROZEN_AT, cases: buildChallenge() };

writeJson(path.join(FIXTURE_DIR, 'dev.json'), dev);
writeJson(path.join(FIXTURE_DIR, 'audit.json'), audit);
writeJson(path.join(FIXTURE_DIR, 'challenge.json'), challenge);

for (const arm of ['A', 'B', 'C']) {
  writeJson(path.join(ARM_DIR, `arm-${arm.toLowerCase()}.json`), buildArm(audit.cases, arm));
}

const auditAccept = audit.cases.filter((c) => c.expect.decision === 'accept').length;
const challengeDefer = challenge.cases.filter((c) => c.expect.decision === 'defer').length;

console.log(`wrote dev: ${dev.cases.length} cases`);
console.log(`wrote audit: ${audit.cases.length} cases (${auditAccept} accept / ${audit.cases.length - auditAccept} defer)`);
console.log(`wrote challenge: ${challenge.cases.length} cases (${challengeDefer} defer / ${challenge.cases.length - challengeDefer} accept)`);
console.log(`wrote arms: ${['A', 'B', 'C'].join(', ')} (100 paired cases each)`);
