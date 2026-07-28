# 主题与视觉基础计划

## 目标

建立 BeauPi 暗色、亮色主题和共享视觉 helper，让所有后续组件使用同一套颜色、状态符号、gutter、间距和宽度规则。

## 文件计划

新增：

```text
packages/coding-agent/src/modes/interactive/theme/beaupi-dark.json
packages/coding-agent/src/modes/interactive/theme/beaupi-light.json
packages/coding-agent/src/modes/interactive/components/beaupi-style.ts
```

可能修改：

```text
packages/coding-agent/src/modes/interactive/theme/theme.ts
packages/coding-agent/src/modes/interactive/theme/theme-schema.json
packages/coding-agent/src/modes/interactive/theme/theme-controller.ts
packages/coding-agent/test/theme-picker.test.ts
packages/coding-agent/test/theme-export.test.ts
```

## 主题策略

### 命名

- `beaupi-dark`
- `beaupi-light`

BeauPi 默认主题切换策略单独实现，不重命名现有 `dark`、`light`，避免破坏用户配置和 Pi Theme API。

### 调色方向

- 暖色 accent
- 默认文本使用终端前景或接近默认前景
- muted 与 dim 形成清晰两级
- 成功绿色低饱和，只突出状态符号
- 错误红色保持高可见度
- warning 使用低饱和黄/橙
- 普通 Tool 不依赖 pending/success/error 背景
- Diff 使用专用整行背景和词级强调色

## Token 评估

现有 Theme token 足以覆盖基础文本和旧式背景，但 Structured Diff 需要评估增加：

```text
toolDiffAddedBg
toolDiffRemovedBg
toolDiffAddedEmphasisBg
toolDiffRemovedEmphasisBg
toolDiffGutter
toolDiffBorder
```

如果增加 token，必须同步：

- TypeBox Theme schema
- JSON schema
- `ThemeColor`/`ThemeBg`
- 内建 dark/light 兼容值
- Theme 文档
- Theme export 与测试 fixture

若能通过现有 `getBgAnsi()` 和固定派生色安全实现，可减少 token；但不得在组件中散落硬编码 ANSI RGB。

## 共享 helper

`beaupi-style.ts` 计划提供：

```typescript
type BeauPiToolState = "queued" | "running" | "success" | "error" | "permission" | "cancelled";

function toolStateSymbol(state: BeauPiToolState, theme: Theme): string;
function toolTitle(name: string, argument: string, state: BeauPiToolState, theme: Theme): string;
function resultGutter(text: string, theme: Theme): string;
function continuationGutter(text: string, theme: Theme): string;
function treeGutter(kind: "branch" | "last" | "pipe", theme: Theme): string;
function fitSingleLine(parts: ResponsivePart[], width: number): string;
```

helper 只负责视觉，不读取 AgentSession 或 Tool Result。

## 间距约定

- Assistant 正文前最多一个空行。
- Tool 标题与前一块内容之间一个空行。
- Tool 结果紧跟标题，不额外空行。
- 连续 Tool 由聚合规则决定间距。
- `⎿` gutter 固定宽度，续行正文对齐。
- 状态行、Footer 和折叠提示默认 dim。

## Theme 失效

所有保存预着色文本的组件必须在 `invalidate()` 时重建：

- Write Highlight Cache 可以保存原始文本和语法结构，但不能永久保存旧 Theme ANSI。
- Diff cache key 必须包含 Theme identity/version。
- Footer 不能缓存已着色字符串跨 Theme 使用。
- helper 不保存全局渲染结果。

## 测试

- 两个 BeauPi Theme 均通过 schema 校验。
- Theme selector 可发现并选择。
- 自动 light/dark 组合可配置为 `beaupi-light/beaupi-dark`。
- 256 色模式可创建 Theme。
- Theme 热切换后 Tool、Diff、Footer 无旧颜色。
- 所有新增 token 有 dark/light/default fallback。

## 验收

- 主题中不存在 Claude 品牌名称或资源。
- 暗色与亮色下 text/muted/dim、success/warning/error 清晰可区分。
- 普通 Tool 即使背景 token存在，也不再依赖大面积背景表达状态。
- 主题扩展不破坏第三方 Theme；新增 token 必须提供兼容策略。
