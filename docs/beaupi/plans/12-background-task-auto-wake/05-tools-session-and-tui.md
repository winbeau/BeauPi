# 05 Tools、Session 与 TUI

## 现有接入点

- SDK runtime tool 聚合和默认 active tool names。
- `AgentSession` 构造/afterToolCall/message_end/rebuild/dispose。
- Workflow versioned details 和 Task Ledger projection 模式。
- `TaskLedgerWidget`、Footer、ToolExecutionComponent、BeauPi 状态/宽度 helper。

## 数据结构

- 六个 Tool 使用 `additionalProperties: false` 的 TypeBox schema。
- `BackgroundToolDetailsV1` 统一返回 task/monitor snapshot、cursor/hash、trigger、wake、diagnostics/error。
- Task Ledger 保存 background snapshots 和 wake summary，不保存完整日志。
- renderer 输入只接受结构化 snapshot。

## 生命周期

- SDK 创建 Manager，注册六个 Tool，默认 Coordinator 激活。
- AgentSession 绑定 wake host、实时投影 Ledger、branch rebuild、dispose。
- afterToolCall/extension replacement 后重新附加 authoritative background details。
- Todo 显示 waiting/running/completed/attention；Footer 显示 bg/wake 聚合。
- Tool renderer 和 Background list 显示状态、持续时间、last activity、diagnostic、log path；完整日志不渲染。

## 失败路径

- schema/unknown task/monitor -> versioned error details。
- cancelled/lost/stalled 使用统一状态色和不可折叠简短诊断。
- 避免同一 Background task 同时显示重复 generic Monitor row。

## 测试场景

- 六个 Tool details 和立即返回语义。
- controlled child profile 不暴露 Background Tools。
- Task Ledger/Compact/resume/branch。
- dark/light 40/80/120/160；空/单/多、长命令/路径、failed/stalled/lost。

## 完成状态

- [x] 接入点审计
- [x] Tool schemas/details
- [x] Session/Task Ledger
- [x] Footer/Todo/renderer
- [x] profile boundary/width 测试
