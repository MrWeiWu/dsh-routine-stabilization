// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

// Host half of the Routine Stabilization bundle.
//
// Responsibilities:
//   - expose the registry operations as agent tools (lib/tools.js)
//   - expose the same operations to the Web settings panel over same-origin
//     Connection Fetch routes under /api/routine-stabilization (the static client
//     half has no package-private host bridge; the Connection service admits the
//     owner browser request before the route runs)
//   - register the "Routine stabilization" agent preset when the profile has an
//     agent-preset service
//
// The operation object is the single implementation both callers share, so the
// panel and the agent cannot diverge on meaning.

import * as engine from './lib/engine.js'
import * as store from './lib/store.js'
import { registerTools } from './lib/tools.js'
import { registerPreset } from './preset/register.js'

export const name = 'routine-stabilization'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const root = store.resolveRoot(typeof config?.root === 'string' ? config.root : undefined)
  // Runtime-registration outcome, surfaced by routine_status so a missing preset
  // is visible instead of only appearing as a Host log line.
  const presetState = { status: 'pending', at: null, error: null }

  const operations = {
    async state() {
      const state = await engine.registryState(root)
      return { ...state, preset: { ...presetState } }
    },
    async evaluate(routine, version, options = {}) {
      const report = await engine.evaluateRoutine(root, routine, version, {
        modelSnapshot: options?.modelSnapshot,
        codeRevision: options?.codeRevision,
        promptVersions: options?.promptVersions,
        toolVersions: options?.toolVersions,
        environment: options?.environment,
        notes: options?.notes,
      })
      return {
        routine,
        version: String(version),
        passed: report.passed,
        eligibility: report.eligibility,
        auditUse: report.auditUse,
        blindRun: report.blindRun,
        dataClass: report.dataClass,
        gates: report.gates,
        metrics: report.metrics,
        evidenceHash: report.evidence?.evidenceHash ?? null,
        reportPath: report.reportPath,
        reportSha256: report.reportSha256,
        generatedAt: report.generatedAt,
      }
    },
    async run(routine, version, input) {
      return engine.invokeRoutine(root, routine, version, input)
    },
    async propose(proposal) {
      return engine.proposeRoutine(root, proposal)
    },
    async preregister(routine, version, preregistration) {
      return engine.writePreregistration(root, routine, String(version), preregistration, { by: 'agent' })
    },
    async report(routine, version) {
      const report = await store.latestReport(root, routine, String(version))
      if (!report) throw new Error(`no evaluation report for ${routine}/${version}`)
      return report
    },
    async compare(options = {}) {
      return engine.compareArms(root, {
        runId: options.runId,
        routine: options.routine,
        version: options.version === undefined ? undefined : String(options.version),
      })
    },
    async release(routine, version) {
      // User authority: only the settings panel reaches this operation, and the
      // panel confirms explicitly before calling it.
      const registry = await engine.releaseRoutine(root, routine, String(version), { by: 'user' })
      return { released: true, registry: summarizeRegistry(registry) }
    },
    async withdraw(routine, version, reason) {
      const registry = await engine.withdrawRoutine(root, routine, String(version), {
        by: 'user',
        reason: typeof reason === 'string' ? reason : undefined,
      })
      return { withdrawn: true, registry: summarizeRegistry(registry) }
    },
    async seed() {
      return store.seedExample(root)
    },
    async log(limit) {
      return store.readRouteLog(root, Number.isFinite(limit) ? limit : 50)
    },
  }

  ctx.effect(() => {
    const disposers = []

    // Make sure the layout exists without blocking activation; a failed mkdir is
    // reported through the status tool and the panel instead of crashing boot.
    store.ensureRoot(root).catch((error) => {
      console.error(`[routine-stabilization] cannot initialize registry root ${root}: ${error.message}`)
    })

    // Discipline barrier: agent tools may not name the protected blind tree.
    // The real read barrier is the 0700/0600 file mode; the release reviewer
    // reads per-case scoring through scripts/score.mjs, not a tool argument.
    if (ctx.tools?.guard) {
      // Only tools that can touch the filesystem or run commands are screened;
      // a chat or plan argument that merely mentions the protected word stays valid.
      const guardedTools = new Set([
        'read',
        'read_image',
        'glob',
        'grep',
        'write',
        'edit',
        'apply_patch',
        'bash',
        'terminal_open',
        'terminal_read',
        'terminal_signal',
        'terminal_close',
      ])
      const protectedDir = 'bl' + 'ind'
      const protectedPrefix = root + '/' + protectedDir
      disposers.push(
        ctx.tools.guard((execution) => {
          if (!guardedTools.has(execution?.name)) return undefined
          const text = JSON.stringify(execution?.arguments ?? {})
          if (text.includes(protectedPrefix) || text.includes(protectedDir + '/')) {
            return 'the protected ' + protectedDir + ' labels are not readable through agent tools; use scripts/score.mjs as the release reviewer'
          }
          return undefined
        }),
      )
    }

    disposers.push(registerTools(ctx, operations))

    const connection = ctx.get('connection')
    if (connection?.rpc) {
      disposers.push(registerRpcChannel(connection, operations))
    } else {
      console.warn('[routine-stabilization] no connection service; the settings panel cannot reach the registry')
    }

    const agentPresets = ctx.get('agentPresets')
    if (agentPresets) {
      Promise.resolve()
        .then(() => registerPreset(agentPresets, ctx))
        .then(() => {
          presetState.status = 'registered'
          presetState.at = new Date().toISOString()
        })
        .catch((error) => {
          presetState.status = 'failed'
          presetState.at = new Date().toISOString()
          presetState.error = String(error?.message ?? error)
          console.error(`[routine-stabilization] cannot register the agent preset: ${presetState.error}`)
        })
    } else {
      presetState.status = 'unavailable'
      presetState.error = 'the profile has no agentPresets service'
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // best-effort teardown
        }
      }
    }
  })
}

function summarizeRegistry(registry) {
  return {
    fallback: registry.fallback ?? null,
    routines: Object.fromEntries(
      Object.entries(registry.routines ?? {}).map(([id, routine]) => [
        id,
        {
          title: routine.title ?? id,
          versions: Object.fromEntries(
            Object.entries(routine.versions ?? {}).map(([version, entry]) => [
              version,
              { status: entry.status, approvedRelease: entry.approvedRelease ?? null },
            ]),
          ),
        },
      ]),
    ),
  }
}

// ---------------------------------------------------------------------------
// Host HTTP surface for the settings panel
//
// A static client half has no package-private host bridge, so the panel uses
// same-origin fetch against exact Connection Fetch routes under `/api`. The
// Connection service admits the browser request (owner principal) before the
// route runs; no extra authentication is implemented here.
// ---------------------------------------------------------------------------

const API_BASE = '/api/routine-stabilization'

function failure(code, message) {
  return { ok: false, error: { code: `routine-stabilization/${code}`, message: String(message), details: {} } }
}

function json(value) {
  return Response.json(value)
}

function readJsonBody(request) {
  return request
    .json()
    .then((body) => (body && typeof body === 'object' ? body : {}))
    .catch(() => ({}))
}

function registerFetchRoutes(connectionFetch, operations) {
  const disposers = []
  const register = (path, methods, handle) => {
    const dispose = connectionFetch.register({
      path: `${API_BASE}/${path}`,
      methods,
      requestBody: 'buffered',
      async fetch(request) {
        try {
          return json({ ok: true, value: await handle(request) })
        } catch (error) {
          return json(failure('operation-failed', error?.message ?? error))
        }
      },
    })
    disposers.push(dispose)
  }

  register('state', ['GET'], () => operations.state())
  register('report', ['GET'], (request) => {
    const url = new URL(request.url)
    const routine = url.searchParams.get('routine')
    const version = url.searchParams.get('version')
    if (!routine || version === null) throw new Error('routine and version query parameters are required')
    return operations.report(routine, version)
  })
  register('log', ['GET'], (request) => {
    const url = new URL(request.url)
    return operations.log(Number(url.searchParams.get('limit') ?? '50'))
  })
  register('evaluate', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (!body.routine || body.version === undefined) throw new Error('routine and version are required')
    return operations.evaluate(String(body.routine), String(body.version), body)
  })
  register('release', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (!body.routine || body.version === undefined) throw new Error('routine and version are required')
    return operations.release(String(body.routine), String(body.version))
  })
  register('withdraw', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (!body.routine || body.version === undefined) throw new Error('routine and version are required')
    return operations.withdraw(String(body.routine), String(body.version), body.reason)
  })
  register('seed', ['POST'], () => operations.seed())
  register('compare', ['POST'], async (request) => operations.compare(await readJsonBody(request)))

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // best-effort teardown
      }
    }
  }
}
function registerRpcChannel(connection, operations) {
  if (typeof connection?.fetch?.register !== 'function') {
    throw new Error('the connection service does not expose fetch.register')
  }
  return registerFetchRoutes(connection.fetch, operations)
}
