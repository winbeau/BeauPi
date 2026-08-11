# 多 Agent Workflow

## 实现状态

M11 已完成。Workflow Runtime 位于 `packages/coding-agent/src/core/workflow/`，直接复用现有 AgentPool、AgentSession、ResourceLoader 投影、MonitorRuntime、Task Ledger、Policy Runtime 和 Session branch 生命周期。M11 不实现后台自动唤醒、sudo 或专用 Git Tools。

## Workflow 格式

当前 Schema 版本为 `1`。`workflow_run.workflow` 接受内置 Workflow 名称、序列化 YAML/JSON，或符合严格 TypeBox Schema 的对象。为降低启动摩擦，对象和序列化定义都可省略 `version`，Runtime 会规范化为当前版本；显式提供未知版本仍会失败。

```yaml
version: 1
id: implement-review
maxConcurrency: 2
nodes:
  - id: implement
    profile: implementer
    task: "Implement: {{task}}"
    writePolicy: shared
    timeoutMs: 300000
    failurePolicy: fail-workflow
    budget:
      maxTurns: 12
  - id: review
    profile: reviewer
    task: "Review: {{task}}"
    dependsOn: [implement]
    condition: all_succeeded
    writePolicy: none
```

节点支持 `id`、`agent`/`profile`、`task`、`dependsOn`、`condition`、`writePolicy`、`timeoutMs`、`failurePolicy`、`budget` 和 `cancelStrategy`。`agent`/`profile` 可省略，此时使用 AgentPool 默认 Profile；CLI 内置 Profile 为 `reviewer`（默认）、`researcher` 和 `implementer`。未知 Profile 错误会同时列出可用 ID 和默认值。节点级 `timeoutMs` 保持从获得 AgentPool 槽位后计算的最终硬上限；节点 `budget.timeoutMs` 与独立 `delegate_task` 一样，只收紧可由 assistant/turn/Tool 活动续期的无进展窗口。Runtime 在启动前校验额外字段、重复 ID、未知依赖、自依赖、环、未知 Profile、条件和预算。

## 条件语法

条件不执行代码，不使用 `eval` 或 `new Function`。最大长度为 512 字符，最多 16 个子句。

```text
always
all_succeeded
any_failed
deps.inspect.status == "completed"
deps.research.output.summary != ""
deps.a.status == "completed" && deps.b.output.summary != "blocked"
deps.a.status == "failed" || deps.b.status == "completed"
```

规则：

- 引用节点必须在当前节点的 `dependsOn` 中。
- `status` 只能与合法节点状态字符串比较。
- `output` 只读取依赖节点的结构化 `AgentTaskResult` 路径。
- 比较操作只有 `==`、`!=`；值必须是 JSON string、number、boolean 或 `null`。
- `&&` 优先于 `||`；不支持括号、函数、赋值或脚本表达式。

## 调度与失败策略

调度器同时服从 Workflow `maxConcurrency` 和 AgentPool 全局并发槽位。

- `none`：只读节点；没有依赖时允许并行。
- `shared`：共享工作区写入；同一 Workflow Runtime 跨并发 Workflow 最多一个 shared 写入者。shared 运行时不启动同工作区 `none` 或另一个 `shared` 节点。
- `isolated`：独立 Git Worktree；可与 shared、none 和其他 isolated 节点并行。

失败策略：

- `fail-workflow`：取消其他节点。
- `continue`：保留失败事实，依赖节点按自己的 condition 决定是否运行。
- `skip-dependents`：跳过传递依赖节点。

Workflow 取消会取消全部运行节点并结束 pending 节点。重复取消返回 `already_terminal`，不会重复计数生命周期事件。

## 结构化依赖边界

下游节点只收到依赖节点的 `nodeId`、状态、结构化 `AgentTaskResult`、错误和诊断。依赖子 Agent 的完整消息历史、Thinking、Tool transcript 和 Session JSONL 不进入下游节点或 Coordinator。

## Git Worktree 安全边界

`WorkflowWorktreeManager` 使用现有 `execCommand()` 以参数数组执行 Git，不经过 shell，也不增加专用 Git Tool。

- 使用 `git rev-parse --show-toplevel` 确认仓库。
- 路径位于系统临时目录下的受控根，包含 cwd hash、Session ID、Workflow ID 和节点 ID。
- 分支名位于 `beaupi-workflow/*` 命名空间。
- 已存在路径不会被覆盖或递归删除；创建直接失败并返回诊断。
- 创建与清理串行，避免并发修改 Git Worktree 元数据。
- 节点失败、超时、取消或 Workflow 非成功终态立即清理。
- 成功 isolated Worktree 保留到 Session 结束，供 Coordinator 检查或整合，再确定性清理。

## Tools

### `workflow_run`

输入 Workflow、可选 `task` 和可选 `background`：

- 默认同步等待 DAG 到达终态，返回 `WorkflowRunDetailsV1`。
- `background: true` 在完成确定性校验和启动后立即返回 `workflowId`/运行快照；DAG 继续由当前 Session Runtime 执行，随后使用 `workflow_status`、`workflow_cancel` 或 Monitor Tools 查询和控制。

后台 Workflow 不创建第二个进程或第二套 Agent Runtime，也不等同于 M12 的进程 Wake Queue。

### `workflow_status`

按 Workflow ID 查询，或列出当前分支全部 Workflow。返回 `WorkflowStatusDetailsV1`。

### `workflow_cancel`

幂等请求取消一个 Workflow，并等待运行节点完成受控 abort/graceful 收尾后返回 `WorkflowCancelDetailsV1`；因此慢速 provider/Tool 的取消响应可能持续到其既有硬上限。

Details 包含 Workflow/节点状态、时间、结构化输出、Monitor ID、稳定 `agentId`、诊断和错误，不包含子 Agent transcript。每个节点的 Agent ID 为 `<workflowId>:<nodeId>`，从节点创建开始即可用于 `agent_control`。受控子 Agent 不暴露 Workflow Tools，防止递归 Workflow。

## Agent ID、tmux 与控制

交互式 CLI 默认为每个运行中的子 Agent 创建独立、只读的本地 tmux transcript；AgentSession 仍在当前进程执行，不启动第二个不受控 CLI。tmux 不可用时 Agent 继续运行，并在结构化诊断中说明可视化降级。

`agent_control` 使用稳定 Agent ID 提供：

- `list` / `status`：发现 Agent、状态、任务、最近活动和 tmux attach 命令。
- `steer`：在当前 Tool batch 结束后注入方向调整。
- `follow_up`：在当前 run 完成后追加任务。
- `cancel`：请求 AgentPool 的既有受控取消路径。
- `capture`：有界读取 tmux transcript，最多返回当前捕获尾部；不会自动注入其他 Agent 上下文。

启用 `peerControl` 后，内置子 Agent 可通过同一 Tool 按 ID 查看、capture、steer、follow-up 或取消同一 AgentPool 中的 peer。完整 transcript 仍不会自动进入下游 Workflow 依赖上下文，只有显式 `agent_control capture` 才会读取。SDK 可通过 `agentPool.tmux` 和 `agentPool.peerControl` 分别启用这两个能力。

## Monitor、Task Ledger 与恢复

Workflow 和每个节点都是现有 `MonitorRuntime` 的 `workflow` target。节点 turn/Tool 活动进入有界 activity log，可用 `monitor_status`、`monitor_logs`、`monitor_wait` 和 `monitor_stop` 查询或取消。

实时 `WorkflowSnapshot` 投影到现有 Task Ledger，并驱动 Todo、Footer 和只读 DAG renderer。Tool Result 和 Monitor custom entries 进入 Session JSONL。Compact、resume 和 tree branch 切换只重建当前分支事实；恢复时不能确认的 pending/running Workflow 或节点标记为 `lost`，绝不猜测成功。

## 内置 Workflow

- `research`：并行研究与证据合成。
- `implement-review`：shared 实现后串行只读审查。
- `parallel-review`：至少两个无依赖只读 reviewer 并行，随后汇总。
- `debug`：检查、修复和验证链。
- `docs-execute`：文档约束解析后执行和审查。

内置模板中的 `{{task}}` 由 `workflow_run.task` 进行纯文本替换。