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
const OBJECT_VALUE = (description) => ({ type: 'object', description, additionalProperties: true })

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
          'Copy the built-in example routine (normalize_detuning/v1, its frozen fixture sets with protected blind labels, the preregistration, the independent reference check) from the package into an empty registry root. Existing files and an existing registry document are not overwritten; use it once on first use.',
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
          'Run the routine\'s frozen dev, audit and challenge fixture sets against the protected blind labels, apply the preregistered promotion gates, and record the first-run audit accounting. Per-case scoring detail is written to a protected blind/runs file; the public report keeps aggregates and route outcomes only. Writes reports/<id>-v<version>-<stamp>.json with evidence hashes and a reproducibility block. Only the first prespecified run of a label set can later support a release.',
        parameters: OBJECT(
          {
            routine: STRING('Routine id, for example "normalize_detuning".'),
            version: STRING('Routine version, for example "1".'),
            modelSnapshot: STRING('Optional model snapshot recorded in the reproducibility block.'),
            codeRevision: STRING('Optional code revision recorded in the reproducibility block.'),
            promptVersions: OBJECT_VALUE('Optional prompt version map recorded in the reproducibility block.'),
            toolVersions: OBJECT_VALUE('Optional tool version map recorded in the reproducibility block.'),
            environment: OBJECT_VALUE('Optional environment map recorded in the reproducibility block.'),
            notes: { type: 'array', items: { type: 'string' }, description: 'Optional notes stored with the report.' },
          },
          ['routine', 'version'],
        ),
        run: (args) =>
          operations.evaluate(args.routine, String(args.version), {
            modelSnapshot: args.modelSnapshot,
            codeRevision: args.codeRevision,
            promptVersions: args.promptVersions,
            toolVersions: args.toolVersions,
            environment: args.environment,
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
          'Create or replace a candidate routine version from agent-authored sources: the manifest, the guard/binding/execution hook files, the dev/audit/challenge case arrays and a frozen preregistration. Dev labels stay in the readable fixture file; audit/challenge labels are split into blind/<id>/<version>/*.labels.json (mode 0600). The candidate is registered as "candidate" and cannot be released until a maintainer adds an independent reviewer signature and evaluates it. A released version is immutable.',
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
              description: 'Case arrays keyed dev, audit, challenge. Each case carries id, description, input and expect; audit/challenge expects are written to the protected blind tree, not the readable fixtures.',
              additionalProperties: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            preregistration: {
              type: 'object',
              description: 'Frozen preregistration object (schemaVersion 1, population, samplingUnit, exclusions, thresholds, workload, decisionDate, nextReviewTrigger, realDataAttested, reviewers). An agent may only add author reviewers; independent domain-reviewer signatures must be added by the user.',
              additionalProperties: true,
            },
            overwrite: BOOLEAN('Replace an existing candidate version. Released versions always reject overwrite.'),
          },
          ['id', 'version', 'manifest', 'files', 'fixtures', 'preregistration'],
        ),
        run: (args) => operations.propose(args),
        timeoutMs: 60000,
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_preregister',
        description:
          'Write or replace the frozen preregistration for a candidate routine version before any blind evaluation. An agent may record author reviewers only; an independent domain-reviewer signature must be added by the user and is required before release. After the first blind run the preregistration is frozen: changing it requires a fresh audit set.',
        parameters: OBJECT(
          {
            routine: STRING('Routine id.'),
            version: STRING('Routine version.'),
            preregistration: {
              type: 'object',
              description: 'Preregistration object with population, samplingUnit, exclusions, thresholds, workload, decisionDate, nextReviewTrigger, realDataAttested and reviewers.',
              additionalProperties: true,
            },
          },
          ['routine', 'version', 'preregistration'],
        ),
        run: (args) => operations.preregister(args.routine, String(args.version), args.preregistration),
        timeoutMs: 60000,
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'routine_report',
        description:
          'Return the latest evaluation report for one routine version: every gate, per-set metrics with denominators, aggregate outcomes, eligibility blockers, audit first-run accounting, evidence and reproducibility hashes, and the path of the protected per-case scoring detail. Blind per-case correctness is not included here; use scripts/score.mjs with the protected run file.',
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
          'Compare measured pilot arms (A fresh LLM agent, B hand-written, C routine) stored as raw arm runs under arms/<runId>/arm-<a|b|c>-r<repeat>.json (produced by pilot/run.mjs). Raw arms carry decisions only; this tool scores them against the protected audit labels and writes aggregates to a public report plus per-case scoring to a protected blind/runs file. Reports repeatability, paired bootstrap, zero-discordance bound, latency, cost basis completeness and the pilot decision. routine and version are required for scoring.',
        parameters: OBJECT({
          runId: STRING('Optional arm run id used to select a record set.'),
          routine: STRING('Optional candidate routine id, used to load its latest gates.'),
          version: STRING('Optional candidate version, used to load its latest gates.'),
        }),
        run: (args) => {
          if (!args.routine || args.version === undefined) {
            throw new Error('routine and version are required: measured arms are scored against the protected labels of that routine version')
          }
          return operations.compare(args)
        },
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
