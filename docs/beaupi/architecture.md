# 系统架构

## 总览

```text
BeauPi CLI / TUI
│
├── Coordinator
│   ├── Task Ledger
│   ├── Document Runtime
│   ├── Skill Registry
│   ├── Workflow Engine
│   ├── Agent Pool
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
    ├── Claude-style Tool/Diff/Todo Renderers
    ├── Tool Timeline
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
│   │   ├── workflow/        # DAG、调度和节点状态
│   │   ├── background/      # 后台任务、监控和唤醒队列
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

子 Agent 使用受控 ResourceLoader，避免加载委派工具并递归创建 Agent。

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

Document Resolver 按任务选择相关文档，生成：

```typescript
interface ExecutionContract {
  documents: DocumentReference[];
  requirements: Requirement[];
  allowedCommands: DocumentedCommand[];
  requiredChecks: Check[];
  stopConditions: StopCondition[];
  completionCriteria: CompletionCriterion[];
}
```

Execution Contract 约束 Agent 执行，但不引入独立 Plan 模式。

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

## 后台任务与唤醒

Background Task Manager 管理长进程、状态轮询、日志增量和唤醒队列。进程完成或满足触发条件后，通过现有 Session 消息机制重新触发 Agent turn。

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

```text
research
├── web_search
│   ├── official docs
│   ├── GitHub Search
│   └── configured web provider
├── web_fetch
│   ├── HTML → Markdown
│   ├── raw text/JSON
│   └── PDF text
└── citation manager
```

Provider 失败不会无限 fallback；达到预算后暂停并报告配置建议。
