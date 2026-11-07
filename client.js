// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 The dsh-routine-stabilization authors

/**
 * Routine stabilization — Client half of the `dsh-routine-stabilization` bundle.
 *
 * Registers one `settings.section` page in the Harness Settings panel:
 *   - the routine registry (routine / version / status / gate summary / role),
 *   - the latest evaluation report of the selected version,
 *   - the most recent routing-log decisions,
 *   - user actions: Evaluate, Release (two-step confirmation), Withdraw (reason), Seed.
 *
 * Data transport: same-origin HTTP routes under `/api/routine-stabilization`.
 * A static client bundle cannot receive the dynamic-package `host.call` builtin
 * (that symbol only exists inside the `new Function` closure of a dynamic Cordis
 * package), and a static client cannot drive `ctx.connection.rpc.handle` either,
 * because that registration needs the connection plugin's own `webServer`.
 * The Host half therefore registers exact HTTP routes with
 * `ctx.connection.fetch.register({ path: '/api/routine-stabilization/<method>',
 * methods: ['GET' | 'POST'], requestBody: 'buffered', fetch })`
 * (@deepseek-ai/dsh-client-connection/lib/index.js, HostConnectionFetch), and the
 * browser calls them with plain same-origin `fetch`; Connection's signed browser
 * cookie authenticates the request. Every response is JSON
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 *
 * Rendering rules followed here: no JSX (React.createElement), no third-party
 * dependencies, React from the browser module table, only `--dsw-alias-*` theme
 * tokens, visible copy through `ctx.locale`, and every resource cleaned up with
 * `ctx.effect`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-routine-stabilization',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useCallback = React.useCallback
    const useEffect = React.useEffect
    const useId = React.useId
    const useRef = React.useRef
    const useState = React.useState

    /** Client locale namespace owned by this plugin. */
    const NS = 'routine-stabilization'
    /** Settings slot and section id (nav row + page). */
    const SECTION_SLOT = 'settings.section'
    const ICON_SLOT = 'settings.section.icon'
    const SECTION_ID = 'routine-stabilization'
    const SECTION_ORDER = 40
    /** Base path of the Host HTTP routes registered through `ctx.connection.fetch`. */
    const HOST_BASE = '/api/routine-stabilization'
    /** Endpoints the Host serves over GET; every other call is a POST with a JSON body. */
    const GET_METHODS = { state: true, report: true, log: true }
    /** Bundle id, also used as the style ownership marker. */
    const PACKAGE_ID = 'dsh-routine-stabilization'
    const STYLE_ID = 'dsh-routine-stabilization/client.css'

    // ---------------------------------------------------------------------
    // Dictionaries (English + Chinese inline; every visible string is a key)
    // ---------------------------------------------------------------------

    const en = {
      'nav.label': 'Routine stabilization',
      'page.title': 'Routine stabilization',
      'page.subtitle': 'Versioned routines with evidence gates, evaluation reports and a routing log.',
      'page.root': 'Registry: {path}',
      'page.lastReport': 'Last report: {at}',
      'page.lastReportNever': 'No report yet',
      'state.loading': 'Loading registry…',
      'state.loadingReport': 'Loading report…',
      'state.errorTitle': 'Could not load the routine registry',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.dismiss': 'Dismiss',
      'action.seed': 'Seed example',
      'action.seeding': 'Seeding…',
      'action.evaluate': 'Evaluate',
      'action.evaluating': 'Evaluating…',
      'action.release': 'Release',
      'action.withdraw': 'Withdraw',
      'action.confirmRelease': 'Release version',
      'action.cancel': 'Cancel',
      'action.submitWithdraw': 'Withdraw version',
      'action.withdrawing': 'Withdrawing…',
      'empty.notSeeded.title': 'No routine registry yet',
      'empty.notSeeded.body': 'Seed the example routine to create the registry and its normalize_detuning candidate version.',
      'empty.noRoutines.title': 'The registry has no routines',
      'empty.noRoutines.body': 'Refresh the registry, or seed the example when the registry is empty.',
      'notice.evaluating': 'Evaluating {routine}@{version}…',
      'notice.evaluatePass': '{routine}@{version} passed all gates.',
      'notice.evaluateFail': '{routine}@{version} did not pass all gates.',
      'notice.released': 'Released {routine}@{version}.',
      'notice.withdrawn': 'Withdrew {routine}@{version}.',
      'notice.seeded': 'Seeded the example registry at {path}.',
      'notice.actionFailed': '{action} failed: {message}',
      'registry.title': 'Registry',
      'registry.hint': '{count} versions',
      'column.routine': 'Routine',
      'column.version': 'Version',
      'column.status': 'Status',
      'column.gates': 'Gate summary',
      'column.role': 'Role',
      'column.actions': 'Actions',
      'status.candidate': 'candidate',
      'status.active': 'active',
      'status.withdrawn': 'withdrawn',
      'status.suspended': 'suspended',
      'status.superseded': 'superseded',
      'role.active': 'active',
      'role.fallback': 'fallback',
      'gates.coverage': 'cov',
      'gates.silentUpper': 'silent',
      'gates.challenge': 'challenge',
      'gates.e2e': 'e2e',
      'report.title': 'Latest report',
      'report.pick': 'Select a version to inspect its latest report.',
      'report.none': 'No report has been generated for this version yet. Run Evaluate to produce one.',
      'report.error': 'Could not load the report',
      'report.metrics.coverage': 'Coverage',
      'report.metrics.silentErrors': 'Silent errors',
      'report.metrics.challengeFailures': 'Challenge failures',
      'report.metrics.e2eSuccess': 'E2E success',
      'report.silentHint': '95% one-sided upper bound {bound}',
      'report.generatedAt': 'Generated',
      'report.cases': 'Cases',
      'report.casesValue': '{total} total · {automatic} automatic · {deferred} deferred · {fallback} fallback',
      'report.accepted': 'Accepted',
      'report.acceptedValue': '{correct} correct · {wrong} wrong',
      'report.evidence': 'Evidence hashes',
      'report.evidenceCount': '{count} hashes',
      'report.reproducibility': 'Reproducibility',
      'report.reportPath': 'Report file',
      'confirm.release.title': 'Release {routine}@{version}?',
      'confirm.release.body': 'Releasing makes this version the active one for the routine. This is a user action and is recorded in the registry.',
      'withdraw.title': 'Withdraw {routine}@{version}',
      'withdraw.body': 'Withdrawing stops this version from being used. A reason is required and is recorded in the registry log.',
      'withdraw.reasonLabel': 'Reason',
      'withdraw.reasonPlaceholder': 'Why is this version being withdrawn?',
      'withdraw.reasonRequired': 'Enter a reason before withdrawing.',
      'log.title': 'Routing log',
      'log.hint': 'Most recent {count} decisions',
      'log.loading': 'Loading routing log…',
      'log.empty': 'No routing decisions recorded yet.',
      'log.error': 'Could not read the routing log',
      'log.column.at': 'When',
      'log.column.decision': 'Decision',
      'log.column.target': 'Routine',
      'log.column.field': 'Field',
      'log.column.reason': 'Reason',
      'log.column.disposition': 'Disposition',
      'log.decision.accept': 'accept',
      'log.decision.defer': 'defer',
      'log.decision.fallback': 'fallback',
      'log.target': '{routine}@{version}',
      'error.noBridge': 'The Host HTTP route /api/routine-stabilization is unreachable, so the routine registry cannot be loaded.',
      'error.httpStatus': 'HTTP {status}',
      'error.unknown': 'Unknown error',
    }

    const zh = {
      'nav.label': '例程稳定化',
      'page.title': '例程稳定化',
      'page.subtitle': '带证据门禁、评估报告与路由日志的版本化例程。',
      'page.root': '注册表：{path}',
      'page.lastReport': '最近报告：{at}',
      'page.lastReportNever': '尚无报告',
      'state.loading': '正在加载注册表…',
      'state.loadingReport': '正在加载报告…',
      'state.errorTitle': '无法加载例程注册表',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.dismiss': '关闭',
      'action.seed': '写入示例',
      'action.seeding': '正在写入…',
      'action.evaluate': '评估',
      'action.evaluating': '评估中…',
      'action.release': '发布',
      'action.withdraw': '撤回',
      'action.confirmRelease': '确认发布',
      'action.cancel': '取消',
      'action.submitWithdraw': '确认撤回',
      'action.withdrawing': '正在撤回…',
      'empty.notSeeded.title': '尚无例程注册表',
      'empty.notSeeded.body': '写入示例会创建注册表文件与 normalize_detuning 候选版本。',
      'empty.noRoutines.title': '注册表中没有例程',
      'empty.noRoutines.body': '请刷新注册表；若为空可写入示例。',
      'notice.evaluating': '正在评估 {routine}@{version}…',
      'notice.evaluatePass': '{routine}@{version} 已通过全部门禁。',
      'notice.evaluateFail': '{routine}@{version} 未通过全部门禁。',
      'notice.released': '已发布 {routine}@{version}。',
      'notice.withdrawn': '已撤回 {routine}@{version}。',
      'notice.seeded': '已在 {path} 写入示例注册表。',
      'notice.actionFailed': '{action}失败：{message}',
      'registry.title': '注册表',
      'registry.hint': '共 {count} 个版本',
      'column.routine': '例程',
      'column.version': '版本',
      'column.status': '状态',
      'column.gates': '门禁摘要',
      'column.role': '角色',
      'column.actions': '操作',
      'status.candidate': '候选',
      'status.active': '生效',
      'status.withdrawn': '已撤回',
      'status.suspended': '已暂停',
      'status.superseded': '已被取代',
      'role.active': '生效',
      'role.fallback': '回退',
      'gates.coverage': '覆盖',
      'gates.silentUpper': '静默',
      'gates.challenge': '挑战',
      'gates.e2e': '端到端',
      'report.title': '最新报告',
      'report.pick': '选择一个版本查看其最新报告。',
      'report.none': '该版本尚未生成报告。运行「评估」即可生成。',
      'report.error': '无法加载报告',
      'report.metrics.coverage': '覆盖率',
      'report.metrics.silentErrors': '静默错误',
      'report.metrics.challengeFailures': '挑战失败数',
      'report.metrics.e2eSuccess': '端到端成功率',
      'report.silentHint': '95% 单侧上界 {bound}',
      'report.generatedAt': '生成时间',
      'report.cases': '用例',
      'report.casesValue': '{total} 条 · 自动 {automatic} · 延后 {deferred} · 回退 {fallback}',
      'report.accepted': '接受结果',
      'report.acceptedValue': '正确 {correct} · 错误 {wrong}',
      'report.evidence': '证据哈希',
      'report.evidenceCount': '{count} 个哈希',
      'report.reproducibility': '可复现性',
      'report.reportPath': '报告文件',
      'confirm.release.title': '发布 {routine}@{version}？',
      'confirm.release.body': '发布后该版本将成为例程的生效版本。这是用户动作，会记录到注册表。',
      'withdraw.title': '撤回 {routine}@{version}',
      'withdraw.body': '撤回后该版本不再被使用；必须填写理由，并会记录到注册表日志。',
      'withdraw.reasonLabel': '理由',
      'withdraw.reasonPlaceholder': '为什么要撤回该版本？',
      'withdraw.reasonRequired': '撤回前请填写理由。',
      'log.title': '路由日志',
      'log.hint': '最近 {count} 条决策',
      'log.loading': '正在加载路由日志…',
      'log.empty': '尚无路由决策记录。',
      'log.error': '无法读取路由日志',
      'log.column.at': '时间',
      'log.column.decision': '决策',
      'log.column.target': '例程',
      'log.column.field': '字段',
      'log.column.reason': '理由',
      'log.column.disposition': '处置',
      'log.decision.accept': '接受',
      'log.decision.defer': '延后',
      'log.decision.fallback': '回退',
      'log.target': '{routine}@{version}',
      'error.noBridge': 'Host HTTP 路由 /api/routine-stabilization 不可达，无法加载例程注册表。',
      'error.httpStatus': 'HTTP {status}',
      'error.unknown': '未知错误',
    }

    // ---------------------------------------------------------------------
    // Small pure helpers (no framework state, safe to share across mounts)
    // ---------------------------------------------------------------------

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function firstNumber(source, keys) {
      if (!isRecord(source)) return undefined
      for (let index = 0; index < keys.length; index += 1) {
        const value = source[keys[index]]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return undefined
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /** The Host `report` operation rejects when the version has no evaluation report yet. */
    function isMissingReportError(error) {
      return /no evaluation report/i.test(messageOf(error))
    }

    function stringOr(value) {
      if (typeof value === 'string' && value !== '') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return '—'
    }

    /** Read a version reference (`{ version }` object or a plain string). */
    function refVersion(ref) {
      if (typeof ref === 'string') return ref
      if (isRecord(ref) && typeof ref.version === 'string') return ref.version
      if (isRecord(ref) && typeof ref.id === 'string') return ref.id
      return null
    }

    function parseTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return 0
      const time = new Date(value).getTime()
      return Number.isFinite(time) ? time : 0
    }

    /** A routine's versions, newest first (stable for equal timestamps). */
    function versionList(rawVersions) {
      const list = Array.isArray(rawVersions) ? rawVersions.filter(isRecord) : []
      return list.slice().sort(function (left, right) {
        return parseTime(right.createdAt) - parseTime(left.createdAt)
      })
    }

    function versionStatus(version) {
      const raw = isRecord(version) && typeof version.status === 'string' ? version.status.toLowerCase() : ''
      if (
        raw === 'candidate' || raw === 'active' || raw === 'withdrawn' ||
        raw === 'suspended' || raw === 'superseded'
      ) return raw
      return 'candidate'
    }

    function finiteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    /**
     * Registry gate summary. The Host registry state carries no `gates` field on a
     * version: the summary is `version.lastReport.gatesSummary`
     * (`{ coverage, silentErrorUpperBound, challengeIncorrectAutomatic, e2eSuccess }`).
     * A flat `version.gates` object and the nested report shape are accepted too.
     */
    function readRegistryGates(version) {
      const gates = isRecord(version) && isRecord(version.gates) ? version.gates : {}
      const lastReport = isRecord(version) && isRecord(version.lastReport) ? version.lastReport : {}
      const summary = isRecord(lastReport.gatesSummary) ? lastReport.gatesSummary : {}
      const coverage = (isRecord(gates.coverage)
        ? firstNumber(gates.coverage, ['value', 'percent'])
        : finiteNumber(gates.coverage)) ?? finiteNumber(summary.coverage)
      const silentUpper = (isRecord(gates.silentError)
        ? firstNumber(gates.silentError, ['upperBound95', 'upperBound95Percent', 'upperBound'])
        : firstNumber(gates, ['silentErrorUpperBound', 'silentErrorUpper'])) ??
        firstNumber(summary, ['silentErrorUpperBound'])
      const challenge = (isRecord(gates.challenge)
        ? firstNumber(gates.challenge, ['incorrectAutomatic', 'failures', 'count'])
        : firstNumber(gates, ['challengeFailures', 'challengeFailureCount'])) ??
        firstNumber(summary, ['challengeIncorrectAutomatic', 'challengeFailures'])
      const e2e = (isRecord(gates.e2eSuccess)
        ? firstNumber(gates.e2eSuccess, ['value', 'percent'])
        : finiteNumber(gates.e2eSuccess)) ?? finiteNumber(summary.e2eSuccess)
      return {
        coverage: coverage,
        silentUpper: silentUpper,
        challenge: challenge,
        e2e: e2e,
      }
    }

    /**
     * Normalize the Host registry state. The Host reports `{ root, seeded,
     * routines, updatedAt }`; a version's last report date arrives as
     * `lastReport.at`, so derive the page-level timestamp from it.
     */
    function normalizeState(value) {
      const source = isRecord(value) ? value : {}
      const routines = Array.isArray(source.routines) ? source.routines.filter(isRecord) : []
      let lastReportAt = typeof source.lastReportAt === 'string' ? source.lastReportAt : null
      if (lastReportAt === null) {
        routines.forEach(function (routine) {
          const versions = Array.isArray(routine.versions) ? routine.versions : []
          versions.forEach(function (version) {
            const lastReport = isRecord(version) && isRecord(version.lastReport) ? version.lastReport : undefined
            const at = lastReport !== undefined && typeof lastReport.at === 'string' ? lastReport.at : undefined
            if (at === undefined) return
            if (lastReportAt === null || at > lastReportAt) lastReportAt = at
          })
        })
      }
      if (lastReportAt === null && typeof source.updatedAt === 'string') lastReportAt = source.updatedAt
      return {
        root: typeof source.root === 'string' ? source.root : '',
        seeded: source.seeded === true,
        routines: routines,
        lastReportAt: lastReportAt,
      }
    }

    /** Flatten the registry into one table row per routine version. */
    function flattenRows(data) {
      const rows = []
      const routines = isRecord(data) && Array.isArray(data.routines) ? data.routines : []
      routines.forEach(function (routine) {
        if (!isRecord(routine) || typeof routine.id !== 'string' || routine.id === '') return
        const activeLabel = refVersion(routine.active)
        const fallbackLabel = refVersion(routine.fallback)
        versionList(routine.versions).forEach(function (version, index) {
          const label = typeof version.version === 'string' ? version.version : null
          rows.push({
            key: routine.id + '\u0000' + (label === null ? '#' + String(index) : label),
            routineId: routine.id,
            routine: routine,
            version: version,
            label: label,
            status: versionStatus(version),
            gates: readRegistryGates(version),
            isActive: label !== null && activeLabel === label,
            isFallback: label !== null && fallbackLabel === label,
          })
        })
      })
      return rows
    }

    function defaultSelection(data) {
      const rows = flattenRows(data)
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index].isActive && rows[index].label !== null) {
          return { routine: rows[index].routineId, version: rows[index].label }
        }
      }
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index].label !== null) {
          return { routine: rows[index].routineId, version: rows[index].label }
        }
      }
      return null
    }

    // --- Number and date formatting -------------------------------------

    /** Accept a 0..1 ratio or an already-percent value; return percent or undefined. */
    function percentValue(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      return Math.abs(value) <= 1 ? value * 100 : value
    }

    function formatPercent(value, digits) {
      const percent = percentValue(value)
      if (percent === undefined) return '—'
      return percent.toFixed(digits === undefined ? 1 : digits) + '%'
    }

    function formatUpperBound(value) {
      const percent = percentValue(value)
      if (percent === undefined) return '—'
      return percent.toFixed(3) + '%'
    }

    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return String(Math.round(value))
    }

    function intlLocale(active) {
      if (typeof active !== 'string' || active === '') return undefined
      if (active === 'zh') return 'zh-CN'
      if (active === 'en') return 'en-US'
      return active
    }

    function formatDateTime(value, active) {
      if (typeof value !== 'string' && typeof value !== 'number') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString(intlLocale(active), {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch (error) {
        return date.toISOString()
      }
    }

    function compactValue(value) {
      if (value === null || value === undefined) return '—'
      if (typeof value === 'string') return value === '' ? '—' : value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) return value.map(compactValue).join(', ')
      if (isRecord(value)) {
        return Object.keys(value).map(function (key) {
          return key + '=' + compactValue(value[key])
        }).join(' · ')
      }
      return String(value)
    }

    function truncate(text, limit) {
      if (text.length <= limit) return text
      return text.slice(0, limit - 1) + '…'
    }

    // --- Report projection ----------------------------------------------

    function isMetricSet(value) {
      return isRecord(value) && (
        'total' in value || 'coverage' in value || 'silentErrors' in value ||
        'automatic' in value || 'e2eSuccess' in value || 'challengeIncorrectAutomatic' in value
      )
    }

    /**
     * Report metrics arrive either as one set object or as a set-name → stats map
     * (`{ dev, audit, challenge }`, as the Host computes them). Aggregate into one
     * summary; the per-set entries stay available for the detail rows.
     */
    function readReportMetrics(report) {
      const metrics = isRecord(report) && isRecord(report.metrics) ? report.metrics : {}
      let sets = []
      if (isMetricSet(metrics)) {
        sets = [{ name: '', stats: metrics }]
      } else {
        sets = Object.keys(metrics).filter(function (name) {
          return isMetricSet(metrics[name])
        }).map(function (name) {
          return { name: name, stats: metrics[name] }
        })
      }
      const summary = {
        total: 0,
        automatic: 0,
        deferred: 0,
        fallback: 0,
        acceptedCorrect: 0,
        acceptedWrong: 0,
        silentErrors: 0,
        incorrectAutomatic: 0,
        challengeIncorrectAutomatic: 0,
        e2eSuccessCount: 0,
        coverageWeighted: 0,
        coverageWeight: 0,
        e2eSuccessWeighted: 0,
        e2eSuccessWeight: 0,
      }
      const has = {
        total: false,
        accepted: false,
        silentErrors: false,
        challengeIncorrectAutomatic: false,
        e2eSuccessCount: false,
      }
      const sumKeys = [
        'automatic',
        'deferred',
        'fallback',
        'acceptedCorrect',
        'acceptedWrong',
        'silentErrors',
        'incorrectAutomatic',
        'challengeIncorrectAutomatic',
        'e2eSuccessCount',
      ]
      sets.forEach(function (entry) {
        const stats = entry.stats
        const total = firstNumber(stats, ['total'])
        if (total !== undefined) {
          summary.total += total
          has.total = true
        }
        sumKeys.forEach(function (key) {
          const value = firstNumber(stats, [key])
          if (value !== undefined) summary[key] += value
        })
        if (firstNumber(stats, ['acceptedCorrect', 'acceptedWrong']) !== undefined) has.accepted = true
        if (firstNumber(stats, ['silentErrors']) !== undefined) has.silentErrors = true
        if (firstNumber(stats, ['challengeIncorrectAutomatic']) !== undefined) has.challengeIncorrectAutomatic = true
        if (firstNumber(stats, ['e2eSuccessCount']) !== undefined) has.e2eSuccessCount = true
        // A set without a case count still contributes its rate with weight 1.
        const weight = total !== undefined && total > 0 ? total : 1
        const coverage = firstNumber(stats, ['coverage'])
        if (coverage !== undefined) {
          summary.coverageWeighted += coverage * weight
          summary.coverageWeight += weight
        }
        const e2e = firstNumber(stats, ['e2eSuccess'])
        if (e2e !== undefined) {
          summary.e2eSuccessWeighted += e2e * weight
          summary.e2eSuccessWeight += weight
        }
      })
      const coverage = summary.coverageWeight > 0
        ? summary.coverageWeighted / summary.coverageWeight
        : firstNumber(metrics, ['coverage'])
      let e2eSuccess
      if (has.e2eSuccessCount && summary.total > 0) e2eSuccess = summary.e2eSuccessCount / summary.total
      else if (summary.e2eSuccessWeight > 0) e2eSuccess = summary.e2eSuccessWeighted / summary.e2eSuccessWeight
      else e2eSuccess = firstNumber(metrics, ['e2eSuccess'])
      return {
        sets: sets,
        total: has.total ? summary.total : undefined,
        automatic: summary.automatic,
        deferred: summary.deferred,
        fallback: summary.fallback,
        acceptedCorrect: has.accepted ? summary.acceptedCorrect : undefined,
        acceptedWrong: has.accepted ? summary.acceptedWrong : undefined,
        silentErrors: has.silentErrors ? summary.silentErrors : undefined,
        incorrectAutomatic: summary.incorrectAutomatic,
        challengeIncorrectAutomatic: has.challengeIncorrectAutomatic ? summary.challengeIncorrectAutomatic : undefined,
        coverage: coverage,
        e2eSuccess: e2eSuccess,
      }
    }

    /**
     * Nested report gates from `engine.evaluateRoutine`:
     * `{ coverage:{value}, silentError:{wrong, upperBound95}, challenge:{incorrectAutomatic}, e2eSuccess:{value} }`.
     */
    function readReportGates(report) {
      const gates = isRecord(report) && isRecord(report.gates) ? report.gates : {}
      return {
        coverage: isRecord(gates.coverage)
          ? firstNumber(gates.coverage, ['value', 'percent'])
          : firstNumber(gates, ['coverage']),
        silentCount: isRecord(gates.silentError)
          ? firstNumber(gates.silentError, ['wrong', 'silentErrors', 'count'])
          : firstNumber(gates, ['silentErrors', 'silentErrorCount']),
        silentUpper: isRecord(gates.silentError)
          ? firstNumber(gates.silentError, ['upperBound95', 'upperBound95Percent', 'upperBound'])
          : firstNumber(gates, ['silentErrorUpperBound', 'silentErrorUpper']),
        challenge: isRecord(gates.challenge)
          ? firstNumber(gates.challenge, ['incorrectAutomatic', 'failures', 'count'])
          : firstNumber(gates, ['challengeFailures', 'challengeFailureCount']),
        e2e: isRecord(gates.e2eSuccess)
          ? firstNumber(gates.e2eSuccess, ['value', 'percent'])
          : firstNumber(gates, ['e2eSuccess', 'e2eSuccessRate']),
      }
    }

    /** Evidence hashes: explicit `evidenceHashes[]` first, then `evidence.{evidenceHash, fixtureHashes, hooks}`. */
    function readEvidence(report) {
      if (isRecord(report) && Array.isArray(report.evidenceHashes)) {
        const list = report.evidenceHashes.filter(function (entry) { return typeof entry === 'string' })
        if (list.length > 0) return { count: list.length, list: list }
      }
      const evidence = isRecord(report) && isRecord(report.evidence) ? report.evidence : {}
      const list = []
      if (typeof evidence.evidenceHash === 'string') list.push(evidence.evidenceHash)
      if (isRecord(evidence.fixtureHashes)) {
        Object.keys(evidence.fixtureHashes).forEach(function (key) {
          if (typeof evidence.fixtureHashes[key] === 'string') list.push(key + ': ' + evidence.fixtureHashes[key])
        })
      }
      if (isRecord(evidence.hooks)) {
        Object.keys(evidence.hooks).forEach(function (key) {
          const hook = evidence.hooks[key]
          if (isRecord(hook) && typeof hook.sha256 === 'string') list.push(key + ': ' + hook.sha256)
        })
      }
      return { count: list.length, list: list }
    }

    // ---------------------------------------------------------------------
    // Styles (injected once, removed with the plugin effect)
    // ---------------------------------------------------------------------

    const STYLES = [
      '.rs-root{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;padding-bottom:8px}',
      '.rs-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.rs-head__text{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.rs-title{margin:0;font-size:15px;font-weight:500;line-height:24px}',
      '.rs-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.rs-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rs-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.rs-button:disabled{opacity:.45;cursor:default}',
      '.rs-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.rs-button--primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}',
      '.rs-button--danger{color:var(--dsw-alias-state-error-primary)}',
      '.rs-button--small{height:26px;padding:0 10px;font-size:12px;line-height:18px;border-radius:7px}',
      '.rs-section{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.rs-section__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:4px}',
      '.rs-section__title{margin:0;font-size:13px;font-weight:500;line-height:20px}',
      '.rs-section__hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.rs-table-wrap{overflow-x:auto;border-top:0.5px solid var(--dsw-alias-border-l1)}',
      '.rs-table{min-width:860px}',
      '.rs-row,.rs-row--head{display:grid;grid-template-columns:minmax(150px,1.3fr) 96px 104px minmax(220px,1.9fr) 96px 196px;align-items:center;gap:12px;padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
      '.rs-row--head{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:8px 0}',
      '.rs-row{cursor:pointer}',
      '.rs-row--selected{background:var(--dsw-alias-bg-layer-1)}',
      '.rs-cell{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.rs-cell--actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow:visible}',
      '.rs-routine-id{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rs-version-button{margin:0;padding:0;border:none;background:none;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;font-variant-numeric:tabular-nums;font-weight:500}',
      '.rs-version-button:hover{color:var(--dsw-alias-brand-primary)}',
      '.rs-version-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:4px}',
      '.rs-gates{display:flex;flex-wrap:wrap;gap:4px 6px}',
      '.rs-gate{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.rs-gate__label{color:var(--dsw-alias-label-secondary)}',
      '.rs-gate__value{color:var(--dsw-alias-label-primary)}',
      '.rs-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rs-badge--active{color:var(--dsw-alias-state-success-primary)}',
      '.rs-badge--candidate{color:var(--dsw-alias-state-warn-primary)}',
      '.rs-badge--withdrawn{color:var(--dsw-alias-state-idle-primary)}',
      '.rs-badge--suspended{color:var(--dsw-alias-state-error-primary)}',
      '.rs-badge--superseded{color:var(--dsw-alias-label-secondary)}',
      '.rs-badge--fallback{color:var(--dsw-alias-state-warn-primary)}',
      '.rs-badge--accept{color:var(--dsw-alias-state-success-primary)}',
      '.rs-badge--defer{color:var(--dsw-alias-state-warn-primary)}',
      '.rs-badge--fallback-decision{color:var(--dsw-alias-state-idle-primary)}',
      '.rs-placeholder{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:20px 16px;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:10px}',
      '.rs-placeholder__title{font-size:14px;font-weight:500;line-height:22px}',
      '.rs-placeholder__body{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.rs-loading{display:flex;align-items:center;gap:8px;padding:16px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.rs-loading__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:rs-pulse 1.1s ease-in-out infinite}',
      '@keyframes rs-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.rs-notice{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px}',
      '.rs-notice--success{color:var(--dsw-alias-state-success-primary)}',
      '.rs-notice--error{color:var(--dsw-alias-state-error-primary)}',
      '.rs-notice--info{color:var(--dsw-alias-label-secondary)}',
      '.rs-notice__message{min-width:0;overflow-wrap:anywhere}',
      '.rs-notice__dismiss{border:none;background:none;padding:0;font:inherit;font-size:16px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rs-report{display:flex;flex-direction:column}',
      '.rs-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:0 24px}',
      '.rs-metric{min-width:0;padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
      '.rs-metric__label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.rs-metric__value{font-size:20px;line-height:28px;font-weight:500;font-variant-numeric:tabular-nums}',
      '.rs-metric__hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.rs-detail{display:flex;flex-direction:column}',
      '.rs-detail__row{display:flex;gap:12px;padding:8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px}',
      '.rs-detail__label{flex:0 0 132px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}',
      '.rs-detail__value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.rs-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.rs-panels{display:flex;flex-direction:column;gap:10px}',
      '.rs-panel{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.rs-panel__title{font-size:13px;font-weight:500;line-height:20px}',
      '.rs-panel__body{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.rs-panel__body--error{color:var(--dsw-alias-state-error-primary)}',
      '.rs-panel__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rs-field{display:flex;flex-direction:column;gap:6px;max-width:420px}',
      '.rs-field__label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.rs-input{height:30px;padding:0 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
      '.rs-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.rs-input--error{border-color:var(--dsw-alias-state-error-primary)}',
      '.rs-log__head,.rs-log__row{display:grid;grid-template-columns:148px 92px minmax(150px,1.1fr) minmax(90px,.6fr) minmax(200px,2.2fr) minmax(90px,.7fr);align-items:center;gap:12px;padding:8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
      '.rs-log__head{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
      '.rs-log__row{font-size:12px;line-height:18px}',
      '.rs-log__time{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.rs-log__reason{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rs-log-table{min-width:820px}',
      '.rs-caption{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '@media (hover:hover){.rs-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.rs-row:hover{background:var(--dsw-alias-bg-layer-2)}}',
      '@media (prefers-reduced-motion:reduce){.rs-loading__dot{animation:none;opacity:1}}',
    ].join('')

    /** Insert the plugin stylesheet; the returned disposer removes it. */
    function installStyles() {
      if (typeof document === 'undefined') return function () {}
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      const existing = document.querySelector(selector)
      if (existing !== null) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return function () {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
      }
    }

    // ---------------------------------------------------------------------
    // Host bridge — same-origin HTTP routes under /api/routine-stabilization
    // ---------------------------------------------------------------------

    function querySuffix(args) {
      const parts = []
      Object.keys(args).forEach(function (key) {
        const value = args[key]
        if (value === undefined || value === null) return
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return parts.length === 0 ? '' : '?' + parts.join('&')
    }

    /** Parse one response body as JSON; an empty or non-JSON body yields undefined. */
    async function readJsonBody(response) {
      const text = await response.text()
      if (text.trim() === '') return undefined
      try {
        return JSON.parse(text)
      } catch (error) {
        return undefined
      }
    }

    /**
     * Build the Host caller over the Host's authenticated HTTP routes.
     * @param t locale-bound translator for local failures.
     * @returns `{ call(method, args) }`, resolving to the Host `value`.
     */
    function createHostBridge(t) {
      return {
        async call(method, args) {
          const payload = isRecord(args) ? args : {}
          const isGet = GET_METHODS[method] === true
          const url = isGet
            ? HOST_BASE + '/' + method + querySuffix(payload)
            : HOST_BASE + '/' + method
          const headers = { accept: 'application/json' }
          const init = {
            method: isGet ? 'GET' : 'POST',
            headers: headers,
            credentials: 'same-origin',
          }
          if (!isGet) {
            headers['content-type'] = 'application/json'
            init.body = JSON.stringify(payload)
          }
          let response
          try {
            response = await fetch(url, init)
          } catch (error) {
            throw new Error(t('error.noBridge') + ' (' + messageOf(error) + ')')
          }
          const body = await readJsonBody(response)
          if (isRecord(body)) {
            if (body.ok === true) return body.value
            const failure = isRecord(body.error) ? body.error : undefined
            const message = failure !== undefined && typeof failure.message === 'string'
              ? failure.message
              : t('error.unknown')
            const error = new Error(message)
            if (failure !== undefined && typeof failure.code === 'string') error.code = failure.code
            throw error
          }
          if (!response.ok) throw new Error(t('error.httpStatus', { status: String(response.status) }))
          throw new Error(t('error.unknown'))
        },
      }
    }

    // ---------------------------------------------------------------------
    // Component factory (host bridge + active-locale reader injected)
    // ---------------------------------------------------------------------

    function createSectionComponent(host, getActiveLocale) {
      function identityT(key) { return key }

      function Section(props) {
        const t = typeof props.t === 'function'
          ? props.t
          : (typeof props.fallbackT === 'function' ? props.fallbackT : identityT)
        const locale = getActiveLocale()
        const registryTitleId = useId()
        const logTitleId = useId()
        const withdrawReasonId = useId()

        const [state, setState] = useState({ status: 'loading', data: null, error: null })
        const [log, setLog] = useState({ status: 'loading', items: [], error: null })
        const [report, setReport] = useState({ status: 'idle', data: null, error: null })
        const [selection, setSelection] = useState(null)
        const [reportNonce, setReportNonce] = useState(0)
        const [busy, setBusy] = useState(null)
        const [notice, setNotice] = useState(null)
        const [pendingRelease, setPendingRelease] = useState(null)
        const [pendingWithdraw, setPendingWithdraw] = useState(null)
        const [withdrawReason, setWithdrawReason] = useState('')
        const [withdrawError, setWithdrawError] = useState(false)

        const mountedRef = useRef(true)
        useEffect(function () {
          mountedRef.current = true
          return function () { mountedRef.current = false }
        }, [])

        const refreshState = useCallback(async function () {
          setState(function (previous) {
            return { status: previous.data === null ? 'loading' : previous.status, data: previous.data, error: null }
          })
          try {
            const value = await host.call('state', {})
            if (!mountedRef.current) return
            setState({ status: 'ready', data: normalizeState(value), error: null })
          } catch (error) {
            if (!mountedRef.current) return
            setState(function (previous) {
              return { status: 'error', data: previous.data, error: messageOf(error) }
            })
          }
        }, [])

        const refreshLog = useCallback(async function () {
          setLog(function (previous) {
            return { status: previous.items.length === 0 ? 'loading' : previous.status, items: previous.items, error: null }
          })
          try {
            const value = await host.call('log', { limit: 12 })
            if (!mountedRef.current) return
            setLog({ status: 'ready', items: Array.isArray(value) ? value.filter(isRecord) : [], error: null })
          } catch (error) {
            if (!mountedRef.current) return
            setLog(function (previous) {
              return { status: 'error', items: previous.items, error: messageOf(error) }
            })
          }
        }, [])

        useEffect(function () {
          void refreshState()
          void refreshLog()
        }, [refreshState, refreshLog])

        const data = state.data
        const rows = data === null ? [] : flattenRows(data)
        const rowCount = rows.length

        // Keep the report selection valid as the registry changes.
        useEffect(function () {
          if (data === null) return
          if (rowCount === 0) {
            if (selection !== null) setSelection(null)
            return
          }
          const exists = selection !== null && rows.some(function (row) {
            return row.routineId === selection.routine && row.label === selection.version
          })
          if (!exists) setSelection(defaultSelection(data))
        }, [data, rowCount, selection])

        const selectionKey = selection === null ? '' : selection.routine + '\u0000' + selection.version

        // Latest report of the selected version.
        useEffect(function () {
          if (selection === null) {
            setReport({ status: 'idle', data: null, error: null })
            return undefined
          }
          let cancelled = false
          const routine = selection.routine
          const version = selection.version
          setReport({ status: 'loading', data: null, error: null })
          host.call('report', { routine: routine, version: version }).then(function (value) {
            if (cancelled || !mountedRef.current) return
            setReport({ status: 'ready', data: isRecord(value) ? value : null, error: null })
          }).catch(function (error) {
            if (cancelled || !mountedRef.current) return
            // A version without a report is an empty state, not a failure.
            if (isMissingReportError(error)) setReport({ status: 'ready', data: null, error: null })
            else setReport({ status: 'error', data: null, error: messageOf(error) })
          })
          return function () {
            cancelled = true
          }
        }, [selectionKey, reportNonce])

        const selectedRow = selection === null ? null : (rows.find(function (row) {
          return row.routineId === selection.routine && row.label === selection.version
        }) || null)

        const disabled = busy !== null

        const selectRow = useCallback(function (row) {
          if (row.label === null) return
          setSelection({ routine: row.routineId, version: row.label })
        }, [])

        const dismissNotice = useCallback(function () { setNotice(null) }, [])

        const evaluate = useCallback(async function (row) {
          if (busy !== null || row.label === null) return
          setBusy({ kind: 'evaluate', key: row.key })
          setNotice({ kind: 'info', message: t('notice.evaluating', { routine: row.routineId, version: row.label }) })
          try {
            const value = await host.call('evaluate', { routine: row.routineId, version: row.label })
            if (!mountedRef.current) return
            // The Host operation reports `passed` (older shapes used `gatesPassed`).
            const passed = isRecord(value) && (value.passed === true || value.gatesPassed === true)
            const reportPath = isRecord(value) && typeof value.reportPath === 'string' ? value.reportPath : null
            let message = passed
              ? t('notice.evaluatePass', { routine: row.routineId, version: row.label })
              : t('notice.evaluateFail', { routine: row.routineId, version: row.label })
            if (reportPath !== null) message = message + ' · ' + reportPath
            setNotice({ kind: passed ? 'success' : 'error', message: message })
            if (isRecord(value) && isRecord(value.report)) {
              setReport({ status: 'ready', data: value.report, error: null })
            } else {
              // The Host evaluate result carries gates/metrics only; re-read the
              // written report so the detail panel always shows the stored copy.
              setReportNonce(function (nonce) { return nonce + 1 })
            }
            setSelection({ routine: row.routineId, version: row.label })
            await refreshState()
            await refreshLog()
          } catch (error) {
            if (!mountedRef.current) return
            setNotice({
              kind: 'error',
              message: t('notice.actionFailed', { action: t('action.evaluate'), message: messageOf(error) }),
            })
          } finally {
            if (mountedRef.current) setBusy(null)
          }
        }, [busy, refreshLog, refreshState, t])

        const requestRelease = useCallback(function (row) {
          if (row.label === null) return
          setPendingWithdraw(null)
          setWithdrawReason('')
          setWithdrawError(false)
          setPendingRelease({ key: row.key, routine: row.routineId, version: row.label })
          setNotice(null)
        }, [])

        const cancelRelease = useCallback(function () { setPendingRelease(null) }, [])

        const confirmRelease = useCallback(async function () {
          const target = pendingRelease
          if (busy !== null || target === null) return
          setPendingRelease(null)
          setBusy({ kind: 'release', key: target.key })
          try {
            await host.call('release', { routine: target.routine, version: target.version })
            if (!mountedRef.current) return
            setNotice({ kind: 'success', message: t('notice.released', { routine: target.routine, version: target.version }) })
            await refreshState()
            await refreshLog()
          } catch (error) {
            if (!mountedRef.current) return
            setNotice({
              kind: 'error',
              message: t('notice.actionFailed', { action: t('action.release'), message: messageOf(error) }),
            })
          } finally {
            if (mountedRef.current) setBusy(null)
          }
        }, [busy, pendingRelease, refreshLog, refreshState, t])

        const requestWithdraw = useCallback(function (row) {
          if (row.label === null) return
          setPendingRelease(null)
          setPendingWithdraw({ key: row.key, routine: row.routineId, version: row.label })
          setWithdrawReason('')
          setWithdrawError(false)
          setNotice(null)
        }, [])

        const cancelWithdraw = useCallback(function () {
          setPendingWithdraw(null)
          setWithdrawReason('')
          setWithdrawError(false)
        }, [])

        const confirmWithdraw = useCallback(async function () {
          const target = pendingWithdraw
          if (busy !== null || target === null) return
          const reason = withdrawReason.trim()
          if (reason === '') {
            setWithdrawError(true)
            return
          }
          setWithdrawError(false)
          setBusy({ kind: 'withdraw', key: target.key })
          try {
            await host.call('withdraw', { routine: target.routine, version: target.version, reason: reason })
            if (!mountedRef.current) return
            setPendingWithdraw(null)
            setWithdrawReason('')
            setNotice({ kind: 'success', message: t('notice.withdrawn', { routine: target.routine, version: target.version }) })
            await refreshState()
            await refreshLog()
          } catch (error) {
            if (!mountedRef.current) return
            setNotice({
              kind: 'error',
              message: t('notice.actionFailed', { action: t('action.withdraw'), message: messageOf(error) }),
            })
          } finally {
            if (mountedRef.current) setBusy(null)
          }
        }, [busy, pendingWithdraw, refreshLog, refreshState, t, withdrawReason])

        const seed = useCallback(async function () {
          if (busy !== null) return
          setBusy({ kind: 'seed' })
          try {
            const value = await host.call('seed', {})
            if (!mountedRef.current) return
            const root = isRecord(value) && typeof value.root === 'string' && value.root !== '' ? value.root : '—'
            setNotice({ kind: 'success', message: t('notice.seeded', { path: root }) })
            await refreshState()
            await refreshLog()
          } catch (error) {
            if (!mountedRef.current) return
            setNotice({
              kind: 'error',
              message: t('notice.actionFailed', { action: t('action.seed'), message: messageOf(error) }),
            })
          } finally {
            if (mountedRef.current) setBusy(null)
          }
        }, [busy, refreshLog, refreshState, t])

        const reload = useCallback(function () {
          void refreshState()
          void refreshLog()
        }, [refreshLog, refreshState])

        const retryReport = useCallback(function () { setReportNonce(function (value) { return value + 1 }) }, [])

        // --- rendering helpers -------------------------------------------

        function loadingBlock(label) {
          return h('div', { className: 'rs-loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
            h('span', { className: 'rs-loading__dot', 'aria-hidden': 'true' }),
            h('span', null, label)
          )
        }

        function errorBlock(title, message, onRetry) {
          return h('div', { className: 'rs-placeholder', role: 'alert' },
            h('div', { className: 'rs-placeholder__title' }, title),
            h('p', { className: 'rs-placeholder__body' }, message),
            h('button', { type: 'button', className: 'rs-button rs-button--small', onClick: onRetry, disabled: disabled },
              t('action.retry'))
          )
        }

        function inlineError(message, onRetry) {
          return h('div', { className: 'rs-notice rs-notice--error', role: 'alert' },
            h('span', { className: 'rs-notice__message' }, message),
            h('button', { type: 'button', className: 'rs-button rs-button--small', onClick: onRetry, disabled: disabled },
              t('action.retry'))
          )
        }

        function gateChip(label, value) {
          return h('span', { className: 'rs-gate' },
            h('span', { className: 'rs-gate__label' }, label),
            h('span', { className: 'rs-gate__value' }, value)
          )
        }

        function metricCell(label, value, hint) {
          return h('div', { className: 'rs-metric' },
            h('div', { className: 'rs-metric__label' }, label),
            h('div', { className: 'rs-metric__value' }, value),
            hint === null || hint === undefined ? null : h('div', { className: 'rs-metric__hint' }, hint)
          )
        }

        function detailRow(label, value, titleText) {
          return h('div', { className: 'rs-detail__row' },
            h('span', { className: 'rs-detail__label' }, label),
            h('span', { className: 'rs-detail__value', title: typeof titleText === 'string' ? titleText : undefined }, value)
          )
        }

        function headCell(label) {
          return h('div', { className: 'rs-cell', role: 'columnheader' }, label)
        }

        function emptyBlock() {
          const notSeeded = data !== null && data.seeded === false
          return h('div', { className: 'rs-placeholder' },
            h('div', { className: 'rs-placeholder__title' },
              notSeeded ? t('empty.notSeeded.title') : t('empty.noRoutines.title')),
            h('p', { className: 'rs-placeholder__body' },
              notSeeded ? t('empty.notSeeded.body') : t('empty.noRoutines.body')),
            notSeeded
              ? h('button', {
                type: 'button',
                className: 'rs-button rs-button--primary rs-button--small',
                onClick: seed,
                disabled: disabled,
              }, busy !== null && busy.kind === 'seed' ? t('action.seeding') : t('action.seed'))
              : h('button', { type: 'button', className: 'rs-button rs-button--small', onClick: reload, disabled: disabled },
                t('action.refresh'))
          )
        }

        function renderRow(row) {
          const selected = selection !== null &&
            selection.routine === row.routineId &&
            selection.version === row.label
          const gates = row.gates
          const silentUpper = formatUpperBound(gates.silentUpper)
          const silentUpperValue = silentUpper === '—' ? silentUpper : '≤' + silentUpper
          const canRelease = row.status !== 'active'
          const canWithdraw = row.status === 'active' || row.status === 'suspended'
          const evaluatingThis = busy !== null && busy.kind === 'evaluate' && busy.key === row.key
          return h('div', {
            key: row.key,
            className: 'rs-row' + (selected ? ' rs-row--selected' : ''),
            role: 'row',
            'aria-selected': selected,
            onClick: function () { selectRow(row) },
          },
            h('div', { className: 'rs-cell', role: 'cell' },
              h('div', null, typeof row.routine.title === 'string' && row.routine.title !== '' ? row.routine.title : row.routineId),
              h('div', { className: 'rs-routine-id', title: row.routineId }, row.routineId)
            ),
            h('div', { className: 'rs-cell', role: 'cell' },
              h('button', {
                type: 'button',
                className: 'rs-version-button',
                'aria-pressed': selected,
                onClick: function (event) { event.stopPropagation(); selectRow(row) },
              }, row.label === null ? '—' : row.label)
            ),
            h('div', { className: 'rs-cell', role: 'cell' },
              h('span', { className: 'rs-badge rs-badge--' + row.status }, t('status.' + row.status))
            ),
            h('div', { className: 'rs-cell rs-gates', role: 'cell' },
              gateChip(t('gates.coverage'), formatPercent(gates.coverage)),
              gateChip(t('gates.silentUpper'), silentUpperValue),
              gateChip(t('gates.challenge'), formatCount(gates.challenge)),
              gateChip(t('gates.e2e'), formatPercent(gates.e2e))
            ),
            h('div', { className: 'rs-cell rs-gates', role: 'cell' },
              row.isActive ? h('span', { className: 'rs-badge rs-badge--active' }, t('role.active')) : null,
              row.isFallback ? h('span', { className: 'rs-badge rs-badge--fallback' }, t('role.fallback')) : null,
              !row.isActive && !row.isFallback ? h('span', { className: 'rs-section__hint' }, '—') : null
            ),
            h('div', { className: 'rs-cell rs-cell--actions', role: 'cell' },
              h('button', {
                type: 'button',
                className: 'rs-button rs-button--small',
                disabled: disabled || row.label === null,
                onClick: function (event) { event.stopPropagation(); void evaluate(row) },
              }, evaluatingThis ? t('action.evaluating') : t('action.evaluate')),
              canRelease ? h('button', {
                type: 'button',
                className: 'rs-button rs-button--small',
                disabled: disabled || row.label === null,
                onClick: function (event) { event.stopPropagation(); requestRelease(row) },
              }, t('action.release')) : null,
              canWithdraw ? h('button', {
                type: 'button',
                className: 'rs-button rs-button--small rs-button--danger',
                disabled: disabled || row.label === null,
                onClick: function (event) { event.stopPropagation(); requestWithdraw(row) },
              }, t('action.withdraw')) : null
            )
          )
        }

        function renderRegistry() {
          return h('section', { className: 'rs-section', 'aria-labelledby': registryTitleId },
            h('div', { className: 'rs-section__head' },
              h('h3', { className: 'rs-section__title', id: registryTitleId }, t('registry.title')),
              h('span', { className: 'rs-section__hint' }, t('registry.hint', { count: rowCount }))
            ),
            rowCount === 0 ? emptyBlock() : h('div', { className: 'rs-table-wrap' },
              h('div', { className: 'rs-table', role: 'table' },
                h('div', { className: 'rs-row--head', role: 'row' },
                  headCell(t('column.routine')),
                  headCell(t('column.version')),
                  headCell(t('column.status')),
                  headCell(t('column.gates')),
                  headCell(t('column.role')),
                  headCell(t('column.actions'))
                ),
                rows.map(function (row) { return renderRow(row) })
              )
            )
          )
        }

        function renderReportBody() {
          if (selectedRow === null) {
            return h('p', { className: 'rs-placeholder__body' }, t('report.pick'))
          }
          if (report.status === 'loading') return loadingBlock(t('state.loadingReport'))
          if (report.status === 'error') {
            return errorBlock(t('report.error'), report.error, retryReport)
          }
          if (report.data === null) {
            const lastReportMeta = isRecord(selectedRow.version) && isRecord(selectedRow.version.lastReport)
              ? selectedRow.version.lastReport
              : {}
            const missingPath = typeof lastReportMeta.path === 'string' && lastReportMeta.path !== ''
              ? lastReportMeta.path
              : null
            return h(React.Fragment, null,
              h('p', { className: 'rs-placeholder__body' }, t('report.none')),
              missingPath === null ? null : h('p', { className: 'rs-placeholder__body rs-code' }, missingPath)
            )
          }
          const reportValue = report.data
          const aggregate = readReportMetrics(reportValue)
          const gates = readReportGates(reportValue)
          const evidence = readEvidence(reportValue)
          const coverage = gates.coverage !== undefined ? gates.coverage : aggregate.coverage
          const silentCount = gates.silentCount !== undefined ? gates.silentCount : aggregate.silentErrors
          const silentUpper = gates.silentUpper
          const challenge = gates.challenge !== undefined ? gates.challenge : aggregate.challengeIncorrectAutomatic
          const e2e = gates.e2e !== undefined ? gates.e2e : aggregate.e2eSuccess
          const generatedAt = typeof reportValue.generatedAt === 'string' ? reportValue.generatedAt : null
          const reportPath = typeof reportValue.reportPath === 'string' ? reportValue.reportPath : null
          const reproducibility = compactValue(reportValue.reproducibility)
          const evidenceTitle = evidence.list.length === 0 ? undefined : evidence.list.slice(0, 20).join('\n')
          const detailRows = [
            detailRow(t('report.generatedAt'), generatedAt === null ? '—' : formatDateTime(generatedAt, locale)),
            aggregate.total === undefined
              ? null
              : detailRow(t('report.cases'), t('report.casesValue', {
                total: formatCount(aggregate.total),
                automatic: formatCount(aggregate.automatic),
                deferred: formatCount(aggregate.deferred),
                fallback: formatCount(aggregate.fallback),
              })),
            aggregate.acceptedCorrect === undefined && aggregate.acceptedWrong === undefined
              ? null
              : detailRow(t('report.accepted'), t('report.acceptedValue', {
                correct: formatCount(aggregate.acceptedCorrect),
                wrong: formatCount(aggregate.acceptedWrong),
              })),
            detailRow(t('report.evidence'),
              evidence.count > 0 ? t('report.evidenceCount', { count: evidence.count }) : compactValue(reportValue.evidenceHashes),
              evidenceTitle),
            detailRow(t('report.reproducibility'), truncate(reproducibility, 160), reproducibility),
            reportPath === null ? null : detailRow(t('report.reportPath'), reportPath, reportPath),
          ].filter(function (item) { return item !== null })
          // One compact row per evaluation set when the Host reports several.
          const setRows = aggregate.sets.length > 1 ? aggregate.sets.map(function (entry) {
            const stats = entry.stats
            return detailRow(
              entry.name === '' ? '—' : entry.name,
              t('gates.coverage') + ' ' + formatPercent(firstNumber(stats, ['coverage'])) +
                ' · ' + t('gates.silentUpper') + ' ' + formatCount(firstNumber(stats, ['silentErrors'])) +
                ' · ' + t('gates.challenge') + ' ' + formatCount(firstNumber(stats, ['challengeIncorrectAutomatic'])) +
                ' · ' + t('gates.e2e') + ' ' + formatPercent(firstNumber(stats, ['e2eSuccess']))
            )
          }) : []
          return h('div', { className: 'rs-report' },
            h('div', { className: 'rs-metrics' },
              metricCell(t('report.metrics.coverage'), formatPercent(coverage), null),
              metricCell(
                t('report.metrics.silentErrors'),
                formatCount(silentCount),
                silentUpper === undefined ? null : t('report.silentHint', { bound: formatUpperBound(silentUpper) })
              ),
              metricCell(t('report.metrics.challengeFailures'), formatCount(challenge), null),
              metricCell(t('report.metrics.e2eSuccess'), formatPercent(e2e), null)
            ),
            h('div', { className: 'rs-detail' }, ...detailRows.concat(setRows))
          )
        }

        function renderReport() {
          return h('section', { className: 'rs-section' },
            h('div', { className: 'rs-section__head' },
              h('h3', { className: 'rs-section__title' }, t('report.title')),
              selectedRow === null ? null : h('span', { className: 'rs-section__hint' },
                selectedRow.routineId + '@' + (selectedRow.label === null ? '—' : selectedRow.label))
            ),
            renderReportBody()
          )
        }

        function renderPanels() {
          const panels = []
          if (pendingRelease !== null) {
            panels.push(h('section', {
              key: 'release',
              className: 'rs-panel',
              role: 'group',
              'aria-label': t('action.release'),
            },
              h('div', { className: 'rs-panel__title' },
                t('confirm.release.title', { routine: pendingRelease.routine, version: pendingRelease.version })),
              h('p', { className: 'rs-panel__body' }, t('confirm.release.body')),
              h('div', { className: 'rs-panel__actions' },
                h('button', {
                  type: 'button',
                  className: 'rs-button rs-button--primary rs-button--small',
                  disabled: disabled,
                  onClick: function () { void confirmRelease() },
                }, t('action.confirmRelease')),
                h('button', {
                  type: 'button',
                  className: 'rs-button rs-button--small',
                  disabled: disabled,
                  onClick: cancelRelease,
                }, t('action.cancel'))
              )
            ))
          }
          if (pendingWithdraw !== null) {
            panels.push(h('section', {
              key: 'withdraw',
              className: 'rs-panel',
              role: 'group',
              'aria-label': t('action.withdraw'),
            },
              h('div', { className: 'rs-panel__title' },
                t('withdraw.title', { routine: pendingWithdraw.routine, version: pendingWithdraw.version })),
              h('p', { className: 'rs-panel__body' }, t('withdraw.body')),
              h('div', { className: 'rs-field' },
                h('label', { className: 'rs-field__label', htmlFor: withdrawReasonId }, t('withdraw.reasonLabel')),
                h('input', {
                  id: withdrawReasonId,
                  className: 'rs-input' + (withdrawError ? ' rs-input--error' : ''),
                  type: 'text',
                  value: withdrawReason,
                  placeholder: t('withdraw.reasonPlaceholder'),
                  maxLength: 500,
                  autoFocus: true,
                  'aria-invalid': withdrawError,
                  'aria-describedby': withdrawError ? withdrawReasonId + '-error' : undefined,
                  onChange: function (event) {
                    setWithdrawReason(event.target.value)
                    if (withdrawError) setWithdrawError(false)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void confirmWithdraw()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelWithdraw()
                    }
                  },
                })
              ),
              withdrawError
                ? h('p', { className: 'rs-panel__body rs-panel__body--error', id: withdrawReasonId + '-error' },
                  t('withdraw.reasonRequired'))
                : null,
              h('div', { className: 'rs-panel__actions' },
                h('button', {
                  type: 'button',
                  className: 'rs-button rs-button--danger rs-button--small',
                  disabled: disabled || withdrawReason.trim() === '',
                  onClick: function () { void confirmWithdraw() },
                }, busy !== null && busy.kind === 'withdraw' ? t('action.withdrawing') : t('action.submitWithdraw')),
                h('button', {
                  type: 'button',
                  className: 'rs-button rs-button--small',
                  disabled: disabled,
                  onClick: cancelWithdraw,
                }, t('action.cancel'))
              )
            ))
          }
          if (panels.length === 0) return null
          return h('div', { className: 'rs-panels' }, panels)
        }

        function renderLogRow(entry, index) {
          const rawDecision = typeof entry.decision === 'string' ? entry.decision.toLowerCase() : ''
          const known = rawDecision === 'accept' || rawDecision === 'defer' || rawDecision === 'fallback'
          const decisionClass = known
            ? (rawDecision === 'fallback' ? 'rs-badge--fallback-decision' : 'rs-badge--' + rawDecision)
            : 'rs-badge--withdrawn'
          const decisionLabel = known ? t('log.decision.' + rawDecision) : stringOr(entry.decision)
          const reason = stringOr(entry.reason)
          return h('div', { key: 'log-' + String(index), className: 'rs-log__row', role: 'row' },
            h('span', { className: 'rs-log__time', role: 'cell' }, formatDateTime(entry.at, locale)),
            h('span', { role: 'cell' }, h('span', { className: 'rs-badge ' + decisionClass }, decisionLabel)),
            h('span', { className: 'rs-cell', role: 'cell' },
              t('log.target', { routine: stringOr(entry.routine), version: stringOr(entry.version) })),
            h('span', { className: 'rs-cell rs-code', role: 'cell' }, stringOr(entry.fieldId)),
            h('span', { className: 'rs-log__reason', role: 'cell', title: reason === '—' ? undefined : reason }, reason),
            h('span', { className: 'rs-cell', role: 'cell' }, stringOr(entry.disposition))
          )
        }

        function renderLogBody() {
          if (log.status === 'loading' && log.items.length === 0) return loadingBlock(t('log.loading'))
          if (log.status === 'error' && log.items.length === 0) {
            return errorBlock(t('log.error'), log.error, function () { void refreshLog() })
          }
          if (log.items.length === 0) return h('p', { className: 'rs-placeholder__body' }, t('log.empty'))
          const table = h('div', { className: 'rs-table-wrap' },
            h('div', { className: 'rs-log-table', role: 'table' },
              h('div', { className: 'rs-log__head', role: 'row' },
                h('span', { role: 'columnheader' }, t('log.column.at')),
                h('span', { role: 'columnheader' }, t('log.column.decision')),
                h('span', { role: 'columnheader' }, t('log.column.target')),
                h('span', { role: 'columnheader' }, t('log.column.field')),
                h('span', { role: 'columnheader' }, t('log.column.reason')),
                h('span', { role: 'columnheader' }, t('log.column.disposition'))
              ),
              log.items.map(function (entry, index) { return renderLogRow(entry, index) })
            )
          )
          const banner = log.status === 'error' ? inlineError(log.error, function () { void refreshLog() }) : null
          return h(React.Fragment, null, banner, table)
        }

        function renderLog() {
          return h('section', { className: 'rs-section', 'aria-labelledby': logTitleId },
            h('div', { className: 'rs-section__head' },
              h('h3', { className: 'rs-section__title', id: logTitleId }, t('log.title')),
              h('span', { className: 'rs-section__hint' }, t('log.hint', { count: log.items.length }))
            ),
            renderLogBody()
          )
        }

        // --- top-level composition ---------------------------------------

        const lastReport = data !== null && data.lastReportAt !== null
          ? formatDateTime(data.lastReportAt, locale)
          : null
        const root = data !== null && data.root !== '' ? data.root : null

        const header = h('div', { className: 'rs-head' },
          h('div', { className: 'rs-head__text' },
            h('h3', { className: 'rs-title' }, t('page.title')),
            h('p', { className: 'rs-subtitle' }, t('page.subtitle'))
          ),
          h('div', { className: 'rs-actions' },
            h('button', { type: 'button', className: 'rs-button', onClick: reload, disabled: disabled },
              t('action.refresh'))
          )
        )

        const noticeElement = notice === null ? null : h('div', {
          className: 'rs-notice rs-notice--' + notice.kind,
          role: notice.kind === 'error' ? 'alert' : 'status',
          'aria-live': 'polite',
        },
          h('span', { className: 'rs-notice__message' }, notice.message),
          h('button', {
            type: 'button',
            className: 'rs-notice__dismiss',
            onClick: dismissNotice,
            'aria-label': t('action.dismiss'),
          }, '\u00d7')
        )

        let body = null
        if (state.status === 'loading' && data === null) {
          body = loadingBlock(t('state.loading'))
        } else if (state.status === 'error' && data === null) {
          body = errorBlock(t('state.errorTitle'), state.error, reload)
        } else if (data === null) {
          body = loadingBlock(t('state.loading'))
        } else {
          body = h(React.Fragment, null,
            state.status === 'error' && state.error !== null ? inlineError(state.error, reload) : null,
            renderRegistry(),
            renderReport()
          )
        }

        const panels = renderPanels()
        const logSection = renderLog()
        const caption = root === null && lastReport === null ? null : h('div', { className: 'rs-caption' },
          root === null ? null : t('page.root', { path: root }),
          root === null || lastReport === null ? null : ' · ',
          lastReport === null ? t('page.lastReportNever') : t('page.lastReport', { at: lastReport })
        )

        return h('div', { className: 'rs-root' }, header, noticeElement, body, panels, logSection, caption)
      }

      return Section
    }

    /** Settings nav glyph; the shell wraps it in its own icon box. */
    function SectionIcon(props) {
      const size = typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
        h('path', { d: 'M1.5 8h3l1.5-4 3 8 1.5-4h3' }),
        h('circle', { cx: 8, cy: 8, r: 6.4, strokeOpacity: 0.35 })
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { en: en, zh: zh })
        }, 'routine-stabilization: dictionaries')

        ctx.effect(function () {
          return installStyles()
        }, 'routine-stabilization: styles')

        const t = ctx.locale.bind(NS)
        const host = createHostBridge(t)
        const getActiveLocale = function () {
          const snapshot = ctx.locale.getLocale()
          return isRecord(snapshot) && typeof snapshot.active === 'string' ? snapshot.active : undefined
        }
        const Section = createSectionComponent(host, getActiveLocale)

        ctx.slots.inject(SECTION_SLOT, function () {
          return ctx.slots.register({
            name: SECTION_SLOT,
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: function () { return t('nav.label') },
            locale: NS,
            inject: function () { return { fallbackT: t } },
          }, Section)
        })

        ctx.slots.inject(ICON_SLOT, function () {
          return ctx.slots.register({
            name: ICON_SLOT,
            id: SECTION_ID,
            locale: NS,
          }, SectionIcon)
        })
      },
    }
  },
})
