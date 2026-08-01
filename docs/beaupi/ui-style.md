# Claude Code 风格 TUI

## 目标与边界

除 Pi 当前跳动加载图标外，BeauPi 的终端视觉语言尽量与 Claude Code 保持一致，重点包括：

- 消息层级
- Tool 调用与结果
- Diff
- Todo List
- 子 Agent 与 Workflow
- Footer 状态区

参考仓库：<https://github.com/anthropics/claude-code>

主要实现参考改为 <https://github.com/claude-code-best/claude-code>。该仓库公开了逆向/反编译恢复的 TUI 源码，但没有可供本项目采用的根许可证，并声明仅供学习研究。BeauPi 作为个人自用项目，可以逐组件研究并尽可能还原其行为；实现仍落在 Pi TUI 上，不直接引入其 React/Ink 组件、Logo、吉祥物或品牌名称。

重点参考文件：

```text
src/components/messages/AssistantToolUseMessage.tsx
src/components/messages/CollapsedReadSearchContent.tsx
src/components/StructuredDiff.tsx
src/components/StructuredDiff/Fallback.tsx
src/components/FileEditToolDiff.tsx
src/components/TaskListV2.tsx
src/components/AgentProgressLine.tsx
src/components/BuiltinStatusLine.tsx
src/components/StatusLine.tsx
packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx
src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx
src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx
src/components/permissions/AskUserQuestionPermissionRequest/SubmitQuestionsView.tsx
src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx
```

完整开发拆分、文件清单、测试矩阵和验收表见 [Claude Code 风格 TUI 调整计划](./plans/README.md)。

## 核心原则

1. 保留 Pi 当前跳动加载图标，不模仿 Claude Code spinner。
2. 普通 Tool 默认无卡片和粗边框；Diff 按参考实现保留整行增删背景及上下实线边界。
3. 一行表达一个动作，详细结果缩进显示。
4. 状态主要依赖符号、文字层级和少量颜色。
5. 成功状态保持安静，错误和用户待处理状态才提高对比度。
6. 默认折叠冗长输出，但不能隐藏失败原因和修改摘要。
7. 所有行必须适配终端宽度，禁止横向溢出。

## 视觉层级

### 主文本

- 使用终端默认前景色
- Assistant 正文不添加背景
- User 输入使用 `>` 前缀或细边界，不使用整块高亮卡片

### 辅助文本

- 路径、耗时、token、模型和折叠提示使用 dim
- Tool 名称略高于参数
- 参数中的主要路径使用普通文本或轻度 accent

### 状态色

- 运行中：accent
- 成功：低饱和绿色，仅用于状态符号
- 警告：低饱和黄色
- 错误：红色
- 普通完成结果：默认色或 dim，不整行染绿

## Tool 执行

### 基本结构

```text
● Read(src/auth/session.ts)
  ⎿  184 lines

● Bash(npm run check)
  ⎿  Completed in 12.4s

● Search("refresh token rotation")
  ⎿  6 results
```

状态变化：

```text
● Bash(npm run check)          运行中（accent）
● Bash(npm run check)          成功（绿色）
● Bash(npm run check)          失败（红色）
```

运行、成功和失败统一使用小圆点，通过 accent、绿色和红色区分；错误原因仍必须在结果文字中明确显示。

### 输出规则

- Tool 标题使用运行图标、粗体名称和括号参数：`● Read(path)`
- Terminal 系 Tool 在参数括号前显示 tmux 名称：`● Terminal Bash [pi5-env](npm run check)`；无额外参数时仍保留空括号，例如 `Terminal Status [pi5-env]()`
- 结果使用 `  ⎿  ` 五列 gutter，后续换行与结果正文对齐
- queued 状态显示灰色空心圆点；运行、成功和失败使用 accent、绿色和红色实心小圆点
- 普通 Tool 不显示 Policy classifier 或权限等待状态；Policy 只在 Footer 给出 advisory。M13 `privileged_exec` 和自动路由的 sudo 使用独立逐请求权限交互，不属于 Policy confirmation
- 单行成功结果直接显示
- 多行输出默认显示最后 3–10 行
- 连续 Read/Search/List/Bash 默认聚合为一条摘要，Ctrl+O 后逐项展开
- 聚合执行中显示当前文件、搜索词或命令提示，并至少保持 700ms，避免闪烁
- 长 Bash 超过 2 秒后显示 elapsed 和累计输出行数
- 折叠提示使用 dim，例如 `… 42 lines hidden`
- Write Tool 的折叠状态保留动态行数反馈，例如 `… (62 more lines, 72 total, ctrl+o to expand)`；写入过程中 `more lines` 和 `total` 必须随输出逐行累加更新
- 动态行数属于交互行为约束，后续可以修改文案、颜色、符号和布局，但不能改为写入结束后一次性显示
- Ctrl+O 展开完整 Tool 输出
- 完整日志保存在文件时展示文件路径

### Tool 名称映射

用户界面使用语义化名称：

| Tool | 显示名称 |
|---|---|
| `read` | `Read` |
| `edit` | `Update` |
| `write` | `Write` |
| `bash` | `Bash` |
| `grep` | `Search` |
| `find` | `Find` |
| `web_search` | `Web Search` |
| `web_fetch` | `Fetch` |
| `ask_user_question` | `Question` |
| `delegate_task` | `Agent` |
| `workflow_run` | `Workflow` |
| `background_start` | `Background` |
| `terminal_bash` | `Terminal Bash` |
| `privileged_exec` | `Sudo Bash` / `Sudo Terminal Bash` |

底层 Tool 名称保持不变，只修改 renderer。

## 询问选择框

M9 增加 Claude Code 风格 `ask_user_question`，作为真实 Tool user-interaction lifecycle，而不是普通通知或伪造 permission 状态。

普通单选：

```text
Library  ■
Which date library should we use?

› 1. date-fns
     Small, modular functions
  2. Luxon
     Rich timezone API
  3. Other
     Type something…

Enter to select · ↑/↓ to navigate · Esc to cancel
```

多问题：

```text
←  ☑ Library   ☐ Scope   ✓ Submit  →
```

规则：

- 一次显示一个问题；顶部 tab 使用短 header、回答复选标记和最终 Submit，宽度不足时优先保留当前 tab 并截断其他 header。
- 当前选项使用 `›` 和 accent，不使用整块高饱和背景；已选多选项使用 checkbox 和 success 色。
- 单问题单选选择后直接提交；多问题和多选进入 review/submit。
- 普通问题自动追加 `Other` 自由输入；进入输入模式后保留光标和外部编辑器入口。
- 可选 preview 模式在宽终端左侧显示约 30 列选项、右侧显示有界 Markdown preview 和 notes；窄终端改为纵向布局或折叠 preview。
- preview 以视觉宽度截断，超出高度显示隐藏行数；不执行 HTML、脚本或代码。
- 问题切换时保持选择、自由输入和 notes，不产生重复 Tool result。
- 上下、Tab/左右、Enter、Esc 和外部编辑器动作全部通过现有可配置 keybinding，不硬编码业务键检查。
- 取消、拒绝、interaction required 和已回答状态使用结构化 Tool details；renderer 不从文案推断。
- 40/80/120/160 列、暗色/亮色、CJK、emoji、长 label/description 和 resize 均不得横向溢出。

BeauPi 不复制参考仓库的 React/Ink 组件；实现复用 Pi TUI 的 selector、editor、Container、Markdown 和 ANSI-aware 宽度 helper。

### Policy advisory

Policy 不再显示确认选择框，也不改变 Tool 的 queued/running/success/error 状态。重复执行、失败/fallback 阈值、敏感路径、工作区外写入、明确解析的直接身份切换命令、terminal 状态和 Search-to-Shell fallback 都继续执行，只在 Footer 工作区行显示当前执行或最近 Policy fact 的 advisory：

```text
~/Projects/pi (main) · policy: Local write outside workspace.
```

advisory 使用 warning 色；同时存在多个 advisory 时显示最后一条和附加计数。Tool 输出、Todo、SDK/RPC interaction 和子 Agent 结果不展示 Policy block/confirm/replace/pause 状态。

## 受控 sudo 终端

M13 权限交互先显示只读 command、target、cwd 和 audit path；用户确认前不得启动 command session。运行后 overlay 只显示受控 PTY capture，认证输入直接进入 secure stdin channel，不保存到组件状态。

最终 Transcript 使用 `Sudo Bash` 或 `Sudo Terminal Bash [terminalId]`，并复用 Bash 的输出、截断、耗时、错误和完整日志路径。等待、运行、取消、阻止和失败状态只从版本化 privilege details 读取；Policy advisory 仍只显示在 Footer。

暗色、亮色及 40/80/120/160 列必须无横向溢出。

## Diff

### 文件标题

```text
● Update(src/auth/session.ts)
```

### 内容

```diff
  116   const token = await loadToken();
- 117   return refresh(token);
+ 117   return refreshWithRotation(token);
+ 118   await persistRotatedToken(token);
  119 }
```

规则：

- Diff 外层只有上下 solid 边界，不显示左右边框
- 左侧 gutter 显示行号和 `+`/`-` 标记
- gutter 在支持的终端模式下不参与文本复制
- 删除行使用整行红色背景，增加行使用整行绿色背景
- 相邻删除/新增行进行词级 diff；变化比例不超过约 40% 时，对具体词使用更深的红/绿背景
- 上下文行 dim，不添加背景
- 长行按可用宽度换行，续行保留空行号 gutter
- 默认每个 hunk 保留固定上下文，大段未变化内容显示 `…`
- Diff 高亮结果按 patch、theme、width 和 dim 状态缓存，终端 resize 时限制缓存版本数量
- 修改执行前可以流式预览，执行后避免重复显示相同 diff
- Error 直接显示在文件标题下，不保留成功背景

### 多文件摘要

```text
● Updated 3 files
  src/auth/session.ts     +12 -4
  src/auth/token.ts        +8 -2
  test/auth.test.ts       +24 -0
```

## Todo List

BeauPi 不提供独立 Plan 模式，但保留基于文档和任务账本的 Todo 展示。

```text
Tasks
  ■ Read authentication documentation    completed（绿色）
  ■ Inspect refresh implementation       completed（绿色）
  □ Update token rotation                active（accent）
  □ Run documented checks
  □ Review diff
```

状态：

- `□` pending、active、failed、blocked（颜色分别表达状态）
- `■` completed（success 色）
- blocked 项仍通过 `▸ blocked by ...` 显示阻塞原因

规则：

- 标题和列表均不加边框
- active 项加粗
- completed 项 dim + 删除线，并在完成后至少保留 30 秒
- blocked 项 dim，并显示 `▸ blocked by #1, #2`
- 多 Agent 时宽终端显示 `(@owner)`，窄于 60 列时隐藏 owner
- active Agent Task 可在下一行显示当前活动并追加省略号
- 根据终端高度动态显示最多约 3–10 项
- 截断时优先显示：最近完成、进行中、未阻塞 pending、已阻塞 pending、较早完成
- 隐藏项显示分类摘要，例如 `… +1 in progress, 3 pending, 4 completed`
- 来源于文档的任务可在展开状态显示引用
- Workflow 节点与 Todo 使用相同状态语言

## 子 Agent

单 Agent：

```text
● Agent(reviewer) Reviewing authentication changes
   └─ reviewer · 3 tool uses · 17.2k tokens
      ⎿  Reading src/auth/session.ts
```

完成：

```text
● Agent(reviewer) Found 1 blocking issue
   └─ reviewer · 3 tool uses · 17.2k tokens
      ⎿  Done
```

多个 Agent：

```text
● 3 agents
   ├─ explorer · 4 tool uses · 12.1k tokens
   │  ⎿  Done
   ├─ researcher · 2 tool uses · 8.4k tokens
   │  ⎿  Searching OAuth specification…
   └─ reviewer · 0 tool uses
      ⎿  Initializing…
```

规则：

- 使用 `├─`、`└─` 和 `│  ⎿  ` 树形 gutter
- Agent 类型/名称加粗，描述放在括号内
- 运行中显示最近 Tool 信息，未开始显示 `Initializing…`
- 完成显示 `Done`
- 后台 Agent 完成主回合但仍运行时显示任务描述，不显示普通 Done 行
- 默认展示 tool use 数和 token 数
- 默认不展示完整子 Agent 对话，只展示工具摘要、最终结果和用量；Ctrl+O 展开详情

## Workflow

```text
Workflow: implement-review
  ● inspect       8.2s
  ● research     12.6s
  ● implement    21.4s
  ○ review
  ○ verify
```

- 无树形粗边框
- 节点按执行顺序缩进
- 并行节点使用相同缩进
- 当前节点突出，已完成节点降低对比度
- 失败节点显示简短原因

M11 已接入真实 `WorkflowSnapshotComponent`：组件只消费版本化 DAG 快照，按依赖深度计算缩进，并行节点保持同级；当前节点加粗/accent、完成节点 dim、失败/超时/lost 节点保留宽度安全的简短原因。`workflow_run/status/cancel` 继续使用 minimal Tool shell；Task Ledger Todo 和 Footer 分别显示当前分支节点状态与 Workflow running/attention 聚合。暗色/亮色及 40/80/120/160 列均使用现有 ANSI-aware helper 校验无横向溢出。

## Footer

## 三行布局

完整宽度时：

```text
38.8 tok/s · out 4,272 · in 8,976 · cache 537,088/0 · total 550,336 · 110.1s
~/Projects/pi (main) · policy: Repeated local read-only check.
↑120k ↓28k R1.2M CH98.9% $2.035 · 112k/272k 41.0% (auto)          gpt-5.6-sol · medium
```

### 第一行：最近一次 Agent Run

来源于当前 `tps.ts`，但不再使用通知弹窗：

```text
38.8 tok/s · out 4,272 · in 8,976 · cache 537,088/0 · total 550,336 · 110.1s
```

规则：

- 仅显示最近一次完成的 Agent run
- 当前 run 未产生 output 时隐藏
- 新 run 开始时可保留上一条，或改为 `running · 12.4s`
- 全行 dim，TPS 数值可使用普通前景色
- 不显示 `TPS` 冗余前缀，除非需要明确语义

建议最终格式：

```text
38.8 tok/s · 4,272 out · 8,976 in · cache 537,088/0 · 550,336 total · 110.1s
```

### 第二行：工作区

```text
~/Projects/pi (main)
```

可追加低频但重要状态：

```text
~/Projects/pi (main) · policy: Repeated local read-only check. · ssh:dev
```

默认显示：

- cwd
- Git branch
- 当前执行或最近 Policy fact 的 advisory（仅在存在时显示，也是 Policy 唯一的 UI 展示位置）

重复执行 advisory 使用 warning 色且不表示阻断；同时存在多个 advisory 时显示最后一条和附加计数。待确认 sudo request、远程目标仅在非默认状态时显示。

### 第三行：Session 累计状态

```text
↑120k ↓28k R1.2M CH98.9% $2.035 · 112k/272k 41.0% (auto)          gpt-5.6-sol · medium
```

左侧：

- 输入累计
- 输出累计
- cache read
- cache hit rate
- 费用
- 上下文占用

右侧：

- 模型
- thinking level

Claude Code 参考实现的内建状态项使用 ` │ ` 分隔，并按 `Model │ Context │ Session │ Weekly │ Cost │ Cache` 排列。BeauPi 保留用户指定的三行结构，但第三行内部的间隔、dim 层级和窄终端隐藏逻辑按该实现对齐。

`cache write` 为 0 时隐藏；非 0 时在 `R` 后增加 `W`。

## Footer 窄终端降级

按以下顺序隐藏：

1. 第一行的 total
2. 第一行的 input
3. 第一行的 cache write
4. 第一行只保留 TPS、output、elapsed
5. 第二行隐藏默认 USER 模式和本地 target
6. 第二行优先隐藏 Policy advisory 的附加计数，再截断 advisory 文案
7. 第三行隐藏 CH
8. 第三行隐藏 cost
9. 模型名称从完整 ID 缩短

最小模式：

```text
38.8 tok/s · 4.3k out · 110s
~/Projects/pi (main)
↑120k ↓28k · 112k/272k 41%                    gpt-5.6-sol
```

任何情况下都不换行；使用 ANSI-aware truncate。

## Compact 进度

Compact 保留 Pi 当前跳动小图标，并在下一行显示 Claude Code 风格的生成进度：

```text
⠹ Compacting context... (esc to cancel)
  ━━━━━━━━━━━━──────────── 63%
```

规则：

- 进度来源于总结响应实际流式输出，不额外轮询模型。
- 总结长度无法预知，因此将累计输出 token 映射到渐近曲线：`1 - exp(-tokens / 1200)`。
- 运行期间最高显示 99%，成功结束后直接移除进度条，避免伪造精确完成时间。
- 手动 Compact、阈值自动 Compact 和上下文溢出恢复使用相同组件。
- Provider 重试时保留已有进度，后续流式输出继续推进。
- 进度条行固定缩进两列，与 Tool Result 的内容层级对齐。
- 终端过窄时缩短进度条，不允许换行或横向溢出。

## 加载动画

保留 Pi 当前跳动小图标。旁边文字优先使用模型最新的 Thinking summary：

```text
● Thinking…
● Planning reusable component architecture…
● Designing dynamic tool grouping logic…
```

规则：

- 去除 summary 外层 Markdown 标记，只显示最新非空单行并追加 `…`。
- 新一轮 Assistant 流开始时回退为 `Thinking…`，收到新 summary 后原位更新。
- Extension 通过 `ctx.ui.setWorkingMessage()` 设置的文字优先级更高。
- Thinking summary 与 Tool call 同属一个 Assistant message 时，原 summary 仍保留在消息历史中；`Update`、Diff 和其他 Tool Result 不受影响。
- 不替换图标帧，不复制 Claude Code spinner。

消息历史中的 Thinking summary 使用紧凑 Thought Chain：

```text
Planning README verification

Thought Chain
  ⎿  Planning README verification
  ⎿  Inspecting code checks

Thought Chain
  ⎿  Planning README verification
  ⎿  …
  ⎿  Confirming naming
```

- 只有一条 summary 时不显示标题或 gutter，仅将原文显示为斜体。
- 两条时显示地道英文标题 `Thought Chain`，并完整显示两条 `  ⎿  ` 分支项。
- 三条及以上时只显示第一条、`…` 和最新一条。
- 流式更新重建当前摘要投影并去重，不能将同一条或旧的“最新一条”重复追加到消息历史。

## Pi 实现路径

### Theme

新增：

```text
packages/coding-agent/src/modes/interactive/theme/beaupi-dark.json
packages/coding-agent/src/modes/interactive/theme/beaupi-light.json
```

使用暖色 accent、低对比度灰色层级、克制的成功/错误颜色。不得使用 Claude Logo 或品牌名称作为最终公开主题名。

### Footer

使用：

```typescript
ctx.ui.setFooter((tui, theme, footerData) => new BeauPiFooter(...));
```

TPS 状态直接整合到现有交互模式和 Footer 数据流，不再通过 `ctx.ui.notify()` 弹出通知。

### Tool Renderer

对齐细节：

- 标题行结构参考 `AssistantToolUseMessage`
- 连续 Read/Search 聚合参考 `CollapsedReadSearchContent`
- 子 Agent 树形状态参考 `AgentProgressLine`
- Todo 排序、截断和 owner 参考 `TaskListV2`

方案优先级：

1. 为内置和自定义 Tool 提供 `renderCall`/`renderResult`
2. 必要时调整 `ToolExecutionComponent`，允许全局 minimal shell
3. 不要复制每个 Tool 的执行实现，只替换展示层

当前 `ToolExecutionComponent` 默认使用带背景的 `Box`。目标样式应使用 `renderShell: "self"` 或增加全局 shell style 配置，避免整块 `toolPendingBg/toolSuccessBg/toolErrorBg`。

### Diff

复用 Pi 已有 diff 计算和 `details.patch`，只替换 `renderDiff()` 展示，不重写 edit 算法。

### Todo

基于 Task Ledger 使用内建 `TaskLedgerWidget`，与 `ctx.ui.setWidget()` 共享 editor 上方的 Widget 容器。Todo 只展示当前 Session 的确定性执行状态，不重新引入 Plan Mode。

M2 已接入：

- phase：discover、execute、verify、commit
- Todo：pending、active、completed、failed、blocked
- 最近完成保留、owner 窄屏隐藏、blocked 摘要和 3–10 项动态截断
- 使用空方框/实心方框的单一 Tasks Widget
- Footer 当前 phase、修改文件数和验证状态
- 40/80/120/160 列及暗色/亮色主题下无横向溢出

## Background Tasks Renderer

M12 增加 `BackgroundTaskComponent`，只接收版本化 `BackgroundTaskSnapshotV1[]` 与 `BackgroundSummaryV1`，不访问或控制 Runtime。它复用统一 activity symbol、状态色、`fitSingleLine()` 和 Tool gutter：

```text
Background Tasks · 2 running · wake 1
● bg-42  npm run test  running · 04:12 · idle 18s
✓ bg-17  npm run build  completed · 01:48
! bg-03  npm run dev  stalled · diagnostic: no activity
  log: /workspace/.beaupi/background-logs/session/bg-03.log
```

- running/healthy、completed、failed、cancelled、stalled、lost 均有结构化状态表达。
- 显示持续时间、最后活动年龄、Wake 数量、简短诊断和完整日志路径；不渲染完整日志。
- Task Ledger 抑制 Background-owned Monitor 重复行；Todo/Footer 只投影同一 snapshot 的等待、运行、完成和 attention 聚合。
- `beaupi-dark`、`beaupi-light` 与 40/80/120/160 列均使用 ANSI-aware 宽度约束，无横向溢出。

## 验收标准

1. 保留 Pi 原加载动画。
2. 普通 Tool 不再显示大面积背景卡片。
3. Read/Bash/Edit/Write 的视觉层级与 Claude Code 接近。
4. Edit diff 支持行号、增删色、上下文折叠和窄终端。
5. Todo 使用空方框/实心方框；Sub-agent 和 Workflow 保留各自的运行状态符号。
6. TPS 不再弹通知，整合到 Footer。
7. Footer 显示当前上下文 token、窗口上限和占用百分比。
8. Compact 使用实际流式输出驱动渐近进度条。
9. Footer 完整模式最多三行，并支持窄终端降级。
10. 所有组件在暗色、亮色和 80/120/160 列终端下可读。
11. Write Tool 折叠提示中的新增行数和总行数在写入过程中动态更新，样式调整不得移除该行为。
12. 使用 tmux 截图进行视觉回归测试。
13. Policy advisory 只出现在 Footer，不改变 Tool、Todo、子 Agent 或 SDK/RPC interaction 的展示状态。
14. M13 受控 sudo overlay 在执行前显示只读命令并逐次确认，认证输入不进入组件状态，最终 `Sudo Bash` renderer 在暗色、亮色及 40/80/120/160 列下无横向溢出。
