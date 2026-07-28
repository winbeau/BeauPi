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

Batch 1 评估结论：增加四个可选 Structured Diff 背景 token：

```text
toolDiffAddedBg
toolDiffRemovedBg
toolDiffAddedEmphasisBg
toolDiffRemovedEmphasisBg
```

现有 `toolSuccessBg`/`toolErrorBg` 不能安全承担 Diff 行背景的长期语义，`selectedBg` 也不能表达词级增删强调，因此四个专用背景 token 是必要的。旧第三方主题缺少这些 token 时，行背景分别回退到 `toolSuccessBg`/`toolErrorBg`，词级强调回退到对应 Diff 行背景。

不增加 `toolDiffGutter` 和 `toolDiffBorder`：gutter 使用现有 `toolDiffContext`，上下虚线边界使用现有 `borderMuted`，两者在 light、dark、truecolor 和 256 色下已有独立语义且不与增删状态混用。

已同步：

- TypeBox Theme schema
- JSON schema
- `ThemeBg`
- 全部内建主题
- Theme 文档与公开类型导出
- Theme export、controller、兼容和 256 色测试

## 共享 helper

`beaupi-style.ts` 提供纯视觉 API：

```typescript
type BeauPiToolState =
  | "queued"
  | "running"
  | "success"
  | "completed"
  | "warning"
  | "error"
  | "failed"
  | "cancelled"
  | "permission"
  | "permission-waiting";

function semanticStatus(state: BeauPiToolState): BeauPiSemanticStatus;
function statusSymbol(state: BeauPiToolState): BeauPiStatusSymbol;
function toolStateSymbol(state: BeauPiToolState, theme: Theme): string;
function toolTitle(name: string, argument: string, state: BeauPiToolState, theme: Theme, width: number): string;
function messageGutter(text: string, theme: Theme, width: number): string;
function resultGutter(text: string, theme: Theme, width: number): string;
function continuationGutter(text: string, theme: Theme, width: number): string;
function treeGutter(kind: "branch" | "last" | "pipe", theme: Theme, width: number): string;
function fitSingleLine(parts: readonly ResponsivePart[], width: number): string;
function fitLabelSuffixMetadata(parts: LabelSuffixMetadata, width: number): string;
```

helper 只负责视觉，不读取 AgentSession 或 Tool Result；所有 fitting 使用 `@earendil-works/pi-tui` 的 cell width 与 ANSI-aware truncate 实现。

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
