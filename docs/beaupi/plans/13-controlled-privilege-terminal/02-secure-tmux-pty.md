# 02 Secure local tmux PTY

## 目标

从现有 Remote local-tmux transport 提取一个共享的本地 PTY broker，使本地 sudo 和远程 terminal sudo 使用同一套 pane、capture、marker、日志和安全输入机制，不新增 `node-pty`。

## 现有接入点

- `core/remote/adapter.ts` 已实现 local tmux session、`pipe-pane` transcript、SSH pane、capture、status、marker 和 close。
- 当前 `tmuxSend()` 使用 `tmux send-keys -l <input>`；普通命令可接受，但不能用于密码，因为 input 会出现在本地进程 argv。
- tmux 3.2+ 支持从 stdin 执行 `tmux load-buffer -`，再用 `paste-buffer -d -r` 原样写入 pane。

## Transport 拆分

建议新增内部模块：

```text
core/terminal/local-tmux-transport.ts
core/terminal/types.ts
```

职责：

- 创建/恢复/关闭受控 local tmux session/pane。
- 配置 `remain-on-exit`、0600 transcript 和 `pipe-pane`。
- `sendLiteral()`：仅用于非敏感协议命令。
- `sendSensitive(Buffer)`：stdin → named tmux buffer → raw paste → delete buffer。
- capture current screen/history、incremental transcript、pane status、resize 和 Ctrl-C。
- begin/end marker + exit code parsing。
- 不知道 sudo、AgentSession、Policy 或模型。

Remote adapter 改为组合该 transport，不保留第二份 tmux implementation。

## Sensitive Input

实现规则：

1. `spawn("tmux", ["load-buffer", "-b", bufferId, "-"])`，stdin 写入用户字节。
2. `tmux paste-buffer -d -r -b <bufferId> -t <pane>`。
3. bufferId 使用随机非秘密 ID；命令 argv 中不含 input。
4. finally best-effort `delete-buffer`，即使 paste 失败也清理。
5. input 不触发 `onData`、Monitor activity message、Policy terminal buffer、debug log 或 error interpolation。
6. NUL byte 默认拒绝；其他控制字节按原样发送。

## Local Privilege Pane

- 每个 local sudo request 使用独立 ephemeral pane，命令完成、取消或失败后关闭。
- 不为 AgentSession 保留 sudo pane，不建立 app-level grant，也不运行 sudo keepalive。
- pane 在目标 cwd 启动配置的真实用户 shell；local privilege transport 使用独立 tmux server，从当前进程安全继承环境并保留普通 shell startup files。
- 不使用 `env -i`、`--noprofile`、`--norc` 或 `sudo --preserve-env`；sudo 自身仍决定 root command 保留哪些环境变量。
- commandPrefix 与 Bash 语义保持一致，但审计展示实际发送的完整 sudo 命令。

## Echo 与 Wrapper

交互 wrapper 必须：

1. 输出 stage marker 和与审计记录完全一致的完整单行或多行文本，然后阻塞等待用户 Enter。
2. Enter 后输出 begin marker，并用原始文本执行；不预先执行 `sudo -v`，不改写为 `sudo -n`。
3. sudo 是否显示密码 prompt 由目标系统 sudoers/timestamp policy决定，但每个 BeauPi request 都已经独立确认。
4. wrapper 不在整个 command 生命周期执行 `stty -echo`；密码期间的 no-echo 由 sudo controlling TTY负责。
5. 认证结束后TUI可以detach，但wrapper继续运行，command退出后记录end marker与exit code。local pane正常dead时必须先解析end marker，再判断是否terminal lost。

命令正文使用现有 base64/marker protocol或 argv-safe helper传递；不依赖模型生成 shell quoting。

## Capture 与 Resize

- overlay 每 50–100ms 读取 pane screen/cursor，不读取或保存输入。
- transcript 继续用于完整输出；UI 只显示与 overlay 高度匹配的末尾行。
- overlay width/height 改变时调用 tmux resize，所有 rendered line 保证不超过 width。
- command terminal 后停止 poll timer；local ephemeral pane始终关闭，existing remote terminal pane保持连接。

## 失败路径

- tmux missing/version unsupported：结构化 `tmux_unavailable`，不 fallback 到密码管道。
- pane/session 消失：`terminal_lost`，取消当前request并清理交互。
- load-buffer/paste 失败：交互失败并清除 buffer，不重试输入。
- command取消后未恢复原用户 shell：关闭local pane，或把existing remote terminal标记recovery failed。
- Abort：发送Ctrl-C、等待marker/settle并flush output；无法确认恢复时不复用terminal。

## 测试

- spawn argv 不包含 sensitive input；stdin 精确收到 bytes。
- tmux buffer 在 success/failure 后删除。
- password-like fixture input 不出现在 transcript、logs、errors、Session facts。
- marker、exit code、timeout、cancel、pane lost、resize。
- sudo密码输入不回显，认证完成后视图detach，command输出继续写入work log。
- 用户shell startup环境、慢zsh初始化、cwd和多行staging。
- 正常pane dead完成marker、真正pane lost与恢复失败；交互式root shell在Runtime边界阻止。
- existing Remote terminal tests继续通过，证明 transport extraction 无退化。

## 完成状态

- [x] tmux/依赖方案审计
- [x] shared transport extraction
- [x] secure stdin channel
- [x] per-request local privilege pane
- [x] wrapper/echo/marker与detach cleanup
- [x] transport tests
