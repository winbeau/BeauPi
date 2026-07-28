# Tool Shell 与生命周期计划

## 目标

统一所有 Tool 的标题、状态和结果 gutter，移除普通 Tool 的大面积 pending/success/error 背景，同时保持 Extension renderer 兼容。

## 目标结构

```text
● Read(src/auth/session.ts)
  ⎿  184 lines
```

状态：

```text
○ Read(path)                 queued
● Bash(npm run check)       running
✓ Bash(npm run check)       success
✗ Bash(npm run check)       error
! Bash(sudo ...)            permission
```

是否让普通成功工具继续显示 `●` 在实现时通过 fixture 决定；错误必须是 `✗`。

## Tool 状态模型

从现有上下文映射：

- queued：参数流式到达但 `executionStarted=false`
- running：`executionStarted=true` 且 `isPartial=true`
- success：Result 完成且 `isError=false`
- error：Result 完成且 `isError=true`
- cancelled：错误内容/未来结构化状态表明取消
- permission：为未来 classifier/confirmation 保留，不在 M1 伪造

建议将显示状态作为纯函数计算，不写回 Tool Result。

## ToolExecutionComponent 调整

### Shell 策略

新增全局 minimal shell 路径：

- 内建 Tool 默认使用 minimal shell。
- 明确指定 `renderShell: "self"` 的 Tool 继续完全自绘。
- Extension Tool 未指定 renderer 时保留安全 fallback，但 fallback 也使用 minimal shell。
- 如需兼容旧 Extension 背景卡片，可保留显式 `renderShell: "default"` 语义，不静默改变自绘组件。

### 生命周期

`updateArgs()`、`markExecutionStarted()`、`setArgsComplete()`、`updateResult()` 和 `setExpanded()` 继续触发原 renderer 更新。

必须保留：

- `context.lastComponent`
- `context.state`
- `context.invalidate()`
- `context.argsComplete`
- `context.executionStarted`
- `context.isPartial`
- `context.expanded`
- 图片转换和展示

### Generic fallback

未知 Tool：

```text
● Custom Tool(summary)
  ⎿  result preview
```

- 参数只显示一行摘要，不默认展开完整 JSON。
- 完整参数和结果仅在 Ctrl+O 展开时显示。
- 错误结果始终显示首要原因。

## Renderer API 边界

首选方案：

- Tool renderer 返回标题正文和结果正文。
- ToolExecutionComponent 统一添加状态符号、标题括号和结果 gutter。

兼容方案：

- 已经 `renderShell: "self"` 的 renderer 自行负责完整结构。
- 内建 renderer 逐步迁移到共享 helper。

不要通过字符串拆解已有 renderer 输出再添加样式。

## 文件

```text
components/tool-execution.ts
components/beaupi-style.ts
core/extensions/types.ts（仅在确有 API 需要时）
core/tools/render-utils.ts
test/tool-execution-component.test.ts
examples/extensions/built-in-tool-renderer.ts（如 API 行为变化需同步）
```

## 测试矩阵

- 内建 Tool + 无 Override
- 内建 Tool + 只 Override call
- 内建 Tool + 只 Override result
- 内建 Tool + 完整 Override
- Custom Tool + renderer
- Custom Tool + 无 renderer
- `renderShell: "self"`
- 空 self-render component 不占高度
- partial → success
- partial → error
- aborted/cancelled
- 图片 Result
- Theme invalidate
- Ctrl+O 展开

## 验收

普通 Tool 无大背景 Box；状态不依赖背景也能识别；Extension renderer 继承、state 和 self shell 行为不退化。
