# BeauPi 设计文档

由 WinBeau 开发、基于 Pi Runtime 持续扩展的 WSL 优先编程 Agent。

当前进度：M0–M14 已完成，包括 Claude Code 风格 TUI、Task Ledger、Document Runtime、Skill Registry、进程内子 Agent、Monitor、SSH/tmux、联网搜索、`ask_user_question`、多 Agent Workflow、后台任务自动唤醒和动态任务规划。M Final 正在完成 npm 与 GitHub Release 正式发行。

## 文档

- [BeauPi 开发启动](./getting-started.md)
- [需求与目标](./requirements.md)
- [系统架构](./architecture.md)
- [Document Runtime 设计](./document-runtime.md)
- [开发路线](./roadmap.md)
- [开发里程碑](./milestones.md)
- [多 Agent Workflow](./workflows.md)
- [后台任务与自动唤醒](./background-tasks.md)
- [Claude Code 风格 TUI](./ui-style.md)
- [Claude Code 风格 TUI 实施计划](./plans/README.md)
- [Skill 导入与注册](./skills.md)
- [发布手册（Release Runbook）](./release-runbook.md)

## 产品定位

BeauPi 是一个文档驱动、工具优先、支持多 Agent 协作的终端编程 Agent，重点解决：

- SSH、tmux 等能力依赖 Skill，调用繁琐且产生大量无效上下文
- Agent 重复执行等价的环境检查和 fallback 命令
- 联网或命令失败后进行大量低价值 fallback
- 长任务过程难以理解和观察
- 缺少原生领域工具、受控提权和流畅的子 Agent 调度
- Agent 空闲后无法等待后台任务并在关键事件发生时自动恢复工作

## 当前优先级

M5–M11 已交付七个可直接使用的能力闭环：

1. 进程内 `delegate_task` 子 Agent
2. 本地进程、Tool 和子 Agent 的 Monitor 监控、增量日志和状态恢复
3. SSH/tmux 远程执行，并复用同一 Monitor Runtime
4. 单一 SearXNG Provider 的 `web_search`/`web_fetch`、共享缓存、稳定引用和严格预算
5. 内置 `ask_user_question` 的单选、多选、Other、notes、多问题 review、Markdown preview 及 SDK/RPC 回调
6. Trusted-local 执行：工具调用不经过授权门，普通 Tool 默认直接执行；Shell 继承宿主环境和用户权限；失败分类与 workspace mutation 等中性执行事实（`core/execution/`）只用于诊断与进度跟踪，不阻断、替换或暂停执行
7. 版本化 YAML/JSON Workflow DAG、依赖条件、失败策略、并发与全局 shared 单写者、isolated Git Worktree、`workflow_run/status/cancel`，以及 Monitor、Task Ledger、Todo、Footer、Compact/resume/branch 生命周期接入

M12 后台任务自动唤醒已落地。BeauPi 不规划专用 Git Tools；普通 Git 开发继续通过现有 Bash 能力和仓库开发规则完成。

## M12 实现状态

M12 已接入现有 `MonitorRuntime`、`AgentSession`、`AgentPool`、Session custom entries、Task Ledger 和 BeauPi TUI：

- `BackgroundTaskManager` 只保存任务与唤醒事实，任务状态、PID/target、资源和日志仍来自已有 `MonitorRecord`。
- `background_start` 使用 executable + args、独立日志和 runner-owned process adapter，启动后立即返回；`background_attach` 可接管已被 Process 或 SSH/tmux adapter 确认的 Monitor target。
- `background_status/logs/wait/cancel` 已使用严格版本化 details；日志通过现有 cursor/hash reader 增量读取，取消复用 Monitor stop 并在本地进程组上执行有界 TERM→KILL。
- Trigger Evaluator 支持 completed、failed、timeout、stalled、error-pattern、progress-review；Wake Queue 串行合并、去重并通过 `AgentSession.sendCustomMessage()` 在空闲时触发 turn、忙碌时进入 follow-up。
- 默认轮询不调用模型；Progress Reviewer 复用共享 AgentPool/ModelRuntime，具备最小间隔、最大次数、输入字符和 wall-clock 预算，日志 hash 不变时零调用。
- 任务、触发器、WakeEvent、消费 key 和 reviewer budget 写入当前 branch；resume/Compact/branch 只恢复当前分支，无法确认的目标标记 `lost`。
- Task Ledger、Todo、Footer、minimal Tool renderer 和 40/80/120/160 列暗/亮主题 renderer 均消费结构化 Background snapshot。

第一版仍只支持 BeauPi TUI 进程运行期间自动唤醒；daemon、IPC、桌面通知和专用 Git Tools 不在范围内。

## 实现策略

BeauPi 不创建 `packages/beaupi` 或独立的外部 Extension Package，而是在现有 `packages/coding-agent` 中直接扩展。源码工作区保留上游内部包名以降低同步成本，发布阶段生成 `@winbeau/beaupi-*` 包并重写内部引用；应用品牌、CLI、配置目录和发行物统一使用 BeauPi。

## 设计原则

1. 原生能力和现有 Extension 机制优先，Skill 只描述知识与流程。
2. 保留并扩展 Pi Runtime/TUI，前期不重写 Agent Loop。
3. 本地 Agent 进程使用启动它的同一 OS 用户身份；受信任 SSH Target 按其 OpenSSH 配置的登录身份运行，允许 AutoDL 等平台提供的 `root` 账户。`sudo`、`su` 等身份切换命令由普通 Shell executor 按宿主 OS 权限直接执行；不提供 `/mode sudo`。
4. 多 Agent 默认单写者，并行写入使用 Git Worktree 隔离。
5. 文档直接生成执行约束，不实现传统 Plan 模式。
6. 所有失败、联网、Shell 和子 Agent 调用都有预算与可视化。
7. 新功能遵循现有包结构和抽象，不维护第二套 Runtime、CLI 或资源加载链路。
8. 网页正文和搜索 snippet 始终视为不可信外部内容；只有 `web_fetch` 正文引用代表已获取的页面内容。
