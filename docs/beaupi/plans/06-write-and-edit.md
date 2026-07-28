# Write 与 Edit 计划

## 实施状态

已完成（Batch 5、6）。Write 保留流式参数预览、动态 `more lines`/`total`、Highlight Cache 和 Ctrl+O；Edit 保留异步 Preview、参数版本保护与执行后去重。

## 目标

让文件写入和精确编辑使用统一标题、流式预览和 Structured Diff，同时保留 Write 动态行数与 Edit 异步预览。

## Write

目标折叠示例：

```text
● Write(src/auth/session.ts)
  ⎿  10 lines shown
      … (62 more lines, 72 total, ctrl+o to expand)
```

### 必须保留

- `updateArgs()` 每次流式参数变化都会更新 renderer。
- `WriteCallRenderComponent` 与增量 Highlight Cache。
- `argsComplete=false` 时增量更新，不等待完整内容。
- `more lines` 和 `total` 随内容增长实时变化。
- Ctrl+O 展开完整预览。
- invalid content 和执行错误立即可见。
- 写入执行逻辑、mutation queue 和 abort 检查不变。

### 调整

- 标题改为 `Write(path)`。
- 内容进入统一 `⎿` gutter。
- 折叠提示使用 dim，但数字可使用普通前景以增强动态反馈。
- 预览行数可从 10 调整，但必须固定并测试。
- 完成成功不重复显示无价值的 `Successfully wrote ...`。
- 若需要结果摘要，显示 bytes/lines，不整行染绿。

### Highlight Cache

当前缓存保存已经着色的 `highlightedLines`。计划需要确保 Theme 切换时：

- 清空 highlighted ANSI；或
- 缓存原始 normalized lines，在 render 时重新着色。

增量更新仍应避免每个 chunk 对完整文件全量高亮。前 50 行全量刷新与新增行单行高亮策略可以保留。

## Edit

目标：

```text
● Update(src/auth/session.ts)
<structured diff>
```

### 必须保留

- `prepareArguments()` 的模型兼容处理。
- 参数完整后异步 `computeEditsDiff()`。
- preview request key 防止旧 Promise 覆盖新参数。
- 执行结果与 preview 相同时不重复 Diff。
- Error preview 和执行 Error 可见。
- `details.patch`、`firstChangedLine` 和 edit 算法不变。

### 调整

- 显示名称由 `edit` 改为 `Update`。
- 移除 Edit header 的 pending/success/error 背景。
- 标题使用统一 Tool 状态符号。
- Preview Diff 紧跟标题，不使用外层 Box。
- Error 直接位于标题下方的结果 gutter。

## 多文件摘要

M1 的 Write/Edit 仍是单文件 Tool。多文件摘要 helper 可以定义，但不在本阶段新增批量写入 Tool。

## 文件

```text
core/tools/write.ts
core/tools/edit.ts
components/diff.ts
components/tool-execution.ts
components/beaupi-style.ts
test/tool-execution-component.test.ts
新增 write-renderer.test.ts（建议）
新增 edit-renderer.test.ts（建议）
```

## 测试

### Write

- 参数按 chunk 增长时 total：10 → 11 → 72。
- `more lines` 同步变化。
- Theme 切换后语法色更新。
- 非代码文件、代码文件、空内容、尾随空行。
- Ctrl+O 展开/折叠。
- invalid arg、abort、write error。

### Edit

- preview pending、成功、错误。
- 参数变化时忽略旧 preview Promise。
- Result Diff 与 preview 相同不重复。
- Result Diff 不同时更新。
- Session 恢复渲染与实时渲染一致。

## 验收

Write 动态跳数字完整保留；Edit 预览不闪烁、不重复；两者都进入统一 Claude Code 风格结构。
