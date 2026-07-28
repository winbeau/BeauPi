# 设计约束

## 目标

在 `packages/coding-agent` 现有交互模式上实现接近 Claude Code 的终端视觉语言：紧凑、无普通 Tool 大卡片、状态明确、输出可折叠、Diff 可读、Footer 信息密度高。

## 必须保留的行为

以下属于产品交互契约，不得在样式调整中移除：

1. Pi 当前跳动加载图标及其动画节奏。
2. Ctrl+O 全局展开/折叠 Tool、资源、摘要和可展开组件。
3. Write Tool 流式参数期间的动态行数：`more lines` 与 `total` 随内容增长实时跳动。
4. Tool partial update、完成、失败、取消、权限等待等生命周期语义。
5. Edit 在参数完成后异步生成预览，并避免执行后重复展示同一 Diff。
6. Bash 增量输出、耗时更新、截断告警和完整日志路径。
7. Compact 由实际流式总结字符驱动进度，不新增模型轮询。
8. OSC 133 消息区域标记。
9. 图片 Tool Result 和 Kitty 图片转换能力。
10. Theme 热重载、终端明暗自动切换和 256 色降级。
11. Extension 自定义 `renderCall`、`renderResult`、`renderShell: "self"`、自定义 Footer 和 Widget 能力。

## 允许改变的内容

- 文案、图标、颜色、间距和缩进
- Tool 名称的显示映射
- Tool 完成后使用 `●` 或 `✓` 的具体选择
- 输出预览行数
- Footer 字段隐藏顺序
- User 消息前缀或细边界形式
- Diff 配色和 gutter 结构

改变后仍必须满足信息不丢失、宽度不溢出、错误不被折叠隐藏。

## 禁止事项

- 不复制 `claude-code-best/claude-code` 的 React/Ink 源码。
- 不使用 Claude Logo、吉祥物、产品名或品牌资源。
- 不引入独立 BeauPi Runtime、第二套 Tool 执行链或第二套 Session 渲染链。
- 不通过解析 Tool 输出文本推断已有 `details` 中可提供的状态。
- 不为解决视觉问题移除 Extension API 或现有 Tool 功能。
- 不硬编码 Ctrl+O；继续使用 `app.tools.expand` Keybinding。
- 不让任何 `render(width)` 返回超宽行。
- 不把所有未来组件一次性实现到 M1。

## 实现优先级

1. 复用现有 Tool `renderCall`/`renderResult`。
2. 提取共享视觉 helper。
3. 调整 `ToolExecutionComponent` 支持全局 minimal shell。
4. 只有现有 Theme token 不足时才扩展 Theme Schema。
5. 只有组件确实需要时才修改 `@earendil-works/pi-tui`。

## 数据与视觉边界

- Tool 执行结果继续由核心 Tool 产生。
- 渲染组件只消费参数、Result、`details` 和生命周期上下文。
- Footer 的运行统计应由明确的数据对象提供，不在 `render()` 中依赖易变日志字符串。
- 缓存 key 必须包含会影响输出的 width、theme、expanded、partial 和状态版本。
- 未来 Todo/Agent/Workflow 只接入共享状态符号和布局 helper，不反向改变 Tool Runtime。

## 参考边界

实现可以对照公开参考中的组件行为和截图，但代码必须独立实现并落在 Pi TUI API 上。最终主题名使用 BeauPi 名称，不使用 Claude 品牌名称。
