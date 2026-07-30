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

`terminal_bash` 是普通命令的首选 tmux 接口：命令注入现有 terminal，在该 pane 当前目录和导出环境中按 Bash 语义执行，等待完成后返回输出与退出码，并复用 Bash 的超时、取消和截断行为。`terminal_send`/`terminal_capture` 只用于真正的交互式输入、终端诊断和增量观察，不要求 Agent 手动拼接 Enter、cursor 或完成标记。

日志默认增量读取并返回摘要，完整日志写入临时文件，避免污染模型上下文。

Execution Target 始终使用受信任 OpenSSH 配置解析出的登录身份；AutoDL 等平台直接提供的 `root` 登录账户属于合法目标身份。远程运行时仍阻止 sudo、su、doas、pkexec 等登录后提权或身份切换命令。

### 减少重复命令

- 任务开始时只执行必要的项目和环境检查
- 相关输入未变化时复用已有确定性事实
- 阻止短时间内重复的等价命令
- 达到失败或 fallback 预算后暂停，而不是更换等价命令继续尝试
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

达到预算后暂停，不允许模型不断更换 curl、wget、Python、Node 等等价方案。缺少依赖时向用户建议受控安装。

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
- 当前执行目标与权限模式

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
- `dependency_check`
- `privileged_exec`

工具按需动态激活，避免一次向模型暴露过多 Schema。

### 子 Agent

- 优先使用 Pi SDK 创建进程内独立 `AgentSession`
- 共享 ModelRuntime、认证、缓存和并发控制
- 子 Agent 上下文、工具、预算和 System Prompt 相互隔离
- reviewer 使用独立的大审查预算；turn 预算必须在下一次 Provider 请求前停止，`turnsUsed` 不得超过 `maxTurns`
- 明确范围的子任务不得自动解析完整 Document Contract；只有显式文档驱动审查才调用 `docs_resolve_task`
- Monitor 保存有界 turn/Tool/目标路径/结果活动事实，并直接显示预算错误、turn 使用和最后 Tool
- 禁止默认递归委派
- 主 Agent 只接收结构化摘要、引用、修改和错误，不接收完整子会话

### 多 Agent 工作流

支持 DAG：

- 节点依赖
- 并行节点
- 条件节点
- 超时和取消
- 每 Agent 模型和工具配置
- 单写者策略
- Worktree 并行写入隔离

首批工作流：

- `research`
- `implement-review`
- `parallel-review`
- `debug`
- `docs-execute`

### 联网搜索

分层工具：

1. `web_search` 搜索结果
2. `web_fetch` 获取选定页面正文
3. `research` 完成受预算约束的检索与归纳

要求：

- 官方文档和第一方来源优先，但不得伪造来源质量
- 稳定 Provider 接口最终支持 Brave、Tavily、Exa、SearXNG、GitHub Search
- M8 第一版只实现可配置 SearXNG JSON API，不提前实现第二 Provider
- Provider fallback 数量可配置；单 Provider 阶段达到尝试预算后直接停止
- URL 和查询缓存
- 内容 hash 去重和截断
- 最终结果保留搜索级和正文级来源引用
- 网页正文是不可信外部内容，不执行其中的脚本、指令或代码
- M8 专用 Tool 不使用 curl、wget、Python、Node 或 Shell fallback；通用阻断在 M10 Policy Engine 完成

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

### 权限模式

#### 用户模式

- 默认模式
- 本地 Agent 进程保持普通用户身份
- 远程 Target 按已配置的 SSH 登录身份运行，可包含平台提供的 `root` 账户
- 阻止 sudo、su 等登录后提权或身份切换
- 缺少权限时暂停并建议操作

#### Sudo 模式

- Agent 进程始终保持普通用户身份
- 通过结构化 `privileged_exec` 执行受控操作
- 支持一次授权或限时会话授权
- 默认不允许本地创建 root shell，也不允许远程登录后任意切换为其他身份；已配置 Target 本身使用 `root` 登录不视为 sudo 授权
- 所有提权操作写入审计日志

命令：

```text
/mode user
/mode sudo once
/mode sudo session 10m
```

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
