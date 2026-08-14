# 受控 sudo 终端（已移除）

状态：M13 已实现并完成全量验收（2026-08-01），随后在 Trusted-Local Runtime 升级中删除（2026）。

M13 的 `PrivilegeRuntime`、`privileged_exec`、受控 tmux PTY、逐请求 Enter 确认、`terminal_send` sudo 拦截和 JSONL 审计已全部移除。`sudo`、`su`、`doas`、`pkexec` 等命令现在由普通 Shell executor 按宿主 OS 权限直接执行，不检查、预览、拦截或要求 Enter；root 与普通用户行为完全由宿主 OS 决定。

当前权限模型：

- Agent 使用启动 BeauPi 的同一 OS 用户、cwd、环境和文件权限执行工具；
- Shell 继承宿主完整环境，不提供 env scrub、workspace containment、OS sandbox、root 降权或网络限制；
- 这不是 Web auth、sandbox 或安全承诺。

设计历史参见 `plans/13-controlled-privilege-terminal.md` 与 `plans/13-controlled-privilege-terminal/`。
