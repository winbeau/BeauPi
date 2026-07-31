# 后台任务与自动唤醒

## 目标

支持类似 Claude Code 的后台任务体验：

1. Agent 启动长时间运行的脚本。
2. 当前模型回合结束，TUI 保持可用，脚本继续执行。
3. 脚本完成、失败或出现关键状态时通知 Agent。
4. Agent 自动开始新的 turn，读取结果并继续任务。
5. 可选地定时复查进度，但避免无变化时重复消耗模型 token。

## 两种运行场景

### TUI 仍在运行

BeauPi 在 `session_start` 生命周期中启动进程内监控器。任务触发事件时：

- Agent 空闲：发送内部消息并立即触发 turn
- Agent 正忙：以 `followUp` 方式进入唤醒队列
- 多个事件同时发生：合并、去重并串行处理

### CLI 已退出

进程内监控器无法唤醒已经退出的 CLI。后续可增加独立守护进程：

- 后台任务和状态存储在 `~/.beaupi/agent/tasks/`
- daemon 监控进程并写入 Session 事件
- 通过终端通知、桌面通知或 IPC 提醒用户
- 用户恢复 Session 后，Agent 读取未处理事件继续工作

第一版只要求支持 TUI 保持运行的场景。

## 组件

M6 先交付独立的 Monitor Runtime 和 session-scoped MonitorRegistry，负责目标注册、状态快照、增量日志和生命周期事件；本阶段（M12）只在其上增加后台任务启动、持久化和自动唤醒，不创建第二套进程监控器。M6 的 Runtime 已接入现有 AgentSession、AgentPool 和 Tool 生命周期，但不会自动唤醒 Coordinator turn。

```text
Monitor Runtime
├── Monitor Registry
├── Process/Tool/Sub-Agent/Remote Adapters
├── Incremental Log Reader
├── State Snapshot and Event Deduper
└── Monitor Widget

Background Task Manager
├── Process Runner
├── Trigger Evaluator
├── Wake Queue
├── Progress Reviewer
└── Persistent Task Store
```

## 工具

### `background_start`

```typescript
background_start({
  command: "npm run dev",
  cwd: "/workspace/project",
  completion: "process-exit",
  timeoutSeconds: 1800,
  wakeOn: ["exit", "error-pattern", "stall"],
  reviewIntervalSeconds: 300
});
```

返回任务 ID、PID、日志文件和初始状态。命令参数应优先使用可执行文件与参数数组，避免不必要的 Shell 拼接。

### `background_status`

低成本读取 PID、运行时间、退出码、日志 hash 和最后活动时间，不调用模型。

### `background_logs`

默认只返回上次读取后的新增日志，并支持 `tail`、`errors`、`summary` 和 `full` 模式。

### `background_wait`

将当前任务登记为等待目标。Agent turn 可以结束，监控器继续运行并在触发后恢复 Agent。

### `background_cancel`

先发送正常终止信号，超时后再强制终止进程树。

## 任务状态

```typescript
interface BackgroundTask {
  id: string;
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "lost";
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
  exitCode?: number;
  logPath: string;
  logOffset: number;
  logHash?: string;
  wakePolicy: WakePolicy;
  reviewBudget: ReviewBudget;
}
```

## 唤醒事件

```typescript
type WakeReason =
  | "completed"
  | "failed"
  | "timeout"
  | "stalled"
  | "error-pattern"
  | "progress-review";
```

内部唤醒消息示例：

```text
[BACKGROUND TASK EVENT]
Task: test-42
Reason: completed
Exit code: 0
Duration: 4m12s
New log summary: 128 tests passed
Log file: /tmp/beaupi/tasks/test-42.log

Inspect the result and continue the original task.
```

事件通过 `pi.sendMessage()` 触发：

- 空闲时使用 `triggerTurn: true`
- 忙碌时使用 `deliverAs: "followUp"`

## 轮询设计

### 进程轮询

不调用模型，只检查：

- PID 是否存在
- 退出码
- 日志文件大小和 hash
- 最近输出时间
- CPU 时间或可选的子进程状态

推荐自适应间隔：

```text
0-30 秒：每 2 秒
30 秒-5 分钟：每 10 秒
5 分钟以后：每 30 秒
长时间无变化：每 60 秒
```

### 模型进度复查

模型复查不是固定心跳，只有满足条件才执行：

- 日志出现了足够多的新内容
- 命中 error/warning/progress 模式
- 达到配置的复查周期且状态发生变化
- 长时间无输出，需要判断是否卡住
- 用户明确要求定时判断

预算示例：

```json
{
  "enabled": true,
  "minimumIntervalSeconds": 300,
  "maxReviews": 6,
  "maxInputCharactersPerReview": 12000,
  "wakeOnlyOnMeaningfulChange": true
}
```

复查应交给轻量 Progress Reviewer 子 Agent，而不是污染主 Agent 上下文。Reviewer 只接收：

- 任务目标
- 上次进度摘要
- 新增日志片段
- 运行时间和资源状态

输出：

```typescript
interface ProgressReview {
  state: "progressing" | "stalled" | "failed" | "needs-user" | "completed";
  summary: string;
  shouldWakeCoordinator: boolean;
  suggestedAction?: string;
}
```

## 去重和并发

- 同一任务相同状态只产生一次事件
- 新日志 hash 未变化时不调用模型
- Coordinator 正在运行时不并发触发第二个 turn
- 多个完成事件可以合并成一次唤醒
- 用户消息优先于定时进度复查
- Session 切换或退出时持久化任务状态

## 安全

- 后台任务继承当前执行身份和后端权限；advisory-only Policy Runtime 不提供提权或强制阻断
- 未来的 Sudo 后台任务必须通过结构化 `privileged_exec` 创建
- 任务记录启动 Agent、Session、工作目录和完整参数
- 限制最大并发后台任务数
- 取消时终止整个进程树
- 日志输出执行截断，完整内容保存在文件中

## TUI

建议 Widget：

```text
Background Tasks
→ test-42   npm run test       04:12  new output 18s ago
✓ build-17  npm run build      01:48  exit 0
! dev-03    npm run dev        12:31  stalled
```

Footer：

```text
USER | bg:2 | wake:1 | workflow:review | gpt-5.4
```

## M6 已交付边界

- `MonitorRecord` 使用稳定 monitor ID 和明确状态机，Process/Tool/Sub-Agent 目标共享同一 Registry；SSH/tmux 只有 adapter 接口，不执行远程连接。
- 增量日志读取使用 cursor/hash，能够识别追加、截断、轮转和目标丢失；无变化时不调用模型，也不重复注入历史内容。
- Session 恢复只恢复 adapter 能确认的目标，无法确认的非终态目标标记为 `lost`。
- `monitor_wait` 和 `monitor_stop` 只观察或请求取消，不启动 Coordinator turn；M12 的 `background_*` 和 Wake Queue 继续复用这些接口。

## M12 实现状态

M12 已在现有 Monitor Runtime 上实现 `BackgroundTaskManager`，并没有创建第二套进程状态库或 Agent loop。

### 事实与存储

- `BackgroundTaskV1` 只保存 taskId、monitorId、命令元数据、触发器、日志消费 cursor/hash、Wake/Reviewer 预算和诊断；状态、PID、target、退出码、资源和完整日志路径从 `MonitorRecord` 读取。
- `beaupi.background.snapshot` 是当前 Session branch 的版本化 custom entry，保存任务、WakeEvent、消费 key 和 review budget。解析严格拒绝未知版本/不完整结构。
- `AgentSession` 构造、Monitor initialize、branch rebuild、Compact/resume 和 dispose 均复用同一 Manager；切换分支时旧 wake delivery 失效，只恢复目标分支事实。

### 执行与触发

- `background_start` 使用 executable + args、独立 0600 日志和 detached process group，spawn 后立即返回；Process adapter 保留 child exit code，避免 PID 消失后误判 `completed`。
- `background_attach` 只接管 Process 或 SSH/tmux Monitor target，并要求已有 adapter 确认；fake remote 不需要真实 SSH server。
- `background_status`/`logs` 不调用模型；logs 支持 tail/errors/summary/full、cursor/hash、截断和轮转，Tool details 只带增量元数据与日志引用，不复制完整日志。
- `background_wait` 只登记等待目标；completed、failed、timeout、stalled、error-pattern、progress-review 事件经 task/status/log hash 去重后进入串行 Wake Queue。
- 空闲 Coordinator 使用现有 `sendCustomMessage(..., { triggerTurn: true })`，忙碌 Coordinator 使用 `{ deliverAs: "followUp" }`；多个事件合并成一个结构化后台消息，用户 steering/follow-up 优先级仍由 AgentSession 保持。
- `background_cancel` 复用 Monitor stop；本地先向进程组发送 TERM，经过有界 grace 后使用既有 process-tree KILL。重复取消返回稳定终态。

### Progress Reviewer

Reviewer 默认关闭。启用后只接收任务目标、上次摘要、新日志片段、运行时间和资源快照，复用现有 AgentPool/ModelRuntime 的只读 reviewer Profile，严格解析 `<progress_review>`，限制最小间隔、最大次数、输入字符、输出 token 和 wall-clock。日志 hash 未变化时不会调用模型；Reviewer 失败只写诊断，不让后台任务失败。

### TUI 与测试

Task Ledger 投影 waiting/running/completed/attention，Footer 显示 `bg` 与 `wake` 聚合，Background renderer 显示状态符号、持续时间、最后活动、诊断和完整日志路径但不渲染完整日志。覆盖 beaupi-dark/light 与 40/80/120/160 列。

定向测试使用 `test/suite/harness.ts`、faux provider、fake Monitor/remote adapter、短本地进程和可控轮询入口；覆盖 start 跨 turn、idle wake、busy follow-up、事件合并/去重、review budget、取消、restore/lost、branch、Task Ledger、Tool details 和 renderer。

## 第一版验收标准

1. `background_start` 启动脚本并立即返回。
2. Agent 可以结束当前 turn，而脚本继续执行。
3. 脚本退出后自动触发新的 Agent turn。
4. Agent 忙碌时事件进入 follow-up 队列。
5. 日志使用增量读取，不重复发送历史内容。
6. 默认进程轮询不调用模型。
7. 模型进度复查有明确间隔、次数和输入预算。

状态：已完成（daemon、IPC、桌面通知和 M13 sudo 不在第一版）。
