# BeauPi 设计文档

由 WinBeau 开发、基于 Pi Runtime 持续扩展的 WSL 优先编程 Agent。

当前进度：M0–M8 已完成，包括 Claude Code 风格 TUI、Task Ledger、Document Runtime、Skill Registry、进程内子 Agent、Monitor、SSH/tmux 和联网搜索闭环。当前优先主线为 M9 Claude Code 风格询问选择框；Policy Engine、Workflow、自动唤醒和 sudo 后置。

## 文档

- [BeauPi 开发启动](./getting-started.md)
- [需求与目标](./requirements.md)
- [系统架构](./architecture.md)
- [Document Runtime 设计](./document-runtime.md)
- [开发路线](./roadmap.md)
- [开发里程碑](./milestones.md)
- [后台任务与自动唤醒](./background-tasks.md)
- [Claude Code 风格 TUI](./ui-style.md)
- [Claude Code 风格 TUI 实施计划](./plans/README.md)
- [Skill 导入与注册](./skills.md)

## 产品定位

BeauPi 是一个文档驱动、工具优先、支持多 Agent 协作的终端编程 Agent，重点解决：

- SSH、tmux 等能力依赖 Skill，调用繁琐且产生大量无效上下文
- Agent 重复执行等价的环境检查和 fallback 命令
- 联网或命令失败后进行大量低价值 fallback
- 长任务过程难以理解和观察
- 缺少原生领域工具、受控提权和流畅的子 Agent 调度
- Agent 空闲后无法等待后台任务并在关键事件发生时自动恢复工作

## 当前优先级

M5–M8 已交付四个可直接使用的能力闭环：

1. 进程内 `delegate_task` 子 Agent
2. 本地进程、Tool 和子 Agent 的 Monitor 监控、增量日志和状态恢复
3. SSH/tmux 远程执行，并复用同一 Monitor Runtime
4. 单一 SearXNG Provider 的 `web_search`/`web_fetch`、共享缓存、稳定引用和严格预算

下一步是 M9 Claude Code 风格询问选择框：新增 `ask_user_question`，支持单选、多选、自由输入、多问题导航和可选 Markdown 预览，并复用现有 AgentSession、Tool registry、selector/keybinding 和 minimal TUI 生命周期。M10 再实现 Policy Engine，集中处理重复命令、失败预算和本地/远程/网络 fallback。BeauPi 不规划专用 Git Tools；普通 Git 开发继续通过现有 Bash 能力和仓库开发规则完成。自动唤醒和 sudo 继续后置。

## 实现策略

BeauPi 不创建 `packages/beaupi` 或独立的外部 Extension Package，而是在现有 `packages/coding-agent` 中直接扩展。内部 npm 包名暂时保持不变，应用品牌、CLI、配置目录和后续发行物统一使用 BeauPi。

## 设计原则

1. 原生能力和现有 Extension 机制优先，Skill 只描述知识与流程。
2. 保留并扩展 Pi Runtime/TUI，前期不重写 Agent Loop。
3. 默认使用普通用户权限，不以 root 身份运行 Agent。
4. 多 Agent 默认单写者，并行写入使用 Git Worktree 隔离。
5. 文档直接生成执行约束，不实现传统 Plan 模式。
6. 所有失败、联网、Shell 和子 Agent 调用都有预算与可视化。
7. 新功能遵循现有包结构和抽象，不维护第二套 Runtime、CLI 或资源加载链路。
8. 网页正文和搜索 snippet 始终视为不可信外部内容；只有 `web_fetch` 正文引用代表已获取的页面内容。
