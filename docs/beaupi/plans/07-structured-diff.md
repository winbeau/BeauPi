# Structured Diff 计划

## 目标

在不改动 edit 算法和 `details.patch` 的前提下，重写 Diff 展示层：整行增删背景、词级强调、行号 gutter、上下 dashed 边界、宽度适配和缓存。

## 输入

优先输入：

- `EditToolDetails.diff`：当前展示型 diff
- `EditToolDetails.patch`：标准 unified patch，可用于更稳定的 hunk 元数据
- file path
- render width
- theme
- expanded/dim 状态

第一版先继续支持现有 display diff 格式；如解析限制阻碍 hunk/line number，改为从 patch 构建结构化模型，但不修改 edit 执行算法。

## 中间模型

建议：

```typescript
type DiffLine = {
  kind: "context" | "added" | "removed" | "ellipsis";
  oldLine?: number;
  newLine?: number;
  content: string;
  emphasis?: DiffSpan[];
};

type DiffHunk = {
  lines: DiffLine[];
};
```

解析与渲染分离，便于单元测试。

## 目标结构

```text
  ┄┄┄┄┄┄┄┄┄┄┄┄
  116   const token = await loadToken();
- 117   return refresh(token);
+ 117   return refreshWithRotation(token);
  118 }
  ┄┄┄┄┄┄┄┄┄┄┄┄
```

## 样式规则

- 仅上下 dashed 边界，无左右边框。
- gutter 显示 `+`/`-`、行号和固定间隔。
- Context 行 dim、无背景。
- Removed 整行红色背景。
- Added 整行绿色背景。
- 相邻 removed/added 做词级 diff。
- 变化比例过高时不做词级强调，避免整行噪声。
- 词级强调使用更深背景，不使用 inverse。
- Ellipsis 使用 dim。
- Error 不渲染 Diff 外壳。

## 宽度与换行

- 先计算 gutter 可见宽度，再计算正文宽度。
- ANSI-aware wrap。
- 宽字符、组合字符和 emoji 使用 `visibleWidth()`。
- 续行保留空行号 gutter，并保持增删背景。
- 任意返回行不得超过 width。
- width 太窄时优先缩短行号列，但保留 `+`/`-`。

## 词级 Diff

- 扩展当前 `diffWords()` 逻辑到可配对的相邻行。
- 第一版支持一对一和简单 N 对 N 配对。
- 计算 changed ratio；约 40% 以上放弃词级强调。
- 不强调纯缩进前缀。
- 保留原始文本，不把 ANSI 输入传入 diff 算法。

## 缓存

Cache key 至少包含：

```text
patch/diff hash
theme identity or version
width
dim/expanded mode
renderer version
```

- resize 时允许保留少量最近 width 版本。
- Theme invalidate 清空全部着色 cache。
- 限制 cache 数量，避免连续 resize 无界增长。

## 复制行为

如 Pi TUI/终端能力允许，gutter 可使用不参与复制的终端标记；第一版不以此为阻塞条件。禁止为了复制语义破坏普通终端显示。

## 文件

```text
components/diff.ts
core/tools/edit.ts（只调整调用参数）
theme/theme.ts
theme/theme-schema.json
beaupi-dark.json
beaupi-light.json
新增 test/structured-diff.test.ts
```

## 测试

- context/add/remove/ellipsis。
- 一删一增、多删多增。
- 低变化比例词级强调。
- 高变化比例不强调。
- tab、长行、空行、宽字符、emoji。
- 20/40/80/120 列。
- Theme 切换和 resize cache。
- 每行 `visibleWidth <= width`。
- Error 路径无 dashed Diff 外壳。

## 验收

Diff 在暗色、亮色和窄终端下可读；整行背景与词级强调正确；不重复展示；resize 和 Theme 切换无旧缓存。
