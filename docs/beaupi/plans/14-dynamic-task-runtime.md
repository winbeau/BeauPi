# M14 动态 Task Runtime 实施计划

状态：已完成。

## 阶段概览

M14 在现有 `AgentSession`、`SessionManager`、`TaskLedger`、Tool registry、`ModelRuntime`、Monitor、Workflow、Background 和 BeauPi TUI 上增加动态任务闭环。主 Agent 通过 Coordinator-only `tasks_update` 编写 Task 结构；唯一的 `DynamicTaskRuntime` 维护 branch-local revision/CAS、确定性事实、Session 恢复和 Reviewer 状态 patch。不存在第二套 Agent、Session、ResourceLoader、Task Ledger 或输入循环。

实施固定按 P1→P6 连续推进：

1. P1：Schema、状态机、revision/CAS 和 Session persistence。
2. P2：`tasks_update` Tool、系统提示词和可执行用户任务触发。
3. P3：mutation/verification/failure/Workflow/Background/Monitor facts 与 Task Ledger 投影。
4. P4：共享 `review.model` 的受限 Task Reviewer。
5. P5：主 Agent prompt projection、受限 follow-up 和 TUI。
6. P6：Compact/resume/branch/dispose、并发、安全和完整验收。

## 里程碑实施摘要

| 阶段 | 主要交付 | 稳定结果 |
|---|---|---|
| P1 | 版本化计划、严格校验、单调 revision、CAS、snapshot/review custom entry | 当前 branch 的 Task 状态可恢复且不会被过期更新覆盖 |
| P2 | Coordinator-only `tasks_update`、动态 registry、initial-plan 提示 | 首次现有模型回合可创建计划，无额外预规划请求 |
| P3 | 自动动工、结构化 facts/evidence、Task Ledger Todo 投影 | 修改不被阻断，动态 Task 与 Document/Workflow/Background 共存 |
| P4 | 通用 Review 模型解析、受限 Reviewer、预算与 usage | facts hash 不变零调用，失败/超时/冲突不修改 Task 状态 |
| P5 | 每次 Provider 请求的紧凑快照、必要 reminder/follow-up、Widget/Footer | 主 Agent 感知当前 revision，普通进度不污染主对话 |
| P6 | 恢复、分支、并发、主题/宽度与完整测试 | M14 验收矩阵、`./test.sh`、`npm run check` 全部通过 |

## 稳定接口

```typescript
interface DynamicTaskPlanV1 {
  version: 1;
  planId: string;
  revision: number;
  goal: string;
  createdAt: number;
  updatedAt: number;
  factSequence: number;
  tasks: DynamicTaskItemV1[];
  facts: DynamicTaskFactV1[];
}

interface DynamicTaskItemV1 {
  id: string;
  title: string;
  status: "pending" | "active" | "completed" | "failed" | "blocked";
  dependsOn: string[];
  matchHints: string[];
  activity?: string;
  evidence: string[];
  blockedBy: string[];
}

interface TaskPatchV1 {
  version: 1;
  expectedRevision: number;
  factsHash: string;
  updates: Array<{
    id: string;
    status?: DynamicTaskItemV1["status"];
    activity?: string;
    evidence?: string[];
    blockedBy?: string[];
  }>;
}
```

稳定 Runtime 边界：

- `DynamicTaskRuntime.updatePlan()`：主 Agent 唯一结构写入口；精确 revision直接 CAS，facts-only stale revision使用 branch-local snapshot三方重基，真实结构并发仍返回 conflict。
- `DynamicTaskRuntime.noteToolStarted()/noteToolFinished()`：修改、验证与失败事实入口。
- `DynamicTaskRuntime.noteWorkflow()/noteBackground()/noteMonitor()`：现有 Runtime 结构化事实入口。
- `DynamicTaskRuntime.rebuild()`：只从 `SessionManager.getBranch()` 恢复。
- `DynamicTaskRuntime.getPromptProjection()`：每次 Provider 请求前生成有界当前快照。
- `DynamicTaskRuntime.reviewAfterSettled()`：每个主 Agent run 最多一次受预算 Review。
- `TaskLedger.setDynamicTaskPlan()`：只接收结构化投影，不反向驱动 Runtime。
- `ReviewModelResolver`：Terminal 与 Task Reviewer 共用 `review.model`、当前 provider 优先和已配置 provider fallback。

## 依赖关系

```text
P1 ──> P2 ──> P3 ──> P4 ──> P5 ──> P6
 │      │      │      │      │
 │      │      │      │      └─ Tasks Widget / Footer / prompt projection
 │      │      │      └─ ModelRuntime / settings.review.model / usage
 │      │      └─ TaskLedger / Policy classifier / Workflow / Background / Monitor
 │      └─ AgentSession / Tool registry / AgentPool exclusion
 └─ SessionManager custom entry / TypeBox / revision queue
```

P4 不依赖 Terminal 的 `@日志路径` 协议，只复用通用模型解析；P5 不从 assistant 文本、Reviewer 对话或日志反推状态。

## 子计划索引

- [01 Contract 与 State](./14-dynamic-task-runtime/01-contract-and-state.md)
- [02 Tool 与 Agent Triggers](./14-dynamic-task-runtime/02-tool-and-agent-triggers.md)
- [03 Task Ledger 与 Session Projection](./14-dynamic-task-runtime/03-task-ledger-session-projection.md)
- [04 Shared Reviewer](./14-dynamic-task-runtime/04-shared-reviewer.md)
- [05 TUI 与 Prompt Projection](./14-dynamic-task-runtime/05-tui-and-prompt-projection.md)
- [06 Tests 与 Acceptance](./14-dynamic-task-runtime/06-tests-and-acceptance.md)

## 实时状态

- [x] 完整读取 M14、Roadmap、Requirements、Architecture、UI、Settings 与核心 Session/Ledger/Reviewer 代码
- [x] 审计 Tool registry、AgentPool、Policy mutation classifier、Workflow/Background/Monitor 与 faux harness
- [x] 建立主计划与六个子计划
- [x] P1 Contract 与 State
- [x] P2 Tool 与 Agent Triggers
- [x] P3 Task Ledger 与 Session Projection
- [x] P4 Shared Reviewer
- [x] P5 TUI 与 Prompt Projection
- [x] P6 Tests 与 Acceptance
