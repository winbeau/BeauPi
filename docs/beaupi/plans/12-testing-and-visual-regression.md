# 测试与视觉回归计划

## 测试层级

### 1. 纯函数测试

覆盖：

- 状态到符号/颜色映射
- Tool 标题格式
- Footer 字段降级
- Diff parse、pair、word emphasis
- ANSI-aware width helper
- Run stats 计算

### 2. 组件渲染测试

对组件调用 `render(width)`，断言：

- 纯文本结构
- 必要 ANSI token
- 每行宽度
- collapsed/expanded
- partial/final/error
- Theme invalidate

### 3. InteractiveMode 事件测试

覆盖事件序列：

```text
message_start
message_update (tool args streaming)
message_end
Tool execution_start
Tool execution_update
Tool execution_end
agent_end
```

重点验证实时渲染与 Session 恢复重建一致。

### 4. tmux 视觉回归

在 80、120、160 列执行受控会话并 capture pane。使用 faux provider 生成固定消息与 Tool 调用；不调用真实 Provider。

## 现有测试扩展

修改或扩展：

```text
test/user-message.test.ts
test/assistant-message.test.ts
test/tool-execution-component.test.ts
test/bash-execution-width.test.ts
test/footer-width.test.ts
test/status-indicator.test.ts
test/compaction-status-indicator.test.ts
test/theme-picker.test.ts
test/theme-export.test.ts
```

建议新增：

```text
test/beaupi-style.test.ts
test/write-renderer.test.ts
test/edit-renderer.test.ts
test/structured-diff.test.ts
test/tool-group.test.ts
test/footer-run-stats.test.ts
test/beaupi-theme.test.ts
test/suite/beaupi-tui-events.test.ts
```

## 必测行为

### Preservation

- Write 动态 `more lines`/`total`。
- Ctrl+O 展开所有可展开组件。
- Pi Working Indicator 默认帧不变。
- OSC 133 标记。
- Edit 异步 Preview。
- Bash partial throttle、tail preview、elapsed。
- Compact 63% 渐近进度。
- Image Result。
- Extension custom/self renderer。

### Width

每个组件至少测试：40、60、80、120、160。包含 CJK、emoji、超长 path、超长 command、超长 model ID。

### Theme

- BeauPi dark/light。
- 当前内建 dark/light 仍可用。
- Theme hot invalidate。
- 256 color。
- HTML export 不因新增 token 失败。

### Error

- Tool exception。
- Result `isError`。
- timeout、abort、cancel。
- invalid args。
- Diff preview error。
- Compact/retry failure。

## tmux 场景

1. User + Assistant 普通文本。
2. Read/Search/List 连续调用与聚合。
3. Write 参数流式增长，观察动态数字。
4. Edit Preview + Structured Diff。
5. Bash 长输出、elapsed、失败和 Ctrl+O。
6. Footer 完整数据与窄终端降级。
7. Compact 进度。
8. Theme dark/light。

## 命令

修改单个测试后从 package root 运行：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

非 E2E 全量测试使用仓库根目录：

```bash
./test.sh
```

每个代码批次完成后：

```bash
npm run check
```

不得运行完整 Vitest suite 或真实 Provider 测试。

## 视觉验收记录

每个 tmux 场景记录：

- width/height
- theme
- fixture 名称
- capture 文件或测试 snapshot
- 已知差异
- 是否阻塞下一批次

## 验收记录（2026-07-28）

- 固定 TUI fixture 覆盖 User、Assistant、Read、Write、Structured Diff、Compact、Footer 和 Ctrl+O。
- tmux 暗色检查：80×45、120×45、160×45；亮色检查：80×45。
- 捕获文件最大可见宽度分别为 80、120、160，没有横向溢出。
- Ctrl+O 展开后确认完整 Write 尾部可见；暗色和亮色均确认增删行背景与 256 色降级。
- `./test.sh`：通过。
- `npm run check`：通过，无错误、警告或 info。
- 已知阻塞差异：无。

## 完成标准

自动化测试覆盖状态、宽度和行为；tmux 检查覆盖主要视觉；无依赖人工记忆的“看起来差不多”验收。
