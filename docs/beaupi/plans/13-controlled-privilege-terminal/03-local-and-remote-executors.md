# 03 Local 与 Remote Executors

## 目标

在统一 `PrivilegeRuntime` 下实现本地 Bash 和远程 `terminal_bash` 两种 sudo executor；两者共享逐次确认、交互、结果和清理语义，但继续使用各自现有 cwd/log/Monitor事实。

## Local Executor

- 输入：完整 sudo command、cwd、shell config、timeout、source tool、AbortSignal。
- 使用 shared local tmux privilege pane，不直接在 BeauPi 进程中 spawn sudo with pipes。
- 每个 request创建独立pane，用户Enter前不发送命令，终态后关闭。
- 输出进入现有 Bash accumulator/truncation path；完整输出路径与 Bash一致或使用明确 privilege log path。
- exit 126/127、permission、timeout、cancel 与普通 Bash保持结构化 failure category。
- 无 handler、tmux unavailable 时不创建可执行command session。

## Remote Terminal Executor

- 只接受 `RemoteExecutionRuntime` 已知、interactive、not busy 的 terminalId。
- 使用同一个 local tmux SSH pane，因此继承远程 shell cwd、export环境和 sudo tty ticket。
- 扩展 `SshConnection`/Remote Runtime，提供受控 interactive command session，而不是让 TUI直接访问 private connection map。
- existing terminal work log继续是完整输出事实源；privilege audit只引用该 logPath。
- command terminal后恢复 `terminal.busy = false`，更新 Monitor并运行现有 output reviewer规则。
- 每个sudo request都重新显示权限框；系统sudo ticket可能省略密码prompt，但不省略用户Enter确认。

## 建议内部接口

```typescript
interface PrivilegeCommandSession {
  readonly request: PrivilegeRequestV1;
  start(): Promise<void>;
  sendSensitive(input: Buffer): Promise<void>;
  capture(): Promise<PrivilegeTerminalFrame>;
  resize(columns: number, rows: number): Promise<void>;
  cancel(): Promise<void>;
  wait(): Promise<PrivilegeCommandResult>;
  dispose(): Promise<void>;
}
```

- `start()` 在用户 Enter 前不得被调用。
- `wait()` 返回输出/exit/log/monitor facts，不返回用户输入。
- fake implementation必须可控制 prompt、output、ticket、exit和lost。

## Per-request Execution Boundary

- 每个request按local或targetId+terminalId绑定唯一执行目标。
- local Bash和terminal_bash的direct sudo都先进入同一router，不允许原执行器旁路。
- Runtime不执行`sudo -v`预认证、不使用`sudo -n`作为session bypass，也不运行后台keepalive。
- 系统sudo timestamp只属于目标TTY和系统策略；BeauPi不读取、不持久化，也不将其转换为app授权。
- branch/reload/dispose只需取消pending request、恢复echo和关闭ephemeral pane，不维护grant revoke状态。

## Root Remote Identity

- target configured user/root或已确认 login identity为root时，普通Remote Tool按该身份执行，不要求构造sudo。
- 若command仍显式包含sudo，返回结构化`redundant_privilege`且不执行；Agent应移除sudo后使用普通`terminal_bash`。
- 不因为系统提示符字符猜测 root；只使用配置和确定性 connection facts。

## 不支持范围

- `remote_exec` one-shot交互 sudo。
- remote target无 terminalId时自动创建长期 terminal。
- `su -`、root login shell、PAM GUI、askpass、doas/pkexec。
- privileged background task和 detached root process。

## 失败路径

- terminal busy/lost/disconnected：不打开重复交互，保留 partial output/log。
- SSH断开：Monitor terminal/connection进入lost，当前request取消并清理。
- timeout/abort：Ctrl-C、flush、echo restore、terminal state复核。
- output reviewer失败：沿用 deterministic fallback，不影响 exit事实。

## 测试

- local success/nonzero/timeout/cancel/truncation。
- remote fake terminal cwd/export继承和work log。
- terminal busy/lost/disconnect。
- 每个request独立确认、target mismatch、系统ticket已缓存时仍要求Enter。
- root target deterministic path。
- no privileged background/one-shot remote path。

## 完成状态

- [x] local/remote语义设计
- [x] local executor
- [x] remote interactive command session
- [x] per-request router/cleanup wiring
- [x] Bash-compatible result integration
- [x] executor tests
