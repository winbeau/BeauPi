# 06 Tests 与 Acceptance

状态：已完成。

## 目标

用 faux provider、fake Runtime和可控时钟完成 P1–P6 回归、恢复、并发、安全、usage和视觉验收；禁止真实付费 Provider。

## 测试文件

新增：

- `packages/coding-agent/test/dynamic-task-schema.test.ts`
- `packages/coding-agent/test/dynamic-task-runtime.test.ts`
- `packages/coding-agent/test/dynamic-task-tools.test.ts`
- `packages/coding-agent/test/review-model-resolver.test.ts`
- `packages/coding-agent/test/dynamic-task-reviewer.test.ts`
- `packages/coding-agent/test/suite/dynamic-task-session.test.ts`

修改：

- `packages/coding-agent/test/task-ledger.test.ts`
- `packages/coding-agent/test/task-ledger-widget.test.ts`
- `packages/coding-agent/test/footer-width.test.ts`
- `packages/coding-agent/test/output-reviewer.test.ts`
- `packages/coding-agent/test/settings-manager.test.ts`
- `packages/coding-agent/test/agent-session-stats.test.ts`
- `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts`
- `packages/coding-agent/test/suite/task-ledger-session.test.ts`
- `packages/coding-agent/test/suite/workflow-session.test.ts`
- `packages/coding-agent/test/suite/background-session.test.ts`
- AgentPool边界相关测试。

## P1 Schema 与 State

- strict schema、额外字段、未知版本。
- 重复 ID、非法 ID、非法状态、未知/自依赖、依赖环。
- 计划/字符串/fact/evidence/blocker预算。
- create r1、连续 CAS、真实结构过期/并发 update、空更新，以及 sudo、Tool、evidence、Workflow、Background、Monitor 或 Reviewer 状态造成 revision 漂移时的 branch-local三方安全重基。
- main结构更新与 Reviewer patch权限隔离。
- duplicate fact/review event去重。
- malformed/gap/regression snapshot恢复。

## P2 Tool 与 Trigger

- `initial_plan`、`work_started`、`plan_changed`、`blocked`。
- Tool result snapshot/revision/diagnostics。
- Tool name/description/snippet/guideline/renderer进入动态 registry。
- Coordinator可用，受控子 Agent/Profile/custom allowlist仍不可用。
- 可执行 prompt首次现有 Provider请求要求计划，Provider call count不增加。
- 纯问答/闲聊不产生 snapshot或 Dynamic Todo。

## P3 Facts 与 Ledger

- 首次 Edit、Write、mutation Bash自动 active且原 Tool继续执行。
- read-only Bash/Read/Search不触发 active。
- file modification evidence、Tool failure/cancel evidence。
- verification start/pass/fail与明确 Task关联。
- Workflow、Background、Monitor结构化事实与event ID去重。
- Dynamic Task与Document required checks、Workflow、Background、interaction、failure共存。
- 存在计划时只隐藏通用 discover/execute/verify；无计划恢复 fallback。

## P4 Reviewer

- bare `review.model`当前 provider优先与已配置 provider fallback。
- provider-qualified不跨 provider。
- valid patch、malformed JSON/schema、未知 Task/evidence、重复 patch、结构字段拒绝。
- timeout、provider failure、fallback、abort、dispose。
- expectedRevision过期、并发 main update、整组原子丢弃。
- completed Task默认不能重开。
- facts hash相同、无新 facts、预算不满足严格零模型调用。
- 每主 Agent run最多一次、最小间隔、输入/输出字符和wall-clock上限。
- usage只记录一次并进入 stats/Footer/breakdown。

## P5 Prompt 与 TUI

- 每次 Provider请求收到当前紧凑 snapshot/revision。
- 不接收 Reviewer对话、完整事实历史或日志。
- 只有 blocked/conflict/replan进入 nextTurn。
- Tasks Widget和Footer显示计划进度/attention。
- Tool renderer只消费 details。
- 暗色/亮色 × 40/80/120/160：每行 `visibleWidth <= width`，Footer最多三行。

## P6 生命周期与端到端

Faux scenario：

```text
executable user prompt
  -> first-turn tasks_update(initial_plan)
  -> discovery
  -> first Write/Edit activates Task
  -> verification terminal fact
  -> one bounded Reviewer patch
  -> Task Ledger/TUI refresh
  -> Compact
  -> branch away/back
  -> resume
  -> dispose/abort
```

断言：

- revision单调、无重复 snapshot/evidence/review usage。
- abandoned branch不污染current branch。
- Compact/resume不回滚或重复。
- Reviewer失败不改变主任务终态。
- 普通进度不增加主对话消息。
- Session dispose无后续 Review写入。

## 执行命令

1. 从 package root运行每个新增/修改测试文件的定向 Vitest命令。
2. 运行全部 Task Ledger、AgentSession、Workflow、Background、settings、reviewer相关测试。
3. 从仓库根运行 `./test.sh`。
4. 从仓库根运行 `npm run check`，修复全部 error、warning和info。
5. 展示 `git diff --check`、最终 diff统计和 `git status --short`。

不运行真实 Provider、不运行完整直接 Vitest suite、不提交或推送。

## 文档验收

实现后更新：

- `docs/beaupi/architecture.md`
- `docs/beaupi/requirements.md`
- `docs/beaupi/milestones.md`
- `docs/beaupi/roadmap.md`
- `docs/beaupi/ui-style.md`
- M14主计划和六个子计划状态
- `packages/coding-agent/docs/settings.md` 仅说明Task Reviewer复用现有 `review.model`

`packages/coding-agent/CHANGELOG.md` 受 `CONTRIBUTING.md` 的禁止编辑规则约束，只有用户再次明确覆盖该 contributor gate后才修改。

## 完成条件

- 定向测试、相关测试、`./test.sh`、`npm run check`全部通过。
- 文档与实现一致。
- 最终 diff无意外文件、无模型目录修改、无专属 Review settings、无 `models.generated.ts` 修改。
