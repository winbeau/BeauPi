# 01 Runtime 与 Store

## 现有接入点

- `MonitorRuntime`/`MonitorRegistry` 是唯一目标状态源。
- `SessionManager.appendCustomEntry()` 持久化版本化事实，`getBranch()` 提供当前分支恢复输入。
- `AgentSession` 构造、`navigateTree()` rebuild 和 `dispose()` 提供 session-scoped 生命周期。

## 数据结构

- `BackgroundTaskV1`：task/monitor 关联、目标、命令摘要、触发器、消费 cursor/hash、review budget、时间、诊断。
- `BackgroundTriggerV1`：completed/failed/timeout/stalled/error-pattern/progress-review。
- `WakeEventV1`：稳定去重 key、queued/delivered/consumed/cancelled、branch/session 事实。
- `ProgressReviewV1`：严格 verdict、摘要、是否唤醒、建议动作和预算事实。
- custom entry 只保存结构化快照，不复制完整日志或 transcript。

## 生命周期

1. 构造时从当前 branch 读取最后有效 snapshot。
2. 安装 runner-owned adapter 并确认恢复中的非终态目标。
3. 自适应 scheduler 串行调用现有 Monitor poll/log API。
4. 每次确定性状态或消费事实变化后 append custom entry。
5. branch rebuild 清空旧分支 timer/wake 注入并恢复目标分支。
6. dispose 停止 scheduler、review、wake 消费和新 Session 注入。

## 失败路径

- 无效版本/结构忽略并记录诊断。
- 非终态目标无法确认时投影 `lost`。
- 存储写入失败不篡改 Monitor 状态；向任务诊断追加失败。
- 并发上限在 spawn 前校验。

## 测试场景

- 严格版本校验、额外字段、最后 snapshot 胜出。
- 最大并发、重复 attach、重复恢复。
- Compact/resume/branch 只恢复当前分支。
- dispose 后无 timer、无注入。

## 完成状态

- [x] 接入点审计
- [x] 类型与严格 parser
- [x] Store 与 rebuild
- [x] scheduler/clock
- [x] 恢复与 dispose 测试
