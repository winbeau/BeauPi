# 03 Task Ledger 与 Session Projection

状态：已完成。

## 目标

把 Dynamic Task snapshot 投影到唯一 `TaskLedgerSnapshot.todos`，并用结构化 Tool、修改、verification、Workflow、Background 和 Monitor 事实更新 activity/evidence。Runtime 不读取 assistant 普通文本或完整日志。

## 事实 schema

```typescript
interface DynamicTaskFactV1 {
  version: 1;
  sequence: number;
  id: string;
  kind: "tool" | "file" | "verification" | "workflow" | "background" | "monitor" | "failure";
  ref: string;
  status: string;
  summary: string;
  path?: string;
  createdAt: number;
}
```

事实 ID：

- Tool：`tool:<toolCallId>:started|success|failed|cancelled`。
- File：`file:<toolCallId>:<normalizedPath>`。
- Verification：`verify:<toolCallId>:passed|failed|cancelled`。
- Workflow：`workflow:<workflowId>:<nodeId>:<status>`。
- Background：`background:<taskId>:<status>`。
- Monitor：`monitor:<monitorId>:<status>`。

只保留稳定 ID、路径、状态、短摘要；不复制 Tool output、terminal log、Reviewer transcript 或完整 Monitor activity。

## 确定性更新

- Tool start：更新 activity；首次 mutation 可自动 pending→active。
- Edit/Write success：附加 file evidence，不自动 completed。
- Tool failure/cancel：附加 failure evidence；普通实现 Task不因一次失败自动终结。
- verification start：激活最匹配 verification Task。
- verification success/failure：只有明确匹配的 verification Task确定性 completed/failed。
- Workflow/Background/Monitor：按稳定 ID、Task title/matchHints 和现有结构化状态匹配；终态事实明确关联时更新状态，否则只更新 activity/evidence，交给 Reviewer辅助判断。
- 相同 fact ID重复到达不推进 revision，不重复 evidence。

## Task Ledger 投影

`TaskLedgerSnapshot` 增加可选 `dynamicTasks`，`TaskLedger.setDynamicTaskPlan()` 接受结构化 clone。

存在合法动态计划时：

- 每个 Dynamic Task 映射为 `TaskTodo`，`source: "dynamic-task"`。
- sequence 使用计划顺序；owner 为 `main`。
- completedAt/updatedAt/activity/blockedBy 来自 snapshot。
- 隐藏通用 `discover`、`execute`、`verify` Todo。
- 保留 Document required check/completion、Workflow、Background、Monitor、interaction、failure、duplicate advisory Todo。

无动态计划时保持 M2 现有 fallback Todo 完全不变。

## Session 与生命周期

- Dynamic Task snapshot/review custom entry 不进入 LLM context。
- AgentSession构造时 Runtime从当前 branch恢复并立即投影到 Ledger。
- tree navigation rebuild顺序：TaskLedger/Policy → Workflow cancel → Monitor → Background → Workflow → DynamicTaskRuntime → Ledger projection/prompt refresh。
- Compact期间 Runtime内存状态不回滚；resume从 custom entry恢复。
- reload不创建新 Runtime，只重新绑定当前 Tool registry并复验当前 branch。
- dispose先取消 Task review，再销毁 Background/Monitor/AgentPool。

## 文件范围

修改：

- `packages/coding-agent/src/core/state/task-ledger.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/monitor/monitor-runtime.ts` 仅使用现有 subscribe，不复制 Registry。
- Workflow/Background Runtime保持原状态源，仅在 AgentSession订阅处转发 snapshot/event。

## 失败回归

先修改/新增：

- `packages/coding-agent/test/dynamic-task-runtime.test.ts`
- `packages/coding-agent/test/task-ledger.test.ts`
- `packages/coding-agent/test/background-task-ledger.test.ts`
- `packages/coding-agent/test/suite/task-ledger-session.test.ts`
- `packages/coding-agent/test/suite/workflow-session.test.ts`
- `packages/coding-agent/test/suite/background-session.test.ts`

覆盖自动 active、确定性 evidence、verification关联、事实去重、动态/文档/Workflow/Background Todo共存及通用 fallback显示/隐藏。

## 完成条件

- TUI消费的全部 Dynamic Task来自 `TaskLedgerSnapshot.todos`。
- 事实只从结构化 Runtime/Tool事件进入，不解析文本日志。
- 自动更新不改变计划结构。
- branch/Compact/resume不会重复、回滚或合并废弃 branch事实。
