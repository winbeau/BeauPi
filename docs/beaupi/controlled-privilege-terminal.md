# 受控 sudo 终端

状态：M13 已实现并完成全量验收（2026-08-01）。

M13 在现有 `AgentSession`、Bash、Remote Runtime、本地 tmux SSH terminal、Monitor 和 Task Ledger 上增加逐请求 sudo 执行边界。它不是 sudo mode，也不保存授权。

## 用户流程

1. `privileged_exec`、local `bash` 或 `terminal_bash` 提交一个可确定解析的完整 sudo command 或换行分隔批次。
2. TUI 第一帧直接打开双分割线 tmux 视图，创建受控 pane 并填充完整只读文本；此时 sudo 尚未执行，光标停在最后一行末尾。
3. 用户按 Enter 后才释放这一条已填充 command/batch；按 Escape 则取消并关闭临时视图，sudo 不会执行。
4. 本地权限 pane 使用独立 tmux server，继承当前进程环境、目标 cwd 和配置的真实用户 shell；不使用 `env -i`、`--noprofile` 或 `--norc`。
5. sudo 直接从 controlling TTY 读取认证输入并负责密码输入期间的 terminal echo。输入不经过 Tool 参数、Session、Monitor、Task Ledger、RPC 或模型上下文。
6. 认证结束后终端继续 attached。普通 command 直到完成；`sudo bash`、`sudo sh`、`sudo -i` 和 `sudo -s` 直到用户输入 `exit`。运行中按 Escape 会终止当前提权流程，不能留下隐藏 root shell。
7. 短成功输出直接返回主对话；失败、诊断或超过 100 行的输出先交给共享 `review.model` 审阅，完整输出仍保留在日志中，并写入无秘密审计。

系统 sudo ticket 可以让 sudo 不再显示密码 prompt，但不会跳过 tmux 中由用户按 Enter 触发执行的边界。

## 路由

- local `bash` 中可确定的 sudo 自动进入 session-scoped `PrivilegeRuntime`，普通 shell executor 不会直接 spawn。
- `terminal_bash` 中的 sudo 复用指定的现有 SSH tmux pane，并进入同一个 Runtime。
- `terminal_send` 在 Enter 前检查累计 shell line；检测到 sudo 或无法安全还原的控制序列时发送 Ctrl-U 清理，且不发送 Enter。
- `remote_exec`、`remote_bash` 和其他 one-shot SSH 路径没有可控认证 TTY，因此阻止提权。
- `sudo bash`、`sudo sh`、`sudo -i` 和 `sudo -s` 作为当前 request 的交互式 shell 受支持；`su`、`doas`、`pkexec`、`runuser`、namespace/chroot identity switch、`sudo -S`/`--stdin` 和 `sudo -A`/`--askpass` 仍不支持。
- SSH target 的受信任登录身份若已是 root，应去掉 sudo，继续使用普通 remote/terminal Tool。

## 敏感输入传输

local 与 remote terminal 共用 tmux transport：

```text
TUI bytes
└── PrivilegeTerminalControl.sendSensitive(Buffer)
    └── tmux load-buffer -b <random> -      # bytes only on child stdin
        └── tmux paste-buffer -d -r ...
            └── controlling TTY
```

finally 路径始终尝试 `delete-buffer`。认证输入不会进入 argv、环境变量、临时明文文件、pane transcript、work log、Tool result/details、Session custom entry、Monitor、Task Ledger、审计 JSONL 或异常文本。

## 事实与审计

`PrivilegeToolDetailsV1` 是 Tool/Session/Task Ledger 的结构化结果事实。每个 request 另外写入：

```text
<agentDir>/audit/privileged/YYYY-MM-DD.jsonl
```

默认 `agentDir` 为 `~/.beaupi/agent`；自定义 `agentDir` 时审计路径随其变化。目录权限为 `0700`，文件权限为 `0600`。事件只有 `requested`、`confirmed`、`started`、`completed`、`failed`、`cancelled`、`blocked`，记录 command、target、时间、exit/duration、Monitor/log 引用和稳定诊断，不记录认证输入。

Session custom entry `beaupi.privilege.fact` 只用于当前 branch 的历史投影。resume、Compact 和 branch navigation 不恢复 pending request、授权或输入。

## 非交互模式

Print、JSON 和 RPC 不安装 privilege interaction handler。sudo request 返回 `interaction_required`，不会读取 stdin 或执行 command。SDK host 必须提供进程内 `PrivilegeInteractionHandler`，由可信 UI 调用 `control.start()` 填充命令，并仅在用户选择执行后调用 `control.execute()`；handler 不应请求或接收密码，认证字节只能由用户直接输入 controlling TTY。

## 明确不提供

- `/mode sudo`、持久 root shell 或脱离当前 request 的后台 root 会话
- once/session grant、expiry、keepalive 或确认绕过
- 密码字段、密码回调、密码缓存或授权恢复
- `sudo -S`、SSH one-shot 密码管道或 `tmux send-keys -l` 密码注入
- native PTY 依赖或第二套 Monitor/Session/Task Ledger
