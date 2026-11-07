// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Admission guard for the built-in `normalize_detuning/v1` routine.
 *
 * Contract: `decide(input)` returns {decision:'accept'|'defer', reason?, details?}.
 * The guard never converts values and never mutates the input; it only decides
 * whether the input is safe to bind and execute.
 *
 * Deterministic decision order (documented in seed/README.md):
 *   1. metadataSource must be 'trusted-schema'          -> missing-metadata
 *   2. value must be a finite number                    -> invalid-value
 *   3. unit must be present                             -> missing-metadata
 *      unit must be one of Hz / kHz / rad/s             -> unsupported-unit
 *   4. declaredUnit must carry header and/or schema     -> missing-metadata
 *   5. header and schema, when both present, must agree -> metadata-conflict
 *   6. candidates, when present, must resolve fieldId
 *      unambiguously to a detuning field               -> competing-fields
 *   7. fieldId must be explicit when no candidates      -> missing-metadata
 */

const UNIT_ENUM = ['Hz', 'kHz', 'rad/s'];
const ROLE_DETUNING = 'detuning';
const ROLE_DRIVE = 'drive';

function accept(details) {
  return { decision: 'accept', details };
}

function defer(reason, details) {
  return { decision: 'defer', reason, details };
}

function normalizeUnit(unit) {
  return typeof unit === 'string' ? unit.trim().toLowerCase() : '';
}

function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    fieldId: candidate && typeof candidate.fieldId === 'string' ? candidate.fieldId : null,
    role: candidate && typeof candidate.role === 'string' ? candidate.role : null,
  }));
}

export function decide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defer('missing-metadata', { missing: 'input' });
  }

  // 1. Only schema-trusted metadata may ever be auto-accepted.
  if (input.metadataSource !== 'trusted-schema') {
    return defer('missing-metadata', {
      missing: 'metadataSource',
      metadataSource: input.metadataSource ?? null,
    });
  }

  // 2. Non-finite (NaN / ±Infinity) or non-numeric values are never bound.
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    return defer('invalid-value', { value: String(input.value) });
  }

  // 3. Unit must be present and supported.
  if (typeof input.unit !== 'string' || input.unit.trim() === '') {
    return defer('missing-metadata', { missing: 'unit' });
  }
  if (!UNIT_ENUM.includes(input.unit)) {
    return defer('unsupported-unit', { unit: input.unit, supported: UNIT_ENUM });
  }

  // 4. Declared metadata must exist in at least one of the two declaration slots.
  const declared = input.declaredUnit;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return defer('missing-metadata', { missing: 'declaredUnit' });
  }
  const header =
    typeof declared.header === 'string' && declared.header.trim() !== '' ? declared.header : null;
  const schema =
    typeof declared.schema === 'string' && declared.schema.trim() !== '' ? declared.schema : null;
  if (!header && !schema) {
    return defer('missing-metadata', { missing: 'declaredUnit.header|declaredUnit.schema' });
  }

  // 5. A header/schema disagreement is a metadata conflict; no numeric answer is allowed.
  if (header && schema && normalizeUnit(header) !== normalizeUnit(schema)) {
    return defer('metadata-conflict', { header, schema });
  }

  const hasExplicitFieldId =
    typeof input.fieldId === 'string' && input.fieldId.trim() !== '';
  const candidates = Array.isArray(input.candidates) ? input.candidates : null;

  // 6. Candidate columns may only confirm a detuning field; they never guessed on the agent's behalf.
  if (candidates && candidates.length > 0) {
    if (!hasExplicitFieldId) {
      return defer('competing-fields', {
        fieldId: null,
        candidates: summarizeCandidates(candidates),
      });
    }
    const matched = candidates.filter(
      (candidate) => candidate && candidate.fieldId === input.fieldId,
    );
    if (matched.length === 0) {
      return defer('competing-fields', {
        fieldId: input.fieldId,
        candidates: summarizeCandidates(candidates),
      });
    }
    const roles = [...new Set(matched.map((candidate) => candidate.role))];
    if (roles.includes(ROLE_DRIVE) || !roles.includes(ROLE_DETUNING)) {
      return defer('competing-fields', { fieldId: input.fieldId, roles });
    }
    return accept({
      fieldId: input.fieldId,
      unit: input.unit,
      resolvedBy: 'candidates',
      candidateCount: candidates.length,
    });
  }

  // 7. Without a candidate table the field id itself must identify the detuning field.
  if (!hasExplicitFieldId) {
    return defer('missing-metadata', { missing: 'fieldId' });
  }
  return accept({
    fieldId: input.fieldId,
    unit: input.unit,
    resolvedBy: 'declared-unit',
  });
}
