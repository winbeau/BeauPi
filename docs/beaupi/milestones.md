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
7. 本地 Agent 进程始终保持普通用户身份；受信任远程 Target 使用 OpenSSH 已配置的登录身份。M13 只允许逐请求受控 sudo：完整命令或批次先填充到 tmux，用户按 Enter 才执行或按 Escape 取消；认证后视图detach且command继续写日志，交互式root shell被阻止，不提供sudo mode、持久root shell或Session grant。
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
| M5 | 建立进程内子 Agent | Agent Pool、Profile、`delegate_task` | M1、M3、M4 |
| M6 | 建立 Monitor 监控闭环 | Monitor Runtime、状态、增量日志、事件 | M1、M2、M5 |
| M7 | 建立 SSH/tmux 远程执行 | Execution Target、SSH、tmux、远程 Tool | M3、M6 |
| M8 | 建立受预算搜索能力 | `web_search`、`web_fetch`、引用与缓存 | M3 |
| M9 | 建立交互式询问闭环 | `ask_user_question`、单选/多选、自由输入、review | M1、M2 |
| M10 | 建立确定性执行策略 | Policy Engine、失败预算、Footer advisory | M2、M6、M7、M8、M9 |
| M11 | 建立多 Agent Workflow | DAG、并发、单写者、Worktree | M5、M6、M10 |
| M12 | 建立后台任务自动唤醒 | Monitor 扩展、Wake Queue、Session 恢复 | M5、M6、M7、M10 |
| M13 | 建立受控权限能力 | 普通用户边界、结构化 sudo、审计 | M7、M9、M10、M12 |
| M14 | 建立动态 Task 计划闭环 | 主 Agent 计划、Task Runtime、快速模型进度审阅 | M2、M5、M6、M12、M13 |
| M Final | 准备可发布发行版 | 安装、二进制、CI、Smoke Test | 全部功能里程碑 |

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
- Edit/Write 结构化 Diff：整行增删背景、词级高亮、行号 gutter、上下实线边界
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

状态：已完成（2026-07-29）。

### 目标

建立后续文档、策略、子 Agent 和 Workflow 共用的任务状态来源，避免各组件维护独立状态，并把状态接入 M1 已建立的 Footer、状态符号、gutter 和列表视觉基础。

### 交付物

- `TaskLedger` 数据模型和生命周期
- phase：`discover`、`execute`、`verify`、`commit`
- Shell 调用、Tool 调用、失败、文件读取和文件修改事件
- 简单的重复命令签名与 `git status` 重复检测
- 基于 Task Ledger 的 Todo Widget
- 当前阶段、修改文件和验证状态接入 M1 的 Footer 与列表组件
- 命令事实保留在 Task Ledger，Tasks Widget 只展示任务清单

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

### 验收记录（2026-07-29）

- `TaskLedger` 直接挂载在现有 `AgentSession`，按当前 Session branch 重建，不创建第二套 Runtime、Session 或 Tool 执行链。
- Tool 使用稳定 `toolCallId` 去重，用户 Bash 使用 Session entry id 重建；恢复、Compact 和分支切换不会重复计数，废弃分支事实不进入当前账本。
- Read、Write、Edit 和 Bash 返回结构化路径、字节数、命令及退出状态 details；取消状态由 Agent AbortSignal 和持久化 Task Ledger details 确定，renderer 不从日志文本反推。
- phase、文件读取/修改、Tool/Shell 成功/失败/取消、验证和 commit 事实均有单元或 faux provider harness 测试。
- 等价 `git status` 使用规范化签名、30 秒窗口和账本观察到的 workspace revision 检测；文件修改后不判为重复。
- Todo 支持 pending、active、completed、failed、blocked，按最近完成、失败、进行中、pending、blocked 和较早完成动态选择 3–10 项，并提供 owner 窄屏隐藏和 blocked/隐藏项摘要。
- Tasks Widget 使用空方框/实心方框表达未完成/完成；Footer 保持最多三行并接入 phase、修改文件数和验证状态。
- tmux 固定 faux provider 场景覆盖暗色/亮色的 40、80、120、160 列；8 个 `/debug` 记录均为 `visibleWidth <= width`，无横向溢出。
- 定向测试、`./test.sh` 和 `npm run check` 通过，无错误、warning 或 info。

---

## M3：Document Runtime

状态：已完成（2026-07-29）。

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
- 文档 Requirement 保留在 Execution Contract 与 Task Ledger，可执行 required check 和 completion criterion 映射为 Todo 与验证项

### 验收标准

给定包含 `AGENTS.md` 和项目文档的测试仓库，Agent 能选择相关文档、说明关键约束来源，并在结束前检查文档要求是否满足。

### 验收记录（2026-07-29）

- `AgentSessionServices` 持有唯一 cwd-bound Document Runtime；`/new`、`/resume`、`/fork`、reload 和 tree branch 重建复用现有 Runtime/Session/ResourceLoader 生命周期。
- Document Runtime 发现并按来源保留 global、ancestor、project、nearby、explicit、package 元数据；复用 `loadProjectContextFiles()` 的 AGENTS/CLAUDE 祖先行为，跳过 `.git`、`node_modules`、构建/缓存/生成目录，处理符号链接 canonical path 去重和有界预算。
- Markdown 索引支持 ATX、Setext、fenced code block、heading path、1-based 行范围、heading/offset 读取和结构化 citation；文档事实使用内容 hash。
- `docs_search`、`docs_read`、`docs_resolve_task` 已接入默认 Tool registry、prompt snippet、minimal renderer 和普通编码任务默认激活策略；URL 返回结构化 unsupported 诊断，不执行网络 fallback。
- Execution Contract details 使用版本化 `documentRuntime` key；自动解析和 Tool Result 存入当前 Session branch，Task Ledger 从当前 branch 去重重建，Extension 替换 Tool details 后仍重新附加 metadata。
- Requirement、required check、completion criterion 只使用结构化文档与 Tool/Shell 证据；冲突保留双方引用，无法判断的状态保持 pending/blocked，关键文档变化会 stale，恢复原 hash 后确定性恢复 active。
- 精简 active Contract 通过现有 System Prompt 重建链注入，stale Contract 不会继续发送；Task Ledger 保留 Contract 与 requirement/check/completion 证据状态，Todo 与 Footer 只展示 actionable required check、completion、来源和 stale/blocked 状态，不单独投影文档 Contract 或 Requirement Todo。
- 定向 Runtime、Tool、Ledger、Session、Widget/Footer 测试覆盖 hash 失效、branch 恢复、Extension metadata、预算、引用、宽度和 faux provider 场景。

---

## M4：Skill Registry

状态：已完成（2026-07-29）。

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

### Stage 1 验收记录（2026-07-29）

- 已实现 typed user/project Registry、版本化确定性 JSON、原子安全写入、scope 路径和 malformed-file 诊断。
- 已复用现有 ResourceLoader 与 Agent Skills discovery，接入 Registry precedence、disabled/invalid 路径抑制、来源保留和同名 collision 诊断。
- 已实现 `SKILL.md`、frontmatter、相对引用、脚本/可执行文件清单、来源/更新能力和 project trust 校验；不会执行 Skill 脚本或 npm lifecycle。
- 已覆盖 persistence、validation、precedence、disabled、conflict、malformed、trust 和 reload rebuild 测试。
- 导入/获取、命令/UI、更新、删除和子 Agent allowlist 留给后续 M4 Stage。

### Stage 2 验收记录（2026-07-29）

- `/skill-import` 已接入本地、`file://`、Git、npm 和 HTTPS 来源；远程 Git/npm 先安全 staging，HTTPS 使用无重定向、2 MiB 上限和 SHA-256 pin。
- 远程 staging 禁止子模块、checkout hooks、npm lifecycle、符号链接，并过滤 `.git`/`node_modules`；Skill 脚本只建立清单，不执行。
- 所有交互式导入和远程更新均显示来源、ref/hash、内容预览、脚本/可执行清单及安全风险后要求确认；project scope 继续受 trust gate 保护。
- `/skill-update` 对 Git/npm/HTTPS 执行 fetch、校验、确认和原子目录替换；失败或取消不会改变旧 Skill 或 Registry entry。`/skill-remove` 保留现有二次删除确认。
- `/skills` UI、命令分发和 `ctx.reload()` 已接入 InteractiveMode；新增 allow/deny `createSkillAllowlistOverride()` 作为 M5 AgentProfile 的 ResourceLoader 过滤接口。
- 定向 Registry、remote staging、allowlist、selector、InteractiveMode 测试覆盖正常、取消、失败、冲突、信任、重载和安全边界路径。

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

使用 Pi SDK 在当前进程创建隔离的子 Agent，并只向 Coordinator 返回结构化结果，为后续监控和 Workflow 提供可靠执行单元。

### 交付物

- `AgentProfile`
- Agent Pool 和并发限制
- 受控 ResourceLoader
- 独立 System Prompt、Tool allowlist、Skill allowlist、预算和超时
- `delegate_task`
- 流式进度、取消、超时、轮数和 token 预算
- 结构化输出：摘要、引用、修改、检查和错误
- 稳定的 started/running/completed/failed/cancelled 生命周期事件
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
- 生命周期事件在正常、失败和取消路径各只产生一次

### 验收标准

Reviewer 子 Agent 可以独立检查一组修改，TUI 展示实时状态，主会话不会接收完整子 Agent 消息历史；结果和生命周期事件可以被 M6 Monitor Runtime 消费。

### 验收记录（2026-07-29）

- `AgentPool` 已接入现有 `createAgentSession()`：子 Agent 在当前进程创建独立 `AgentSession` 和内存 `SessionManager`，共享 Coordinator 的 `ModelRuntime`、认证和 Provider 配置，不创建第二套 Runtime、CLI 或 ResourceLoader 生命周期。
- `AgentProfile` 支持独立 System Prompt、Tool/Skill allowlist、最大 output token、最大轮数、超时、取消策略和文件修改边界；受控 ResourceLoader 直接复用 M4 `createSkillAllowlistOverride()`，默认不继承 Skill。
- BeauPi CLI 通过 `agentPool: {}` 启用 Coordinator 的 `delegate_task`；受控子 Agent 始终排除 `delegate_task`，即使 Coordinator 的全局 Tool registry 中存在该 Tool。
- `delegate_task` 的 Tool 参数使用 TypeBox 校验。Coordinator 只接收包含状态、summary、citations/references、filesModified、checks、diagnostics、error、usage 和 budget 的结构化结果，不接收子 Agent transcript。
- Agent Pool 使用共享 Runtime 的并发槽位，全局同时运行上限为 `max(1, floor(availableParallelism() / 3))`，显式配置只能进一步降低；子 Agent 的 Provider、Tool 和 bash 操作都服从同一 AbortSignal，正常、失败、取消、超时、Provider/Tool 错误均转换为结构化状态。
- 生命周期事件以稳定 task ID、profile、任务摘要、时间、状态、预算、最后活动和错误字段发出；progress 包含 turn、Tool、目标路径与 started/succeeded/failed 结果，并对持续 assistant/Tool 流发出节流活动心跳，单次 terminal 事件可直接供 M6 Monitor Runtime 消费。
- 所有内置 Profile 在获得并发槽位后使用 10 分钟无进展窗口和 30 分钟最终 wall-clock 硬上限；排队不消耗执行预算，单次 request 的较短 `budget.timeoutMs` 只收紧无进展窗口，assistant 流、turn 和 Tool start/update/end 活动会续期但不能越过硬上限；默认不设置 output token 或 turn 上限。独立 `delegate_task` 调用允许并行执行，排队任务可由 Monitor 取消，槽位交接中的取消不会阻塞后续 waiter；超时优先返回最后已完成或流式生成的 assistant 文本，没有文本时返回最后活动摘要；Ctrl+O 可展开 Agent 结构化结果。子任务关闭自动 Document Contract preflight，明确范围的简单任务不先扫描项目文档，仍可在显式文档审查时调用 `docs_resolve_task`。
- 自定义 Profile 仍可通过 Agent loop 的 turn-end stop hook 配置 turn/token 预算，并在下一次 Provider 请求前结束，不通过 abort 产生额外的合成 turn。
- faux provider 定向测试覆盖成功委派、Profile 选择、Tool/Skill/文件边界、token/轮数预算、超时部分输出和最后活动 fallback、取消、Provider/Tool 失败、Coordinator transcript 隔离、递归委派阻断、生命周期事件去重和 CPU-aware 并发限制。

---

## M6：Monitor 监控闭环

### 目标

建立统一的执行监控能力，先覆盖本地长进程、Tool 和子 Agent，再为 SSH/tmux 提供适配接口。监控器只采集和呈现确定性事实，不从日志文本猜测业务状态。

### 交付物

- session-scoped Monitor Registry 和 `MonitorRecord`
- Process、Tool、Sub-Agent monitor adapter
- `monitor_attach`、`monitor_list`、`monitor_status`、`monitor_logs`、`monitor_wait`、`monitor_stop`
- `starting`、`running`、`healthy`、`stalled`、`completed`、`failed`、`cancelled`、`lost` 状态
- 开始时间、运行时长、最后活动、退出原因和资源快照
- 基于 cursor/hash 的增量日志读取，完整输出文件路径
- 完成、失败、超时、停滞和连接丢失事件的去重
- 低成本进程轮询；模型 Progress Reviewer 为可选、有限预算的扩展
- Monitor 状态接入 Tool renderer、Tasks Widget 和 Footer
- Session 恢复后的状态重建；无法确认的目标必须标记为 `lost`
- SSH/tmux adapter 接口，后续不创建第二套监控系统

### 测试

使用 faux provider、fake process adapter 和可控时钟覆盖：

- 本地进程和子 Agent 的注册、状态转换和停止
- 日志 cursor/hash 增量读取与完整日志路径
- 无变化日志不触发模型调用
- stalled、timeout、failed、cancelled 和 lost 事件
- 相同状态事件去重以及多事件串行处理
- Session 恢复后不重复计数，无法确认的状态保持 `lost`
- Monitor Widget/Footer 在 80、120、160 列下不溢出

### 验收标准

用户能够统一查看本地进程、Tool 和子 Agent 的状态、运行时长、最后活动和新增日志，并能等待或停止支持取消的目标；历史日志不会重复注入上下文，监控轮询不会在无变化时消耗模型 token。

### 实现边界

M6 不实现自动唤醒 Coordinator turn、远程 SSH 连接或 sudo。自动唤醒在 M12 完成，SSH/tmux 在 M7 接入本 Monitor Runtime。

### 验收记录（2026-07-29）

- `MonitorRuntime` 持有唯一 session-scoped `MonitorRegistry`，复用现有 `AgentSession`、`AgentPool`、Tool registry、SessionManager 和 ResourceLoader；没有创建第二套 Agent Runtime、Session 或任务账本。
- `MonitorRecord` 固化稳定 ID、Process/Tool/Sub-Agent/SSH-tmux 目标、任务摘要、时间、运行时长、最后活动、资源快照、退出信息、日志 cursor/hash 和完整日志路径；Sub-Agent 额外保存最多 32 条 turn/Tool/目标路径/结果活动事件和预算终态；状态机严格限制为 `starting`、`running`、`healthy`、`stalled`、`completed`、`failed`、`cancelled`、`lost`。
- Node/fake Process adapter、事件驱动 Tool/Sub-Agent adapter 和未实现的 SSH/tmux adapter 接口已接入。M5 `AgentPool` 的生命周期事件直接映射到同一 Monitor record，并支持通过现有 pool 请求取消。
- `monitor_attach`、`monitor_list`、`monitor_status`、`monitor_logs`、`monitor_wait`、`monitor_stop` 使用 TypeBox/Compile 参数校验并返回结构化 details；等待、停止和日志读取均不启动模型回合。
- `IncrementalLogReader` 使用 cursor、完整内容 hash、prefix hash 和文件 identity 识别追加、截断、轮转、目标丢失及日志文件不可用，不重复返回历史日志；没有文件日志的 Sub-Agent 由 `monitor_logs` 使用同一 cursor 语义返回有界活动事件。完整日志路径始终保留在 record/details 中。
- 生命周期事件按状态/原因/退出事实去重并串行派发；Session 恢复重建当前 branch 的最新 record，Process 只能在 adapter 确认后恢复，无法确认的非终态目标标记为 `lost`，不猜测成功。
- Monitor 状态接入 Tool renderer、Tasks Widget 和 Footer；Sub-Agent 失败直接显示 `budget_exhausted · N/N turns · last: Tool`。测试覆盖 faux provider、fake adapter、可控时钟、状态转换、超时/停滞/丢失、文件/活动增量日志、事件边界、M5 事件接入和 80/120/160 列宽度。

---

## M7：SSH、tmux 远程执行

状态：已完成（2026-07-30）。

### 目标

以结构化 Tool 建立稳定的 SSH/tmux 连接能力，并将远程命令和长会话纳入 M6 Monitor Runtime。

### 交付物

- user/project scope 的 Execution Target 配置和信任边界
- `target_select`、`remote_exec`
- 复用系统 OpenSSH 配置、SSH Agent 和 known_hosts，不保存私钥或口令
- SSH ControlMaster 连接复用、连接超时和明确关闭
- 远程 read/write/edit/bash Operation adapter
- `terminal_create`、`terminal_bash`、`terminal_send`、`terminal_capture`、`terminal_status`、`terminal_close`
- 本地 tmux pane 内直接运行 SSH，远端不再要求 tmux；所有 terminal 输入由本地 tmux 注入
- `terminal_bash` 在现有远端 shell 当前目录和导出环境中执行普通 Bash 命令，一次调用等待完成；send/capture 保留给交互式控制和诊断
- 每 terminal 的完整脱敏 `工作日志.log`、增量 capture、随机 marker/退出码协议和关闭时清理的本地 pane transcript
- 可配置 `TerminalOutputReviewer`：短成功输出直接返回，失败或输出超过 100 行时审阅，最后一行固定为 `@绝对日志路径`
- 非零退出、超时、取消和断线保留 Tool details、usage、Monitor 关联和正确 `isError`
- 连接、认证、主机密钥、命令、超时和会话丢失的结构化诊断
- 远程目标和长任务状态复用 Monitor Widget、Footer 和 Tool renderer
- 第一版使用受信任 Target 的 OpenSSH 登录身份，允许 AutoDL 等平台提供的 `root` 账户；不实现 sudo、su 等登录后提权或身份切换

### 测试

使用 fake SSH/tmux adapter 覆盖：

- 目标选择、参数验证和信任边界，包括配置为 `root` 的 provider-managed Target
- 连接建立、复用、超时、关闭和断线
- 远程命令成功、失败、取消和退出码
- 本地 tmux 创建、pane 内 SSH readiness、Bash marker 注入与等待、发送、增量捕获、状态和关闭
- 远程 cwd/export 持久化，远端无 tmux 依赖
- 失败和超过 100 行时的 fake reviewer、模型失败 fallback、usage 和强制 `@日志路径`
- 长日志 cursor、完整工作日志和无 pane history 截断的 transcript 收集
- Monitor 状态与远程会话生命周期一致
- 不保存认证秘密，不把完整历史日志注入上下文

### 真实环境启动预检

M7 不只使用 fake adapter 验证；启动远程实现前必须使用当前用户已有的 OpenSSH 配置执行真实连通性测试：

```bash
ssh h100-server 'hostname && curl -fsSL --max-time 20 -o /dev/null -w "http_code=%{http_code}\nremote_ip=%{remote_ip}\ntime_total=%{time_total}s\nurl=%{url_effective}\n" https://www.google.com'
```

当前预检已通过：远端主机 `zhengchen-ubuntu-8xh100-05` 返回 Google HTTP `200`。该测试只证明 SSH、DNS、TLS 和 HTTPS 出网，不代表 M7 远程命令或 tmux 功能已经验收。真实 E2E 必须继续使用 `h100-server`，通过无害命令验证 `target_select`、`remote_exec`、tmux 创建/发送/capture/关闭、Monitor 状态和断线恢复；输出不得包含认证秘密。

### 验收标准

Agent 可以选择受信任目标，通过结构化 Tool 执行远程命令，并在本地 tmux pane 内创建、控制和关闭 SSH terminal；普通命令可直接使用一次 `terminal_bash` 在现有远端 shell 当前目录执行，无需手动组合 send/capture/status；断线、超时、非零退出和会话丢失状态可见；完整输出进入工作日志，主上下文只接收短成功输出或审阅摘要。验收同时要求 fake adapter 测试和 `h100-server` 真实 E2E 测试。

### 补充验收记录（2026-07-31）

- Terminal transport 已从“SSH 到远端 tmux”改为“本地 tmux pane 内运行 SSH”，并通过真实 `h100-server` E2E 验证 cwd、命令执行、增量 capture、连接重建、关闭和 5,000 行完整日志。
- `terminal_bash` 使用本地 transcript 和 marker/退出码协议，完整脱敏输出按 terminal 追加到 `.beaupi/terminal-logs/.../工作日志.log`；临时 transcript 在关闭/dispose 时清理。
- 共享 `review.model` 默认 `gpt-5.6-luna`，裸 model id 优先跟随当前 Agent provider；Terminal 与 Sudo Bash 的短成功输出直接返回，失败或输出超过 100 行才审阅，未设置额外 `maxTokens` 硬限制。
- Tool Result 最后一行由代码强制为 `@绝对日志路径`；模型失败使用确定性 fallback，review usage 进入 Tool Result/Session 使用统计。
- AgentSession 根据 Remote details 的 `ok` 设置 `isError`，非零退出、超时和断线不再因通用异常路径丢失 terminal/monitor/log/review details。

---

## M8：联网搜索闭环

状态：已完成（2026-07-30）。

### 目标

提供可验证、有预算、不会无限 fallback 的联网研究能力。

### 交付物

- 统一 `SearchProvider` 接口
- 首个可配置 SearXNG JSON Provider
- `web_search`
- `web_fetch`
- HTML 正文提取和 Markdown 转换
- URL、查询缓存与内容 hash 去重
- 结果截断和完整内容临时文件
- 稳定网络引用与保守的第一方来源优先级
- 查询、fetch、Provider 尝试、字节、字符、重定向和 timeout 预算

### 验收标准

研究任务优先返回与查询主体匹配的第一方候选来源；Provider 失败达到预算后停止并报告配置问题，不改用多个等价 Shell 命令继续尝试。

### 验收记录（2026-07-30）

- `SearchRuntime` 由现有 `AgentSessionServices` 按 cwd 持有，`createAgentSession()`、默认 Tool registry 和 `AgentPool` 复用同一实例；Coordinator 与受控 `researcher` 子 Agent 共享查询/URL 缓存和预算 scope，不复制缓存到 Session branch。
- `SearchProvider` 固化规范化结果接口；第一版只实现 SearXNG JSON API。endpoint、Provider timeout、结果数、可选 engine allowlist、查询/正文 TTL 和全部 M8 预算来自现有 Settings，endpoint/API key 也可由环境变量注入，secret 不进入 Session、Tool details、缓存或诊断；全部引擎 suspended/unresponsive 且无结果时返回结构化错误。
- `web_search` 使用 TypeBox/Compile 校验，执行 NFKC 查询规范化、规范 URL 去重、include/exclude domain 过滤和可解释的 query-domain/requested-domain 排序；snippet 明确保留为未验证发现信息。
- `web_fetch` 只允许 HTTP/HTTPS，拒绝 URL credentials、localhost、loopback、私网、link-local、保留地址和 metadata hostname；IPv4/IPv6 DNS 结果分别验证并固定到 Undici lookup，每次重定向重新校验。标准 HTTP(S) proxy 路径固定已验证目标 IP，并保留原始 Host/TLS SNI；支持 timeout、AbortSignal、响应字节和重定向上限。
- HTML 使用内置、无脚本执行的正文转换器移除 script/style/nav/header/footer/aside 等噪声并输出 Markdown；text/JSON 使用受控解析。PDF 和其他 content type 返回结构化 unsupported 诊断。
- 文件缓存使用版本化、原子写入的 query/URL JSON entry，保存 canonical key、source/URL、fetchedAt/expiresAt、content hash 和规范化结果；损坏/过期 entry 安全失效并重建，并发相同请求只访问一次网络。
- 大正文沿用 2,000 行/50 KiB 模型输出上限，完整 Markdown 写入权限受限的临时文件；相同 content hash 在同一任务预算 scope 中只注入一次正文。
- 搜索级和正文级 `WebCitation` 进入 Tool details、Session 与现有 Task Ledger；Task Ledger 记录调用状态、cache hit、预算、诊断和引用，子 Agent 只向 Coordinator 返回结构化引用，不返回 transcript。
- M8 预算确定性限制单次结果数、单任务 query/fetch/Provider 尝试、单次 fetch 字节、总输入字符、timeout 和 redirects；达到限制后不继续网络访问，并通过 Tool prompt guideline 禁止 curl/wget/Python/Node/Bash 等价 fallback。
- M8 本身不实现通用 Shell Policy Engine；M10 在现有 Tool 生命周期中分类 Bash、Remote 和 terminal 网络 fallback，并只记录 Footer advisory。
- fake provider、fake HTTP server、可控时钟和临时目录测试覆盖成功、空结果、参数、排序/去重、缓存、正文提取、hash/截断、错误分类、SSRF、预算、Session 恢复、分支预算重建、子 Agent 隔离/引用传递及 80/120/160 列 renderer。

---

## M9：Claude Code 风格询问选择框

状态：已完成（2026-07-30）。

### 目标

让 Agent 在存在真实歧义或需要用户偏好时，通过结构化 Tool 显示 Claude Code 风格的询问选择框，并把用户选择作为当前 Tool call 的确定性结果继续执行。

### 交付物

- `ask_user_question`
- 1–4 个问题、短 header、2–4 个唯一选项的版本化 schema
- 单选、多选、自动 `Other` 自由输入和取消
- 多问题 tab、已回答标记、review/submit
- 可选单选 Markdown preview、notes 和窄终端降级
- 现有 keybinding、selector、editor、Tool registry 和 AgentSession 生命周期接入
- SDK/RPC interaction callback 与无交互通道的 `interaction_required`
- 当前 Session branch 的 pending/answered/cancelled 事实恢复
- Coordinator-only 用户交互边界；子 Agent 只返回 clarification request

### 实现参考与边界

参考 `../claude-code/` 的 `AskUserQuestionTool`、`AskUserQuestionPermissionRequest`、`QuestionView`、`QuestionNavigationBar`、`SubmitQuestionsView`、`PreviewQuestionView` 和 `use-multiple-choice-state`，提炼以下行为：

- 单问题单选选择后自动提交
- 多选不自动推进，显式 Next/Submit
- 多问题以 header tab 导航，并显示 answered checkbox
- 普通问题自动提供自由输入
- preview 问题使用左侧选项、右侧有界预览和 notes
- 选项、自由输入和 notes 在切题/resize 后保持

不复制 React/Ink 代码、品牌资源或 Plan interview；第一版不包含图片粘贴、HTML preview、Channel relay 或新的 Plan Mode。所有键位必须进入现有可配置 keybinding，不硬编码业务键检查。

### 测试

使用 faux provider 和可控 TUI 覆盖：

- schema 数量、唯一性和长度边界
- 单问题单选自动提交
- 多选、Other 输入、多问题导航和 review
- preview/notes、长文本、CJK、emoji 和 truncation
- cancel/reject/interaction_required
- Session resume、Compact 和 branch 切换
- 子 Agent Tool 隔离
- 暗色/亮色与 40/80/120/160 列宽度
- faux Coordinator 收到答案后继续同一任务

### 验收标准

用户可以只用键盘完成单选、多选、Other 输入、多问题 review 和取消；结构化答案回到原 Tool call 后 Agent 继续；TUI 外模式不挂起；所有布局在窄终端下无横向溢出。

### 验收记录（2026-07-30）

- `ask_user_question` 使用严格 TypeBox schema：1–4 题、12 字符 header、2–4 个选项、无额外字段；Runtime 复验 NFKC、header/label 唯一性、内置 Other 冲突、单选 preview 限制和总 preview 预算。
- Session-bound `QuestionRuntime` 串行化交互，处理 answered/cancelled/rejected/interaction-required/interaction-error、AbortSignal、重叠请求和 handler 异常；无 handler 时立即返回，不读取 stdin。
- InteractiveMode 复用现有 custom UI、Editor、Markdown、Theme 和焦点恢复，支持单选、多选、Other、notes、问题 tab、answered 标记、review、preview confirmation、外部编辑器以及宽/窄布局。
- `app.question.next/previous/toggle/notes/submit` 已进入统一 keybinding；选项导航、取消和外部编辑器继续复用现有 TUI/app action。
- Tool result 走普通 message/Session JSONL 生命周期；Task Ledger 从当前 branch 重建精简 interaction facts，仅在等待回答时投影一个用户 blocked Todo，并通过 Compact/branch 测试验证恢复。
- RPC 复用 `extension_ui_request`/`extension_ui_response`，新增 `askUserQuestion` 和同 id answers/cancelled/rejected/error 响应；`RpcClient` 提供可控 callback。SDK 提供 `questionHandler`/`questionRuntime`。
- Coordinator 默认启用；AgentPool 在 allowlist、custom Tool 和 `excludeTools` 三层硬排除该 Tool，子 Agent system prompt/result 使用机器可读 `<clarification_request>`。
- faux provider、fake RPC child、可控时钟和 fake TUI 覆盖 schema、错误、顺序、Session/Compact/branch、SDK、RPC、AgentPool、renderer、CJK、Markdown 和窄终端。

---

## M10：Policy Engine

状态：已完成（2026-07-30）。

### 目标

把重复命令、失败预算、敏感/权限边界和等价 fallback 从模型提示转化为确定性分类与 advisory，并覆盖本地、远程和网络执行。

### 交付物

- 命令与错误分类
- 等价操作签名
- Shell、远程执行、网络和失败预算
- `PolicyDecision` 与 advisory details；新的 decision 只使用 `action: "allow"`
- Session 恢复、分支切换和并发调用下的策略事实一致性
- 缺少依赖、权限不足、认证失败、限流和超时的分类与 advisory
- Policy details 接入现有 Task Ledger，当前执行或最近 Policy fact 的 advisory 只接入 Footer
- 不发起 Policy confirm，不调用 M9、SDK 或 RPC 交互接口
- 明确不增加专用 Git Tools；普通 Git 操作继续使用现有 Bash 能力和仓库开发规则

### 验收标准

工作区相关事实未变化时，重复等价检查仍执行并记录 advisory；达到失败或 fallback 预算后原操作继续执行；敏感、特权、terminal 和网络 fallback 条件使用一致的非阻断 Policy 语义。

### 验收记录（2026-07-30）

- `core/policy/` 提供集中默认预算、保守 Shell/路径/错误分类、稳定脱敏签名和 Session-scoped 串行 Policy Runtime；新的 Policy fact 始终记录 `decision.action: "allow"`。
- Tool registry wrapper 和用户 Bash 共用同一分类/finalize 生命周期；本地 read/grep/find/ls/write/edit、Bash、Remote、terminal、target selection 和 Search facts 都进入现有 Session/Task Ledger。
- quote、escaped newline、operator、pipeline、redirect、multiline、常见 wrapper/解释器、Git inspect/mutation、敏感路径、远程绝对写入和本地 symlink 边界已有定向分类测试；Policy details 只保留 hash、类别和非敏感摘要。
- 等价只读检查在目标 revision 未变化时仍执行并记录 advisory；不透明/修改操作不按文本去重；并发 read/mutation finalize 不回滚 revision；失败、类别和 fallback 预算原子更新，取消不消耗普通失败预算。
- 能够明确解析为直接执行的 sudo/su/doas/pkexec、敏感路径、工作区/远程边界、symlink、terminal 未知/超长/待处理输入、Search-to-Shell fallback 和专用 Tool 推荐都只产生 advisory。
- Policy 不发起 confirmation、不调用 TUI/SDK/RPC handler，也不向受控子 Agent 返回 `policyRequest`；旧 SDK 输入保留为 no-op，RPC Client 对旧 `policyConfirm` 请求只返回 cancelled。
- 当前执行或最近 Policy fact 的 advisory 只显示在 Footer；Tool renderer 不显示 blocked/confirm/replace/paused。旧 Session 中的 Policy action/status/confirmation details 保持可解析；Session 文件恢复、Compact、branch 切换、extension details replacement、用户 Bash custom facts 和 AgentPool 边界均有 faux/fake 测试。
- Policy Runtime、AgentSession、renderer、AgentPool、Task Ledger、完整非 E2E 测试和 `npm run check` 均作为验收检查。

---

## M11：多 Agent Workflow

状态：已完成（2026-07-31）。

### 目标

在已稳定的子 Agent、Monitor 和策略系统上实现 DAG 调度。

### 交付物

- Workflow YAML/JSON Schema
- 依赖、条件、并发限制、超时和取消
- `workflow_run`、`workflow_status`、`workflow_cancel`
- 单写者调度
- 并行写入 Worktree 隔离
- 节点结构化输入输出
- 节点状态接入 Monitor、Todo、Footer 和统一状态符号
- 首批工作流：`research`、`implement-review`、`parallel-review`、`debug`、`docs-execute`

### 验收标准

`implement-review` 能串行完成实现与审查；两个只读节点能够并行；两个共享工作区写入节点不会并发执行；节点状态和日志可在 Monitor 中查询。

### 验收记录（2026-07-31）

- `core/workflow/` 已提供 `version: 1` 的严格 TypeBox Schema、YAML/JSON/内置名称解析、重复 ID/未知依赖/环/Profile/条件/预算校验，以及五个内置 Workflow。
- 条件解析器只接受常量或 `deps.<id>.status|output.<path> ==|!= <JSON 标量>`，支持有界 `&&`/`||`，不使用 `eval`/`new Function`；节点 prompt 只包含依赖的结构化输出、状态、错误和诊断。
- DAG scheduler 同时服从 Workflow `maxConcurrency` 和 AgentPool 全局并发槽；只读节点可并行，shared 写入跨同时运行的 Workflow 全局单写且与同工作区只读节点互斥，isolated 写入可并行。
- `WorkflowWorktreeManager` 通过现有无 shell `execCommand()` 执行 Git Worktree 操作，使用受控临时根和 `beaupi-workflow/*` 分支；创建/清理串行，只删除自身生成路径，失败/取消/非成功 Workflow 立即清理，成功节点在 Session 结束清理。
- `workflow_run`、`workflow_status`、`workflow_cancel` 已默认注册到启用 AgentPool 的 Coordinator，使用严格参数和版本化 details；AbortSignal、节点超时、Workflow 取消和重复取消均返回确定终态。
- Workflow/节点使用现有 Monitor kind/adapter、状态机和 activity log；`monitor_status/logs/wait/stop` 可直接查询或取消，不建立独立监控器。恢复时无法确认的运行状态标记 `lost`。
- Workflow 实时快照和 Tool Result 进入现有 Task Ledger，并驱动 Todo、Footer、minimal Tool shell 和 DAG renderer；Compact、resume 和 tree branch 切换只恢复当前分支事实。
- faux provider 与 fake Git/Monitor 场景覆盖 Schema/环、依赖/条件、并发、shared 互斥、isolated 隔离/清理、成功/失败/跳过/取消/超时、Tool、Monitor、Session、Profile 边界和暗/亮 40/80/120/160 列。

---

## M12：后台任务与自动唤醒

### 目标

在 M6 Monitor Runtime 之上让长时间运行的本地或远程任务在模型回合结束后继续执行，并在关键事件发生时恢复 Agent。

### 交付物

- `background_start`
- `background_attach`
- `background_status`
- `background_logs`
- `background_wait`
- `background_cancel`
- Monitor Registry 复用、增量日志和持久化任务状态
- 自适应进程/远程会话轮询
- Wake Queue 去重与串行处理
- 空闲时触发 turn，忙碌时发送 follow-up
- 受预算约束的 Progress Reviewer
- Session 恢复时重新接管任务

### 测试

- 本地和远程长任务启动、接管、完成、失败、超时、停滞和取消
- 日志无变化时不调用模型
- Agent 忙碌时事件进入 follow-up 队列
- 多个同时完成事件不会并发启动多个 Coordinator turn
- Session 恢复后不重复消费事件
- 后台任务继承当前执行身份和后端权限；Policy 只记录 advisory，不作为权限强制边界

### 验收标准

脚本完成后自动触发新的 Agent turn；无日志变化时不调用模型；多个同时完成事件不会并发启动多个 Coordinator turn；本地和远程任务使用同一套 Monitor 状态和日志语义。

### 验收记录

- `core/background/` 提供版本化 Task/Trigger/WakeEvent/ProgressReview、严格 Tool/Store schema、session-scoped Manager、runner-owned Process adapter、Trigger Evaluator 和 Wake Queue；MonitorRecord 继续是目标状态唯一来源。
- `background_start/attach/status/logs/wait/cancel` 默认注册；start/wait 立即返回，logs 使用现有 cursor/hash/rotation/truncation 语义，cancel 对本地进程执行有界 TERM→KILL，并与 `monitor_status/logs/wait/stop` 观察同一 monitorId。
- completed/failed/timeout/stalled/error-pattern/progress-review 以 task/reason/status/log hash 去重；多事件合并，Coordinator 空闲时通过现有 custom message 触发 turn，忙碌时进入 follow-up，不创建第二个 Agent loop。
- Progress Reviewer 共享 AgentPool/ModelRuntime，只接收目标、上次摘要、新日志、运行时和资源，具有最小间隔、最大次数、输入字符、输出 token 和 wall-clock timeout；hash 无变化时零调用，失败不改变任务终态。
- custom entries 保存 task、trigger、Wake Queue、消费 key 和 review budget；Compact/resume/branch 只恢复当前分支，未确认目标为 `lost`，已消费事件不重复。
- Task Ledger、Todo、Footer、Tool renderer 和 Background renderer 已接入；测试覆盖真实短本地进程、fake process/remote、faux idle wake/busy follow-up/reviewer、进程组取消、恢复/branch 和暗/亮 40/80/120/160 列。

状态：已完成。

## M13：受控权限能力

状态：已完成（2026-08-01）。

### 目标

在 SSH/tmux 和 Policy Engine 稳定后提供可审计的结构化提权，不改变 Agent 进程的普通用户边界。

### 交付物

- local Bash 和 `terminal_bash` 的 sudo 自动路由到统一 `PrivilegeRuntime`
- 结构化 `privileged_exec`
- 完整 sudo 命令或换行分隔批次直接填充到双分割线 tmux、用户 Enter 执行或 Escape 取消，以及受控 PTY 输入
- 认证完成后临时终端自动detach，缓存credential时在稳定running后detach；`sudo bash`、`sudo sh`、`sudo -i`和`sudo -s`明确阻止
- `terminal_send` sudo bypass 拦截
- 非交互模式和无可控 PTY 的远程 one-shot 路径默认阻止
- JSONL 审计日志
- permission/confirm/blocked 状态复用统一 Tool renderer 和 Monitor
- 不实现 `/mode sudo`、一次授权或限时会话授权

### 验收标准

Agent 进程始终以普通用户运行；每个 sudo request 都先在受控权限终端中填充而不执行，并只由用户按 Enter 释放；密码不进入 Agent 数据链；本地与远程提权均有审计记录。

### 验收记录（2026-08-01）

- `privileged_exec`、local `bash` 和 `terminal_bash` 的明确 sudo command 统一进入 session-scoped `PrivilegeRuntime`；普通执行器和 one-shot SSH 路径不能旁路。
- 每个 request 第一帧直接在双分割线 tmux 中显示完整只读命令或批次；Enter 执行、Escape 取消，不存在 `/mode sudo`、once/session grant、keepalive 或恢复授权。
- local privilege session 使用独立 tmux server 继承真实用户 shell、startup files、cwd 和环境；local 与 existing remote terminal 共用 secure stdin buffer，认证输入不进入 argv、Session、Monitor、Task Ledger、日志、审计或模型上下文。
- 认证视图detach后command继续由Runtime等待并写work log；正常pane dead先解析end marker而不误报lost；短成功输出直返，长输出或失败复用共享`review.model`。
- `terminal_send` sudo bypass、非交互模式、取消、超时、terminal lost、JSONL 权限和 branch/reload/dispose 生命周期均有自动化验证。
- M13 相关定向测试 16 个文件、85 个测试通过；`./test.sh` 和 `npm run check` 通过，无错误、warning 或 info。

## M14：动态 Task 计划与进度审阅

状态：已完成。

### 目标

让主 Agent 在可执行任务开始时创建结构化计划，并在动工、范围变化和验证阶段更新 Tasks；后续完成度由确定性事实优先、快速模型受限辅助更新，不通过普通文本 JSON 或 Agent 间对话同步状态。

### 交付物

- Coordinator-only `tasks_update` Tool 和严格版本化 `DynamicTaskPlanV1`
- task revision、`expectedRevision` CAS、Session custom entry、Compact/resume/branch 恢复
- 可执行用户提示词进入时由主 Agent 在现有回合内提交初始 Task JSON，不额外启动预规划模型回合
- 首次 Edit/Write/修改型 Bash 自动激活对应任务；重大范围变化由主 Agent 刷新计划
- Dynamic Tasks 接入现有 Task Ledger、Tasks Widget、Footer 和宽度安全 renderer；存在动态计划时隐藏重复的通用 discover/execute/verify Todo
- 确定性 Tool、文件修改、验证、Workflow、Background 和 Monitor facts 优先更新 activity/evidence
- Task Reviewer 与 Bash Terminal 共同复用 `review.model`、ModelRuntime 解析和 provider fallback，不增加独立模型设置；只允许修改状态、activity、evidence 和 blockedBy，不能增删、重命名或重排任务
- Reviewer 只在 facts hash 变化、主 Agent settled、修改批次结束、验证结束或关键失败时受预算调用；普通完成不向主 Agent 注入对话消息
- 每次 Provider 请求前向主 Agent 投影紧凑任务快照；只有 blocked、revision 冲突或需要重新规划时进入 follow-up

### 安全与一致性边界

- 主 Agent 是任务结构的唯一作者，Task Runtime 是唯一事实源，快速模型只提交带 revision 的受限 patch。
- 不解析 assistant 普通回复中的 JSON，不创建第二套 Task Ledger，不让快速模型直接调用主 Agent。
- Reviewer 失败、格式错误、超时或 revision 过期时不修改任务状态；无新增事实时零模型调用。
- 纯问答和闲聊不创建动态 Todo；无动态计划时继续使用现有通用 Task Ledger 投影。

### 验收标准

一个可执行用户任务能在首次主 Agent 回合生成动态计划；首次修改和重大阶段变化及时更新 Tasks；完成、失败、阻塞和验证状态可由确定性事实或受限 Reviewer 安全推进；Session 恢复、Compact、branch 切换和 Reviewer 失败不会丢失、重复或回滚任务状态，主 Agent 对话历史不被普通进度更新污染。

### 验收记录（2026-08-01）

- 已交付 Coordinator-only `tasks_update`、严格 TypeBox schema、单调 revision/CAS、branch-local snapshot/review custom entry 和唯一 `DynamicTaskRuntime`。
- 首次 mutation、sudo、verification、Workflow、Background 和 Monitor 使用稳定结构化 facts；无明确匹配不修改任意 Task，重复事件不推进 revision，facts-only revision漂移可安全重基而不触发重复 `tasks_update`。
- 受限 Task Reviewer 与 Terminal 共用 `review.model`、ModelRuntime 和 provider fallback；无新 facts零调用，revision/hash/evidence不匹配及失败路径均原子丢弃。
- Dynamic Tasks 已接入 Task Ledger、Tasks Widget、Footer、usage统计和每请求 prompt projection，并保持 Document、Workflow、Background、Monitor、interaction、privilege 和 failure 共存。
- faux provider、恢复、并发、dispose、Reviewer、Prompt、暗亮主题及 40/80/120/160 宽度测试已覆盖；定向测试、相关测试、`./test.sh` 和 `npm run check` 通过。

## M Final：发行准备

M Final 不占用后续数字里程碑；新增功能继续使用 M15、M16 等编号，全部功能稳定后再进入最终发行。

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

## 第一开发周期（已完成的历史记录）

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

## 当前推荐开发入口

M0–M14 已形成连续能力闭环。后续功能继续使用 M15、M16 等编号；M Final 发行准备等待后续新增功能稳定后再启动。

M14 已稳定复用现有 AgentSession、Task Ledger、Session custom entries、ModelRuntime 和 TUI，并提供后续里程碑可复用的 branch-local revision/CAS、结构化 facts、受限 Reviewer 和 next-turn projection 边界。
