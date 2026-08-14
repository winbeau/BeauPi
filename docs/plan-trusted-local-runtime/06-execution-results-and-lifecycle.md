# Step 06：中性执行结果与 Run/Job 生命周期

## 状态

设计完成，未实现。依赖 Step 03、Step 05。

## 1. 目标

在无 Core Policy 的前提下，让工具结果、Bash 状态、取消、Background 和 Workflow 生命周期仍然可读、可测试、可恢复；不增加授权或权限限制。

## 2. 中性结果模型

建议建立 packages/coding-agent/src/core/execution/：

- failure-types.ts
- failure-classifier.ts
- execution-types.ts
- execution-record.ts（如确有需要）

字段建议：

status: completed | failed | cancelled | timed_out | killed | unknown
exitCode: number | null
signal?: string
durationMs?: number
failureCategory?: ExecutionFailureCategory
truncated?: boolean
fullOutputPath?: string

这些字段是事实和诊断，不是 allow/deny 决策。

## 3. Bash 结果

涉及 core/tools/bash.ts、core/bash-executor.ts、agent harness env/tools。

要求：

1. 不硬编码成功 exitCode，使用 executor 真值。
2. policyCategory 全部改为 failureCategory。
3. 保留 timeout 参数可选语义；本步骤不添加默认 timeout。
4. 保留宿主环境继承；本步骤不 scrub 环境。
5. 失败、取消、timeout 在 Tool Result/RPC/TaskLedger 一致。
6. 输出截断和完整输出路径保持当前产品行为；若后续改变 spill/内存上限，另开明确变更。

## 4. Run 状态机

created → running → cancelling → settling → completed|failed|cancelled|unknown

至少携带 runId、sessionId、owner、attempt、startedAt/endedAt、AbortController、settlement promise。

await 后 continuation 不能写入已替换的 session/run；使用 runId/session revision 检查。这是状态一致性，不是权限控制。

## 5. Job/Background/Workflow

统一最小事实字段：jobId、owner、runId、status、attempt、startedAt、endedAt、cancelRequested、result。

- cancel-requested 与实际 cancelled 分开；
- 外部进程未确认退出时使用 unknown；
- Workflow node 有 nodeId、attempt、parent/child ID、terminal event；
- 重启只恢复明确可恢复的本地状态，不自动重放未知外部副作用；
- 不把 process-local 状态宣传成 durable scheduler。

## 6. 复用现有能力

优先复用 AgentSession active run/abort/idle、MonitorRuntime 状态、TaskLedger command records、BackgroundTaskManager、WorkflowRuntime snapshots 和 AgentToolResult。不要创建第二套 Agent loop、Tool executor 或 Task Ledger。

## 7. 验收

- interactive/print/RPC 对同一 Bash 失败产生一致 status/category/exitCode。
- cancel 不报告 succeeded。
- 调用方提供 timeout 时，超时结果为 timed_out。
- session replacement 后旧 continuation 不写入新 session。
- 不出现 Policy* 类型或 policyCategory。
