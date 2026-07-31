# 02 Process 与 Remote adapters

## 现有接入点

- 本地 `spawnProcess()`、detached process group、`killProcessTree()` 和完整输出文件能力。
- `MonitorAdapter` 与 Process target；Background adapter 保存 child exit code，避免 PID 消失后误判。
- M7 `RemoteExecutionRuntime` 已为 connection/command/terminal 创建 `ssh-tmux` Monitor records，并提供 fake adapter。

## 数据结构

- 本地 owner map：monitorId/PID、ChildProcess、exit facts、log path、graceful/force 状态。
- attach descriptor：existing monitorId；只接受 adapter 能确认的 process 或 ssh-tmux target。
- Tool result 只返回 PID/target、monitor/task ID、日志路径与结构化诊断。

## 生命周期

- start：创建 mode 0600 log，使用 executable + args spawn，立即 attach Monitor 并返回。
- exit：child event 固化 exit code/signal，下一次 poll 将同一 Monitor 转终态。
- attach：先 poll 现有 Monitor；unknown/missing 拒绝。
- cancel：先 Monitor stop graceful，等待有界 grace，再 force；本地杀进程组，远程复用 adapter stop。
- restore：仍存在且可确认则接管观察；无法恢复 child exit code的目标最终按 Monitor 规则 `lost`。

## 失败路径

- spawn error -> failed Monitor + 结构化 error。
- log create/write failure -> 启动失败或 diagnostic，不丢失目标引用。
- PID 重用不推断旧任务成功。
- fake remote disconnected/missing -> lost；取消拒绝保持事实。

## 测试场景

- 短成功/非零/timeout/stall/cancel process。
- 先 TERM 后 KILL 进程树。
- attach existing local/fake remote Monitor。
- terminal completion/disconnect/lost/cancel。
- monitor_status/logs/wait/stop 观察同一 monitorId。

## 完成状态

- [x] 接入点审计
- [x] runner-owned process adapter
- [x] start/attach/cancel
- [x] fake remote 路径
- [x] 进程树测试
