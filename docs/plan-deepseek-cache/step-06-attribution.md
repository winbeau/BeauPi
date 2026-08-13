# Step 6 — 来源归属文档

## 目标

满足两个 donor 的 MIT 许可证要求：保留版权声明与许可声明，记录每一处移植的 SOURCE/TARGET/WHY/LICENSE/MODIFICATIONS。纯文档，无代码。

## 文件变更

### 新增 `docs/third-party/reasonix.md`

内容模板（按实际移植范围填写，不得删减版权声明）：

```markdown
# Reasonix-derived components

Portions of the DeepSeek cache optimization implementation are adapted from:

## DeepSeek-Reasonix
- Repository: https://github.com/esengine/DeepSeek-Reasonix
- License: MIT

MIT License
Copyright (c) 2026 Reasonix Contributors
<MIT notice 全文>

## pi-reasonix
- Repository: https://github.com/TheTrebor/pi-reasonix （按其 README 记录）
- License: MIT

MIT License
Copyright (c) 2026 TheTrebor
<MIT notice 全文>

## 移植清单
| Source | Target | Why | Modifications |
|---|---|---|---|
| DeepSeek-Reasonix internal/provider/schema_canonicalize.go | packages/ai/src/api/schema-canonicalize.ts | 唯一成熟的 JSON Schema 规范化实现，Pi 缺失 | Go→TS，去除 JSON 字节层，对象键排序 |
| DeepSeek-Reasonix internal/agent/cache_shape.go | packages/coding-agent/src/core/prefix-shape.ts | 前缀诊断三段 hash | Go→TS，仅 system/tools 两段，接入 Pi 类型 |
| DeepSeek-Reasonix internal/config/cache_policy.go | packages/coding-agent/src/core/cache-policy.ts | DeepSeek 24h TTL 策略 | Go→TS，单位毫秒，host 精确匹配 |
| pi-reasonix 扩展事件接线思路 | （仅参考，未复制代码） | 了解 Pi 扩展事件用法 | — |
```

### 移植文件头注释模板（Step 2/4 的文件用）

```ts
/**
 * Adapted from DeepSeek-Reasonix <原始相对路径>
 * (MIT, Copyright (c) 2026 Reasonix Contributors).
 * See docs/third-party/reasonix.md for the full notice and modification notes.
 */
```

### `packages/ai/CHANGELOG.md` 与 `packages/coding-agent/CHANGELOG.md`

在各自 `## [Unreleased]` 的 `### Added` 下追加一行（按 AGENTS.md 规则先读现有 Unreleased 段，追加不重复）：
- ai：`Added canonical tool schema serialization and DeepSeek prompt-cache compatibility fixes.`
- coding-agent：`Added prompt-cache prefix diagnostics and cache TTL policy.`

（实现各步骤时顺手更新，不单独开 commit 也行；若实现者选择在各步骤内完成，本步只负责 reasonix.md。）

## 验收

- `docs/third-party/reasonix.md` 存在，含两份 MIT notice 全文与移植清单。
- 每个移植文件头部有来源注释。
- 无 emoji、技术行文（AGENTS.md 风格规则）。

## 风险

无。纯文档。
