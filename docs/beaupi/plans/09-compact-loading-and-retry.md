# Compact、加载与重试计划

## 目标

统一 Working、Compact、Retry 和 Branch Summary 的状态文字与层级，同时保留 Pi 当前加载动画和 Compact 实际流式进度。

## Working

示例：

```text
● Thinking…
● Running npm run check…
● Waiting for background task…
```

这里的 `●` 代表 Pi 当前动画位置，实际帧不替换。

计划：

- 保留 `WorkingStatusIndicator` 的 Loader 和 Extension `setWorkingIndicator()`。
- 只调整默认文案、颜色和间距。
- `setWorkingVisible(false)` 行为不变。
- 自定义 Working Indicator 仍可覆盖普通 streaming indicator。

## Compact

示例：

```text
⠹ Compacting context... (esc to cancel)
━━━━━━━━━━━━──────────── 63%
```

必须保留：

- `compaction_progress.deltaCharacters`。
- `1 - exp(-tokens / 1200)` 渐近曲线。
- 运行期间最高 99%。
- 手动、threshold、overflow 使用同一组件。
- Retry 时保留已生成字符并继续推进。
- Escape 使用配置的 `app.interrupt` 提示与现有 abort 链路。

调整：

- 进度条按 width 缩短。
- 状态文字和 bar 之间保持一行层级。
- 成功后移除，不短暂伪造 100%。
- 失败和取消显示一次明确状态，不产生重复 chat/error。

## Retry

- 保留 attempt/maxAttempts/countdown。
- warning 色只用于 spinner 或关键数字，正文 dim。
- 倒计时每秒更新且不产生新聊天行。
- Escape 恢复原 handler。
- Summarization retry 与普通 retry 共享视觉语言，但保留来源语义。

## Branch Summary

- 使用同一 Loader 基础。
- 文案简洁：`Summarizing branch…`。
- 未来如有流式字符事件可复用 Compact progress；M1 不伪造进度。

## Idle Status

当前 `IdleStatus` 返回两行空白。计划确认它是否仍需要固定高度：

- 如果状态区高度固定可防止 editor 跳动，保留两行。
- 如果新布局可稳定高度，允许改为一行或零行，但必须通过 tmux 验证输入区不抖动。

## 文件

```text
components/status-indicator.ts
components/countdown-timer.ts
interactive-mode.ts
test/status-indicator.test.ts
test/compaction-status-indicator.test.ts
test/interactive-mode-status.test.ts
```

## 测试

- Working 默认与自定义 indicator。
- Compact 0、63、99% 和窄宽度。
- manual/threshold/overflow 文案。
- abort、success、failure。
- retry fake timer 与 attempt。
- summarization retry 保留 Compact progress。
- 每行宽度不溢出。

## 验收

Pi 动画保持不变；Compact 进度继续由真实流式输出驱动；Retry 不刷屏；状态区切换无明显布局抖动。
