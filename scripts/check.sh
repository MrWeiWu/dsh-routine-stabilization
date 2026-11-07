#!/usr/bin/env bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The dsh-routine-stabilization authors

# Consistency check for the routine-stabilization bundle.
# Exits 0 only when every check passes.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== node --check (every .js/.mjs in the bundle)"
while IFS= read -r file; do
  node --check "$file"
done < <(find . -type f \( -name '*.js' -o -name '*.mjs' \) ! -path './node_modules/*' | sort)

echo "== JSON manifests and locale resources"
node - <<'NODE'
const fs = require('node:fs')
const files = [
  'package.json',
  'locale/en.json',
  'locale/zh.json',
  'seed/registry/registry.json',
  'seed/routines/normalize_detuning/v1/manifest.json',
  'seed/fixtures/normalize_detuning/v1/dev.json',
  'seed/fixtures/normalize_detuning/v1/audit.json',
  'seed/fixtures/normalize_detuning/v1/challenge.json',
  'seed/arms/arm-a.json',
  'seed/arms/arm-b.json',
  'seed/arms/arm-c.json',
]
for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${file} is not a JSON object`)
}
console.log(`parsed ${files.length} JSON files`)
NODE

echo "== preset declaration and skill"
node preset/validate.mjs

echo "== engine self-check (seed, evaluate, gates, release, stale evidence, comparison, withdraw)"
node lib/selfcheck.mjs

echo "== independent reference calculation from the seed example"
node seed/evals/reference_check.mjs

echo "ALL CHECKS PASSED"
