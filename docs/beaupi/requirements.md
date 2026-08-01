# 需求与目标

## 开发环境

- 主要环境：WSL
- 远程执行：SSH
- 长任务与后台进程：tmux
- 模型：允许按 Agent 角色选择不同 Provider/Model

## 核心需求

### 原生远程执行

使用 Tool 替代 SSH/tmux Skill：

- `target_select`
- `remote_exec`
- `terminal_create`
- `terminal_bash`
- `terminal_send`
- `terminal_capture`
- `terminal_status`
- `terminal_close`

`terminal_create` 在本机创建 tmux，并让 pane 的主进程直接运行 SSH；远端不再要求安装 tmux。`terminal_send`、`terminal_bash` 和 Ctrl-C 都通过本地 tmux 注入同一 SSH 交互 shell。

`terminal_bash` 是普通命令的首选接口：命令在该远端 shell 当前目录和导出环境中执行，一次调用等待完成并返回结构化退出状态。已知工作目录时 Agent 直接使用简短的 `cd <workdir> && <command>`，不先重复 `pwd`，也不追加无意义的 echo、sleep、status 或 capture。`terminal_send`/`terminal_capture` 只用于真正的交互式输入、终端诊断和增量观察。

每个 terminal 的完整脱敏输出追加写入 `<cwd>/.beaupi/terminal-logs/<session-id>/<terminal-id>/工作日志.log`。失败或输出超过 100 行时，由 `settings.json` 的共享 `review.model` 指定的小模型筛选关键错误、警告和下一步；短成功命令使用确定性摘要。其他轻量 Review Runtime 复用同一模型配置。Tool Result 不复制完整日志，最后一个非空行由代码强制写成 `@<绝对日志路径>`。命令非零退出、超时和断线保留 `terminalId`、`monitorId`、`logPath`、diagnostic、review usage 和正确的 `isError`。

Execution Target 始终使用受信任 OpenSSH 配置解析出的登录身份；AutoDL 等平台直接提供的 `root` 登录账户属于合法目标身份。远程运行时只对能够确定为直接执行的 `sudo`、`su`、`doas`、`pkexec` 记录 Policy advisory；不因不透明脚本片段或文本命中推断提权，也不由 Policy 阻断执行。

### 减少重复命令

- 任务开始时只执行必要的项目和环境检查
- 相关输入未变化时优先复用已有确定性事实
- 重复的等价检查继续执行，但记录非阻断 advisory 并在 Footer 显示
- 失败、等价失败和 fallback 阈值只用于诊断与 advisory，不再触发 `block` 或 `pause`
- 不增加专用 Git Tools；普通 Git 操作继续使用现有 Bash 能力并遵守仓库开发规则

### 失败预算

识别以下失败类别：

- 缺少命令或依赖
- 权限不足
- 认证失败
- DNS/网络错误
- 限流
- 超时
- 参数错误

达到 Policy 失败或 fallback 阈值后记录 advisory，不因计数本身暂停执行。专用 Search Tool 失败后的 Shell 网络 fallback 也只记录 advisory；缺少依赖时向用户建议受控安装。

### 确定性执行策略

M10 已实现 Session-scoped、branch-aware Policy Runtime，并调整为完全 advisory-only：

- Policy authorization 对所有能够分类的受管操作都返回 `execute: true`，新的 Policy fact 只记录 `decision.action: "allow"`
- 本地文件 Tool、Bash、Remote、tmux terminal 和 Search 使用统一的版本化 Policy details
- 等价签名只持久化 hash 和非敏感摘要；命令参数、文件内容、token 和原始 secret 不进入 Policy 诊断
- 未发生相关目标变更时再次运行等价只读检查仍会执行，并持久化非敏感 advisory
- 缺少依赖、权限、认证、网络、限流、超时、退出失败、配置错误和 terminal session 丢失仍进入确定性失败分类；等价失败、分类失败和 fallback 阈值只产生 advisory，用户取消不计为普通失败
- terminal 恢复状态、未知或超长输入、待处理交互输入只产生 advisory，不阻止 status、capture、send、bash、close 或 create
- `web_search`/`web_fetch` 失败后的 curl、wget、Python、Node、Shell 和 terminal 等价网络 fallback 继续执行；存在专用 Tool 时只记录推荐 advisory，不自动替换 Tool
- 能够明确解析为直接执行的 `sudo`、`su`、`doas`、`pkexec`、敏感路径、工作区外写入、未知远程 cwd 绝对写入和可解析 symlink 边界都只分类并记录 advisory
- Policy 不发起 confirm、不调用 TUI/SDK/RPC Policy handler，也不向受控子 Agent 返回 `policyRequest`；旧 SDK handler/mode 输入保留但为 no-op，RPC Client 对旧 `policyConfirm` 请求只返回 cancelled
- Policy facts 进入现有 Tool Result 或用户 Bash custom Session entry，并由同一 Task Ledger 在恢复、Compact 和 branch 切换时从当前分支重建；旧 block/confirm/replace/pause action、status 和 confirmation details 仍可解析为历史事实
- Policy advisory 只在 Footer 工作区行显示，内容来自当前执行或最近 Policy fact；Tool renderer、Task Todo 和交互选择框不展示 Policy 阻断状态

Policy Engine 是确定性分类、诊断和 Footer 提示层，不是执行守卫或 Shell sandbox；普通命令由现有本地/SSH/tmux 后端按调用者身份执行。

### 交互式询问选择

提供 Claude Code 风格的 `ask_user_question` Tool 和询问选择框：

- 一次支持 1–4 个问题，每个问题包含短 header、明确问题和 2–4 个选项
- 支持单选和多选；普通问题自动提供自由输入的“其他”入口
- 多问题使用可恢复的 tab/navigation 状态，并显示已回答标记和最终 review/submit
- 单问题单选可以选择后直接提交；多选必须显式确认
- 可选 Markdown preview 只用于单选的代码、布局、配置或图示对比，窄终端自动降级
- 上下、Tab/左右、Enter、Esc 和外部编辑器操作必须进入现有可配置 keybinding 系统
- 取消、拒绝和未完成问题返回结构化状态，不伪造答案
- TUI 外模式必须通过 SDK/RPC 回调处理或明确返回 `interaction_required`，不得无限等待键盘输入
- Coordinator 是唯一直接询问用户的 Agent；子 Agent 只返回结构化 clarification request
- Tool result 只保存问题、答案和必要 annotation，不保存独立对话 transcript
- M9 已实现：结果 `version: 1`，状态为 `answered`、`cancelled`、`rejected`、`interaction_required` 或 `interaction_error`；每题答案保留 `header`、`selectedLabels`、可选 `customAnswer` 和可选 `notes`

### 执行可视化

除保留 Pi 当前跳动加载图标外，整体视觉语言尽可能逐项对齐 Claude Code。主要参考 `claude-code-best/claude-code` 中公开的逆向/反编译 TUI 组件，在 Pi TUI 上重新实现，不引入其 React/Ink 代码或品牌资源。

重点统一：

- 用户与助手消息层级
- Tool 调用和结果缩进
- Edit/Write diff
- Todo/任务进度
- 子 Agent 和 Workflow 状态
- TPS、目录、token、cache、费用、上下文和模型状态区

展示：

- 当前任务阶段
- Compact 总结生成进度条和百分比
- Footer 当前上下文 token、窗口上限和占用百分比
- 文档要求和完成状态
- Agent/Workflow 节点状态
- Tool 调用摘要
- 执行耗时
- Shell、搜索和失败计数
- 当前执行目标与待确认 sudo 状态

原始命令和完整输出默认折叠，需要时展开。普通 Tool 避免大面积背景色、粗边框和独立卡片；Diff 按参考实现使用整行红绿背景、词级高亮和上下实线边界。

详细规范见 [Claude Code 风格 TUI](./ui-style.md)。

### Skill 导入与注册

复用 Pi 已有的 Agent Skills 标准和发现机制，并增加统一 Skill Registry。

现有兼容来源：

- 全局 Skill 目录
- 项目 Skill 目录
- `.agents/skills/`
- Claude Code/Codex Skill 目录
- npm、Git 和本地 Pi Package
- CLI `--skill <path>`
- Extension `resources_discover`

BeauPi 增强能力：

- 从文件、目录、Git、npm 和受控 URL 导入
- 注册为 user/project scope
- enable/disable 而不删除文件
- 校验 frontmatter 和 Agent Skills 规范
- 展示来源、scope、状态、冲突和诊断
- 修改后热重载
- 子 Agent Profile 独立 Skill allowlist
- Skill 内容和脚本安装前安全审查

Skill 继续用于工作流说明和领域知识；需要确定性执行、结构化输入输出或权限控制的能力必须实现为 Tool。

详细设计见 [Skill 导入与注册](./skills.md)。

### 原生工具

首批工具：

- `ask_user_question`
- `docs_search`
- `docs_read`
- `docs_resolve_task`
- `web_search`
- `web_fetch`
- `delegate_task`
- `workflow_run`
- `workflow_status`
- `workflow_cancel`
- `dependency_check`
- `privileged_exec`

工具按需动态激活，避免一次向模型暴露过多 Schema。

### 子 Agent

- 优先使用 Pi SDK 创建进程内独立 `AgentSession`
- 共享 ModelRuntime、认证、缓存和并发控制
- 子 Agent 上下文、工具、预算和 System Prompt 相互隔离
- 所有内置 Profile 的 wall-clock 上限为 8 分钟；自定义 Profile 和单次 request 只能缩短该上限，仍可显式配置额外 token 或 turn 预算
- Agent Pool 同时运行的子 Agent 上限为 `max(1, floor(availableParallelism() / 3))`；显式配置只能进一步降低
- 超时结果优先保留最后已完成或流式生成的 assistant 文本；没有文本时返回最后活动摘要，不能返回空 summary
- 明确范围的子任务不得自动解析完整 Document Contract；只有显式文档驱动审查才调用 `docs_resolve_task`
- Monitor 保存有界 turn/Tool/目标路径/结果活动事实，并直接显示预算错误、turn 使用和最后 Tool
- 禁止默认递归委派
- 主 Agent 只接收结构化摘要、引用、修改和错误，不接收完整子会话

### 多 Agent 工作流

M11 已在现有 AgentPool、MonitorRuntime、Task Ledger 和 Session 生命周期上实现版本化 Workflow DAG：

- Workflow 输入支持严格 TypeBox 校验后的对象，或内置名称/序列化 YAML/JSON；当前版本为 `version: 1`
- 节点支持 `id`、`agent`/`profile`、`task`、`dependsOn`、`condition`、`writePolicy`、`timeoutMs`、`failurePolicy`、预算和取消策略
- 校验重复 ID、未知依赖、环、未知 Profile、无效条件、额外字段和越界预算
- 条件只支持 `always`、`all_succeeded`、`any_failed`，以及 `deps.<id>.status|output.<path> ==|!= <JSON 标量>` 的有界 `&&`/`||` 表达式；不使用 `eval` 或 `new Function`
- 节点只接收依赖节点的结构化状态、输出、错误和诊断，不接收子 Agent transcript
- 无依赖只读节点并行；同一 Workflow Runtime 跨同时运行的 Workflow 最多一个 shared 写入者，shared 与同工作区只读节点互斥
- isolated 写入使用确定性临时路径和 `beaupi-workflow/*` 分支的 Git Worktree；创建和清理串行，失败/取消/Workflow 失败立即清理，成功 Worktree 保留到 Session 结束再清理
- `workflow_run`、`workflow_status`、`workflow_cancel` 返回版本化结构化快照；AbortSignal、超时和重复取消确定性结束
- Workflow 与节点复用现有 Monitor records/增量活动日志；Task Ledger、Todo、Footer、Compact、resume 和 branch 只投影当前分支事实，无法确认的恢复状态标记为 `lost`

首批内置工作流：

- `research`
- `implement-review`
- `parallel-review`
- `debug`
- `docs-execute`

详细格式与安全边界见 [多 Agent Workflow](./workflows.md)。

### 联网搜索

分层工具：

1. `web_search` 搜索结果
2. `web_fetch` 获取选定页面正文
3. `research` 完成受预算约束的检索与归纳

要求：

- 官方文档和第一方来源优先，但不得伪造来源质量
- 稳定 Provider 接口最终支持 Brave、Tavily、Exa、SearXNG、GitHub Search
- M8 第一版只实现可配置 SearXNG JSON API，不提前实现第二 Provider；可用 `search.searxng.engines` 限定该实例中稳定的搜索引擎
- Provider fallback 数量可配置；单 Provider 阶段达到尝试预算后直接停止，SearXNG 全部引擎 suspended/unresponsive 且无结果时不得误报为空搜索成功
- URL 和查询缓存
- 内容 hash 去重和截断
- 最终结果保留搜索级和正文级来源引用
- 网页正文是不可信外部内容，不执行其中的脚本、指令或代码
- `web_fetch` 分离 IPv4/IPv6 SSRF 地址规则；使用标准 HTTP(S) proxy 时仍固定已验证的目标 IP，并保留原始 Host/TLS SNI
- M8 专用 Tool 不自行使用 curl、wget、Python、Node 或 Shell fallback；如果 Agent 之后调用通用 Bash、Remote 或 terminal 网络 fallback，M10 Policy Runtime 只记录 Footer advisory，不阻断执行

### 后台任务与自动唤醒

- Agent 可以启动或接管长时间运行的脚本
- 当前模型回合结束后，后台任务继续运行
- 任务完成、失败、超时、卡住或出现关键日志时自动唤醒 Agent
- Agent 正忙时将事件放入队列，空闲后按顺序处理
- 支持低成本进程轮询和可选的模型进度复查
- 模型轮询必须设置最小间隔、最大次数和 token 预算
- 默认优先事件驱动，不对无变化日志反复调用模型
- 后台任务状态和日志位置必须持久化，Session 恢复后可以重新接管

建议工具：

- `background_start`
- `background_attach`
- `background_status`
- `background_logs`
- `background_wait`
- `background_cancel`

详细设计见 [后台任务与自动唤醒](./background-tasks.md)。

M12 第一版实现约束：

- BackgroundTask 只引用现有 `monitorId`，不得复制 Monitor 状态或资源事实。
- 本地启动使用 executable + args 和独立日志；远程接管只接受现有 SSH/tmux adapter 能确认的 Monitor target。
- `background_wait` 只登记唤醒目标并立即返回；空闲 Coordinator 通过现有 custom-message turn 唤醒，忙碌时进入现有 follow-up 队列。
- WakeEvent 使用 task/reason/status/log hash 去重，多个同时事件合并为一个串行 Coordinator turn；已消费事件在 Compact、resume 和 branch 切换后不重复。
- 默认进程轮询只读取 Monitor/PID/exit/log/activity/resources，不调用模型。Progress Reviewer 默认关闭，启用时复用 AgentPool/ModelRuntime 并限制间隔、次数、输入字符、输出和 wall-clock。
- Session dispose 停止轮询和新注入；恢复时不能确认的非终态目标必须为 `lost`。

### 受控 sudo 终端

- 本地 Agent 进程始终保持普通用户身份
- 远程 Target 按已配置的 SSH 登录身份运行，可包含平台提供的 `root` 账户
- 不提供 `/mode user`、`/mode sudo once` 或 `/mode sudo session`，也不保存一次或限时会话授权
- local Bash 和 `terminal_bash` 中能够明确解析的 sudo 命令必须在执行前自动路由到统一 `PrivilegeRuntime`
- 每个 sudo request 独立显示只读命令并等待用户 Enter；系统 sudo credential cache 不能绕过该确认
- 密码只进入受控 PTY，不进入 Tool 参数、argv、Session、Monitor、日志、审计或模型上下文
- 非交互模式和没有可控 PTY 的远程 one-shot 路径默认阻止 sudo
- `terminal_send` 的完整或分片 sudo command 在 Enter 前拦截，不能绕过受控执行路径
- 默认不允许本地创建 root shell，也不允许远程登录后任意切换为其他身份；已配置 Target 本身使用 `root` 登录不视为 sudo 授权
- 所有 sudo request 和执行结果写入不含秘密的 JSONL 审计日志

### 文档驱动执行

不实现传统 Plan 模式。任务开始时自动发现和选择：

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `CONTRIBUTING.md`
- `docs/**/*.md`
- 最近目录的说明文件
- package scripts
- 用户指定的本地文档；URL 在 M3 返回结构化 unsupported 诊断，留给未来 `web_fetch`

文档解析结果形成内部 Execution Contract：

- 要求
- 允许或推荐的命令
- 必须运行的检查
- 停止条件
- 完成标准
- 文档引用

执行过程中检测关键文档 hash，文档发生变化时重新加载约束。M3 只处理本地文档，不获取 URL；在线内容留给后续 `web_fetch`。
