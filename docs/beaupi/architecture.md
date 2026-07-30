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
│   └── Policy Engine
│
├── Execution Modes
│   ├── User Mode
│   └── Controlled Sudo Mode
│
├── Execution Backends
│   ├── Local WSL
│   ├── SSH
│   └── tmux
│
├── Native Tools
│   ├── Git
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
│   │   ├── policy/          # 命令、失败、预算和权限策略
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
  error?: AgentTaskError;
  usage: AgentTaskUsage;
  budget: AgentTaskBudgetSummary;
}
```

生命周期事件携带稳定 task ID、Profile、任务摘要、时间、状态和错误；`started`、`running`、`progress` 与单次 terminal event 可直接由 M6 Monitor Runtime 消费。子 Agent 的完整消息历史只存在于其内存 Session，不进入 Coordinator branch。

## Skill Registry

Skill Registry 建立在 Pi 的 Skill discovery、Pi Package 和 `resources_discover` 之上。Registry 维护来源、scope、启停状态和诊断；导入完成后通过命令上下文调用 `ctx.reload()`。第一版优先复用现有接口，确有需要时直接在 `packages/coding-agent` 中扩展 ResourceLoader 和相关生命周期。

子 Agent 创建受控 ResourceLoader 时，根据 Agent Profile 过滤可用 Skill，避免所有 Skill 自动注入每个子 Agent。详细设计见 [Skill 导入与注册](./skills.md)。

## Workflow Engine

工作流是 DAG，每个节点声明：

```typescript
interface WorkflowNode {
  id: string;
  agent: string;
  task: string;
  dependsOn?: string[];
  condition?: string;
  writePolicy?: "none" | "isolated" | "shared";
}
```

默认规则：

- 同一时间只有一个共享工作区写入者
- 只读 Agent 可以并发
- 并行写入使用独立 Git Worktree
- 节点只消费依赖节点的结构化输出
- 节点失败根据策略暂停、跳过或终止

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

## Policy Engine

策略结果：

```typescript
interface PolicyDecision {
  action: "allow" | "block" | "confirm" | "replace" | "pause";
  reason?: string;
  replacementTool?: string;
  suggestion?: string;
}
```

主要策略：

- 重复命令检测
- 等价 fallback 检测
- Shell 调用预算
- 网络搜索预算
- 敏感路径保护
- Git 工作流约束
- sudo 提权约束
- 专用 Tool 替代原始 Bash

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
- Tasks Widget 和 Footer 只消费 Ledger snapshot，不维护独立 Plan/Workflow 状态。

## Monitor 与后台任务

Monitor Runtime 是本地进程、Tool、子 Agent、SSH 连接和 tmux 会话的统一观察层，内部只有一个 session-scoped `MonitorRegistry` 保存 `MonitorRecord`；它不创建 Agent、Session、ResourceLoader 或第二套任务状态系统。Runtime 负责确定性状态、最后活动时间、资源快照、增量日志 cursor/hash、生命周期事件去重和可视化。它不从日志文本猜测业务结论，也不会在无变化时调用模型。

M6 的 Process adapter 只检查 PID、退出码、日志位置/identity/hash 和资源快照；Tool/Sub-Agent adapter 消费现有 `AgentSession`/`AgentPool` 生命周期事件。`starting`、`running`、`healthy`、`stalled`、`completed`、`failed`、`cancelled`、`lost` 是唯一 Monitor 状态，无法确认恢复目标时使用 `lost`，不推断成功。SSH/tmux adapter 只保留接口，M7 才实现连接。

Background Task Manager 管理长进程、状态轮询、日志增量和唤醒队列，并复用 Monitor Runtime；进程完成或满足触发条件后，才通过现有 Session 消息机制重新触发 Agent turn。M6 先交付 Monitor，M11 再增加后台自动唤醒。

系统区分两种轮询：

- 进程轮询：只检查 PID、退出码、日志位置和内容 hash，不调用模型
- 模型复查：只在有新进度、长时间无变化或达到用户配置的复查周期时调用

唤醒事件必须去重并串行处理，避免同一任务同时触发多个 Agent turn。详细设计见 [后台任务与自动唤醒](./background-tasks.md)。

## 权限边界

BeauPi 不以 root 身份启动。Sudo 模式只开放结构化操作，例如：

```typescript
type PrivilegedAction =
  | { type: "apt-install"; packages: string[] }
  | { type: "service-restart"; service: string }
  | { type: "service-status"; service: string }
  | { type: "file-write"; path: string; content: string };
```

每次操作经过模式检查、参数验证、确认和审计。

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

`SearchProvider` 只暴露规范化请求和结构化结果，后续 Brave、Tavily、Exa 和 GitHub Search 可实现同一接口；M8 不实现第二 Provider，也没有 fallback 链。

query/URL cache 位于现有 agentDir 下，使用版本化 JSON、canonical key、原子写入、TTL、fetchedAt/expiresAt 和 SHA-256 content hash。Coordinator 与受控子 Agent 共享 Runtime/cache，Session branch 只保存 Tool details 和预算事实，不复制缓存正文。

`web_search` 只返回精简结果和搜索级引用。第一方候选优先级只使用显式 include domain 或 query token 与 hostname label 的可解释匹配，不把来源标记成未经验证的“官方”。snippet 始终是未验证发现信息。

`web_fetch` 使用 Undici，并在连接前解析和验证全部 DNS 地址，再通过固定 lookup 避免验证后重新解析；每次重定向重新执行协议、credentials、hostname 和 IP 范围检查。HTML、text、JSON 属于不可信外部内容，不执行 script、指令或代码。PDF 提取属于后续阶段。

预算按 Coordinator task scope 统计 query、fetch、Provider 尝试、输入字符，并限制单次结果、响应字节、timeout 和 redirect。预算/配置失败不会执行网络请求或 Shell fallback。M8 通过 Tool prompt guideline 阻止模型继续尝试等价 curl/wget/Python/Node/Bash；对通用 Bash 网络调用的强制策略属于 M9 Policy Engine。
