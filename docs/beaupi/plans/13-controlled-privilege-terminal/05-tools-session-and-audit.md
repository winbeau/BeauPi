> 已移除：M13 受控 sudo 终端已在 Trusted-Local Runtime 升级中删除，本文保留为历史实施记录。

# 05 Tools、Session、Monitor 与 Audit

## 目标

把权限执行接入现有Tool注册、AgentSession生命周期、Monitor、Task Ledger、Session facts和Bash renderer，并增加不含秘密的0600 JSONL审计日志。

## `privileged_exec` Tool

严格union schema：

```typescript
{ execution: "local", command: string, timeout?: number }
{ execution: "terminal", terminalId: string, command: string, timeout?: number }
```

- executionMode为sequential。
- command不允许NUL、空白，且必须包含classifier可确定识别的sudo executable。
- Tool参数不包含mode、grant、confirmation或password字段。
- controlled child、reviewer和Workflow默认profile不暴露该Tool。
- system prompt明确：默认优先直接sudo命令并保留多行批次；交互式root shell不支持；普通local Bash/terminal_bash中的sudo也会自动进入同一受控终端，绝不请求或传递密码。

## Tool Result

`PrivilegeToolDetailsV1`至少包含：

- version、operation、execution、status、ok。
- requestId、auditId、command、targetKey、route/sourceTool。
- confirmedAt、startedAt和terminal lifecycle facts。
- terminalId/targetId/monitorId/logPath。
- exitCode、durationMs、diagnostic。
- 短成功直返或长输出/失败审阅的review metadata与usage。
- Bash truncation/fullOutputPath。
- Policy metadata引用。

Tool `content`复用共享Terminal输出管线：短成功直接返回，失败、诊断或超过100行时返回`review.model`报告；details不复制完整日志或terminal transcript。

## Renderer

- call：`Sudo Bash(command)` 或 `Sudo Terminal Bash [id](command)`。
- waiting：复用permission视觉槽位和`Waiting for user`。
- running：复用Bash animation/elapsed。
- result：调用共享Bash result renderer。
- blocked/interaction_required/terminal recovery失败使用不可折叠简短诊断。
- `ToolExecutionComponent`只根据结构化details/Tool名称切换标题，不解析展示文本。

## AgentSession 与 SDK

- `createAgentSessionServices()`创建session-scoped `PrivilegeRuntime`或允许显式注入。
- `createAgentSession()`注册Tool并绑定Session id/branch facts。
- AgentSession公开runtime getter和interaction handler setter，不公开mode/grant/revoke API。
- branch、reload、Session replacement、dispose顺序先取消pending privilege interaction并恢复terminal，再重建/销毁remote/monitor。
- Compact保留audit facts，但不恢复pending request或任何授权。
- SDK headless默认handler缺失；调用返回interaction_required。

## 替代旧权限模式

- 不实现 `/mode user`、`/mode sudo once` 或 `/mode sudo session <duration>`。
- 不在Footer显示持续sudo状态，不在Session中保存sudo mode。
- 每个sudo request都生成独立permission状态；用户Enter只确认当前展示的完整命令。
- 系统sudoers可能在同一TTY缓存credential，但该事实不会成为BeauPi API、Tool参数或授权状态。
- 旧权限模式阶段已从roadmap删除；实现完成时继续确保requirements和milestones M13不出现mode/expiry交付物。

## Monitor 与 Task Ledger

- 每次privileged execution引用现有Tool或SSH/tmux Monitor record；不新增第二套进程状态。
- local hidden tmux可使用明确Tool monitor或扩展现有terminal monitor target，但必须由MonitorRuntime管理。
- remote沿用terminal monitorId和work log。
- Task Ledger投影waiting_for_permission/running/succeeded/failed/cancelled/blocked，不保存input。
- Footer只显示permission pending聚合，不显示持续sudo mode、命令或密码prompt。

## JSONL Audit

建议路径：

```text
<agentDir>/audit/privileged/YYYY-MM-DD.jsonl
```

或按现有审计目录规范确定最终位置。规则：

- 目录0700、文件0600、append/lock写入。
- 每行严格`PrivilegeAuditEventV1`。
- 记录sessionId、requestId、toolCallId、sourceTool、route、timestamp、event、target、redacted command、exit、duration、monitorId、logPath、diagnostic code。
- 不记录raw input、prompt文本、pane capture全文、环境变量、credential cache内容或Provider auth。
- command使用现有redaction helper；audit引用完整work log而不复制output。
- audit写入失败不能假装成功；命令开始前的requested/confirmed审计失败应保守阻止，命令结束后的final audit失败必须在Tool result显式诊断。

## Direct Bash/Terminal 行为

- ordinary local Bash检测sudo后不进入原Bash executor，直接把同一Tool call路由到`PrivilegeRuntime`。
- terminal_bash检测sudo后不进入普通terminal command path，直接携带terminalId路由到同一Runtime。
- terminal_send在pending input收到Enter前识别sudo，阻止提交并清理未执行shell line，不能通过分片send绕过。
- remote_exec/remote_bash无可控PTY时继续阻止sudo，并要求使用terminal路径。
- permission-denied但命令本身不含sudo时不会自动升级；Agent必须提交明确的sudo命令，随后由router接管。

## 文档

实施完成后更新requirements、architecture、roadmap、milestones、ui-style、SDK/keybindings和Changelog；所有文档必须统一为逐次受控sudo终端，不得重新引入`/mode sudo`、once/session grant或自动超时降权。Changelog遵循用户明确覆盖规则。

## 测试

- Tool schema/details/result/isError/renderer。
- AgentSession handler、branch/reload/dispose和pending request清理。
- local Bash/terminal_bash自动路由，且不存在`/mode`或grant API。
- Monitor/Task Ledger同源和无重复row。
- audit权限、锁、顺序、redaction、failure路径、secret扫描。
- faux provider看得到结果但看不到terminal input。

## 完成状态

- [x] Tool/Session/Audit设计
- [x] Tool与schema
- [x] AgentSession/SDK lifecycle
- [x] sudo router与Footer pending状态
- [x] Monitor/Task Ledger/renderer
- [x] JSONL audit
- [x] tests/docs
