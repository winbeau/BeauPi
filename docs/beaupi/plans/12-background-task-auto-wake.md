# M12 后台任务与自动唤醒实施计划

## 阶段简介

M12 在现有 `MonitorRuntime`、`AgentSession`、`AgentPool`、Task Ledger、Session branch 与 BeauPi TUI 上增加 session-scoped Background Task Manager。第一版只保证 BeauPi TUI 进程仍运行时自动唤醒，不实现 CLI 退出后的 daemon、IPC、桌面通知、M13 sudo 或专用 Git Tools。

## 范围边界

- BackgroundTask 只引用现有 `monitorId`；`MonitorRecord` 继续是目标状态、资源、退出事实与日志位置的唯一来源。
- 使用现有 `AgentSession.sendCustomMessage()`、follow-up 队列和 Agent loop，不直接从 Monitor callback 并发调用 `prompt()`。
- 使用版本化 Session custom entries 保存任务、触发器、WakeEvent、消费确认与 ProgressReview 预算事实。
- 本地启动使用 executable + args 和独立日志；远程第一版接管已被现有 adapter 确认的 Monitor target。
- 不创建第二套 Monitor、Agent Runtime、Session、ResourceLoader、Task Ledger、Tool 执行链、模型客户端或输入循环。

## 当前可复用接口盘点

- `MonitorRuntime.attach/status/logs/poll/stop/subscribe/rebuild/dispose`、单一 `MonitorRegistry`、严格状态机、终态等待与 Session custom entry 恢复。
- `MonitorAdapter.poll/stop` 与现有 Process、Tool、Sub-Agent、Workflow、SSH/tmux adapter；M12 仅补充 runner-owned process facts 和进程树取消。
- `IncrementalLogReader` 的 cursor/hash/prefixHash、截断和轮转检测；Background logs 继续调用 Monitor API。
- `AgentSession.isStreaming/isIdle/sendCustomMessage/waitForIdle` 与现有 steering/follow-up 队列；空闲触发 turn，忙碌投递 follow-up。
- `SessionManager.appendCustomEntry/getBranch`、`TaskLedger.rebuild`、Monitor/Workflow branch rebuild、Compact 保留 custom entries。
- `AgentPool.delegateTask`、受控 Profile、共享 `ModelRuntime`、faux provider；Progress Reviewer 只使用只读 profile 和结构化标签输出。
- Workflow details、Task Ledger snapshot/Todo、Footer、minimal Tool shell、统一状态符号和 ANSI-aware width helper。

## 分阶段实现顺序

1. 固化版本化类型、Session store、scheduler/clock 和 runner-owned process adapter。
2. 实现 Manager 启动/接管/轮询/恢复/取消及 Monitor 双向一致性。
3. 实现确定性 Trigger Evaluator、Wake Queue 去重、串行消费和 AgentSession 注入。
4. 实现受预算 Progress Reviewer，并确保日志 hash 无变化零调用。
5. 注册六个默认 Tools，接入 Task Ledger、Compact/resume/branch 与 TUI。
6. 完成 fake clock、fake Monitor/remote、faux provider、本地短进程与宽度测试，运行全量验收。

## 里程碑

### B1 Runtime 与 Store

实现版本化结构、严格恢复、并发上限、自适应 scheduler、runner-owned 进程事实和 `lost` 保守恢复。

### B2 Trigger 与 Wake

完成 completed/failed/timeout/stalled/error-pattern/progress-review 触发、事件去重、Wake Queue 串行消费和 dispose/branch 隔离。

### B3 Tools 与 Session

六个 Tool 默认注册并接入现有 AgentSession；`background_start`/`wait` 立即返回，完成事件真实触发 Coordinator turn，忙碌时进入 follow-up。

### B4 Reviewer 与 UI

Progress Reviewer 共享 AgentPool/ModelRuntime，具有最小间隔、次数、输入字符和 wall-clock 预算；Task Ledger、Todo、Footer 与结构化 renderer 接入。

### B5 Acceptance

定向测试、`./test.sh`、`npm run check` 全部通过，文档状态更新，未确认恢复状态为 `lost`，已消费 WakeEvent 不重复。

## 验收矩阵

| 能力 | 代码事实 | 自动化验证 |
|---|---|---|
| 跨 turn 运行 | child process 与 Agent turn 解耦 | start 立即返回、turn 后继续 |
| 自动唤醒 | `sendCustomMessage` + trigger/follow-up | idle/busy faux Session |
| 无模型轮询 | 默认 poll 只读 Monitor/log facts | faux callCount 不变 |
| 事件去重 | task/status/log hash/reason key | 重复 poll/resume/Compact |
| 可恢复 | branch custom entries + adapter confirm | confirmed/lost/consumed |
| 本地/远程 | Process adapter + existing SSH/tmux Monitor | short process + fake remote |
| 取消 | graceful 后 bounded force tree kill | repeated cancel/AbortSignal |
| 可视化 | Task Ledger + renderer/Footer | dark/light, 40/80/120/160 |

## 风险与停止条件

- 若现有 adapter 无法确认恢复目标，必须标记 `lost`，不得猜测成功。
- 若 wake 注入需要绕开 `AgentSession` 队列或创建第二个 Agent loop，停止并重构接入点。
- 若 Progress Reviewer 需要新模型客户端或完整 Coordinator transcript，停止该路径。
- Session dispose 或 branch 切换后不得继续投递旧分支事件。
- `CHANGELOG.md` 与 `CONTRIBUTING.md` 的禁止编辑规则冲突；除非用户明确确认覆盖仓库规则，否则不修改。

## 模块子计划

- [01 Runtime 与 Store](./12-background-task-auto-wake/01-runtime-and-store.md)
- [02 Process 与 Remote adapters](./12-background-task-auto-wake/02-process-and-remote-adapters.md)
- [03 Triggers 与 Wake Queue](./12-background-task-auto-wake/03-triggers-and-wake-queue.md)
- [04 Progress Reviewer](./12-background-task-auto-wake/04-progress-reviewer.md)
- [05 Tools、Session 与 TUI](./12-background-task-auto-wake/05-tools-session-and-tui.md)
- [06 Tests 与 Acceptance](./12-background-task-auto-wake/06-tests-and-acceptance.md)

## 实时完成状态

- [x] 完整阅读 M12 指定 BeauPi 文档与仓库规则
- [x] 审计 Monitor、Process/Remote、AgentPool、Session queue、Task Ledger 与 TUI 接入点
- [x] B1 Runtime 与 Store
- [x] B2 Trigger 与 Wake
- [x] B3 Tools 与 Session
- [x] B4 Reviewer 与 UI
- [ ] B5 Acceptance（定向测试与 `npm run check` 已通过；`./test.sh` 两次仅剩既有子进程/本地网络并行 flake，失败文件单独运行通过）
