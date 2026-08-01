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
- pane 在目标 cwd 启动用户 shell；command wrapper 使用配置的 shell path/args。
- 不使用 `sudo --preserve-env`；root command 不显式继承 Provider/Auth/PI_* secrets。
- commandPrefix 与 Bash 语义保持一致，但审计展示实际发送的完整 sudo 命令。

## Echo 与 Wrapper

交互 wrapper 必须：

1. 记录 begin marker。
2. `stty -echo`，安装 EXIT/HUP/INT/TERM cleanup。
3. 用户按 Enter 后发送与审计记录完全一致的完整 sudo 命令；不预先执行 `sudo -v`，不改写为 `sudo -n`。
4. sudo 是否显示密码 prompt 由目标系统 sudoers/timestamp policy决定，但每个 BeauPi request 都已经独立确认。
5. 恢复 `stty echo`，记录 end marker 与 exit code。
6. cleanup 不成功时关闭 local privilege pane；remote existing pane 标记 terminal recovery required并尝试 `stty echo`。

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
- no-echo cleanup 未确认：关闭 pane或把现有 remote terminal标记 lost/recovery required。
- Abort：发送 Ctrl-C、等待 marker/settle、恢复 echo、flush output。

## 测试

- spawn argv 不包含 sensitive input；stdin 精确收到 bytes。
- tmux buffer 在 success/failure 后删除。
- password-like fixture input 不出现在 transcript、logs、errors、Session facts。
- marker、exit code、timeout、cancel、pane lost、resize。
- no-echo 恢复；硬失败时关闭 pane。
- existing Remote terminal tests继续通过，证明 transport extraction 无退化。

## 完成状态

- [x] tmux/依赖方案审计
- [x] shared transport extraction
- [x] secure stdin channel
- [x] per-request local privilege pane
- [x] wrapper/echo/marker cleanup
- [x] transport tests
