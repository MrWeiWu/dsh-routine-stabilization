// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Compatibility entry point for the seed acceptance command
 *   node seed/evals/reference_check.mjs
 *
 * The canonical evaluator referenced by manifest.evidence.evaluator is
 * evals/normalize_detuning/v1/reference_check.mjs; this file only forwards to it
 * and resolves relative to its own location, so it also works after the seed
 * tree has been copied to a registry root.
 */

import './normalize_detuning/v1/reference_check.mjs';
