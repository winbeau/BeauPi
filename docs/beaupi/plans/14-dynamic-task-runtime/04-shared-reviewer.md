# 04 Shared Reviewer

状态：已完成。

## 目标

建立无 Tool、无文件权限、无主 Agent完整上下文的 Task Reviewer。Terminal 与 Task Reviewer 共用 `settings.json` 的 `review.model`、同一 `ReviewModelResolver`、ModelRuntime鉴权和 provider fallback；Task Reviewer不复用 Terminal 的日志路径协议。

## 通用模型解析

新增 `packages/coding-agent/src/core/review/model-resolver.ts`：

- provider-qualified `provider/model`：只使用指定 provider，要求 model存在且 auth已配置。
- bare model ID：当前 Agent provider优先；若未配置则跳过，随后按模型目录顺序使用其他已配置 provider。
- 不调用网络刷新，不维护第二份模型目录，不增加功能专属 settings key。
- `DEFAULT_REVIEW_MODEL` 只定义在共享 Settings 默认值，不在 Task Reviewer写死。
- 提供 model label 和 Usage合并 helper。

`LunaTerminalOutputReviewer` 改为消费该 resolver，保留 Terminal 专属内容裁剪和强制 `@logPath`。

## Reviewer 输入与输出

输入仅包含：

- 当前 Task snapshot 的紧凑 review view。
- `expectedRevision`。
- 上次 review hash。
- `throughFactSequence` 之后新增的有界结构化 facts。
- trigger 类型。

不包含：

- 主 Agent消息历史、thinking、Tool output、完整日志、文件内容、Session transcript。
- Tool definitions或修改文件能力。

输出严格为单个 `<task_patch>...</task_patch>`：

```typescript
interface TaskPatchV1 {
  version: 1;
  expectedRevision: number;
  factsHash: string;
  updates: Array<{
    id: string;
    status?: DynamicTaskStatus;
    activity?: string;
    evidence?: string[];
    blockedBy?: string[];
  }>;
}
```

拒绝额外字段、未知/重复 Task ID、未知 evidence、结构字段、completed重开和 revision/hash不匹配。整组 patch原子应用，不部分接受。

## 触发与预算

第一版固定 Runtime预算，不增加 settings：

- 每个主 Agent run最多一次。
- 仅在 agent settled且存在新事实时调用；mutation batch、verification终态、关键 failure/blocker只设置 eligible trigger。
- 最小间隔 15 秒。
- 输入最多 16,000 字符。
- 输出响应最多 16,000 字符；不向 Provider设置功能专属 `maxTokens`。
- 整个 provider fallback链 wall-clock timeout 20 秒。
- facts hash未变化时在模型解析前直接返回 skipped，零调用。

用户 abort、Session dispose和branch navigation终止待执行 Review。Review失败不改变主任务终态。

## Review 流程

1. Runtime在串行区读取 revision、新 facts、hash和预算。
2. 无新 facts/hash相同/预算不允许 => 不调用模型。
3. 在锁外执行 direct `ModelRuntime.completeSimple()`，`cacheRetention: "none"`，无 Tools。
4. provider failure、malformed或不可用 stop reason尝试下一个已配置 candidate。
5. 汇总所有有 Usage 的 attempt。
6. 在串行区重新检查 expectedRevision。
7. valid + revision一致 => 原子应用状态 patch并推进 revision。
8. conflict/timeout/abort/malformed/provider failure => 不修改计划。
9. append `beaupi.dynamic-task.review` 记录 hash、fact sequence、status、model、usage和有界诊断；用于零重复调用和 usage统计。

## 主 Agent通知

- 普通 completed/activity/evidence 更新只刷新 Ledger/TUI。
- Reviewer产生 blocked状态或 Reviewer CAS冲突时，通过 AgentSession `nextTurn` 投影一条有界结构化提醒。
- Reviewer不直接调用、委派或与主 Agent对话。

## Usage

动态 Review custom entry 的 `usage` 进入：

- `AgentSession.getSessionStats()`。
- Footer累计 usage/cost。
- `getUsageCostBreakdown()` 的 `Reviews` bucket。

同一 usage只记录一次，不复制到后续 snapshot。

## 文件范围

新增：

- `packages/coding-agent/src/core/review/model-resolver.ts`
- `packages/coding-agent/src/core/review/index.ts`
- `packages/coding-agent/src/core/tasks/task-reviewer.ts`

修改：

- `packages/coding-agent/src/core/remote/output-reviewer.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/usage-totals.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`

## 失败回归

先新增/修改：

- `packages/coding-agent/test/review-model-resolver.test.ts`
- `packages/coding-agent/test/dynamic-task-reviewer.test.ts`
- `packages/coding-agent/test/output-reviewer.test.ts`
- `packages/coding-agent/test/agent-session-stats.test.ts`
- `packages/coding-agent/test/suite/dynamic-task-session.test.ts`

覆盖 valid、malformed、timeout、provider fallback/failure、abort、无变化零调用、usage去重、过期 revision和 completed不可重开。

## 完成条件

- Task Reviewer与 Terminal使用相同 `review.model`解析链。
- 无新增 facts严格零模型调用。
- 任何失败或冲突均不修改 Dynamic Task计划。
- Reviewer没有 Tool、主 Agent transcript或文件写权限。
