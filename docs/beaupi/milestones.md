# BeauPi 开发里程碑

## 目的

本文把 [开发路线](./roadmap.md) 转换为可连续交付、可验收的开发里程碑。开发时按里程碑顺序推进；每个里程碑都必须形成可运行代码、自动化测试和文档更新，避免同时铺开多个未闭环子系统。

## 当前基线

截至开始开发前，仓库已经具备：

- BeauPi 产品名和 `beaupi` 开发命令
- `.beaupi` 用户与项目配置路径
- `BEAUPI_CODING_AGENT_*` 环境变量
- 从 TypeScript 源码启动的 `beaupi-test.sh`
- 开发命令安装脚本 `scripts/install-beaupi-dev.sh`
- BeauPi 品牌回归测试
- Pi Runtime、AgentSession、ResourceLoader、Extension、Skill、Tool 和 TUI 基础能力
- Footer 上下文用量和 Compact 流式进度的初步改动

当前阶段不创建 `packages/beaupi`，也不复制 Pi 的 Runtime、CLI、Session 或资源加载链路。所有功能直接扩展 `packages/coding-agent`。

## 开发约束

每个里程碑遵循以下规则：

1. 先检查并复用现有模块，再增加新抽象。
2. 每次只建立一个完整能力闭环，避免只完成数据结构或 UI 外壳。
3. 核心状态必须可测试，不依赖真实 Provider、真实 API key 或人工 TUI 操作。
4. Tool 返回结构化 `details`，渲染器不从日志文本反向推断状态。
5. Session 恢复、Compact 和分支切换不能破坏已实现状态。
6. 子 Agent 默认不能递归委派，也不能自动继承全部 Tool 和 Skill。
7. 普通用户模式是默认权限边界；任何 sudo 能力延后到策略系统稳定后实现。
8. 每个里程碑完成后运行 `npm run check`；修改测试文件时运行对应测试。
9. 第一开发里程碑先建立 Claude Code 风格的 TUI 视觉基础；后续功能必须复用该组件和状态语言，不能重新引入旧式大背景 Tool 卡片。

## 里程碑总览

| 里程碑 | 目标 | 主要交付物 | 依赖 |
|---|---|---|---|
| M0 | 固化可开发基线 | 品牌、启动、配置、冒烟测试 | 无 |
| M1 | 建立 Claude Code 风格 TUI 基础 | 消息、Tool、Diff、Footer、Compact、主题 | M0 |
| M2 | 建立任务状态闭环 | Task Ledger、事件采集、Todo | M1 |
| M3 | 建立文档驱动执行 | 文档发现、读取、Execution Contract | M2 |
| M4 | 建立 Skill 管理闭环 | Registry、导入、校验、启停、重载 | M3 |
| M5 | 建立进程内子 Agent | Agent Pool、Profile、`delegate_task` | M1、M3 |
| M6 | 建立受预算搜索能力 | `web_search`、`web_fetch`、引用与缓存 | M3 |
| M7 | 建立执行策略与 Git 工具 | Policy Engine、失败预算、Git Tools | M2、M3 |
| M8 | 建立多 Agent Workflow | DAG、并发、单写者、Worktree | M5、M7 |
| M9 | 建立后台任务自动唤醒 | 后台进程、Wake Queue、Session 恢复 | M5、M7 |
| M10 | 建立远程与受控权限能力 | SSH、tmux、结构化 sudo | M7、M9 |
| M11 | 准备可发布发行版 | 安装、二进制、CI、Smoke Test | M0–M10 |

---

## M0：可开发基线

### 目标

确保 BeauPi 可以稳定启动、读取独立配置，并在不破坏现有 Pi Coding Agent 能力的前提下继续开发。

### 交付物

- `beaupi` CLI 和 `BeauPi` 产品标题
- `~/.beaupi/agent/` 与 `.beaupi/` 配置路径
- BeauPi 环境变量
- 源码启动脚本和开发命令安装脚本
- 品牌、配置路径、帮助和版本输出测试
- 最小手动启动说明

### 验收标准

- `./beaupi-test.sh --help` 成功
- `./beaupi-test.sh --version` 成功
- 从仓库外目录运行 `beaupi` 时保留调用目录
- 不读取或写入 `.pi` 作为 BeauPi 默认配置目录
- 现有 Coding Agent 基础会话仍可启动

### 状态

基础实现已经存在。开始 M1 前应先完成一次基线检查，并把发现的问题限制在 M0 范围内修复。

---

## M1：Claude Code 风格 TUI 基础

状态：已完成（2026-07-28）。

### 目标

第一步先把现有 BeauPi 交互界面调整为 Claude Code 风格，建立后续 Todo、子 Agent、Workflow 和后台任务共同复用的视觉组件、状态符号与布局规则。此阶段只渲染当前已有数据，不为展示效果提前实现 Task Ledger 或其他核心系统。

### 交付物

- BeauPi 暗色和亮色主题
- 保留 Pi 当前跳动加载图标
- 用户与 Assistant 消息层级
- minimal Tool shell，移除普通 Tool 的大面积状态背景卡片
- Tool 标题、queued/running/permission/success/error 状态
- Read/Search/List/Bash 聚合与当前操作提示
- Read/Edit/Write/Bash/Search renderer
- Edit/Write 结构化 Diff：整行增删背景、词级高亮、行号 gutter、上下 dashed 边界
- 三行 Footer：最近运行统计、cwd/branch、Session/上下文/模型状态
- Footer 的 80、120、160 列降级策略
- Compact 实际流式输出驱动的渐近进度条
- Ctrl+O 折叠与展开行为
- Write Tool 折叠提示中的新增行数和总行数在写入过程中动态累加；允许修改样式，但必须保留实时跳数字行为
- 可供后续 Todo、Agent、Workflow 和 Background 组件复用的状态符号与 gutter helper
- tmux 视觉回归基线

### 实现边界

- 不复制参考仓库的 React/Ink 实现、Logo、吉祥物或品牌资源。
- 优先使用 Tool 的 `renderCall`/`renderResult` 和现有 `details.patch`，不重写 Tool 执行逻辑或 edit 算法。
- Todo、Agent、Workflow 和 Background 在本阶段只定义视觉接口或 fixture，不实现对应运行时。
- 动态行数、流式状态和 Ctrl+O 展开属于行为约束，不能在样式重构中丢失。

### 测试

- Tool queued、running、success、error、permission 和 cancelled 状态
- Read/Search/List/Bash 聚合、延迟提示和展开
- Write 动态新增行数与总行数逐步更新
- Diff 行号、换行、上下文折叠和 resize 缓存
- Footer 和 Compact 在 80、120、160 列下不溢出
- 暗色与亮色主题所需 token 完整
- tmux 启动、执行 Tool、展开输出和 Compact 截图检查

### 验收标准

普通会话中的消息、Read、Write、Edit、Bash、Search、Diff、Footer 和 Compact 已使用统一的 Claude Code 风格；普通 Tool 不再显示大背景卡片；Write 动态行数持续跳动；所有组件在暗色、亮色及 80/120/160 列终端下可读。

详细规范见 [Claude Code 风格 TUI](./ui-style.md)，完整实施拆分见 [Claude Code 风格 TUI 调整计划](./plans/README.md)。

---

## M2：Task Ledger 与任务可视化

### 目标

建立后续文档、策略、子 Agent 和 Workflow 共用的任务状态来源，避免各组件维护独立状态，并把状态接入 M1 已建立的 Footer、状态符号、gutter 和列表视觉基础。

### 交付物

- `TaskLedger` 数据模型和生命周期
- phase：`discover`、`execute`、`verify`、`commit`
- Shell 调用、Tool 调用、失败、文件读取和文件修改事件
- 简单的重复命令签名与 `git status` 重复检测
- 基于 Task Ledger 的 Todo Widget
- 当前阶段、修改文件和验证状态接入 M1 的 Footer 与列表组件
- Tool Timeline 使用 M1 的 Tool 状态语言

### 实现边界

第一版 Task Ledger 只记录当前 Session 的确定性事实，不实现完整 Policy Engine，也不提前设计 Workflow 的全部状态。

建议最小接口：

```typescript
interface TaskLedger {
  taskId: string;
  phase: "discover" | "execute" | "verify" | "commit";
  commands: CommandRecord[];
  filesRead: FileReadRecord[];
  filesModified: string[];
  failures: FailureRecord[];
  requirements: RequirementState[];
}
```

### 测试

- AgentSession 生命周期创建和更新 Ledger
- Tool 成功、失败和取消时记录正确状态
- 相同命令在工作区未变化时得到相同签名
- Session 恢复后状态不会重复计数
- Task Ledger 驱动的 Todo 排序、状态更新和动态截断
- Footer 接入 Ledger 后仍满足 M1 的宽度和布局约束

### 验收标准

执行一个普通编辑任务时，用户能够看到当前阶段、已修改文件、待验证事项和上下文状态；系统能够识别短时间内重复的 `git status`。

---

## M3：Document Runtime

### 目标

让 BeauPi 自动读取任务相关文档，并把文档要求转化为可跟踪的执行约束，而不是引入独立 Plan 模式。

### 交付物

- 文档发现器：`AGENTS.md`、`CLAUDE.md`、`README.md`、`CONTRIBUTING.md`、`docs/**/*.md`
- 最近目录优先和祖先目录规则
- `docs_search`
- 支持 heading 与行范围的 `docs_read`
- Markdown heading、文件位置和引用信息
- `docs_resolve_task`
- `ExecutionContract`
- 文档 hash 与变更失效
- Task Ledger 中的 requirement/check/completion 状态

### 测试

- 多层目录的文档优先级
- 大文档按 heading 和行范围读取
- 无关文档不会全部注入上下文
- 文档变化后 Contract 失效并重建
- 冲突要求能够保留来源并报告
- 文档要求可映射为 Todo 和验证项

### 验收标准

给定包含 `AGENTS.md` 和项目文档的测试仓库，Agent 能选择相关文档、说明关键约束来源，并在结束前检查文档要求是否满足。

---

## M4：Skill Registry

### 目标

在现有 Pi Skill discovery 之上完成导入、注册、启停、诊断和热重载闭环。

### 交付物

- user/project Registry 文件
- 本地目录、Claude Code、Codex、Git 和 npm 来源
- `/skills`
- `/skill-import`
- `/skill-enable`
- `/skill-disable`
- `/skill-remove`
- `/skill-validate`
- frontmatter、相对引用、脚本和冲突诊断
- Registry 与 ResourceLoader discovery 合并
- 修改后调用 `ctx.reload()`

### 安全要求

- URL 导入只允许 HTTPS，并要求内容预览和确认
- 项目 Skill 只在项目受信任后加载
- 不自动执行 Skill 附带脚本
- 同名 Skill 不静默覆盖
- 删除托管文件需要二次确认

### 验收标准

导入一个项目 Skill 后无需重启即可调用；禁用后立即从 discovery 中消失；冲突时 UI 明确展示双方来源。

---

## M5：进程内子 Agent

### 目标

使用 Pi SDK 在当前进程创建隔离的子 Agent，并只向 Coordinator 返回结构化结果。

### 交付物

- `AgentProfile`
- Agent Pool 和并发限制
- 受控 ResourceLoader
- 独立 System Prompt、Tool allowlist、Skill allowlist、预算和超时
- `delegate_task`
- 流式进度、取消和错误传播
- 结构化输出：摘要、引用、修改、检查和错误
- 禁止默认递归委派

### 测试

使用 faux provider 覆盖：

- 成功委派
- Tool 和 Skill 隔离
- token/轮数/时间预算
- 用户取消
- Provider 失败
- Coordinator 只接收结构化结果
- 子 Agent 无法再次调用 `delegate_task`

### 验收标准

Reviewer 子 Agent 可以独立检查一组修改，TUI 展示实时状态，主会话不会接收完整子 Agent 消息历史。

---

## M6：联网搜索闭环

### 目标

提供可验证、有预算、不会无限 fallback 的联网研究能力。

### 交付物

- 统一 `SearchProvider` 接口
- 首个可配置搜索 Provider
- `web_search`
- `web_fetch`
- HTML 正文提取和 Markdown 转换
- URL、查询缓存与内容去重
- 结果截断和完整内容文件
- 来源评分与引用
- 查询、Provider fallback 和 token 预算

### 验收标准

研究任务优先返回官方来源；Provider 失败达到预算后停止并报告配置问题，不改用多个等价 Shell 命令继续尝试。

---

## M7：Policy Engine 与 Git Tools

### 目标

把重复命令、失败预算、权限边界和高频 Git 操作从模型提示转化为确定性执行策略。

### 交付物

- 命令与错误分类
- 等价操作签名
- Shell、网络和失败预算
- `PolicyDecision`
- `project_inspect`
- `git_snapshot`
- `git_diff`
- `git_sync_status`
- `git_commit`
- 缓存失效和并发会话检查
- 缺少依赖、权限不足、认证失败、限流和超时的停止策略

### 验收标准

普通提交流程通过结构化 Git Tool 完成；工作区未变化时不会重复运行等价检查；达到失败预算后 Agent 暂停并给出明确原因。

---

## M8：多 Agent Workflow

### 目标

在已稳定的子 Agent 和策略系统上实现 DAG 调度。

### 交付物

- Workflow YAML/JSON Schema
- 依赖、条件、并发限制、超时和取消
- `workflow_run`、`workflow_status`、`workflow_cancel`
- 单写者调度
- 并行写入 Worktree 隔离
- 节点结构化输入输出
- 首批工作流：`research`、`implement-review`、`parallel-review`、`debug`、`docs-execute`

### 验收标准

`implement-review` 能串行完成实现与审查；两个只读节点能够并行；两个共享工作区写入节点不会并发执行。

---

## M9：后台任务与自动唤醒

### 目标

让长时间运行的任务在模型回合结束后继续执行，并在关键事件发生时恢复 Agent。

### 交付物

- `background_start`
- `background_status`
- `background_logs`
- `background_wait`
- `background_cancel`
- 增量日志和持久化任务状态
- 自适应进程轮询
- Wake Queue 去重与串行处理
- 空闲时触发 turn，忙碌时发送 follow-up
- 受预算约束的 Progress Reviewer
- Session 恢复时重新接管任务

### 验收标准

脚本完成后自动触发新的 Agent turn；无日志变化时不调用模型；多个同时完成事件不会并发启动多个 Coordinator turn。

---

## M10：SSH、tmux 与受控权限

### 目标

以结构化 Tool 替代远程执行和提权 Skill，并保持普通用户进程边界。

### 交付物

- Execution Target 配置
- `target_select` 和 `remote_exec`
- tmux create/send/capture/status/close
- 增量远程日志
- `/mode user`
- `/mode sudo once`
- `/mode sudo session <duration>`
- `privileged_exec`
- 参数验证、确认、超时降权和 JSONL 审计

### 验收标准

Agent 本身始终以普通用户运行；未授权 sudo 被阻止；结构化授权到期后自动恢复用户模式；远程长任务日志不会整体注入上下文。

---

## M11：发行准备

### 目标

在功能闭环稳定后，决定并实现 BeauPi 的独立分发方式。

### 交付物

- npm 包和 CLI 发行策略
- Bun standalone binary
- 安装、升级和卸载脚本
- GitHub Actions 构建与发布
- Node/Bun 外部目录 smoke test
- 标准 Responses、Codex、手动 Compact、自动 Compact 和兼容降级测试
- 文档、许可证和第三方参考归属检查

### 验收标准

新环境可以安装、启动、配置模型、运行交互会话并安全升级；发布产物不依赖仓库 workspace 文件。

## 第一开发周期

开始开发时只执行以下顺序：

1. 完成 M0 基线检查，修复启动、配置或品牌回归。
2. 盘点现有 TUI、Tool renderer、Diff、Footer、Compact、主题和 Ctrl+O 展开链路。
3. 建立 Claude Code 风格的颜色 token、状态符号、gutter 和 ANSI-aware 宽度 helper。
4. 先改造消息层级和普通 Tool shell，再逐项改造 Read、Write、Edit、Bash 和 Search。
5. 保留并测试 Write 折叠提示动态跳数字和 Ctrl+O 展开行为。
6. 改造结构化 Diff、三行 Footer 和 Compact 流式进度。
7. 在 80、120、160 列及暗色、亮色主题下进行测试和 tmux 视觉检查。
8. 完成 M1 验收后，再开始 M2 Task Ledger。

第一周期明确不做：

- Task Ledger 和 Document Runtime
- Todo 的真实任务数据源
- 子 Agent 和 Workflow Runtime
- sudo
- SSH/tmux
- 后台 daemon
- 搜索 Provider
- 独立 npm 包或二进制

## 里程碑完成定义

一个里程碑只有同时满足以下条件才算完成：

- 交付物已经接入真实 Agent 生命周期，不是孤立模块
- 正常、失败、取消和 Session 恢复路径有测试
- 没有引入第二套 Runtime、CLI 或 ResourceLoader
- `npm run check` 无错误、警告或 info
- 修改的测试已单独运行并通过
- 相关 BeauPi 文档和 `CHANGELOG.md` 已更新
- 已记录下一里程碑所依赖的稳定接口

## 推荐开发入口

第一项实现任务：

> 盘点 `packages/coding-agent/src/modes/interactive/` 中现有消息、ToolExecutionComponent、Tool renderer、Diff、Footer、Compact 和主题实现，先制定最小的 Claude Code 风格渲染基础，然后完成普通 Tool shell 与 Read/Write/Edit/Bash/Search 的第一轮改造。

实现时先固定视觉组件和交互行为，再让后续 Task Ledger、Todo、子 Agent、Workflow 与后台任务接入这些组件。Write 折叠提示动态跳数字、Ctrl+O 展开和 Pi 跳动加载图标必须保留。
