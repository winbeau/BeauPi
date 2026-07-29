# 最终验收清单

## 品牌与边界

- [x] 最终界面不使用 Claude Logo、吉祥物或品牌名称。
- [x] 未复制参考仓库 React/Ink 代码。
- [x] 未创建第二套 Runtime、CLI、Session 或 Tool 执行链。

## Theme

- [x] `beaupi-dark` 可选择。
- [x] `beaupi-light` 可选择。
- [x] 暗色和亮色层级清晰。
- [x] Theme 热切换无旧 ANSI 缓存。
- [x] 256 色降级可读。
- [x] 第三方 Theme 兼容。

## 消息

- [x] User 不使用整块背景卡片。
- [x] User 多行正文与前缀对齐。
- [x] Assistant 正文无背景。
- [x] Thinking 合并、隐藏和展开正确。
- [x] OSC 133 标记保持正确。
- [x] length/abort/error 始终可见且不重复。

## Tool Shell

- [x] 普通 Tool 无大面积状态背景。
- [x] queued/running/success/error 可区分。
- [x] permission 视觉槽位已定义。
- [x] 结果使用统一 `⎿` gutter。
- [x] Generic fallback 紧凑且可展开。
- [x] Extension override 和 `renderShell: "self"` 兼容。
- [x] 图片 Result 正常。

## Read/Search/List/Bash

- [x] Read 路径和行范围正确。
- [x] Read 折叠/展开和语法高亮正确。
- [x] Search/Find/List 数量摘要正确。
- [x] 无结果保持安静。
- [x] 截断与完整日志路径可见。
- [x] Bash partial output、elapsed、exit/timeout/abort 正确。
- [x] Bash Mode 与 Bash Tool 状态语言一致。
- [x] Tool Group 不改变 Session 数据。

## Write

- [x] Write 参数流式增长时持续更新预览。
- [x] `more lines` 动态更新。
- [x] `total` 动态更新。
- [x] 样式变化未移除跳数字行为。
- [x] Ctrl+O 展开完整预览。
- [x] Theme 切换后 Highlight Cache 更新。
- [x] 空内容、尾随空行和 invalid arg 正确。

## Edit 与 Diff

- [x] Edit 异步 Preview 正确。
- [x] 旧 Preview Promise 不覆盖新参数。
- [x] 执行后不重复相同 Diff。
- [x] Diff 有上下实线边界。
- [x] Added/Removed 使用整行背景。
- [x] 低变化行有词级强调。
- [x] 高变化行不过度强调。
- [x] 长行、宽字符和窄终端正确换行。
- [x] Diff cache 在 resize/Theme change 后正确失效。

## Footer

- [x] 完整模式最多三行。
- [x] 第一行显示最近 Run 数据。
- [x] 第二行显示 cwd/branch。
- [x] 第三行显示 Session/context/model。
- [x] TPS、output、input、cache、total、elapsed 语义正确。
- [x] Context unknown 状态正确。
- [x] 字段按计划顺序降级。
- [x] Extension status 仍可见且不产生第四行。

## Compact 与状态

- [x] Pi 当前加载动画保留。
- [x] Working 自定义 indicator 兼容。
- [x] Compact 使用真实流式字符。
- [x] Compact 渐近曲线与 99% 上限正确。
- [x] Compact retry 保留已有进度。
- [x] Retry countdown 和 Escape 正确。
- [x] 状态区无明显高度抖动。

## 响应式与性能

- [x] 40 列不崩溃。
- [x] 80/120/160 列完成视觉验收。
- [x] 所有行 `visibleWidth <= width`。
- [x] CJK、emoji 和长 path/model/command 正确。
- [x] 连续 resize 无旧缓存或无界 cache。
- [x] Write/Bash/Compact 流式更新无明显卡顿。
- [x] Footer 不在高频动画 render 中反复全量扫描大型 Session。

## 测试与文档

- [x] 修改的定向测试已通过。
- [x] `./test.sh` 已通过。
- [x] `npm run check` 无错误、警告或 info。
- [x] tmux 视觉场景已记录。
- [x] `docs/beaupi/ui-style.md` 与实现一致。
- [x] Roadmap、Milestone 和 Changelog 已更新；M3 Document Runtime 已接入现有生命周期，下一里程碑为 M4 Skill Registry。

## 里程碑判定

只有全部阻塞项完成后，M1“Claude Code 风格 TUI 基础”才可标记完成。Todo、子 Agent、Workflow 和 Background 的真实 Runtime 不属于本清单，但其视觉接入点必须已经定义。
