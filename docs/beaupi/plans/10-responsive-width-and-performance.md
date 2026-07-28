# 宽度、缓存与性能计划

## 核心规则

Pi TUI 要求每个 `render(width)` 返回的每一行可见宽度不超过 `width`。这是所有 TUI 组件的硬约束。

## 宽度工具

统一使用：

- `visibleWidth()`
- `truncateToWidth()`
- `wrapTextWithAnsi()`
- 现有 `truncateToVisualLines()`

禁止：

- 使用 `string.length` 作为终端列宽。
- 对含 ANSI 的字符串直接 `slice()`。
- 假设 emoji、CJK 和 combining mark 宽度为 1。
- 让外层 Container 依赖子组件自行“应该能放下”。

## 响应式断点

测试宽度：

- 40：极窄防崩溃
- 60：窄终端
- 80：最低正式验收宽度
- 120：常见宽度
- 160：完整布局

组件不应硬依赖固定断点；优先基于字段实际宽度逐项降级。

## Gutter 计算

所有 gutter 先计算可见宽度：

```text
Tool result:   "  ⎿  "
Tree branch:   "   ├─ "
Diff line:     sign + old/new line number + spacing
User message:  "> "
```

正文可用宽度为 `width - gutterWidth`。续行必须重新添加对应 gutter。

## 缓存规范

缓存 key 必须包含所有影响显示的状态：

- width
- theme identity/version
- expanded
- partial/result version
- data hash/version
- renderer-specific options

`invalidate()`：

- 清除 render lines。
- 清除或重建预着色内容。
- Theme 改变时不得复用旧 ANSI。

## 组件策略

### Tool

- 流式参数更新只更新受影响 renderer。
- Bash 继续使用 100ms throttle。
- Write 保留增量高亮，不全量重算大文件。

### Diff

- 缓存解析后的结构模型与 width-specific 渲染分开。
- 限制最近 width cache 数量。
- Theme 切换清除着色 cache，不必重复 parse patch。

### Footer

- 使用 entries version 或事件驱动 totals，避免每次动画 render 遍历完整 Session。
- Running elapsed 每秒更新，不需要更高频率。

### Tool Group

- 聚合组件只保存子组件引用和当前摘要，不复制完整 Tool output。

## Theme 热切换

TUI 会调用组件 `invalidate()`。所有继承 Container 且预先生成 themed Text 的组件需重建 child tree。优先在 render 时着色，或保存原始数据后在 invalidate 重建。

## 性能测试建议

- 500 个 Session item 重建。
- 100 个 Tool component Ctrl+O 切换。
- Write 2000 行参数按 chunk 流式增长。
- Diff 1000 行、连续 resize。
- Footer 在 Working spinner 频繁 render 下不重复全量聚合。

不要求第一版建立严格 benchmark 门槛，但应记录明显回归并为 Diff/Write 加定向性能测试。

## 验收

- 所有目标组件在测试宽度下 `visibleWidth <= width`。
- resize 后不会显示旧宽度缓存。
- Theme 热切换后无旧颜色。
- Write、Bash 和 Compact 流式更新无明显卡顿。
- 缓存大小有上限。
