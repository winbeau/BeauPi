# 开发路线

## 开发顺序

BeauPi 第一项开发工作是建立 Claude Code 风格 TUI。先固定消息、Tool、Diff、Footer、Compact、状态符号和终端宽度处理，后续 Task Ledger、Skill、子 Agent、Workflow 与后台任务直接接入这些组件，不在功能完成后再集中重写展示层。

TUI 优先不代表先伪造尚未存在的运行时状态。阶段 2 只渲染现有真实数据，并为未来组件定义稳定的视觉接口；Todo、Agent、Workflow 和 Background 的真实状态分别在对应阶段接入。

## 当前优先主线

M0–M14 已完成。M14 已建立动态 Task 计划与进度审阅闭环：

1. 主 Agent 通过 Coordinator-only `tasks_update` 在可执行用户任务的现有首次回合创建结构化计划。
2. 唯一 Task Runtime 使用 revision/CAS、稳定 facts 和 Session custom entry 管理 branch-local 状态，并投影到现有 Task Ledger、Tasks Widget 和 Footer。
3. 首次明确 mutation 自动激活匹配 Task；verification、Workflow、Background 和 Monitor 只更新明确关联的 Task，不从 assistant 普通文本解析 JSON。
4. 受限 Reviewer 与 Bash Terminal 共同复用通用 `review.model` 和模型 fallback，只提交受 revision/hash/evidence约束的状态 patch，不修改计划结构或直接与主 Agent 对话。
5. 后续功能继续使用 M15、M16 等编号；发行准备保留为 M Final。

M10 已提供确定性分类、等价检查签名、失败/fallback 预算诊断、敏感路径与普通用户 advisory、Search-to-Shell advisory，以及 Session/Compact/branch 一致性。Policy authorization 始终返回 `execute: true`，不发起 TUI/SDK/RPC confirmation；当前执行或最近 Policy fact 的提示只显示在 Footer。普通 Git 操作继续使用 Bash，不增加专用 Git Tools。

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

状态：已完成（2026-07-29）。

## 阶段 6：进程内子 Agent

状态：已完成（2026-07-29）。

- 创建共享 ModelRuntime 的 Agent Pool
- 实现受控子 Agent ResourceLoader
- 实现 Agent Profile
- 实现 `delegate_task`
- 支持流式状态、取消、超时、轮数和 token 预算
- 返回结构化摘要、引用、修改、检查和错误，不回传完整会话
- 禁止子 Agent 默认递归调用 `delegate_task`
- 输出稳定生命周期事件，供阶段 7 的 Monitor Runtime 接管
- 对照 `AgentProgressLine`，将真实子 Agent 状态接入阶段 2 的树形 gutter 和状态组件

验收：Reviewer 子 Agent 无需启动额外 Pi 进程即可独立检查修改；Tool、Skill 和预算边界有效；主会话只接收结构化结果。

M5 实现了 `AgentProfile`、受控 ResourceLoader、共享 Runtime 的 Agent Pool、`delegate_task`、结构化结果和可去重的生命周期事件。当前每个内置子 Agent 在获得并发槽位后使用 10 分钟无进展窗口和 30 分钟最终 wall-clock 硬上限；单次较短 `budget.timeoutMs` 会随 assistant/turn/Tool 活动续期但不能越过硬上限，排队不消耗执行预算。全局并发上限为 `max(1, floor(availableParallelism() / 3))`；独立 `delegate_task` 调用可并行执行，排队任务可取消，槽位交接取消不会阻塞后续 waiter。超时结果保留流式 assistant 文本或最后活动摘要，Ctrl+O 可展开结构化结果详情。测试使用 faux provider 覆盖成功、失败、取消、超时、预算、并发和上下文隔离。

## 阶段 7：Monitor 监控闭环

状态：已完成（2026-07-29）。

- 建立统一 Monitor Runtime 和 session-scoped Monitor Registry
- 定义 Process、Tool 和 Sub-Agent monitor adapter
- 实现 `monitor_attach`、`monitor_list`、`monitor_status`、`monitor_logs`、`monitor_wait` 和 `monitor_stop`
- 统一 starting/running/healthy/stalled/completed/failed/cancelled/lost 状态
- 记录开始时间、运行时长、最后活动、退出原因和可用资源快照
- 日志按 cursor/hash 增量读取，完整输出保存在文件中
- 对完成、失败、超时、停滞和连接丢失事件去重
- 默认轮询不调用模型；只有显式 Progress Reviewer 才消耗模型预算
- 状态接入 Tool renderer、Tasks Widget 和 Footer
- Session 恢复后重建可确认状态，无法确认的目标标记为 lost，不猜测成功
- 预留 SSH/tmux monitor adapter，避免阶段 8 创建第二套监控系统

验收：本地长进程和子 Agent 可被统一列出、等待、查看增量日志和停止；状态变化不会重复计数；无日志变化时不调用模型或重复注入历史输出。

M6 已完成：Process/Tool/Sub-Agent adapter、fake adapter、状态机、cursor/hash 日志读取、session 恢复丢失判定、M5 AgentPool 事件接入、六个 `monitor_*` Tool 以及 Tool/Tasks/Footer 可视化均接入现有 AgentSession 生命周期。默认轮询不调用模型；SSH/tmux、自动唤醒和 sudo 保持后续阶段边界。

## 阶段 8：SSH 和 tmux 远程执行

状态：已完成（2026-07-30）。

- 增加 user/project scope 的 Execution Target 配置和信任边界
- 实现 `target_select` 和 `remote_exec`
- 复用系统 OpenSSH 配置、SSH Agent 和 known_hosts，不保存私钥或口令
- 支持 SSH ControlMaster 连接复用、连接超时和明确关闭
- 增加远程 read/write/edit/bash Operation adapter
- 实现 `terminal_create`、`terminal_bash`、`terminal_send`、`terminal_capture`、`terminal_status` 和 `terminal_close`
- `terminal_create` 在本机创建 tmux，pane 内直接运行 SSH；远端不依赖 tmux
- `terminal_bash` 将普通命令通过本地 `tmux send-keys` 注入现有 SSH shell，在 terminal 当前目录和导出环境中等待执行完成；普通命令不再手动组合 send/capture
- 每 terminal 将完整脱敏输出追加到 `工作日志.log`；短成功输出直接返回，失败或超过 100 行的输出由可配置小模型审阅，Tool Result 最后一行固定为 `@绝对日志路径`
- tmux capture 使用增量 cursor；非零退出、超时和断线保留结构化 details、usage 和 `isError`
- 将连接、远程命令和 tmux 会话接入阶段 7 的 Monitor Runtime
- 结构化区分认证、主机密钥、连接、命令、超时和会话丢失错误
- 第一版按受信任 Target 的 OpenSSH 配置身份执行，允许 AutoDL 等平台直接提供的 `root` 登录；能够明确解析为直接执行的 sudo/su/doas/pkexec 登录后身份切换只由 Policy 分类并显示 advisory，不由 Policy 阻断
- 真实环境预检固定使用现有 OpenSSH alias `h100-server`，先在远端执行 `curl -fsSL https://www.google.com` 验证 SSH、DNS、TLS 和 HTTPS 出网
- 真实 E2E 继续使用 `h100-server` 验证无害远程命令、tmux 生命周期、Monitor 状态、增量日志和断线恢复；fake adapter 测试仍然必须保留

验收：Agent 可以选择受信任目标，通过结构化 Tool 执行远程命令，并在本地 tmux pane 内保持 SSH terminal；普通命令通过一次 `terminal_bash` 在现有远端 shell 当前目录执行，交互式场景才使用 send/capture；断线、超时、非零退出和会话丢失保留结构化状态；完整日志落盘且主上下文只接收短成功输出或审阅摘要及 `@日志路径`；同时通过 fake adapter 测试和 `h100-server` 真实 E2E 测试。

## 阶段 9：联网搜索

状态：已完成（2026-07-30）。

- 已实现稳定 `SearchProvider` 接口，第一版只接入可配置 SearXNG JSON API
- 已实现 `web_search` 与 `web_fetch`
- 已实现 HTML 主体提取、Markdown 转换以及 text/JSON 支持；PDF 后置
- 已实现版本化文件缓存、TTL、原子写入、损坏重建、并发请求去重和 content hash 去重
- 已实现搜索级/正文级 `WebCitation`、规范 URL 去重和保守的第一方候选优先级
- 已实现 query/fetch/Provider/字节/字符/timeout/redirect 预算，第一版没有第二 Provider 或 fallback
- 已接入现有 AgentSessionServices、Tool registry、Task Ledger、AgentPool 和阶段 2 minimal Search renderer

验收：普通研究任务可先搜索、再获取受控正文；重复查询和 URL 命中共享缓存；所有结果保留可验证引用；预算或配置失败后停止，不使用 Shell 网络 fallback。

## 阶段 10：Claude Code 风格询问选择框

状态：已完成（2026-07-30）。

- 新增结构化 `ask_user_question` Tool，标记为 read-only、requires-user-interaction
- 输入支持 1–4 个唯一问题；每题包含不超过 12 个显示字符的 header、明确 question 和 2–4 个唯一选项
- 支持单选、多选和普通问题自动追加的 `Other` 自由输入
- 单问题单选选择后直接提交；多问题和多选提供 question tabs、已回答标记及最终 review/submit
- 支持上下导航、Tab/左右切题、Enter 选择、Esc 取消和外部编辑器，并接入现有可配置 keybinding
- 可选 Markdown preview 仅用于单选的代码、布局、配置和图示对比；宽终端左右布局，窄终端纵向/折叠降级
- 问题切换和 resize 保持每题选择、自由输入与 notes，不重复生成 Tool result
- answers、annotations、cancelled/rejected/interaction-required 使用版本化 Tool details，Session 恢复和 branch 切换只重建当前分支事实
- SDK/RPC 通过 interaction callback 回答；没有交互通道时立即返回 `interaction_required`，不挂起
- Coordinator 默认可用；受控子 Agent 不直接询问用户，只返回结构化 clarification request
- 复用现有 selector、editor、Markdown、minimal Tool shell 和 ANSI-aware 宽度 helper，不复制参考仓库 React/Ink 实现

参考实现：

- `../claude-code/packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`
- `../claude-code/src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx`
- `QuestionView.tsx`、`QuestionNavigationBar.tsx`、`SubmitQuestionsView.tsx`
- `PreviewQuestionView.tsx`、`PreviewBox.tsx`、`use-multiple-choice-state.ts`

不纳入 M9 第一版：图片粘贴、Plan interview 专用动作、HTML preview、Channel relay 或新的 Plan Mode。

验收：faux Coordinator 调用 `ask_user_question` 后，用户可以完成单选、多选、Other 输入、多问题切换、review/submit 和取消；结构化答案回到同一 Tool call 后 Agent 继续；TUI 外模式不会挂起；暗色/亮色及 40/80/120/160 列无横向溢出。

M9 实现了严格 TypeBox schema 和 NFKC/去重/预算复验、版本化答案结果、Session-bound Question Runtime、Claude 风格 selector、Markdown preview、可配置问题键位、minimal Tool 状态、SDK handler、RPC `askUserQuestion` 请求响应、Task Ledger interaction facts/pending Todo，以及受控子 Agent 的 Tool 硬排除与结构化 clarification request。Print/JSON 和无 handler SDK 立即返回 `interaction_required`；取消、拒绝、abort、重叠调用和 handler 错误均以确定性结构化状态结束。

## 阶段 11：Policy Engine（已移除）

状态：已完成（2026-07-30），随后在 Trusted-Local Runtime 升级中删除。

- 命令和错误分类
- 等价操作签名
- 缺少依赖、权限、认证、网络和超时的确定性分类与 advisory
- Shell、远程执行和网络 fallback 预算
- Session 恢复、分支切换和并发调用下的策略事实一致性
- Policy advisory 接入 Footer 工作区行，不改变统一 Tool 状态组件
- 不发起 Policy confirm，也不复用阶段 10 的交互接口
- 明确不增加专用 Git Tools，普通 Git 操作继续走现有 Bash 能力

M10 的 Core Policy Engine 已删除：工具调用不再经过授权门。仍保留的中性失败分类（`core/execution/`）只用于结果诊断。

## 阶段 12：多 Agent Workflow

状态：已完成（2026-07-31）。

- 定义 Workflow YAML/JSON Schema
- 实现 DAG 调度
- 实现依赖、条件和并发限制
- 默认单写者
- 增加 Worktree 隔离写入
- 实现 `workflow_run/status/cancel`
- 将真实节点状态接入统一 Monitor、Todo、树形 gutter 和状态符号

首批工作流：

- research
- implement-review
- parallel-review
- debug
- docs-execute

验收：只读节点可以并行；共享工作区写入节点不能并发；Workflow 状态在 TUI 中实时更新。

M11 已完成：`core/workflow/` 提供严格版本化 Schema、YAML/JSON/内置 Workflow 解析、无 `eval` 的有界条件、DAG/失败策略/取消/超时调度、跨并发 Workflow 的 shared 单写者、isolated Git Worktree 生命周期，以及 `workflow_run/status/cancel`。节点继续由 AgentPool 创建受控 AgentSession，只消费依赖结构化输出；Workflow/节点复用 Monitor activity log，并实时投影到 Task Ledger、Todo、Footer 和宽度安全的 DAG renderer。Compact、resume、branch 切换和未知运行状态恢复均只使用当前分支事实，不能确认时标记 `lost`。

## 阶段 13：后台任务与自动唤醒

- 在阶段 7 Monitor Runtime 上增加 Background Task Manager，不创建第二套进程监控器
- 实现 `background_start`、`background_attach`、`background_status`、`background_logs`、`background_wait` 和 `background_cancel`
- 后台进程输出写入独立日志文件
- 实现完成、失败、超时和关键日志触发器
- Agent 空闲时通过现有 Session 消息机制自动恢复 turn
- Agent 忙碌时进入 Wake Queue
- 实现自适应进程轮询和受预算约束的 Progress Reviewer
- Session 恢复时重新接管仍在运行的本地或远程任务

验收：模型回合结束后本地或远程脚本继续执行；脚本退出后自动唤醒 Agent；无变化时不调用模型；多个事件不会并发触发 Coordinator turn。

状态：已完成。M12 在单一 Monitor Registry 上实现 BackgroundTaskManager、runner-owned process exit facts、六个默认 Tool、自适应纯代码轮询、确定性 Trigger Evaluator、串行 Wake Queue、AgentSession idle/follow-up 注入、受预算 AgentPool Progress Reviewer、Session custom entry 恢复、Task Ledger/Todo/Footer 和暗/亮宽度安全 renderer。本地短进程、进程组 TERM→KILL、fake remote Monitor、faux Coordinator/reviewer、resume/lost/consumed/branch 路径均有定向测试；第一版不包含 daemon、IPC、通知或 sudo。

## 阶段 14：受控 sudo 终端（已移除）

状态：已完成（2026-08-01），随后在 Trusted-Local Runtime 升级中删除。

M13 的 `PrivilegeRuntime`、`privileged_exec`、受控 tmux PTY、逐请求 Enter 确认和 JSONL 审计已全部移除：`sudo`、`su` 等命令由普通 Shell executor 按宿主 OS 权限直接执行，不检查、预览、拦截或要求 Enter；root 与普通用户行为完全由宿主 OS 决定。

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

## 阶段 15：动态 Task 计划与进度审阅

状态：已完成。

- 增加 Coordinator-only `tasks_update` 和版本化 Dynamic Task schema
- 用户可执行任务进入时由主 Agent 在现有回合提交初始计划
- Task Runtime 维护 revision/CAS、Session、Compact、resume 和 branch 一致性
- 首次 Edit/Write/修改型 Bash 自动激活任务，计划结构变化由主 Agent 更新
- Dynamic Tasks 复用现有 Task Ledger/TUI，并在存在计划时隐藏重复通用 Todo
- 确定性 Tool、修改、验证、Workflow 和 Background facts 优先提供 activity/evidence
- 快速模型 Reviewer 与 Bash Terminal 共同复用通用 `review.model`、ModelRuntime 解析和 fallback，只提交状态 patch；无新增事实时零调用，失败或 revision 冲突时不更新
- 主 Agent 通过下一次 Provider 请求的紧凑任务快照感知状态；只有 blocker 或冲突进入 follow-up

验收：任务计划、动工、完成、失败、阻塞和验证状态可持续更新；主 Agent 是计划结构唯一作者，Runtime 是唯一事实源，快速模型不会污染主对话或回滚状态。

## 最终阶段：发行版（M Final）

M Final 不占用数字里程碑；功能稳定后再进行：

- 确定自有 npm 包和 CLI 发行策略
- Bun standalone binary
- 安装和更新脚本
- GitHub Actions 发布
- 文档与许可证归属
- 将标准 Responses、Codex、自动压缩和兼容降级加入发布 smoke test

## 第一版建议范围

第一版按以下顺序形成可用闭环：

1. Claude Code 风格 TUI 基础（已完成）
2. Task Ledger 和 Todo（已完成）
3. 文档发现与读取（已完成）
4. Skill Registry 和 `/skills`（已完成）
5. 进程内 `delegate_task`（已完成）
6. Monitor Runtime、增量日志和运行状态可视化（已完成）
7. SSH/tmux 远程执行并接入 Monitor Runtime（已完成）
8. 一个搜索 Provider（已完成）
9. Claude Code 风格 `ask_user_question` 询问选择框（已完成）
10. Policy Engine：重复命令、失败预算、敏感边界和等价 fallback advisory（已完成，2026 年 Trusted-Local 升级中移除）

当前已连续完成 M0–M14。后续功能继续使用 M15、M16 等编号；发行准备保留为 M Final。
