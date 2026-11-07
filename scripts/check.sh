#!/usr/bin/env bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 The dsh-routine-stabilization authors

# Consistency check for the routine-stabilization bundle.
# Exits 0 only when every check passes.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== node --check (every .js/.mjs in the project)"
while IFS= read -r file; do
  node --check "$file"
done < <(find . -type f \( -name '*.js' -o -name '*.mjs' \) ! -path './node_modules/*' | sort)

echo "== JSON manifests, fixtures, blind labels and locale resources"
node - <<'NODE'
const fs = require('node:fs')
const files = [
  'package.json',
  'locale/en.json',
  'locale/zh.json',
  'seed/registry/registry.json',
  'seed/routines/normalize_detuning/v1/manifest.json',
  'seed/routines/normalize_detuning/v1/preregistration.json',
  'seed/fixtures/normalize_detuning/v1/dev.json',
  'seed/fixtures/normalize_detuning/v1/audit.inputs.json',
  'seed/fixtures/normalize_detuning/v1/challenge.inputs.json',
  'seed/blind/normalize_detuning/v1/audit.labels.json',
  'seed/blind/normalize_detuning/v1/challenge.labels.json',
  'pilot/cost-model.json',
]
for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${file} is not a JSON object`)
}
const inputs = JSON.parse(fs.readFileSync('seed/fixtures/normalize_detuning/v1/audit.inputs.json', 'utf8'))
if (inputs.cases.some((c) => c.expect !== undefined)) throw new Error('audit inputs must not carry expectations')
const labels = JSON.parse(fs.readFileSync('seed/blind/normalize_detuning/v1/audit.labels.json', 'utf8'))
if (labels.cases.some((c) => !c.expect)) throw new Error('audit labels must carry expectations')
console.log(`parsed ${files.length} JSON files; blind inputs/labels are separated`)
NODE

echo "== seeded blind label permissions (0600 files, 0700 directories)"
node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const { seedExample } = await import('./lib/store.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-seed-mode-'))
  try {
    const seeded = await seedExample(root)
    const labels = seeded.copied.filter((file) => file.startsWith('blind/'))
    if (labels.length === 0) throw new Error('seedExample did not copy any blind labels')
    for (const relative of labels) {
      const mode = fs.statSync(path.join(root, relative)).mode & 0o777
      if ((mode & 0o077) !== 0) throw new Error(`${relative} seeded with mode ${mode.toString(8)}; git does not carry 0600 so seeding must enforce it`)
    }
    console.log(`seeded ${labels.length} protected label files with mode 0600`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error); process.exit(1) })
NODE

echo "== preset declaration and skill"
node preset/validate.mjs

echo "== engine self-check (blind evidence, prereg, gates, eligibility, audit reuse, measured comparison, suspension)"
node lib/selfcheck.mjs

echo "== independent reference calculation from the seed example"
node seed/evals/reference_check.mjs

if [ -f pilot/selftest.mjs ]; then
  echo "== measured pilot runner self-test"
  node pilot/selftest.mjs
fi

if [ -f pilot/meter-session.mjs ]; then
  echo "== arm A session meter"
  node --check pilot/meter-session.mjs
  node pilot/meter-session.mjs --help >/dev/null
fi

if [ -f pilot/fresh-audit.mjs ]; then
  echo "== fresh evidence-cycle generator (deterministic)"
  node pilot/fresh-audit.mjs >/dev/null
fi

if [ -f pilot/meter-percase.mjs ]; then
  echo "== per-request arm A meter"
  node --check pilot/meter-percase.mjs
  node pilot/meter-percase.mjs --help >/dev/null
fi

if [ -f scripts/score.mjs ]; then
  echo "== scoring command syntax and empty-root failure behaviour"
  node --check scripts/score.mjs
  if node scripts/score.mjs --root "$(mktemp -d)" >/dev/null 2>&1; then
    echo "scripts/score.mjs unexpectedly succeeded on an empty root" >&2
    exit 1
  fi
fi

echo "ALL CHECKS PASSED"
