# DeepSeek 缓存命中率迁移计划（主索引）

> 状态：审计完成，详细设计完成，等待实现。
> 用途：本文件是总览；每个步骤的详细设计见 `docs/plan-deepseek-cache/step-0X-*.md`，实现时按顺序读对应文件。

## 已确认的决策

1. **工具排序全局生效**：`convertTools` 按工具名排序 + schema 规范化，不区分 provider。
2. **taskProjection 移出 system prompt**：动态任务投影改放 user 消息，system prompt 保持纯净（接受行为变化）。

## 背景（大白话）

DeepSeek 缓存规则：请求开头（前缀）必须和之前某次请求**逐字节相同**才命中。
每轮请求 = `[系统提示词] → [工具定义] → [历史] → [新内容]`，前缀抖动 = 从抖动点往后全部重新计费。
现在几乎不命中的三个根因：工具定义没排序没规范化、系统提示词混入每轮变化的动态任务投影、没有任何诊断。

## 实施步骤

| 步骤 | 内容 | 涉及包 | 估时 | 依赖 | 设计文档 |
|---|---|---|---|---|---|
| 1 | 命中率基线测量 | ai | 30 分钟 | 无 | [step-01](plan-deepseek-cache/step-01-cache-metrics-baseline.md) |
| 2 | 稳定工具序列化（核心） | ai | 1-2 小时 | 无 | [step-02](plan-deepseek-cache/step-02-stable-tool-serialization.md) |
| 3 | DeepSeek compat 元数据修正 | ai | 15 分钟 | 无 | [step-03](plan-deepseek-cache/step-03-deepseek-compat-metadata.md) |
| 4 | 前缀诊断模块 + TTL 策略 | coding-agent | 1 小时 | 无 | [step-04](plan-deepseek-cache/step-04-prefix-diagnostics.md) |
| 5 | 系统提示词稳定化 | coding-agent | 半天 | 4（诊断先行） | [step-05](plan-deepseek-cache/step-05-system-prompt-stabilization.md) |
| 6 | 来源归属文档 | docs | 15 分钟 | 2/4 | [step-06](plan-deepseek-cache/step-06-attribution.md) |

## 通用守则（每步都适用）

- 每步一个 commit；回滚 = revert 该 commit；步骤间无相互破坏的依赖（1-4 可并行）。
- 代码改动后必须 `npm run check`（repo 根）。
- 测试：单文件用 `node ../../node_modules/vitest/dist/cli.js --run test/xxx.test.ts`（包目录内）；非 e2e 全量用 `./test.sh`（repo 根）。禁止 `npm test`。
- 第 5 步完成前不碰：agent loop、session 结构、compaction 逻辑。
- 移植代码必须带来源注释（SOURCE/WHY/LICENSE），模板见 step-06。
- 最终目标：同会话第 3 轮起缓存命中率 ≥ 80%，且能解释每次未命中的原因。

## 里程碑验收

- Step 1+2+3 完成：`packages/ai` 全部测试通过，DeepSeek 请求的 tools 字节确定且稳定。
- Step 4 完成：有前缀变化诊断能力（system/tools 哈希 + 原因）。
- Step 5 完成：同一会话多轮 system prompt 字节一致（含动态任务计划会话）；`./test.sh` 通过。
- 全部完成：真实会话连续 5 轮以上，footer 显示 Cached 比率稳定上升。
