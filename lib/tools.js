// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Agent-facing tools. Every tool delegates to the same registry operations the
// Web UI calls, so the panel and the agent cannot diverge on meaning.

const OUTPUT_SCHEMA = { type: 'object' }

function textContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function defineTool({ name, description, parameters, run, timeoutMs }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textContent(value),
    },
    timeoutMs,
    async execute(args) {
      return run(args ?? {})
    },
  }
}

const OBJECT = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const STRING = (description) => ({ type: 'string', description })
const BOOLEAN = (description) => ({ type: 'boolean', description })

export function registerTools(ctx, operations) {
  const disposers = []

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_status',
        description:
          'Show the routine registry: versions, candidate/active/withdrawn status, the active version and fallback pointer, and the gate summary of each version\'s latest evaluation report. Read-only.',
        parameters: OBJECT({}),
        run: () => operations.state(),
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_seed',
        description:
          'Copy the built-in example routine (normalize_detuning/v1, its 170 frozen fixture cases, the independent reference check and the three paired arm records) from the package into an empty registry root. Existing files and an existing registry document are not overwritten; use it once on first use.',
        parameters: OBJECT({}),
        run: () => operations.seed(),
        timeoutMs: 60000,
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_evaluate',
        description:
          'Run the routine\'s frozen dev, audit and challenge fixture sets, then apply the promotion gates: dev must pass, coverage >= 60%, zero observed silent errors with a one-sided 95% upper bound below 5%, zero incorrect automatic results on the 40 near-misses, and the independent reference check must exit 0. Writes a report under reports/ and records its hash. Use before any release.',
        parameters: OBJECT(
          {
            routine: STRING('Routine id, for example "normalize_detuning".'),
            version: STRING('Routine version, for example "1".'),
            modelSnapshot: STRING('Optional model snapshot recorded in the reproducibility block.'),
            codeRevision: STRING('Optional code revision recorded in the reproducibility block.'),
            notes: { type: 'array', items: { type: 'string' }, description: 'Optional notes stored with the report.' },
          },
          ['routine', 'version'],
        ),
        run: (args) =>
          operations.evaluate(args.routine, String(args.version), {
            modelSnapshot: args.modelSnapshot,
            codeRevision: args.codeRevision,
            notes: args.notes,
          }),
        timeoutMs: 180000,
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_run',
        description:
          'Invoke one active-or-candidate routine on a single input through the runtime path: resolve the field and provenance, check applicability, run the conversion, validate the output, and fall back on a failed check. Every decision is logged with its reason. Returns the decision (accept/defer/fallback), deferral reason, bound field, output and postcondition results.',
        parameters: OBJECT(
          {
            routine: STRING('Routine id.'),
            version: STRING('Routine version.'),
            input: { type: 'object', description: 'Routine input object; the routine manifest documents its schema and metadata requirements.', additionalProperties: true },
          },
          ['routine', 'version', 'input'],
        ),
        run: (args) => operations.run(args.routine, String(args.version), args.input),
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_propose',
        description:
          'Create or replace a candidate routine version from agent-authored sources: the manifest, the guard/binding/execution hook files, and the dev/audit/challenge fixture arrays. The candidate is written to routines/<id>/<version>/ and fixtures/<id>/<version>/ and registered as "candidate"; it cannot run as a release until a maintainer evaluates and releases it in the UI. A released version is immutable.',
        parameters: OBJECT(
          {
            id: STRING('Routine id, lowercase (for example "normalize_detuning").'),
            version: STRING('Version label starting with a digit (for example "2").'),
            manifest: { type: 'object', description: 'Manifest with schemaVersion 1, identity, inputs, admission, binding, execution, postconditions, errorPolicy, fallback and evidence fields.', additionalProperties: true },
            files: {
              type: 'object',
              description: 'Hook sources keyed by file name: guard.js, binding.js, execution.js. Manifest entries must reference them as "guard.js#decide" and so on.',
              additionalProperties: { type: 'string' },
            },
            fixtures: {
              type: 'object',
              description: 'Fixture case arrays keyed dev, audit, challenge.',
              additionalProperties: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            overwrite: BOOLEAN('Replace an existing candidate version. Released versions always reject overwrite.'),
          },
          ['id', 'version', 'manifest', 'files', 'fixtures'],
        ),
        run: (args) => operations.propose(args),
        timeoutMs: 60000,
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_report',
        description:
          'Return the latest evaluation report for one routine version, including every gate, per-set metrics with denominators, per-case outcomes, and the evidence and reproducibility hashes.',
        parameters: OBJECT({ routine: STRING('Routine id.'), version: STRING('Routine version.') }, ['routine', 'version']),
        run: (args) => operations.report(args.routine, String(args.version)),
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_compare',
        description:
          'Compare three paired arms (A fresh agent, B hand-written, C trace-derived) from arms/*.json: success rate, paired discordant counts, a case-level bootstrap interval, a zero-discordance bound, p50/p95 latency, and projected total cost at the declared workload. Applies the pilot decision rule when the candidate report is available (routine and version supplied).',
        parameters: OBJECT({
          runId: STRING('Optional arm run id used to select a record set.'),
          routine: STRING('Optional candidate routine id, used to load its latest gates.'),
          version: STRING('Optional candidate version, used to load its latest gates.'),
        }),
        run: (args) => operations.compare(args),
        timeoutMs: 60000,
      }),
    ),
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // disposal is best effort during plugin unload
      }
    }
  }
}
