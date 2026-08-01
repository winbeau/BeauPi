# 系统架构

## 总览

```text
BeauPi CLI / TUI
│
├── Coordinator
│   ├── Task Ledger
│   ├── Document Runtime
│   ├── Skill Registry
│   ├── Agent Pool
│   ├── Monitor Runtime
│   ├── Workflow Engine
│   ├── Background Task Manager
│   ├── Policy Engine
│   └── Privilege Runtime
│
├── Execution Boundaries
│   ├── Ordinary User Execution
│   └── Per-request Controlled Sudo
│
├── Execution Backends
│   ├── Local WSL
│   ├── SSH
│   └── local tmux SSH panes
│
├── Native Tools
│   ├── Interaction
│   ├── Documents
│   ├── Search
│   ├── Remote/Terminal
│   ├── Multi-Agent
│   ├── Background Tasks
│   └── Privileged Operations
│
└── Observability
    ├── Task Status
    ├── Workflow DAG
    ├── Claude-style Tool/Diff Renderers
    ├── Tasks Widget
    ├── Usage Footer
    ├── Failures
    └── Background Progress
```

## 包与目录策略

BeauPi 直接扩展现有 `packages/coding-agent`，不创建 `packages/beaupi`、第二个 Coding Agent Package 或独立 Runtime。内部模块遵循现有目录职责，在需要时增量增加子目录：

```text
packages/coding-agent/
├── package.json
├── src/
│   ├── core/
│   │   ├── documents/       # Document Runtime 和 Execution Contract
│   │   ├── skills/          # Skill Registry、导入和诊断
│   │   ├── agents/          # Agent Pool、Profile 和委派
│   │   ├── monitor/         # 进程、Tool、子 Agent 和远程目标监控
│   │   ├── workflow/        # DAG、调度和节点状态
│   │   ├── background/      # 后台任务和唤醒队列，复用 Monitor Runtime
│   │   ├── questions/       # 询问 schema、pending interaction 和结构化答案
│   │   ├── policy/          # 命令、失败、预算分类和 advisory
│   │   ├── privilege/       # 逐请求 sudo 路由、受控 PTY、交互与审计
│   │   ├── state/           # Task Ledger 和持久化状态
│   │   └── tools/           # 内置结构化工具
│   └── modes/
│       └── interactive/     # BeauPi TUI、Footer、Todo 和渲染器
└── test/
```

实际实现前先检查并复用现有模块，不为满足该示意图而搬迁稳定代码。CLI、配置、Session、ResourceLoader、Tool 和 TUI 生命周期继续使用现有实现，BeauPi 功能直接接入这些路径。

## TUI 视觉层

视觉层保留 Pi 的加载动画，替换 Tool shell、diff、Todo、Workflow 和 Footer 渲染。默认不使用 Pi 当前 ToolExecutionComponent 的整块状态背景，而由自定义 renderer 使用紧凑的 Claude Code 式层级。

Footer 使用自定义 `setFooter()` 组件，并从 Session、模型、Git branch 和 TPS 状态读取数据。详细规范见 [Claude Code 风格 TUI](./ui-style.md)。

## Agent Pool

子 Agent 使用 Pi SDK 在当前进程创建独立 Session：

- 共享 `ModelRuntime`
- 共享认证和 Provider 配置
- 共享搜索/文档缓存
- 独立消息上下文
- 独立 Tool allowlist
- 独立 System Prompt
- 独立超时、轮数和 token 预算

子 Agent 使用受控 ResourceLoader，避免加载委派工具并递归创建 Agent。受控 Loader 复用 Coordinator 已完成的 discovery/runtime，不调用第二次 reload；M4 的 `createSkillAllowlistOverride()` 负责 allow/deny 投影。

`AgentPool` 只把以下结构化结果交还 Coordinator：

```typescript
interface AgentTaskResult {
  taskId: string;
  profile: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  summary: string;
  citations: Array<DocumentCitation | WebCitation>;
  references: string[];
  filesModified: string[];
  checks: AgentTaskCheck[];
  diagnostics: string[];
  clarificationRequest?: AgentClarificationRequest;
  lastActivity?: AgentTaskActivity;
  error?: AgentTaskError;
  usage: AgentTaskUsage;
  budget: AgentTaskBudgetSummary;
}
```

生命周期事件携带稳定 task ID、Profile、任务摘要、时间、状态、预算、最后活动和错误；progress 记录 turn、Tool、目标路径与 started/succeeded/failed 结果，单次 terminal event 可直接由 M6 Monitor Runtime 消费。默认 reviewer 只设置 300 秒 wall-clock timeout，不设置 output token 或 turn 上限；子任务 prompt 跳过自动 Document Contract preflight，只有显式文档驱动审查才使用 `docs_resolve_task`。子 Agent 的完整消息历史只存在于其内存 Session，不进入 Coordinator branch。

## Skill Registry

Skill Registry 建立在 Pi 的 Skill discovery、Pi Package 和 `resources_discover` 之上。Registry 维护来源、scope、启停状态和诊断；导入完成后通过命令上下文调用 `ctx.reload()`。第一版优先复用现有接口，确有需要时直接在 `packages/coding-agent` 中扩展 ResourceLoader 和相关生命周期。

子 Agent 创建受控 ResourceLoader 时，根据 Agent Profile 过滤可用 Skill，避免所有 Skill 自动注入每个子 Agent。详细设计见 [Skill 导入与注册](./skills.md)。

## Workflow Engine

M11 `core/workflow/` 直接组合现有 AgentPool、MonitorRuntime、SessionManager 和 Tool registry，不创建第二个 Agent Runtime、ResourceLoader、Monitor、Task Ledger、Tool 执行链或输入循环。

工作流使用 `version: 1` 的严格 TypeBox Schema，并可从对象、内置名称或序列化 YAML/JSON 加载。每个节点声明：

```typescript
interface WorkflowNodeDefinition {
  id: string;
  agent?: string;
  profile?: string;
  task: string;
  dependsOn?: string[];
  condition?: string;
  writePolicy?: "none" | "isolated" | "shared";
  timeoutMs?: number;
  failurePolicy?: "fail-workflow" | "continue" | "skip-dependents";
  budget?: { maxTokens?: number; maxTurns?: number };
  cancelStrategy?: "abort" | "graceful";
}
```

调度规则：

- 先校验重复 ID、未知依赖、环、Profile、条件、额外字段和预算，再创建任何子 Agent 或 Worktree
- 条件使用有界解析器：常量或 `deps.<id>.status|output.<path> ==|!= <JSON 标量>`，支持最多 16 个 `&&`/`||` 子句，不执行代码
- 无依赖只读节点并行；Workflow 自身的 `maxConcurrency` 与 AgentPool 全局并发槽位同时生效
- 同一 Workflow Runtime 跨并发 Workflow 最多一个 shared 写入者；shared 与同一工作区只读节点互斥，isolated 节点可并行
- isolated 节点由 `WorkflowWorktreeManager` 通过现有无 shell `execCommand()` Git 调用创建；路径位于受控临时根，分支使用 `beaupi-workflow/*`，创建/清理串行且只删除 Runtime 自己生成的路径和分支
- 失败/取消/Workflow 非成功终态立即清理 Worktree；成功 isolated Worktree 保留到 Session 结束，供 Coordinator 检查或整合，然后确定性清理
- 节点 prompt 只附加依赖节点的结构化 `AgentTaskResult`、状态、错误和诊断，不附加完整 transcript
- `fail-workflow` 取消其余节点，`continue` 允许依赖节点按条件继续，`skip-dependents` 跳过传递依赖
- Workflow/节点快照只通过 `workflow_run/status/cancel` Tool Result 和现有 Monitor custom entries 持久化；恢复时无法确认的非终态标记为 `lost`

`workflow_run` 同步等待 DAG 到达终态，不实现 M12 的后台自动唤醒；`workflow_status` 和 `workflow_cancel` 可由 SDK、并行 Tool 调用或后续回合查询/取消。详细契约见 [多 Agent Workflow](./workflows.md)。

## Document Runtime

M3 Document Runtime 位于 `core/documents/`，由现有 `AgentSessionServices` 按 cwd 唯一持有。它复用 `ResourceLoader.getAgentsFiles()` 的 AGENTS/CLAUDE 祖先发现行为，再在项目范围内发现 README、CONTRIBUTING、`docs/**/*.md`、附近 Markdown 和最近 package.json scripts。

Runtime 提供 Markdown heading/行范围索引、内容 hash、有限缓存、相关性排序、结构化 citation 和 Contract stale/rebuild。它使用稳定 canonical path/id，不把所有 docs 注入 System Prompt。只有当前 active Contract 的精简摘要进入现有 `buildSystemPrompt()`；stale Contract 会被移除。

```typescript
interface ExecutionContract {
  version: number;
  id: string;
  task: string;
  documents: DocumentReference[];
  requirements: Requirement[];
  allowedCommands: DocumentedCommand[];
  requiredChecks: RequiredCheck[];
  stopConditions: StopCondition[];
  completionCriteria: CompletionCriterion[];
  documentHashes: Record<string, string>;
  status: "active" | "stale";
  diagnostics: DocumentDiagnostic[];
}
```

`docs_search`、`docs_read` 和 `docs_resolve_task` 是现有 Tool registry 中的内置 Tool，使用 M1 minimal shell 和结构化 `details`。`docs_resolve_task` 不启动 Agent 或 Provider。Contract details 使用版本化 `documentRuntime` key；自动解析和 Tool Result 都存入当前 Session branch，Task Ledger 只从当前 branch 重建。

Execution Contract 约束 Agent 执行，但不引入独立 Plan Mode。Document Runtime 负责文档内容、索引、引用和 Contract；Task Ledger 保留 requirement/check/completion 的证据状态，但 Tasks Widget 只投影 actionable required check 和 completion criterion，不单独展示文档 Contract 或 Requirement Todo。关键文档 hash 变化后旧 Contract 不再作为有效约束。详见 [Document Runtime 设计](./document-runtime.md)。

## 询问选择框

M9 在现有 AgentSession、Tool registry 和 InteractiveMode selector 生命周期上增加 `ask_user_question`，不创建第二套输入循环或对话 Runtime：

```text
AgentSession
└── ask_user_question
    ├── Question schema validation
    ├── Pending interaction state
    ├── Claude-style Question Selector
    │   ├── single select / multi-select
    │   ├── Other free-text input
    │   ├── question tabs and review
    │   └── optional Markdown preview
    └── structured answers / annotations
```

输入限定为 1–4 个唯一问题，每个问题包含不超过 12 个显示字符的 header、2–4 个唯一选项、单选/多选标记和可选 preview。普通问题由 UI 自动提供“其他”自由输入，不允许模型重复构造 `Other` 选项。

单问题单选在选择后直接完成；多问题或多选保留每题状态，通过 tab/左右键切换并在最终 review 后提交。所有按键使用现有可配置 keybinding；Esc 返回结构化 `cancelled`，SDK/RPC host 还可明确返回 `rejected`。可选 preview 只支持不可信 Markdown 文本，不执行 HTML、脚本或代码；窄终端退化为纵向选项和折叠 preview。

TUI 外模式不能等待不存在的键盘输入：SDK/RPC 可提供 interaction callback，否则 Tool 返回结构化 `interaction_required`。受控子 Agent 默认没有该 Tool，只能把 clarification request 返回 Coordinator，由 Coordinator 决定是否询问用户。

参考 `../claude-code/` 中的 `AskUserQuestionTool`、`AskUserQuestionPermissionRequest`、`QuestionView`、`QuestionNavigationBar`、`SubmitQuestionsView` 和 preview 组件重新实现行为；只提炼交互和布局，不复制 React/Ink 代码或品牌资源。

M9 已落地为 Session-bound `QuestionRuntime`：Tool result 继续走普通 Agent message/Session JSONL 生命周期，Task Ledger 从当前 branch 重建完成交互事实，并只在实际等待回答时投影一个 `owner: user` 的 blocked Todo。InteractiveMode 使用现有 custom UI editor replacement/focus 恢复；RPC 复用现有 `extension_ui_request`/`extension_ui_response` id 关联；Print/JSON 和无 handler SDK 不读取 stdin，立即返回 `interaction_required`。受控子 Agent 在 Tool allowlist 和 custom Tool 投影后仍硬排除 `ask_user_question`，并通过 `<clarification_request>` 结果约定返回机器可读澄清请求。

## Policy Engine

M10 Policy Engine 已作为现有 AgentSession 的 session-scoped 服务实现。它在 Tool wrapper/用户 Bash 执行前分类，在现有 `afterToolCall`/用户 Bash 完成路径中 finalize，并从当前 Session branch 的 Tool Result 或 `beaupi.policy.fact` custom entry 重建；Compact 不复制状态，branch 切换只使用目标分支事实。

新的 Policy authorization 始终返回 `execute: true`，对应 fact 始终记录 `decision.action: "allow"`；Policy Runtime 不再返回执行阻断、replacement、pause 或 confirmation。旧 Session 中的 `block`/`confirm`/`replace`/`pause` action、status 和 confirmation details 仍可被解析为历史事实，但不会驱动当前 Tool UI。旧 SDK `policyHandler`/`policyInteractionMode` 输入保留为无操作兼容接口，RPC Client 收到旧 `policyConfirm` 请求时只返回 cancelled。

主要策略：

- quote/operator/pipeline/redirection/multiline-aware Shell 分类和 hash-only 等价签名
- 本地、Remote、terminal、Search 与用户 Bash 的统一失败/类别/fallback 预算诊断
- 目标 revision 驱动的等价只读检查 advisory，以及并发 mutation 的单调 revision 更新
- 缺少依赖、权限、认证、网络、限流、超时、退出失败、配置和 session-lost 分类
- 敏感路径、工作区外写入、未知远程 cwd 绝对写入和可解析 symlink 边界 advisory
- 能够明确解析为直接执行的 sudo/su/doas/pkexec、terminal 未知/超长/待处理输入和 Search-to-Shell fallback advisory
- 存在专用 Tool 时记录推荐 advisory，但不替换或阻止原 Tool
- Policy 不发起 TUI、SDK 或 RPC interaction，受控子 Agent 不返回 Policy confirmation request
- Policy details 进入现有 Task Ledger；当前执行或最近 Policy fact 的 advisory 只渲染在 Footer 工作区行

Policy Runtime 使用串行分类队列，使并发预算和目标 revision 更新具有确定顺序；原始命令、文件内容和 token 不进入 Policy 持久化诊断。它是诊断与可视化层，不是执行守卫或 Shell sandbox。

BeauPi 不增加专用 Git Tools。普通 Git 操作继续使用现有 Bash 能力、项目文档约束和仓库开发规则；Policy Engine 只对其应用通用的重复命令、失败预算和敏感/权限 advisory。

## State

Task Ledger 记录：

```typescript
interface TaskLedger {
  taskId: string;
  phase: "discover" | "execute" | "verify" | "commit";
  commands: CommandRecord[];
  filesRead: FileReadRecord[];
  filesModified: string[];
  failures: FailureRecord[];
  workflowNodes: WorkflowNodeState[];
  requirements: RequirementState[];
}
```

分支敏感状态存入 Tool Result `details`，在 `session_start` 时从当前 Branch 重建。

M2 已实现该最小状态层；M3 在同一 snapshot 上增加当前 Contract、文档、requirement、required check、completion criterion、诊断和来源 citation：

- `AgentSession.taskLedger` 是唯一任务状态源。
- Tool 以稳定 `toolCallId` 去重，用户 Bash 以 Session entry id 重建。
- 只记录当前 Session 可确定的 Tool、Shell、文件和验证事实。
- workspace revision 只随账本确认的文件修改推进，用于短时间重复 `git status` 检测。
- M11 Workflow Runtime 将实时结构化快照投影到同一 Ledger；Workflow Tool Result 和 Monitor records 负责分支恢复，Tasks Widget 与 Footer 只消费 Ledger/Monitor snapshot，不读取或驱动调度器。

## Remote Terminal transport

M7 Terminal 使用“本地 tmux + pane 内 SSH”，不在远端运行 tmux：

```text
terminal_create
└── local tmux session/pane
    └── exec ssh <trusted target>
        └── remote login shell
            └── marker-wrapped terminal_bash command
```

本地 tmux 负责 session/pane 生命周期、`send-keys`、Ctrl-C、capture 和临时 pane transcript；OpenSSH 继续负责受信任 alias、Agent、known_hosts、ControlMaster 和登录身份。随机 begin/end marker 只属于 transport 协议，不要求 Agent 编写。pane transcript 用于无固定历史行上限地收集当前命令输出，命令完成后只把脱敏内容追加到每 terminal 的 `工作日志.log`；原始 transcript 在 terminal 关闭或 Runtime dispose 时删除。

`TerminalOutputReviewer` 与 transport 解耦。默认实现通过现有 `ModelRuntime` 解析 `terminalOutputReview.model`，在失败或输出超过 100 行时进行一次无 Tool 审阅；不设置独立的模型输出 token 硬限制。Tool Result 只保存审阅文本、结构化状态、usage 和日志路径，代码强制最后一行为 `@<绝对日志路径>`。AgentSession 根据版本化 `details.ok` 设置 `isError`，不靠异常文本或 renderer 反推。

## Monitor 与后台任务

Monitor Runtime 是本地进程、Tool、子 Agent、Workflow/节点、SSH 连接和本地 tmux SSH terminal 的统一观察层，内部只有一个 session-scoped `MonitorRegistry` 保存 `MonitorRecord`；它不创建 Agent、Session、ResourceLoader 或第二套任务状态系统。Runtime 负责确定性状态、最后活动时间、资源快照、增量日志 cursor/hash、生命周期事件去重和可视化。它不从日志文本猜测业务结论，也不会在无变化时调用模型。

M6 的 Process adapter 只检查 PID、退出码、日志位置/identity/hash 和资源快照；Tool/Sub-Agent adapter 消费现有 `AgentSession`/`AgentPool` 生命周期事件。`starting`、`running`、`healthy`、`stalled`、`completed`、`failed`、`cancelled`、`lost` 是唯一 Monitor 状态，无法确认恢复目标时使用 `lost`，不推断成功。M11 Workflow adapter 只消费 Workflow Runtime 的结构化状态和取消入口；节点 turn/Tool 活动进入现有有界 activity log，可继续通过 `monitor_status`、`monitor_logs`、`monitor_wait` 和 `monitor_stop` 查询。M7 SSH/tmux adapter 以本地 tmux session 是否存在和 pane 内 SSH 是否存活作为 terminal 的确定性事实。

Background Task Manager 管理长进程、状态轮询、日志增量和唤醒队列，并复用 Monitor Runtime；进程完成或满足触发条件后，才通过现有 Session 消息机制重新触发 Agent turn。M6 先交付 Monitor，M12 再增加后台自动唤醒。

系统区分两种轮询：

- 进程轮询：只检查 PID、退出码、日志位置和内容 hash，不调用模型
- 模型复查：只在有新进度、长时间无变化或达到用户配置的复查周期时调用

唤醒事件必须去重并串行处理，避免同一任务同时触发多个 Agent turn。详细设计见 [后台任务与自动唤醒](./background-tasks.md)。

M12 已按该边界落地：

```text
AgentSession
├── MonitorRuntime / MonitorRegistry       # 目标状态唯一来源
├── BackgroundTaskManager                  # task/trigger/wake/review 消费事实
│   ├── BackgroundProcessAdapter           # 保留 runner-owned child exit facts
│   ├── adaptive scheduler                 # 只调用 Monitor poll/logs
│   ├── deterministic Trigger Evaluator
│   ├── serialized Wake Queue
│   └── AgentPool Progress Reviewer        # optional, bounded, read-only
└── sendCustomMessage()
    ├── idle: triggerTurn
    └── busy: followUp
```

Background store 使用 `beaupi.background.snapshot` 版本化 custom entry。Task 本身不保存独立进程状态；Tool details、Task Ledger、Todo、Footer 和 renderer 都从 Manager snapshot 中引用同一 MonitorRecord。branch rebuild 顺序为 Task Ledger/Policy 重建、Workflow 取消、Monitor rebuild、Background rebuild、Workflow rebuild；Session dispose 先停止 Background wake/scheduler，再销毁 Monitor。

## 权限边界

BeauPi 不以 root 身份启动，也不提供 sudo mode、root shell 或 session grant。M13 使用唯一的 session-scoped `PrivilegeRuntime` 接收 `privileged_exec`、local `bash` 和 `terminal_bash` 路由的完整 sudo command；每个 request 都必须在 TUI 中独立确认。

```text
AgentSession
├── PrivilegeRuntime                 # request 状态机与唯一结果事实
│   ├── local tmux command session
│   └── existing remote terminal pane
├── MonitorRuntime / TaskLedger      # 引用结构化 result/monitor facts
└── Session custom fact + 0600 JSONL audit
```

Runtime 在确认前不创建 command session。确认后，local/remote adapter 必须先通过 controlling TTY 执行 `stty -echo` 并观察 begin marker，才开放敏感输入。输入只经 `tmux load-buffer` child stdin 和 `paste-buffer -d -r` 进入 TTY，finally 删除 buffer；不进入 Tool、argv、env、Session、Monitor、Task Ledger、日志、审计、RPC 或模型上下文。

`terminal_send` 在 Enter 前检查累计 line 并用 Ctrl-U 清理 sudo；one-shot remote 路径阻止提权。`sudo -S`、`su`、`doas`、`pkexec` 和 namespace/chroot identity switch 不支持。详细设计见 [受控 sudo 终端](./controlled-privilege-terminal.md)。

## 搜索架构

M8 Search Runtime 直接由现有 `AgentSessionServices` 持有：

```text
AgentSessionServices
└── SearchRuntime
    ├── SearchProvider
    │   └── SearXNG JSON（M8 唯一 Provider）
    ├── SearchCache
    │   ├── query entries
    │   └── URL/content entries
    ├── SearchBudgetManager
    ├── web_search
    ├── web_fetch
    │   ├── URL/DNS/redirect safety validation
    │   ├── HTML → Markdown
    │   └── raw text/JSON
    └── WebCitation
```

`SearchProvider` 只暴露规范化请求和结构化结果，后续 Brave、Tavily、Exa 和 GitHub Search 可实现同一接口；M8 不实现第二 Provider，也没有 Provider fallback 链。SearXNG 可通过 `search.searxng.engines` 限定实例中已启用的引擎；全部引擎 suspended/unresponsive 且无结果时返回结构化错误，不缓存为空成功。

query/URL cache 位于现有 agentDir 下，使用版本化 JSON、canonical key、原子写入、TTL、fetchedAt/expiresAt 和 SHA-256 content hash。Coordinator 与受控子 Agent 共享 Runtime/cache，Session branch 只保存 Tool details 和预算事实，不复制缓存正文。

`web_search` 只返回精简结果和搜索级引用。第一方候选优先级只使用显式 include domain 或 query token 与 hostname label 的可解释匹配，不把来源标记成未经验证的“官方”。snippet 始终是未验证发现信息。

`web_fetch` 使用 Undici，并在连接前分别验证 IPv4/IPv6 DNS 地址，再通过固定 lookup 避免验证后重新解析；每次重定向重新执行协议、credentials、hostname 和 IP 范围检查。标准 HTTP(S) proxy 存在时，请求使用已验证的固定目标 IP，同时保留原始 Host 和 TLS SNI，避免代理侧 DNS 重新解析绕过 SSRF 边界。HTML、text、JSON 属于不可信外部内容，不执行 script、指令或代码。PDF 提取属于后续阶段。

预算按 Coordinator task scope 统计 query、fetch、Provider 尝试、输入字符，并限制单次结果、响应字节、timeout 和 redirect。Search Runtime 自身在预算/配置失败后不会继续网络请求或启动 Shell fallback。若 Agent 随后显式调用通用 Bash、Remote 或 terminal 网络 fallback，M10 Policy Runtime 只记录 Footer advisory，不暂停执行。
