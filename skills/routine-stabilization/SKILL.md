---
name: routine-stabilization
description: 维护版本化 LLM routine：观察重复请求、propose 候选、跑 CI 证据门禁、shadow 验证；release/withdraw 由用户决定。评估或改动 routine 时使用。
whenToUse: 当任务要求把重复出现的请求/工具调用固化为可复用 routine、评估或回归某个 routine 版本、或排查 routine 运行时误判与 defer 原因时加载。
---

# Routine stabilization / 例程稳定化

面向 agent 的工作流：把重复出现的请求固化成**版本化、可验证、可回退**的 routine。先在 shadow 里证明，再由用户决定 release。

## 目录布局（默认 root：`$DSH_HOME/routine-registry`）

```
registry/registry.json      # 版本状态 candidate/active/superseded/withdrawn/suspended；active 与 fallback 指针
routines/<id>/<version>/    # manifest.json + guard.js + binding.js + execution.js
fixtures/<id>/<version>/    # {dev,audit,challenge}.json：{cases:[{id,input,expect:{decision,reason?,checks?}}]}
evals/<id>/<version>/       # 独立 reference check（exit 0 才算过）
reports/                    # 每次 evaluate/compare 报告 + release/withdraw decision 记录
logs/routes.jsonl           # 运行时逐次决策日志（自动轮转）
arms/                       # 配对 A/B/C 臂记录（shadow 成本对比）
```

**五组件**（按运行时顺序；manifest 是契约，其余四个环节串联执行）：

1. `manifest.json` — 元数据与契约：身份、`inputs.schema`、`admission.predicate`、`binding.entry`、`execution.entry`、`postconditions`、`errorPolicy`、`fallback`、`evidence`。
2. `binding.js` — 解析并绑定字段、单位与 provenance，导出 `bind(input) -> bound`；保留 `originalInput`。先解析再判断适用性：guard 的入场判断可以基于这里已解析的 field + candidates。
3. `guard.js` — admission guard / applicability，导出 `decide(input) -> {decision:'accept'|'defer', reason?, details?}`；只判断能否执行，不改值、不换算。
4. `execution.js` — 纯实现/换算，导出 `run(bound) -> {fieldId, sourceUnit, valueHz}`。
5. postconditions — 输出校验（`manifest.postconditions` 声明的已知 id + `outputSchema.requiredFields`），由 runtime 执行。

`routine_propose` 的 `files` 只接受 `guard.js`、`binding.js`、`execution.js`；manifest 必须用 `"guard.js#decide"`、`"binding.js#bind"`、`"execution.js#run"` 引用。

## 生命周期

### 1) 观察 observe

- 记录 recurring requests / tool calls / outcomes / failure reasons / costs。payload 最小化：存 trace ID、input hash、字段名与单位、错误码、耗时与成本，不存原始敏感值。
- 可固化条件：重复模式稳定、outcome 可判定、failure reason 可枚举、成本可测量；任一不满足就不 propose。
- 保留 source trace IDs，propose 时写入 `manifest.evidence.derivationTraces`，让结论可回溯。

### 2) 提议 propose

`routine_propose{id,version,manifest,files,fixtures,overwrite?}`

- `id` 小写 `[a-z0-9_.-]`；`version` 以数字开头；`manifest.id/version` 必须与参数一致；`schemaVersion: 1`。
- manifest 必填：`contractRevision`、`title`、`allowedEffects`（pilot 必须含 `read-only`）、三个 hook 指针、非空 `postconditions`（已知 id）、`errorPolicy{onCheckFailure:'discard-and-fallback',onUnavailable:'ask-user'}`、`fallback`、`evidence{fixtureSets:{dev,audit,challenge},evaluator,provenance,derivationTraces}`。
- 已 release 的版本不可覆盖；行为变化就发新版本号。`overwrite` 只对 candidate 有效。
- propose 返回 `{directory,fixtureSets,sourceTraces}`：核对 sourceTraces 与观察记录一致后，才能进入 evaluate。

### 3) CI evaluate

`routine_evaluate{routine,version,modelSnapshot?,codeRevision?,notes?}` — 写 `reports/`，记录 `reportSha256`。门禁（`passed=true` 才能提议 release）：

| gate | 条件 |
|---|---|
| contract | manifest 校验通过、hook 可加载、evidence 可解析、无 contractRevision drift |
| dev | total>0、silentErrors=0、deferred=0 |
| coverage | audit 自动接受数 / audit 总数 ≥ **60%** |
| silent error | audit silentErrors=**0** 且 one-sided 95% upper bound **<5%**；0/59 时上限 **4.95%**（由 `(1-p)^n=0.05` 得） |
| challenge | ≥**40** 条构造 near-miss，challengeIncorrectAutomatic=0 |
| referenceCheck | 独立 evaluator 退出码 0 |
| e2e success | audit end-to-end success > 0；pilot 用 `routine_compare` 要求不低于 A/B 基线 |

- 必须报分母：自动接受 n/总数、每类 deferral reason 直方图、逐 case 结果；禁止只报平均值。
- 门禁失败按「失败回归」修源文件后重跑；不得改 expect 迁就实现，不得放宽 gate。
- `routine_report{routine,version}` 读最近报告；报告与证据哈希是 release 的唯一凭据。

### 4) shadow

- candidate 保持 `candidate` 状态；候选输出对 incumbent 和 labeler 都不可见。
- blind 纪律：dev 只用于 derive/tune，冻结后不再改；audit **100** 条 blind；challenge **40** 条人工构造 near-miss。
- blind labels 放 workspace 之外的受保护位置；agent 只拿到 scoring 命令（如 `evals/<id>/<version>/` 下的 evaluator），只读分数/退出码，不读 label 文件，不把 candidate 输出回写成 label。
- 相关 paraphrase / 同源文件必须留在同一 partition：同源派生样本不得跨 dev/audit/challenge 拆分。
- 无真实数据时标 `evidence.provenance: "synthetic"`，保持 shadow，不得 release。
- `routine_compare{runId?,routine?,version?}` 比较 `arms/` 中 A（fresh agent）/B（手写）/C（trace-derived）的成功数、discordant 对与成本；`pilotDecision.advance` 要求 C 通过 gates、successRate 不低于 A/B、总成本低于两者。

### 5) release / withdraw

- **用户权威**：release 与 withdraw 只能由用户在 Web UI 的 Routine stabilization 面板执行；agent 没有该工具，禁止用 propose、改 `registry.json`、调 engine 或替用户确认来绕过。
- 提议 release 前：最新报告 `passed=true`，且 manifest、fixtures、hooks 的 sha256 与报告证据一致（改过任何文件都要重新 evaluate）。
- 自动停用条件：critical mismatch、schema drift（`approvedRelease.contractRevision` ≠ 当前 manifest）、postcondition 失败、audit silent error、challenge 错误自动接受 → 丢弃 provisional 结果、走 fallback（ask-user），并记录 decision。
- withdraw 记录 reason；若撤的是 fallback 版本则清空 fallback 指针。

## 运行时顺序

依据：framework 第 3 页 "Resolve the field and its provenance, check applicability, run the conversion, then validate the output"。guard 的入场判断基于已解析的 field + candidates；binding 抛出的 defer reason 词表与 guard 一致（`missing-metadata`、`invalid-value`、`unsupported-unit`、`metadata-conflict`、`competing-fields`）。

1. **resolve field + provenance → binding**（`binding.js#bind`）：字段身份来自显式 `fieldId` 或 `candidates`（`fieldId`+`role='detuning'`），单位来自 `declaredUnit.header/schema` 且两者一致，产出 bound。不能凭数值大小、单位相同或「看起来对」推断来源。
2. **admission guard**（`guard.js#decide`）：基于已解析的 field + candidates 检查 applicability，返回 accept 或 defer(reason)；defer 必须记录 reason 并 ask-user。
3. **execution**（`execution.js#run`）：纯换算/实现，输出 `outputSchema` 字段。
4. **postconditions**：逐项校验；任一失败 → `decision=fallback`，丢弃 provisional output。

- 缺元数据（`metadataSource`、`unit`、`declaredUnit`、`fieldId`）不要猜：defer(`missing-metadata`) + `ask_user_question`。
- 每条日志写入 `logs/routes.jsonl`：routine/version/registryStatus/contractRevision/route/decision/reason/disposition/fieldId/unit/inputHash/checks。
- 反例：drive frequency 与 detuning 单位同为 Hz、数值也合理，仍不能互换——字段来源只能由 binding 解析出的 fieldId/candidates provenance（并由 guard 复核）证明。

## 失败回归规则

- 绑定错列 → 修 `binding.js`，并在 dev/audit 加双列反例（同一输入同时含 drive 与 detuning 两列，expect 只接受 detuning）。
- 值对但换算错 → 修 `execution.js`，加单位往返反例（Hz/kHz/rad/s）；binding 不动。
- 两种合法方法得到同一结果 → 两种都保留在 outcome test 下，不删、不取平均，报告期望集合与各自得分。
- 每次修复后重新 `routine_evaluate`，报告须含修复前后的 case id 与分母。

## Reproducibility record（每份 evaluate/compare 报告必含）

- model snapshot（`modelSnapshot`）、prompt/tool versions（`promptVersions`/`toolVersions`）、environment、case-set hash（`caseSetHash`）、code revision（`codeRevision`）、engine name/version、node/platform/arch/cwd。
- 逐 case 结果：id、expected、decision、reason、correct、e2eSuccess、silentError、challengeIncorrectAutomatic、latencyMs。
- 证据哈希：manifestSha256、hook sha256、fixture sha256、evidenceHash、reportSha256。
- 成本：每请求成本、setup/maintenance、总成本，并带分母与 workload。
- reproducibility record 缺字段的报告不能作为 release 证据。

## 工具清单

| tool | 参数 | 用途 |
|---|---|---|
| `routine_status` | 无 | registry 版本、状态、active/fallback 指针、各版本最新 gate 摘要 |
| `routine_evaluate` | `routine,version`；可选 `modelSnapshot,codeRevision,notes` | 跑 dev/audit/challenge 并应用门禁，写 reports/ |
| `routine_run` | `routine,version,input` | 走运行时五组件流水线，返回 decision/reason/bound/output/checks |
| `routine_propose` | `id,version,manifest,files,fixtures`；可选 `overwrite` | 写入候选版本（release 版本不可覆盖） |
| `routine_report` | `routine,version` | 读最近评估报告（gates、分母、逐 case） |
| `routine_compare` | `runId?,routine?,version?` | 对比 A/B/C 臂成功率、discordant、成本与 pilotDecision |

没有 release/withdraw 工具——这是有意的权限边界。

## 反模式

- 用「应该没问题 / 理论上可以 / 数值看起来合理」代替 `routine_run`、`routine_evaluate` 的实际结果。
- agent 自行 release/withdraw（改 registry、调 engine、代用户确认都算）。
- 把 blind 标签写进 dev/训练集，或把 candidate 输出回灌成标签。
- 只报告平均值不报分母（n、自动接受数、defer 数）。
- 把 drive frequency 当 detuning（单位相同也不行）。
- 为了让 gate 变绿而改 expect、放宽门禁或删 case。
- 用 dev 调参后的结果冒充 audit 证据。
- 未记录 reproducibility 就宣称可复现或可发布。

## 完成定义

- 改动后：`node --check` 每个 hook 与脚本；`routine_evaluate` 实际执行并 `passed=true`；回复里写文件路径、命令与退出码。
- 未通过项与原因必须如实报告，不得用「应该没问题」收尾。
