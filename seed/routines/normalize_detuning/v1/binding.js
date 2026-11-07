// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Binding stage for the built-in `normalize_detuning/v1` routine.
 *
 * Contract: `bind(input)` returns
 *   {fieldId, unit, value, source, preservedInput}
 * and throws `new Error(code)` where `code` is one of the guard's defer reasons
 * when the input cannot be bound unambiguously.
 *
 * The binding step is intentionally lossless: `source` records how the detuning
 * field was resolved (`candidates` vs `declared-unit`) and `preservedInput` keeps
 * a deep copy of the original input for audit/reproduction purposes.
 */

import { decide } from './guard.js';

function clone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function bind(input) {
  const verdict = decide(input);
  if (verdict.decision !== 'accept') {
    throw new Error(verdict.reason || 'missing-metadata');
  }

  const usedCandidates = Array.isArray(input.candidates) && input.candidates.length > 0;

  return {
    fieldId: input.fieldId,
    unit: input.unit,
    value: input.value,
    source: usedCandidates ? 'candidates' : 'declared-unit',
    preservedInput: clone(input),
  };
}
