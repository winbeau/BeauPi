# M13 受控 sudo 终端实施计划

状态：已完成并验收（2026-08-01）；本文保留为 M13 实现与安全契约记录。

旧的权限模式阶段已从 `roadmap.md` 删除。本计划作为 M13 的唯一 sudo 方案，不再保留 `/mode sudo once/session` 设计。

## 阶段简介

M13 在现有 `PolicyRuntime`、`AgentSession`、Bash Tool、Remote SSH/tmux Runtime、Monitor、Task Ledger 和 BeauPi TUI 上增加唯一的 sudo 执行闭环。任何实际 sudo 命令都必须经过该模块，不再先切换全局或会话级 sudo 模式。用户体验是：Agent 请求 sudo 后，TUI 显示一个类似 tmux 的权限终端框，命令以只读预填形式展示；用户按 Enter 后，原始命令才被注入受控 PTY，密码只在该 PTY 中输入。执行结束后交互框关闭，Transcript 中留下普通 `Sudo Bash`/`Sudo Terminal Bash` Tool 卡片，输出、截断、完整日志路径和错误语义与 Bash 一致。

## 已确认产品决策

1. 密码不通过 `ask_user_question`、Tool 参数、RPC JSON、Session entry、模型上下文或审计日志传递。
2. `ask_user_question` 只作为 handler 生命周期、焦点切换和 TUI 布局参考；权限交互使用独立 `PrivilegeRuntime` 与 `PrivilegeInteractionHandler`。
3. 第一版不新增 `node-pty`。本地和远程交互统一复用本机 tmux 作为 PTY broker；当前 BeauPi 无需运行在 tmux 内。
4. TUI 中的“预填命令”是只读显示。只有用户按 Enter 后，Runtime 才发送经过审计的原始命令，避免用户编辑后实际命令与审计命令不一致。
5. 终端输入通过 `tmux load-buffer -` 的 stdin 和 `paste-buffer -d -r` 传递，不使用会把密码暴露到进程 argv 的 `tmux send-keys -l <password>`。
6. 不使用 `sudo -S`，不读取、缓存或转发密码；sudo 直接从控制 TTY 读取。
7. 删除 `/mode user`、`/mode sudo once` 和 `/mode sudo session <duration>`；不建立 BeauPi 级 sudo grant，也不让后续命令绕过逐次确认。
8. 普通 local `bash` 和 `terminal_bash` 中可确定解析的 sudo 命令由执行边界自动转交 `PrivilegeRuntime`，不要求模型先失败再改 Tool；原执行器不得直接 spawn sudo。
9. `privileged_exec` 保留为统一的严格内部/模型可见结构化入口，直接 Bash/Terminal 路由也必须归一化为同一 request、审计和 renderer。
10. 每次 sudo request 都显示只读命令并要求用户 Enter。系统 sudoers 自身可能缓存凭据并决定是否再次询问密码，但 BeauPi 不把该缓存当作授权模式，也不使用 `sudo -n` 静默绕过交互框。
11. `terminal_send` 的 pending command buffer 在发送 Enter 前必须检查 sudo；检测到后不得把 Enter 发给pane，必须清理未执行的shell line并要求改用`terminal_bash`/`privileged_exec`。
12. `remote_exec`/`remote_bash` 的 one-shot SSH 没有可控 PTY 时不得执行 sudo；返回使用现有 `terminalId`/`terminal_bash` 路径的结构化诊断，实际执行仍只能经过本模块。
13. 第一版不支持 daemon、IPC、桌面通知、后台 root task、`su` 交互 shell 或把密码交给非交互 RPC 客户端。

## 当前可复用接口盘点

- `PolicyRuntime`/classifier 已能识别本地 Bash、远程命令和 Terminal 命令中的 privilege-changing executable；M13 只增加窄范围执行控制，不恢复 M10 的通用确认阻塞模式。
- `QuestionRuntime`、`AgentSession.setQuestionInteractionHandler()` 与 `InteractiveMode.showQuestionInteraction()` 已证明“Tool 等待用户交互、AbortSignal 取消、不同 run mode handler”模式。
- `showExtensionCustom()` 和 TUI overlay 已提供焦点、编辑器恢复、响应式尺寸与 dispose 生命周期。
- `createBashToolDefinition()`、`OutputAccumulator`、`executeBashWithOperations()` 和 `BashExecutionComponent` 已提供流式输出、截断、完整日志路径、取消和统一 Bash renderer。
- `OpenSshConnection` 已在本机 tmux pane 中运行 SSH，提供 capture、marker、exit code、transcript、Monitor 与 fake adapter。
- `RemoteExecutionRuntime.terminalBash()` 已保证同一个远程 shell 的 cwd/export 环境和 terminal work log。
- `MonitorRuntime`、Task Ledger 和 Tool details 已是生命周期与展示事实源，不创建第二套状态库。
- 当前依赖中没有 `node-pty`；第一版继续避免 native PTY 依赖、Bun binary 打包和 lifecycle-script 风险。

## 安全不变量

- Agent 永远以登录普通用户身份运行；M13 不切换 BeauPi 进程 UID，也不使用 `sudo`, `su`, `doas`, `pkexec`, `runuser`, `setpriv`, `nsenter`, `chroot` 或 `machinectl` 启动 Agent。
- 模型只能提交待执行命令和目标，不能提交密码、授权结果、授权时长或“用户已确认”标志。
- 用户输入字节不会进入 Tool call、Tool result、Session、Monitor activity、Task Ledger、日志、错误文本、telemetry 或子 Agent。
- 交互期间外层 wrapper 先执行 `stty -echo`，并通过 trap/cleanup 恢复 echo；即使用户输入时机错误，输入也不应出现在 pane transcript。
- 所有 sudo command 都必须经过逐次 user-presence；无 handler、非交互模式、目标不匹配或 PTY 不可用时默认阻止。
- BeauPi 不保存 once/session grant，不启动 sudo keepalive，也不依据系统 sudo ticket 推断用户已授权下一条命令。
- local Bash、existing remote terminal 和显式 `privileged_exec` 必须进入同一个 request pipeline；不存在备用 sudo 执行器。
- branch 切换、Session replacement、reload 和 dispose 必须取消 pending interaction、关闭临时 pane 并恢复 terminal echo。
- 审计命令为实际发送的完整 sudo 命令；第一版不允许用户在权限框内编辑命令。

## 目标架构

```text
Coordinator / User Bash / terminal_bash
  └─ sudo request router
      └─ privileged_exec request
          ├─ Policy classifier
          │   └─ validates exact sudo command and target
          ├─ PrivilegeRuntime
          │   ├─ per-request interaction state
          │   ├─ PrivilegeInteractionHandler
          │   ├─ PrivilegeAuditWriter
          │   └─ Monitor / Task Ledger facts
          └─ PrivilegeTerminalAdapter
              ├─ local: hidden local tmux shell pane
              └─ remote: existing terminal_bash local tmux SSH pane
                  ├─ read-only command preview
                  ├─ secure stdin -> tmux load-buffer/paste-buffer
                  ├─ sudo reads controlling TTY
                  ├─ marker/capture/exit code
                  └─ Bash-compatible output/log result

InteractiveMode
  └─ PrivilegeTerminalComponent
      ├─ review: Enter run / cancel
      ├─ authenticating/running: captured pane output
      └─ complete: close overlay, finalize Tool card
```

## 用户流程

### Local Bash

1. Agent 调用普通 `bash`，command 中包含可确定解析的 sudo。
2. Bash execution boundary 在 spawn 前识别 sudo，并把完整命令、cwd、timeout 和 toolCallId 归一化为 `PrivilegeRequestV1`。
3. Tool 卡片切换为 `Sudo Bash — waiting for user`，TUI 打开权限框。
4. 权限框展示 target、cwd、完整命令、日志路径和“输入不会被记录”。
5. 用户按 Enter；Runtime 才向临时本地 tmux pane 注入原始命令。
6. sudo 按系统策略从 controlling TTY 读取密码；输入不回显、不记录。
7. 命令完成后 overlay 关闭，Tool 卡片展示 Bash-compatible 结果；下一个 sudo request 仍需重新确认。

### Explicit `privileged_exec`

- Agent 也可直接提交结构化 `privileged_exec`，用于明确知道需要 sudo 的操作。
- `command` 保存完整、可审计的 sudo 命令；Runtime 不替模型添加或改写 sudo。
- 该路径与普通 Bash 自动路由使用完全相同的 request、handler、PTY、audit 和 renderer。

### Remote Terminal

- `terminal_bash` 中可确定解析的 sudo 在执行前自动转交同一 `PrivilegeRuntime`。
- `terminal_send` 不允许通过分片字面量+Enter绕过：Runtime在pending command提交前检测sudo，清理尚未执行的shell line并返回使用受控路径的诊断。
- 远程提权只在已有 interactive `terminalId` 内执行，保证 controlling TTY、cwd/export 环境和 sudo tty ticket 一致。
- configured SSH login identity 已是 root 时不需要 sudo；普通 `terminal_bash` 继续按已配置身份执行。
- `remote_exec`/`remote_bash` one-shot 路径不承担交互 sudo；第一版不临时拼接密码通道。

### Non-interactive

- print、JSON、RPC 或 SDK 未注册 interaction handler 时返回稳定的 `interaction_required`，不执行 sudo。
- 不存在通过设置 mode、复用 grant 或传入 confirmation flag 绕过该边界的接口。

## Tool 契约

建议模型可见 Tool：

```typescript
privileged_exec({
  execution: "local",
  command: "sudo apt-get install -y curl",
  timeout: 120,
})

privileged_exec({
  execution: "terminal",
  terminalId: "server-shell",
  command: "sudo systemctl restart api",
  timeout: 60,
})
```

规则：

- `command` 是包含 sudo 的完整原始命令；Runtime 只验证和受控执行，不添加、删除或重排命令。
- `execution: "local"` 复用本地 Bash cwd、shellPath、commandPrefix 和输出语义，但不向 root 环境显式透传 Provider/Auth/PI_* secrets。
- `execution: "terminal"` 复用既有 Terminal state、Monitor、work log、capture 和 output reviewer。
- 普通 Bash/Terminal 自动路由产生相同的 `PrivilegeToolDetailsV1`，记录 source tool 和原 toolCallId。
- Tool result 使用严格版本化 `PrivilegeToolDetailsV1`，包含 command、target、route、status、exitCode、duration、monitorId、logPath、auditId、diagnostic 和 Bash truncation facts，不包含交互输入。
- renderer 名称为 `Sudo Bash` 或 `Sudo Terminal Bash [terminalId]`，结果 renderer 复用 Bash。

## 分阶段实施顺序

1. 固化 Privilege request、Tool schema、Session/audit details、sudo 自动路由和 direct-execution 阻断边界。
2. 从现有 Remote adapter 提取共享 local tmux PTY transport，增加 secure stdin、resize、capture、marker 和 echo cleanup。
3. 实现本地 privilege executor 与远程 terminal executor；每个 request 独立确认，不建立 sudo grant。
4. 实现 PrivilegeTerminalComponent、Interactive handler、run-mode boundary 和可配置 keybindings。
5. 注册 `privileged_exec` 与 Bash/Terminal router，接入 AgentSession、SDK、Monitor、Task Ledger、Tool renderer 和 JSONL audit。
6. 同步 requirements、milestones 和 UI 文档中的逐次确认语义；完成 fake adapter、faux provider、短本地 tmux fixture、TUI width/theme、安全回归和全量验收。

## 里程碑

### P1 Contract 与 Policy Boundary

版本化类型、严格 parser、sudo request router、普通执行器 direct sudo 阻止和 controlled child 边界。

### P2 Secure tmux PTY

共享 local tmux transport、stdin-sensitive input、no-echo wrapper、capture/resize/cleanup、无 argv/日志秘密泄漏。

### P3 Local 与 Remote Execution

本地临时 pane、remote existing terminal、逐次用户确认、系统 sudo prompt 和 Bash-compatible result。

### P4 TUI Interaction

只读预填命令、Enter 注入、密码终端、取消、Abort、窄宽度、暗亮主题、dispose 和编辑器恢复。

### P5 Tools、Session 与 Audit

`privileged_exec`、Bash/Terminal 自动路由、AgentSession/SDK wiring、Monitor/Task Ledger、Tool renderer、JSONL audit、run-mode boundary。

### P6 Acceptance

全部定向测试、`./test.sh`、`npm run check`、文档/Changelog 和安全检查通过。

## 验收矩阵

| 能力 | 代码事实 | 自动化验证 |
|---|---|---|
| 密码不进入 Agent | secure stdin channel，无 password schema | argv/stdin/session/log scan |
| 用户 presence | Enter 后才发送 command | fake handler send count |
| 本地 sudo | hidden local tmux PTY | short fake-sudo fixture |
| 远程 sudo | existing terminal pane | FakeSshTmuxAdapter |
| 每次确认 | 每个 sudo request 都等待 Enter | sequential request tests |
| 无 sudo 模式 | 无 once/session grant 或 mode command | API/Session schema tests |
| 非交互阻止 | handler absent => interaction_required/blocked | print/JSON/RPC tests |
| 生命周期清理 | branch/reload/dispose 取消 pending request | Session tests |
| Bash-compatible output | shared accumulator/details/renderer | success/error/truncate tests |
| 安全日志 | 0600 JSONL + no input bytes | filesystem assertions |
| 可视化 | overlay + final Sudo Bash card | dark/light 40/80/120/160 |

## 风险与停止条件

- 若实现需要密码进入 `sudo -S`、环境变量、命令行参数、临时明文文件或 Session，立即停止。
- 若 tmux sensitive input 只能通过 argv 传递，立即停止；必须使用 stdin buffer path。
- 若 remote sudo 不能绑定已有 terminal controlling TTY，不降级为 one-shot SSH 密码管道；返回 unsupported/interaction_required。
- 若实现依赖 BeauPi 级 once/session grant、sudo keepalive 或从 Session 恢复授权，立即停止；每个 request 必须独立确认。
- 若需要新增 native PTY dependency，先单独审查依赖、lifecycle scripts、Bun binary 和跨平台成本，不在第一版静默加入。
- 不通过提高全局 timeout、真实系统密码、真实付费 Provider 或真实 SSH server完成单元测试。

## 预计修改范围

核心候选：

- 新增 `packages/coding-agent/src/core/privilege/`
- `packages/coding-agent/src/core/policy/`
- `packages/coding-agent/src/core/remote/types.ts`
- `packages/coding-agent/src/core/remote/adapter.ts`
- `packages/coding-agent/src/core/remote/runtime.ts`
- `packages/coding-agent/src/core/remote/tools.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/bash-executor.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-services.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/state/task-ledger.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- 新增 `packages/coding-agent/src/modes/interactive/components/privilege-terminal.ts`
- `packages/coding-agent/src/core/keybindings.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

测试候选：

- 新增 privilege runtime/tools/terminal/TUI tests
- `packages/coding-agent/test/suite/` faux AgentSession tests
- Remote fake adapter tests
- print/JSON/RPC interaction boundary tests

文档候选：

- `docs/beaupi/requirements.md`
- `docs/beaupi/architecture.md`
- `docs/beaupi/roadmap.md`
- `docs/beaupi/milestones.md`
- `docs/beaupi/ui-style.md`
- `packages/coding-agent/docs/keybindings.md`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/CHANGELOG.md`（仅在用户明确要求覆盖 contributor gate 时）

## 模块子计划

- [01 Contract 与 Policy Boundary](./13-controlled-privilege-terminal/01-contract-and-policy.md)
- [02 Secure local tmux PTY](./13-controlled-privilege-terminal/02-secure-tmux-pty.md)
- [03 Local 与 Remote executors](./13-controlled-privilege-terminal/03-local-and-remote-executors.md)
- [04 TUI Interaction 与 Keybindings](./13-controlled-privilege-terminal/04-tui-interaction.md)
- [05 Tools、Session、Monitor 与 Audit](./13-controlled-privilege-terminal/05-tools-session-and-audit.md)
- [06 Tests 与 Acceptance](./13-controlled-privilege-terminal/06-tests-and-acceptance.md)

## 实施与验收记录

M13 已按 P1→P6 完成，核心实现提交为 `5affb98b`。后续修改必须继续遵守本文的逐请求确认、secure stdin、无 sudo mode、无授权恢复和单一事实源边界。

- M13 相关定向测试：16 个文件、85 个测试通过。
- 完整非 E2E：`./test.sh` 通过。
- 静态与生成物检查：`npm run check` 通过，无错误、warning 或 info。

## 实时完成状态

- [x] 审计 Question/TUI overlay、Bash、Policy classifier、Remote local tmux 和依赖边界
- [x] 确认无 `node-pty`，第一版采用 shared local tmux PTY
- [x] 固化安全不变量、用户流程、架构和实施顺序
- [x] 创建主计划与六个模块子计划
- [x] P1 Contract 与 Policy Boundary
- [x] P2 Secure tmux PTY
- [x] P3 Local 与 Remote Execution
- [x] P4 TUI Interaction
- [x] P5 Tools、Session 与 Audit
- [x] P6 Acceptance
