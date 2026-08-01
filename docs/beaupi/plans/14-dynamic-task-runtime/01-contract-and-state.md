# 01 Contract 与 State

状态：已完成。

## 目标

建立唯一 `DynamicTaskRuntime` 的版本化数据契约、严格校验、状态机、branch-local revision/CAS、事实去重和 Session persistence。Runtime 是主 Agent 与 Reviewer 的唯一共享状态，Task Ledger 只消费快照。

## Schema

新增 `packages/coding-agent/src/core/tasks/`：

- `types.ts`：`DynamicTaskPlanV1`、`DynamicTaskItemV1`、`DynamicTaskFactV1`、`TaskPatchV1`、Tool/review details。
- `schema.ts`：全部 TypeBox object 使用 `additionalProperties: false`，使用 `Compile()` 校验。
- `dynamic-task-runtime.ts`：状态机、串行写队列、CAS、snapshot/review entry、事实与订阅。
- `index.ts`：稳定公开导出。

第一版上限：

- 最多 16 个 Task，建议主 Agent 保持 3–7 个。
- ID 使用安全 ASCII，最多 64 字符；title 240；goal 1,000；activity 500。
- 每个 Task 最多 16 个依赖、12 个 match hint、32 个 evidence、8 个 blocker。
- Runtime 保留最多 128 条有界事实；事实只保存稳定 ID/ref、状态、短摘要和必要路径。
- 拒绝额外字段、重复 ID、未知/自依赖、依赖环、未知 evidence、重复 patch、非法状态和总字符预算超限。

## 状态机

计划：

```text
absent
  └─ tasks_update(reason=initial_plan, expectedRevision=0) -> revision 1

active plan
  ├─ main full-plan CAS          -> revision +1
  ├─ deterministic fact/active  -> revision +1
  └─ reviewer state patch CAS   -> revision +1
```

Task：

```text
pending -> active -> completed
   │         ├----> failed
   │         └----> blocked
   ├--------------> failed
   └--------------> blocked

failed/blocked -> active        主 Agent或 Reviewer在有新证据时
completed -> active/pending     仅主 Agent可重开
```

约束：

- 主 Agent 可以增删、重命名、重排、修改依赖和重开 completed Task。
- 自动转换不能改变 Task 数量、ID、title、顺序、依赖或 match hints。
- Reviewer 不能重开 completed Task；其 patch 只能修改 status/activity/evidence/blockedBy。
- Reviewer 将 Task 标记 completed 时必须引用当前计划中已有的新事实 evidence。
- Edit/Write 成功只增加修改 evidence，不自动完成整个功能 Task。
- 明确关联的 verification 成功可以完成 verification Task；失败可以标记该验证 Task failed。

## Revision 与 CAS

- revision 从 0（无计划）开始，当前 branch 上每个接受的计划快照严格 `+1`。
- 所有写操作进入一个 Promise 串行队列；CAS 比较必须在队列内部执行。
- `tasks_update` 在 `expectedRevision` 落后时读取该 revision 的 branch-local snapshot做三方重基；若中间只新增 Tool、sudo、evidence、Workflow、Background、Monitor 或 Reviewer 状态事实，则保留当前 status/activity/evidence/blockedBy 并应用主 Agent显式变化，不返回冲突。
- 只有 goal、Task ID/顺序、title、dependsOn 或 matchHints 等结构在基准后被另一结构更新改变，或基准 snapshot不可用时，才返回 `{ status: "revision_conflict", expectedRevision, actualRevision, snapshot, diagnostics }`，不修改状态。
- validation failure、重复 fact ID、空 patch、时间戳差异和无意义重基不推进 revision。
- 主 Agent full-plan 更新保留同 ID Task 的确定性 evidence；新 Task evidence 为空，删除 Task 不删除全局事实池。

## Session persistence

Custom entry：

- `beaupi.dynamic-task.snapshot`：完整已验证快照。
- `beaupi.dynamic-task.review`：Review attempt/result、throughFactSequence、factsHash、usage 和有界诊断；不属于 Task 状态 revision。

恢复规则：

1. 只扫描 `SessionManager.getBranch()`。
2. 忽略未知版本、malformed entry、revision 回退、重复 revision 不同内容和 revision gap。
3. 相同 revision/内容的重复 snapshot 去重。
4. Compact 不复制 Task 状态；custom entry 仍保留在 branch。
5. tree navigation 后调用 `rebuild(targetBranch)`；废弃 branch 的 snapshot/review 不合并。
6. reload 复验当前 branch；resume 从当前 branch 最新合法 snapshot 恢复。
7. dispose 终止 review 和后续写入。

## 文件范围

新增：

- `packages/coding-agent/src/core/tasks/types.ts`
- `packages/coding-agent/src/core/tasks/schema.ts`
- `packages/coding-agent/src/core/tasks/dynamic-task-runtime.ts`
- `packages/coding-agent/src/core/tasks/index.ts`

修改：

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/session-manager.ts` 仅在确需共享 usage parser 类型时修改；不改变树结构。

## 失败回归

先新增：

- `packages/coding-agent/test/dynamic-task-schema.test.ts`
- `packages/coding-agent/test/dynamic-task-runtime.test.ts`

覆盖严格 schema、重复 ID、状态、依赖、环、计划大小、revision CAS、并发更新、过期 patch、事件去重、malformed restore 和 branch-only restore。

## 完成条件

- 所有结构与状态写入只有一个 Runtime。
- revision/CAS 在并发和恢复路径均单调、无静默覆盖。
- custom entry 不进入主模型上下文。
- P1 定向测试通过，后续 Tool/Reviewer 可只依赖本阶段稳定接口。
