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
```

完整开发拆分、文件清单、测试矩阵和验收表见 [Claude Code 风格 TUI 调整计划](./plans/README.md)。

## 核心原则

1. 保留 Pi 当前跳动加载图标，不模仿 Claude Code spinner。
2. 普通 Tool 默认无卡片和粗边框；Diff 按参考实现保留整行增删背景及上下虚线边界。
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
● Bash(npm run check)          运行中
✓ Bash(npm run check)          成功
✗ Bash(npm run check)          失败
! Bash(sudo apt install curl)  等待用户确认
```

如果希望更接近 Claude Code，可让完成后的普通工具继续使用 `●`，只通过结果文字表达完成状态；但错误必须使用明显的 `✗`。

### 输出规则

- Tool 标题使用运行图标、粗体名称和括号参数：`● Read(path)`
- 结果使用 `  ⎿  ` 五列 gutter，后续换行与结果正文对齐
- queued 状态显示灰色圆点，运行状态使用 Pi 跳动图标，失败显示错误状态
- 等待权限或 classifier 时在标题下显示 dim 状态
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
| `delegate_task` | `Agent` |
| `workflow_run` | `Workflow` |
| `background_start` | `Background` |

底层 Tool 名称保持不变，只修改 renderer。

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

- Diff 外层只有上下 dashed 边界，不显示左右边框
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
✓ Updated 3 files
  src/auth/session.ts     +12 -4
  src/auth/token.ts        +8 -2
  test/auth.test.ts       +24 -0
```

## Todo List

BeauPi 不提供独立 Plan 模式，但保留基于文档和任务账本的 Todo 展示。

```text
Tasks
  ✓ Read authentication documentation
  ✓ Inspect refresh implementation
  ● Update token rotation
  ○ Run documented checks
  ○ Review diff
```

状态：

- `□` pending（实际字符使用终端 figures 的 small square）
- `■` active（使用 accent/claude 色）
- `✓` completed
- `✗` failed（BeauPi 新增状态）
- `!` blocked / waiting for user

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
✓ Agent(reviewer) Found 1 blocking issue
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
  ✓ inspect       8.2s
  ✓ research     12.6s
  ● implement    21.4s
  ○ review
  ○ verify
```

- 无树形粗边框
- 节点按执行顺序缩进
- 并行节点使用相同缩进
- 当前节点突出，已完成节点降低对比度
- 失败节点显示简短原因

## Footer

## 三行布局

完整宽度时：

```text
38.8 tok/s · out 4,272 · in 8,976 · cache 537,088/0 · total 550,336 · 110.1s
~/Projects/pi (main)
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
~/Projects/pi (main) · USER · ssh:dev
```

默认只显示：

- cwd
- Git branch

权限模式、远程目标仅在非默认状态时显示。

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
6. 第三行隐藏 CH
7. 第三行隐藏 cost
8. 模型名称从完整 ID 缩短

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
- 使用 M1 状态符号的 Tool Timeline
- Footer 当前 phase、修改文件数和验证状态
- 40/80/120/160 列及暗色/亮色主题下无横向溢出

## 验收标准

1. 保留 Pi 原加载动画。
2. 普通 Tool 不再显示大面积背景卡片。
3. Read/Bash/Edit/Write 的视觉层级与 Claude Code 接近。
4. Edit diff 支持行号、增删色、上下文折叠和窄终端。
5. Todo、Sub-agent 和 Workflow 使用统一状态符号。
6. TPS 不再弹通知，整合到 Footer。
7. Footer 显示当前上下文 token、窗口上限和占用百分比。
8. Compact 使用实际流式输出驱动渐近进度条。
9. Footer 完整模式最多三行，并支持窄终端降级。
10. 所有组件在暗色、亮色和 80/120/160 列终端下可读。
11. Write Tool 折叠提示中的新增行数和总行数在写入过程中动态更新，样式调整不得移除该行为。
12. 使用 tmux 截图进行视觉回归测试。
