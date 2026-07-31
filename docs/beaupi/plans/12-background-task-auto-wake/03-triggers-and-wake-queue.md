# 03 Triggers 与 Wake Queue

## 现有接入点

- `MonitorRuntime.subscribe()` 串行发送生命周期事件。
- `MonitorRuntime.logs()` 提供 cursor/hash/截断/轮转事实。
- `AgentSession.sendCustomMessage()`：空闲 `triggerTurn`，忙碌 `deliverAs: followUp`。
- Agent queue 已保证 steering 优先于 follow-up，用户输入可优先处理。

## 数据结构

- Trigger 保存 kind、pattern/interval、enabled 和上次匹配 hash。
- WakeEvent 保存 reason、monitor/task snapshot、log delta summary/reference、dedupeKey、状态与消费时间。
- WakeQueue snapshot 保存有序 event ID、当前 delivering ID 和已消费 keys。

## 生命周期

1. Monitor event/log delta 进入串行 evaluator。
2. 以 task + reason/status + log hash 生成稳定 key。
3. 新事件进入 Wake Queue；同时事件可在一次投递中合并。
4. Coordinator 忙碌时只登记 follow-up；空闲时触发一个 custom-message turn。
5. `agent_settled` 后继续消费队列；同一时刻最多一个 Coordinator turn。
6. 消费确认持久化后才移除；resume/Compact 不重复。
7. branch rebuild 取消旧分支 queued/delivering 注入并恢复目标分支事实。

## 失败路径

- sendCustomMessage 失败：事件保持 queued，有限重试，不标 consumed。
- Session 已 dispose：停止并将未投递事件留在持久化状态。
- 日志无变化：不创建事件、不调用 reviewer。
- callback 重复/循环状态：dedupe key 阻止重复。

## 测试场景

- completed/failed/timeout/stalled/error-pattern/progress-review。
- 多事件合并、串行 turn、busy follow-up、idle trigger。
- 用户消息优先级。
- resume/Compact/branch 不重复消费。
- duplicate wait/cancel 和 dispose/AbortSignal。

## 完成状态

- [x] 接入点审计
- [x] evaluator
- [x] persistent Wake Queue
- [x] AgentSession binding
- [x] dedupe/priority/branch 测试
