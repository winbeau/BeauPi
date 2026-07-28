# 消息布局计划

## 范围

- User message
- Assistant text
- Thinking block
- Assistant stop/error
- 消息与 Tool 之间的垂直间距
- OSC 133 区域标记

## User Message

目标示例：

```text
> 请检查登录逻辑并修复测试
```

多行：

```text
> 第一行
  第二行继续对齐
```

计划：

- 移除 `UserMessageComponent` 的整块 `userMessageBg` Box。
- 使用 `>` 前缀或细左侧 gutter；第一版优先 `>`。
- Markdown 仍保留 ordered list marker 和 backslash escape 行为。
- 多行 wrapping 必须与正文列对齐。
- `outputPad` 继续生效，但默认 BeauPi 样式不依赖大 padding。
- 保留 OSC 133 start/end/final 标记和当前高度语义。

## Assistant Message

目标：

- 正文无背景、无角色卡片。
- 与 User/Tool 之间只保留必要空行。
- Markdown heading、code、list 继续使用现有 Markdown renderer。
- 流式更新不重新创建整个 Chat 容器。

计划修改 `AssistantMessageComponent.updateContent()`：

- 把 spacing 决策集中为明确规则，避免每个 content block 自行添加多余 Spacer。
- Assistant 含 Tool Call 时，正文与第一个 Tool 标题之间最多一个空行。
- 纯文本消息继续保留 OSC 133；包含 Tool Call 的消息维持现有避免错误区域嵌套的行为。

## Thinking

隐藏状态：

```text
Thinking…
```

展开状态：

- 使用 dim/italic。
- 不增加背景卡片。
- 相邻 Thinking block 继续合并。
- Thinking 与后续正文之间最多一个空行。

## 错误和停止

- `length` 必须始终可见。
- `aborted`、`error` 使用统一错误前缀或红色文本。
- Tool Call 已负责显示错误时，Assistant 不重复打印相同错误。
- 错误不能因 Ctrl+O 折叠而消失。

## 文件

```text
components/user-message.ts
components/assistant-message.ts
components/skill-invocation-message.ts
components/custom-message.ts（只做兼容检查）
test/user-message.test.ts
test/assistant-message.test.ts
```

## 测试

- User 单行、多行、Markdown、宽字符和窄终端。
- User 不含整行背景 ANSI。
- OSC 133 标记顺序保持正确。
- Assistant 纯文本、Thinking+正文、正文+Tool Call。
- `length`、`aborted`、`error` 不重复且可见。
- `outputPad=0/1` 均不超宽。
- Theme 切换后 Thinking 和 User 前缀颜色更新。

## 验收

消息层级清晰但克制；User 不再是大背景卡片；Assistant 和 Thinking 保持现有功能；所有消息行严格不超过宽度。
