# 现状与差距

## 当前渲染链

```text
AgentSessionEvent
  → InteractiveMode.handleEvent()
  → AssistantMessageComponent / UserMessageComponent
  → ToolExecutionComponent
  → built-in Tool renderCall/renderResult
  → Text / Box / Container / Markdown
  → TUI.render(width)
```

Session 恢复通过 `renderSessionItems()` 重建同一组件链。Ctrl+O 由 `setToolsExpanded()` 遍历实现 `setExpanded()` 的组件。

## 当前能力

| 区域 | 当前实现 | 可复用能力 |
|---|---|---|
| User | 背景 Box + Markdown | OSC 133、outputPad、Markdown |
| Assistant | 无背景 Markdown | Thinking 合并、隐藏、错误展示 |
| Tool Shell | 默认状态背景 Box | renderer 继承、partial、images、self shell |
| Read | 折叠普通结果，文档/Skill 紧凑标题 | 路径、范围、语法高亮、截断信息 |
| Write | 流式内容预览 | 增量高亮缓存、动态总行数 |
| Edit | `renderShell: "self"` | 异步预览、结果去重、`details.diff/patch` |
| Bash Tool | 5 个视觉行尾部预览 | 100ms partial update、耗时、完整日志 |
| Bash Mode | 独立 bordered component | 流式输出、取消、宽度缓存 |
| Diff | 前景色 + inverse 词级变化 | 行号解析、单行词级 diff |
| Footer | cwd 行 + usage/model 行 + extension 状态 | Context、费用、cache、branch、model |
| Compact | Loader + 渐近进度条 | 实际输出字符驱动、99% 上限 |
| Theme | 51 个 token、暗/亮、热重载 | truecolor/256、自动明暗、Extension Theme |

## 主要差距

### 消息

- User 使用整块背景，与目标的 `>` 前缀或细边界不一致。
- Assistant 与 Tool 之间的空行由多个组件独立控制，容易出现过多间距。
- Thinking 视觉仍是普通 Markdown，缺少统一辅助层级。

### Tool

- 除 Edit 外，多数内建 Tool 仍进入默认背景 Box。
- Tool 状态没有统一标题前缀；运行、成功、失败主要依赖背景。
- Tool renderer 各自拼接换行和折叠提示，gutter 不统一。
- Read/Search/List/Bash 尚未形成连续调用聚合组件。
- Generic fallback 仍展示 JSON 参数和大块输出。

### Write

- 动态行数已经存在，但嵌在旧式预览布局中。
- 当前显示前 10 行；目标格式需要标题 + `⎿` gutter。
- 必须避免重构时把增量 `args` 更新改成仅 `argsComplete` 后渲染。

### Diff

- 增删行只有前景色，不是整行红绿背景。
- 无上下 dashed 边界。
- 词级变化使用 inverse，不是独立深色背景。
- 仅一删一增时做词级 diff。
- 没有 width-aware 换行、续行 gutter 和明确缓存策略。

### Footer

- 当前核心布局为两行，Extension status 可成为第三行。
- 缺少最近一次 Agent Run 的 TPS、输入、输出、cache、total 和 elapsed 行。
- 窄终端主要依赖整体截断，缺少字段级降级顺序。
- `render()` 每次遍历全部 Session entries，需评估缓存或预聚合。

### 状态

- Working/Retry/Compact 各自使用 Loader，但文案和层级未统一。
- Bash Mode 仍有上下粗边界，与普通 Tool 目标不一致。
- 权限等待尚无 BeauPi 内建 Tool 状态数据，M1 只定义视觉槽位。

## 关键修改入口

- `components/tool-execution.ts`
- `components/user-message.ts`
- `components/assistant-message.ts`
- `components/diff.ts`
- `components/footer.ts`
- `components/status-indicator.ts`
- `components/bash-execution.ts`
- `core/tools/read.ts`
- `core/tools/write.ts`
- `core/tools/edit.ts`
- `core/tools/bash.ts`
- `core/tools/grep.ts`
- `core/tools/find.ts`
- `core/tools/ls.ts`
- `theme/theme.ts`
- `theme/theme-schema.json`
- BeauPi 暗色/亮色主题文件
- `interactive-mode.ts` 中事件接线、Tool 聚合和 Footer 数据更新

## 风险

1. 默认 Tool shell 改动可能影响所有 Extension Tool。
2. 预着色文本缓存可能在 Theme 热切换后保留旧 ANSI。
3. Diff 整行背景在换行、宽字符和复制时容易错位。
4. Footer 三行会压缩聊天区域，必须严格限制高度。
5. Tool 聚合需要保持 Session 重建和流式事件一致。
6. Write 增量高亮性能不能因每个参数 chunk 全量重算而退化。
