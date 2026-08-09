# 05 TUI 与 Prompt Projection

状态：已完成。

## 目标

把动态 Task 的当前 snapshot和 revision以紧凑、宽度安全方式投影给主 Agent和现有 BeauPi UI；不复制历史、不插入 Reviewer对话、不从文本反推状态。

## Provider request projection

`AgentSession.prepareNextTurnWithContext` 每次请求动态追加一个有界 block：

```text
<dynamic_tasks revision="4">
goal: Implement M14 dynamic tasks
- p1 [completed] Contract and state
- p2 [active] Tool and trigger · editing tools.ts
- p3 [pending] Ledger projection · depends on p2
</dynamic_tasks>
```

规则：

- 最多包含当前 16 个 Task、status、ID、短 title、依赖和一行 activity。
- evidence只显示最多两个稳定 ID摘要，不包含完整事实历史。
- 无计划且当前 prompt被分类为 executable时，显示一次 initial-plan要求。
- 自动动工或用户范围变化后显示一次短 refresh reminder。
- 不将 Reviewer输出、provider错误或完整日志写入主上下文。
- Base system prompt不缓存旧 revision；每次 request即时生成。

## Follow-up / next-turn

仅以下情况排队有界通知：

- Reviewer将 Task置为 blocked。
- Reviewer结果因 revision conflict被丢弃。
- Runtime检测主 Agent需要重新规划才能继续。

普通状态完成、activity/evidence刷新和成功验证不生成消息。通知使用现有 `sendCustomMessage(..., { deliverAs: "nextTurn" })`，不创建第二个消息队列。

## Tasks Widget

继续使用 `TaskLedgerWidget`：

- header显示 `plan r<revision>` 和 `<completed>/<total>`。
- blocked/failed数量使用 warning/error attention。
- Todo本体沿用 pending/active/completed/failed/blocked、owner、activity和blockedBy布局。
- Dynamic Task保留内部 `source: "dynamic-task"` provenance，但 Tasks Widget不显示 `· dynamic-task` 来源标签。
- Tasks Widget 只显示 `source: "dynamic-task"` 的动态 Todo；Document、Workflow、Background、Monitor 和其他 Task Ledger Todo 不再进入该栏。
- Monitor 状态迁移到 Footer 的有界列表；最多 4 行，超过 4 条时显示 3 条加隐藏数量汇总。
- 不新增独立 Dynamic Task Widget。

## Footer

工作区行增加紧凑计划摘要：

- 正常：`tasks 2/5`。
- attention：`tasks 2/5 · 1 blocked` 或 `1 failed`。
- 无动态计划时保持现有 phase/files/verification显示。
- Footer 保留原有最多三行的基础状态区；Monitor 状态可额外占最多 4 行，超过 4 条时折叠为 3 条加汇总行。
- 40列最小模式优先保留 cwd/model/context，计划摘要和 Monitor 次要字段可降级隐藏。

## Tool renderer

`tasks_update`：

```text
● Tasks(initial_plan · expected r0)
  ⎿  5 tasks · 0 completed · revision 1
```

异步 facts 安全重基：

```text
● Tasks(work_started · expected r2)
  ⎿  5 tasks · 1 completed · revision 6 · rebased from r2
```

真正结构冲突：

```text
● Tasks(plan_changed · expected r2)
  ⎿  Revision conflict · expected r2 · current r3
```

renderer只读取版本化 details。

## Theme 与宽度

暗色/亮色、40/80/120/160列均要求：

- 每行 `visibleWidth <= width`。
- CJK、emoji、长 title/activity/blocker/model/branch不横向溢出。
- active加粗、completed dim+strike、blocked/failed对比度沿用M1状态语言。
- Footer不产生第四行，Tasks Widget动态截断仍保持3–10项。

## 文件范围

修改：

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/components/task-ledger-widget.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/coding-agent/src/core/tasks/tools.ts`
- 必要的 HTML Tool renderer测试，不新增独立 TUI Runtime。

## 失败回归

先修改：

- `packages/coding-agent/test/task-ledger-widget.test.ts`
- `packages/coding-agent/test/footer-width.test.ts`
- `packages/coding-agent/test/dynamic-task-tools.test.ts`
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts`

覆盖紧凑快照、无 Reviewer对话、Tool renderer、暗亮主题和四种宽度。

## 完成条件

- 主 Agent每次请求收到当前 revision而不是历史副本。
- 普通进度不会向主对话添加消息。
- Widget/Footer只消费结构化 snapshot并保持M1宽度与主题约束。
