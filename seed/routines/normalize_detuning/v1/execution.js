// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Execution stage for the built-in `normalize_detuning/v1` routine.
 *
 * Contract: `run(bound)` returns {fieldId, sourceUnit, valueHz}.
 *
 * Conversion factors (sign always preserved):
 *   Hz    -> 1
 *   kHz   -> 1000
 *   rad/s -> 1 / (2 * PI)
 *
 * The function is pure and has no dependency on the guard/binding modules.
 */

const FACTOR_BY_UNIT = Object.freeze({
  Hz: 1,
  kHz: 1000,
  'rad/s': 1 / (2 * Math.PI),
});

export function run(bound) {
  if (!bound || typeof bound !== 'object' || Array.isArray(bound)) {
    throw new Error('missing-metadata');
  }
  const factor = FACTOR_BY_UNIT[bound.unit];
  if (factor === undefined) {
    throw new Error('unsupported-unit');
  }
  if (typeof bound.value !== 'number' || !Number.isFinite(bound.value)) {
    throw new Error('invalid-value');
  }
  const valueHz = bound.value * factor;
  if (!Number.isFinite(valueHz)) {
    throw new Error('invalid-value');
  }
  return {
    fieldId: bound.fieldId,
    sourceUnit: bound.unit,
    valueHz,
  };
}
