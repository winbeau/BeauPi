# 开发路线

## 开发顺序

BeauPi 第一项开发工作是建立 Claude Code 风格 TUI。先固定消息、Tool、Diff、Footer、Compact、状态符号和终端宽度处理，后续 Task Ledger、Skill、子 Agent、Workflow 与后台任务直接接入这些组件，不在功能完成后再集中重写展示层。

TUI 优先不代表先伪造尚未存在的运行时状态。阶段 2 只渲染现有真实数据，并为未来组件定义稳定的视觉接口；Todo、Agent、Workflow 和 Background 的真实状态分别在对应阶段接入。

## 阶段 1：BeauPi 基础整合

目标：在现有 `packages/coding-agent` 中建立最小可运行的 BeauPi 发行版，不创建新 Package。

- 将应用名、CLI、配置目录和环境变量统一为 BeauPi
- 增加 BeauPi 源码启动和开发命令安装脚本
- 保持内部 npm 包名暂时不变
- 整合默认 System Prompt 和内置资源加载入口
- 增加品牌、配置目录、帮助和版本输出回归测试

验收：`beaupi` 能从 TypeScript 源码启动，使用 `.beaupi` 配置，现有 Pi Coding Agent 功能保持可用。

## 阶段 2：Claude Code 风格 TUI 基础

目标：把当前可用交互界面优先调整为统一的 Claude Code 风格，并建立后续功能复用的视觉组件。

- 创建 BeauPi 暗色和亮色主题
- 保留 Pi 当前跳动加载图标
- 调整用户与 Assistant 消息层级
- 替换普通 Tool 默认背景卡片为紧凑标题和缩进结果
- 对照 `AssistantToolUseMessage` 重做 Tool 标题和 queued/running/permission/success/error 状态
- 对照 `CollapsedReadSearchContent` 实现 Read/Search/List/Bash 聚合与当前操作提示
- 重做现有 Read、Write、Edit、Bash 和 Search renderer
- 对照 `StructuredDiff` 实现整行增删背景、词级高亮、行号 gutter、上下实线边界和缓存
- 将 TPS 从通知改为 Footer 状态
- Footer 显示 cwd、branch、模型、Session 累计用量、当前上下文 token、窗口上限和占用百分比
- Compact 使用实际流式总结输出驱动 Claude Code 风格渐近进度条
- 实现三行 Footer 和 80/120/160 列窄终端降级
- 保留 Ctrl+O Tool 输出展开行为
- 保留 Write 折叠提示的动态跳数字：写入过程中新增行数和总行数必须逐行累加更新
- 建立可供 Todo、Agent、Workflow 和 Background 复用的状态符号、gutter 与布局 helper
- 使用 tmux 截图进行视觉回归检查

实现边界：

- 不直接引入参考仓库的 React/Ink 组件、Logo、吉祥物或品牌资源
- 优先使用现有 `renderCall`、`renderResult` 和 `details.patch`
- 不重写 Tool 执行逻辑和 edit 算法
- 不为展示效果提前实现 Task Ledger、子 Agent 或 Workflow Runtime
- 文案、颜色和布局后续可以调整，但 Write 动态行数、Ctrl+O 展开和 Pi 加载动画必须保留

验收：普通会话中的消息、Read、Write、Edit、Bash、Search、Diff、Footer 和 Compact 使用统一视觉语言；普通 Tool 不再使用大面积背景卡片；Write 行数在写入过程中持续动态更新；所有组件在暗色、亮色和 80/120/160 列终端下可读且不横向溢出。

状态：已完成（2026-07-28）。详细规范见 [Claude Code 风格 TUI](./ui-style.md)，完整实施拆分和验收记录见 [Claude Code 风格 TUI 调整计划](./plans/README.md)。

## 阶段 3：Task Ledger 与任务可视化

- 实现 Task Ledger
- 记录 phase、Tool、Shell、失败、文件读取和文件修改事件
- 将命令事实保留在 Task Ledger，Tasks Widget 只展示任务清单
- 加入重复 `git status` 检测
- 基于 Ledger 实现 Todo Widget
- 对照 `TaskListV2` 实现 Todo 排序、动态截断、owner、blocked 和最近完成保留
- 将任务阶段和验证状态接入阶段 2 的 Footer/Todo 组件；文档 Requirement 保留在 Task Ledger，不单独投影为 Todo

验收：普通编辑任务能够展示当前阶段、已修改文件、待验证事项和 Tool 状态；工作区未变化时能够识别短时间内重复的 `git status`。

状态：已完成（2026-07-29）。Task Ledger 由当前 Session branch 的稳定 Tool call id、Tool Result `details` 和 Bash Session entry 重建；Tasks Widget 与 Footer 已接入 M1 视觉基础，命令事实仍保留在 Ledger 中但不单独渲染，重复 `git status` 按 30 秒窗口和账本观察到的工作区 revision 识别。

## 阶段 4：文档驱动执行

状态：已完成（2026-07-29）。

- 实现文档发现
- 实现 `docs_search`
- 实现按 heading/行范围读取的 `docs_read`
- 跟踪 Markdown 引用
- 生成 Execution Contract
- 检测文档变更
- 在 Task Ledger 保留文档 Contract 与 Requirement，并在 Todo Widget 只展示 actionable required check、completion 和验证状态

验收：Agent 能按 `AGENTS.md` 和相关文档执行任务，并说明关键操作来源。

M3 已完成：Document Runtime、Markdown citation、内容 hash/stale、Execution Contract、三个内置 document Tool、Task Ledger/Todo/Footer 投影、Session branch 恢复和 faux provider 测试均已接入现有 Agent 生命周期。下一阶段为 Skill Registry，不在 M3 提前实现 Skill 导入或注册。

## 阶段 5：Skill Registry

- 复用 Pi Agent Skills discovery 和 `resources_discover`
- 实现 user/project Registry
- 实现本地、Claude Code、Codex、Git 和 npm 导入
- 实现 `/skills` 管理 UI，并复用阶段 2 的列表和状态语言
- 实现 import/enable/disable/remove/validate 命令
- 实现冲突诊断和来源展示
- 修改后调用 `ctx.reload()` 热加载
- 为子 Agent Profile 增加 Skill allowlist
- URL 和项目 Skill 加入安全确认

验收：Skill 可以导入、注册、启停和热重载，同名 Skill 不会静默覆盖。

详细设计见 [Skill 导入与注册](./skills.md)。

## 阶段 6：进程内子 Agent

- 创建共享 ModelRuntime 的 Agent Pool
- 实现受控子 Agent ResourceLoader
- 实现 Agent Profile
- 实现 `delegate_task`
- 支持流式状态、取消、超时和预算
- 返回结构化结果，不回传完整会话
- 对照 `AgentProgressLine`，将真实子 Agent 状态接入阶段 2 的树形 gutter 和状态组件

验收：子 Agent 无需启动额外 Pi 进程，并能在 TUI 中实时展示状态。

## 阶段 7：联网搜索

- 实现统一 SearchProvider 接口
- 首先接入一个 Provider
- 实现 `web_search`
- 实现 `web_fetch`
- 增加 HTML 主体提取和 Markdown 转换
- 增加 SQLite 缓存
- 增加来源评分、去重和引用
- 实现研究预算和 Provider fallback 策略
- 搜索状态和结果复用阶段 2 的 Search renderer

验收：研究结果优先使用官方来源，并保留可验证引用。

## 阶段 8：失败与命令策略

- 命令分类
- 错误分类
- 等价操作签名
- 缺少依赖时暂停
- 权限错误时暂停
- 网络 fallback 限制
- Shell 软/硬预算
- 专用 Tool 替代高频 Bash 操作
- Policy block/confirm/replace/pause 状态接入统一 Tool 状态组件

验收：达到失败或 fallback 预算后 Agent 暂停并报告原因，不继续尝试等价 Shell 方案。

## 阶段 9：Git Tools

- `git_snapshot`
- `git_diff`
- `git_sync_status`
- `git_commit`
- 缓存失效规则
- 并发会话安全检查
- Git diff 和 commit 结果复用阶段 2 的 Diff 与 Tool renderer

验收：普通 commit 流程不再反复调用多个 Git 检查命令。

## 阶段 10：多 Agent Workflow

- 定义 Workflow YAML/JSON Schema
- 实现 DAG 调度
- 实现依赖、条件和并发限制
- 默认单写者
- 增加 Worktree 隔离写入
- 实现 `workflow_run/status/cancel`
- 将真实节点状态接入统一 Todo、树形 gutter 和状态符号

首批工作流：

- research
- implement-review
- parallel-review
- debug
- docs-execute

验收：只读节点可以并行；共享工作区写入节点不能并发；Workflow 状态在 TUI 中实时更新。

## 阶段 11：后台任务与自动唤醒

- 实现 Background Task Manager
- 后台进程输出写入独立日志文件
- 实现完成、失败、超时和关键日志触发器
- Agent 空闲时通过现有 Session 消息机制自动恢复 turn
- Agent 忙碌时进入 Wake Queue
- 实现自适应进程轮询
- 实现受预算约束的模型进度复查
- Session 恢复时重新接管仍在运行的任务
- 将真实后台状态接入阶段 2 的状态组件和 Footer

验收：模型回合结束后脚本继续执行，脚本结束时 Agent 自动读取结果并继续处理。

## 阶段 12：SSH 和 tmux

- Execution Target 配置
- SSH ControlMaster 支持
- 代理 read/write/edit/bash Operations
- tmux 会话创建、发送、状态和停止
- 增量日志捕获
- 日志摘要和完整输出文件
- 远程目标和长任务状态接入 Footer 与 Tool renderer

验收：远程和 tmux 操作使用结构化 Tool；长日志默认增量展示且不会整体污染上下文。

## 阶段 13：权限模式

- `/mode user`
- `/mode sudo once`
- `/mode sudo session <duration>`
- 结构化 privileged actions
- 非交互模式默认阻止
- JSONL 审计日志
- 自动超时降权
- permission/confirm/blocked 状态复用统一 Tool renderer

验收：Agent 进程始终以普通用户运行；未授权提权被阻止；授权到期后自动恢复用户模式。

## 贯穿阶段：Provider 兼容与自动压缩可靠性

BeauPi 复用 Pi Runtime 时，普通对话、自动压缩、分支摘要和子 Agent 请求必须执行同一套 Provider 兼容策略，不能假设模型目录中的能力标记永远与实际端点一致。

已验证经验（OpenAI Responses 自动压缩回归）：

- 自动压缩是独立的总结请求；为避免无复用价值的缓存写入，可以使用 `cacheRetention: "none"` 和独立 `sessionId`。
- `openai-codex-responses` 与标准 `openai-responses` 是不同协议路径。Codex 能通过省略 `prompt_cache_key` 禁用会话缓存，不代表标准 Responses 端点接受 `prompt_cache_options`。
- 模型能力元数据只决定是否尝试发送可选参数，服务端响应才是最终事实。
- 当服务端以 HTTP 400 明确报告 `prompt_cache_options` unsupported/unknown/unrecognized 时，只删除该字段并重试一次。
- 不得对其他 HTTP 400 做兼容重试，避免隐藏无效 token 上限、工具定义或请求格式错误。
- 降级重试必须继续服从 AbortSignal、超时和原有 Provider retry 配置。

实现与验收要求：

- Provider Adapter 集中实现可选参数降级，不在自动压缩或 UI 层匹配错误字符串。
- 回归测试模拟“首次拒绝可选参数、第二次成功”，并断言第二次 payload 已移除该字段。
- 另测无关 HTTP 400 只请求一次并原样报错。
- 发布前分别验证标准 OpenAI Responses 与 OpenAI Codex 的手动压缩和自动压缩。
- 运行记录和诊断信息应记录发生过兼容降级，但不得输出 API key、Authorization header 或完整敏感请求体。

验收：Provider 可选参数与实际端点不一致时，自动压缩能够安全降级完成；非兼容性请求错误仍立即失败并保留原始原因。

## 阶段 14：发行版

功能稳定后再进行：

- 确定自有 npm 包和 CLI 发行策略
- Bun standalone binary
- 安装和更新脚本
- GitHub Actions 发布
- 文档与许可证归属
- 将标准 Responses、Codex、自动压缩和兼容降级加入发布 smoke test

## 第一版建议范围

第一版按以下顺序实现：

1. Claude Code 风格 TUI 基础
2. Task Ledger 和 Todo
3. 文档发现与读取
4. Skill Registry 和 `/skills`
5. 进程内 `delegate_task`
6. 一个搜索 Provider
7. 重复命令和缺少依赖检测

第一步只处理当前已有消息、Tool、Diff、Footer 和 Compact，不提前实现 Workflow、sudo、SSH、tmux 或后台 daemon。完成 TUI 基础后，所有新增功能必须直接使用统一的状态符号、gutter、折叠和宽度处理。
