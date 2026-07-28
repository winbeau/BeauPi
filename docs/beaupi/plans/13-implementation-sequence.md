# 实施批次与文件清单

## 实施状态

Batch 0–10 已全部完成并于 2026-07-28 通过最终验收。M1 已关闭，后续工作从 M2 Task Ledger 开始。

## 原则

每个批次必须可独立运行和回退。先建立共享基础，再改造组件；不在同一个大改动中同时修改所有 Tool。

## Batch 0：基线与 Fixture

### 工作

- 运行现有相关测试。
- 用 tmux 保存当前 80/120/160 列截图。
- 建立固定 User、Assistant、Tool、Diff、Footer、Compact fixture。
- 记录现有 Write 动态行数行为。

### 输出

- 基线说明
- fixture/helper
- 不改变视觉

## Batch 1：BeauPi Theme 与共享 helper

### 文件

```text
theme/beaupi-dark.json
theme/beaupi-light.json
components/beaupi-style.ts
theme/theme.ts（必要时）
theme/theme-schema.json（必要时）
```

### 验收

Theme 可发现、切换、热失效；helper 有纯函数测试。

## Batch 2：消息布局

### 文件

```text
components/user-message.ts
components/assistant-message.ts
test/user-message.test.ts
test/assistant-message.test.ts
```

### 验收

User 无大背景；Assistant/Thinking/OSC 133 不退化。

## Batch 3：Tool Minimal Shell

### 文件

```text
components/tool-execution.ts
core/tools/render-utils.ts
test/tool-execution-component.test.ts
```

### 验收

内建 Tool 进入 minimal shell；Extension override/self/fallback 兼容。

## Batch 4：Read/Search/List/Bash

### 文件

```text
core/tools/read.ts
core/tools/grep.ts
core/tools/find.ts
core/tools/ls.ts
core/tools/bash.ts
components/bash-execution.ts
```

先逐个 renderer 改造，再实现可选 Tool Group。不要在单次 edit 中同时重写全部 Tool。

### 验收

摘要、错误、截断、elapsed 和 Ctrl+O 正确。

## Batch 5：Write

### 文件

```text
core/tools/write.ts
test/write-renderer.test.ts
```

### 验收

动态数字测试先写；改样式后行为不变；Theme invalidate 正确。

## Batch 6：Structured Diff 与 Edit

### 文件

```text
components/diff.ts
core/tools/edit.ts
test/structured-diff.test.ts
test/edit-renderer.test.ts
```

### 验收

整行背景、词级强调、宽度、cache、preview 去重。

## Batch 7：Footer 与 Run Stats

### 文件

```text
components/footer.ts
interactive-mode.ts
core/footer-data-provider.ts
core/recent-run-stats.ts（如采用）
test/footer-width.test.ts
test/footer-run-stats.test.ts
```

### 验收

三行布局、字段级降级、TPS/elapsed、最多三行。

## Batch 8：Compact、Working、Retry

### 文件

```text
components/status-indicator.ts
interactive-mode.ts
test/status-indicator.test.ts
test/compaction-status-indicator.test.ts
```

### 验收

Spinner 保留；Compact 真流式；Retry 无刷屏。

## Batch 9：Tool Group

Tool Group 风险高，放在单项 renderer 稳定后。

### 文件

```text
components/tool-group.ts
interactive-mode.ts
test/tool-group.test.ts
test/suite/beaupi-tui-events.test.ts
```

### 验收

实时和 Session 恢复分组一致；错误/写 Tool 正确打断；Ctrl+O 展开。

## Batch 10：最终收敛

- 删除只为迁移存在的重复 helper。
- 补齐未来组件 visual contract fixture。
- 完成所有宽度和 Theme 矩阵。
- 更新文档与 Changelog。
- 运行相关测试、`./test.sh` 和 `npm run check`。
- 完成 tmux 视觉回归。

## 提交粒度建议

若用户要求提交，建议每个 Batch 一个提交，避免一个提交包含整个 TUI 重构。每个提交必须包含对应测试。

## 暂缓决策

以下在实施中先做 Spike，再决定是否进入正式改动：

- 是否扩展 Theme Token。
- Tool minimal shell 是否新增第三种 `renderShell` 值。
- Tool Group 是否需要 InteractiveMode 容器抽象。
- Diff 是否从 display diff 切换为 patch 解析。
- Footer usage 是否事件驱动缓存。

Spike 结论写回对应计划文档，避免只存在于会话中。
