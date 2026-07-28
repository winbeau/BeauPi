# 最终验收清单

## 品牌与边界

- [ ] 最终界面不使用 Claude Logo、吉祥物或品牌名称。
- [ ] 未复制参考仓库 React/Ink 代码。
- [ ] 未创建第二套 Runtime、CLI、Session 或 Tool 执行链。

## Theme

- [ ] `beaupi-dark` 可选择。
- [ ] `beaupi-light` 可选择。
- [ ] 暗色和亮色层级清晰。
- [ ] Theme 热切换无旧 ANSI 缓存。
- [ ] 256 色降级可读。
- [ ] 第三方 Theme 兼容。

## 消息

- [ ] User 不使用整块背景卡片。
- [ ] User 多行正文与前缀对齐。
- [ ] Assistant 正文无背景。
- [ ] Thinking 合并、隐藏和展开正确。
- [ ] OSC 133 标记保持正确。
- [ ] length/abort/error 始终可见且不重复。

## Tool Shell

- [ ] 普通 Tool 无大面积状态背景。
- [ ] queued/running/success/error 可区分。
- [ ] permission 视觉槽位已定义。
- [ ] 结果使用统一 `⎿` gutter。
- [ ] Generic fallback 紧凑且可展开。
- [ ] Extension override 和 `renderShell: "self"` 兼容。
- [ ] 图片 Result 正常。

## Read/Search/List/Bash

- [ ] Read 路径和行范围正确。
- [ ] Read 折叠/展开和语法高亮正确。
- [ ] Search/Find/List 数量摘要正确。
- [ ] 无结果保持安静。
- [ ] 截断与完整日志路径可见。
- [ ] Bash partial output、elapsed、exit/timeout/abort 正确。
- [ ] Bash Mode 与 Bash Tool 状态语言一致。
- [ ] Tool Group 不改变 Session 数据。

## Write

- [ ] Write 参数流式增长时持续更新预览。
- [ ] `more lines` 动态更新。
- [ ] `total` 动态更新。
- [ ] 样式变化未移除跳数字行为。
- [ ] Ctrl+O 展开完整预览。
- [ ] Theme 切换后 Highlight Cache 更新。
- [ ] 空内容、尾随空行和 invalid arg 正确。

## Edit 与 Diff

- [ ] Edit 异步 Preview 正确。
- [ ] 旧 Preview Promise 不覆盖新参数。
- [ ] 执行后不重复相同 Diff。
- [ ] Diff 有上下 dashed 边界。
- [ ] Added/Removed 使用整行背景。
- [ ] 低变化行有词级强调。
- [ ] 高变化行不过度强调。
- [ ] 长行、宽字符和窄终端正确换行。
- [ ] Diff cache 在 resize/Theme change 后正确失效。

## Footer

- [ ] 完整模式最多三行。
- [ ] 第一行显示最近 Run 数据。
- [ ] 第二行显示 cwd/branch。
- [ ] 第三行显示 Session/context/model。
- [ ] TPS、output、input、cache、total、elapsed 语义正确。
- [ ] Context unknown 状态正确。
- [ ] 字段按计划顺序降级。
- [ ] Extension status 仍可见且不产生第四行。

## Compact 与状态

- [ ] Pi 当前加载动画保留。
- [ ] Working 自定义 indicator 兼容。
- [ ] Compact 使用真实流式字符。
- [ ] Compact 渐近曲线与 99% 上限正确。
- [ ] Compact retry 保留已有进度。
- [ ] Retry countdown 和 Escape 正确。
- [ ] 状态区无明显高度抖动。

## 响应式与性能

- [ ] 40 列不崩溃。
- [ ] 80/120/160 列完成视觉验收。
- [ ] 所有行 `visibleWidth <= width`。
- [ ] CJK、emoji 和长 path/model/command 正确。
- [ ] 连续 resize 无旧缓存或无界 cache。
- [ ] Write/Bash/Compact 流式更新无明显卡顿。
- [ ] Footer 不在高频动画 render 中反复全量扫描大型 Session。

## 测试与文档

- [ ] 修改的定向测试已通过。
- [ ] `./test.sh` 已通过。
- [ ] `npm run check` 无错误、警告或 info。
- [ ] tmux 视觉场景已记录。
- [ ] `docs/beaupi/ui-style.md` 与实现一致。
- [ ] Roadmap、Milestone 和 Changelog 已更新。

## 里程碑判定

只有全部阻塞项完成后，M1“Claude Code 风格 TUI 基础”才可标记完成。Todo、子 Agent、Workflow 和 Background 的真实 Runtime 不属于本清单，但其视觉接入点必须已经定义。
