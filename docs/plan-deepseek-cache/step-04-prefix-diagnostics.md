# Step 4 — 前缀诊断模块 + TTL 策略

## 目标

能回答三个问题：前缀 hash 是什么、哪一段变了（system / tools / 内容重写）、为什么这一轮没命中。纯诊断、只读，不改任何 wire 行为。这是 Step 5 动手改 system prompt 之前的必要观测工具。

## 背景事实（已核实）

- 移植来源：DeepSeek-Reasonix `internal/agent/cache_shape.go`（126 行，MIT）：`PrefixShape`（system/tools/prefix 三段短 SHA-256）+ `CompareShape`（输出变化原因列表）+ `normalizeToolSchemas`（按 name/description/parameters 排序）+ `estimateTokens`（~4 字符/token）。
- 移植来源：`internal/config/cache_policy.go`（64 行，MIT）：`DefaultCacheTTL` 按 host 精确匹配（`api.deepseek.com`/`*.deepseek.com` → 24h；dashscope/anthropic → 5m；未知 → 24h）。
- Pi 现有可挂接点：`packages/coding-agent/src/core/cache-stats.ts`（跨轮 miss 统计已存在，`CACHE_TTL_MS` 常量固定 5min，L10）。
- 规则约束：erasable TS、顶层导入（`node:crypto` 的 `createHash` 在顶部导入）、无 enum。

## 文件变更

### 1. 新增 `packages/coding-agent/src/core/prefix-shape.ts`

文件头注释（模板见 step-06）。设计：

```ts
import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";

export interface PrefixShape {
  systemHash: string;
  toolsHash: string;
  prefixHash: string;
  toolSchemaTokens: number;
}

export function capturePrefixShape(systemPrompt: string, tools: Tool[]): PrefixShape
export function comparePrefixShape(prev: PrefixShape | undefined, cur: PrefixShape): string[]
// 返回变化原因：["system"] | ["tools"] | []（首个调用返回 []）
```

实现要点：
- `shortHash(v: string): string` = `createHash("sha256").update(v).digest("hex").slice(0, 16)`（donor 取 8 字节 → 16 hex 字符）。
- `toolsHash` 输入是 `JSON.stringify(normalizedTools)`；`normalizedTools` = 工具按 `name`、`description`、`JSON.stringify(parameters)` 三元组排序后的浅拷贝（**不原地排序**）。
- `prefixHash = shortHash(systemHash + toolsHash)`。
- `toolSchemaTokens = Math.floor(toolsJson.length / 4)`（byte 长度估算，仅诊断）。
- `comparePrefixShape`：prev 为空 → `[]`；`prev.systemHash !== cur.systemHash` → 加 `"system"`；tools 同理。content 改写原因（compaction 等）由调用方传入追加，本模块只算 system/tools 两段。

### 2. 新增 `packages/coding-agent/src/core/cache-policy.ts`

移植 `DefaultCacheTTL`：

```ts
export function defaultPromptCacheTtlMs(baseUrl: string | undefined): number
// host 精确匹配（URL 解析后取 host，不子串匹配整串 URL）：
// dashscope.aliyuncs.com / *.dashscope.aliyuncs.com / *.maas.aliyuncs.com → 5 * 60_000
// api.anthropic.com / *.anthropic.com → 5 * 60_000
// api.deepseek.com / *.deepseek.com → 24 * 60 * 60_000
// 未知/undefined → 24 * 60 * 60_000
```

注意 donor 注释的语义：TTL 只影响冷恢复观测与提示，**绝不用来主动改写历史**——移植时把这个原则写进 doc 注释。

### 3. `packages/coding-agent/src/core/cache-stats.ts`（可选接线，本步可不做）

`CACHE_TTL_MS` 目前固定 5min 且无 baseUrl 上下文；接线需要把 model 的 baseUrl 传入 scan。**本步不接线**，只在 cache-policy.ts 顶部 doc 注明"Step 5 之后由 idle-gap 提示接入"。若实现者想顺手接线：`detectMiss` 的 `idleMs` 阈值改用 `defaultPromptCacheTtlMs(models.getModel(...)?.baseUrl)`——需要给 `ModelPriceSource.getModel` 返回值增加 `baseUrl` 字段，改动面变大，建议放到后续独立 commit。

## 测试

### 新增 `packages/coding-agent/test/prefix-shape.test.ts`

1. `capture is deterministic`：相同输入两次 → 三个 hash 全等。
2. `tool order does not change toolsHash`：同一工具集两种注册序 → toolsHash 相同（normalizedTools 排序后的效果）。
3. `system change reports ["system"]`：只改 systemPrompt → comparePrefixShape 输出 `["system"]`。
4. `tools change reports ["tools"]`：增删工具或改 schema → `["tools"]`。
5. `first call has no reasons`：prev 为 undefined → `[]`。
6. `toolSchemaTokens is byte-based estimate`：长 schema 估算值大于短 schema（不断言精确值）。

### 新增 `packages/coding-agent/test/cache-policy.test.ts`

1. `deepseek hosts map to 24h`：`https://api.deepseek.com`、`https://custom.deepseek.com/v1` → 24h。
2. `anthropic and dashscope map to 5m`。
3. `unknown hosts default to 24h`：`https://example.com`、`undefined`。
4. `substring lookalikes do not match`：`https://notdeepseek.com.evil.example.com` → 未知分支（host 后缀匹配 `*.deepseek.com` 不应命中 `evil.example.com`）。

## 验证命令

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/prefix-shape.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/cache-policy.test.ts
cd ../..
npm run check
```

## 风险与回滚

- 风险：无。两个新模块未被任何运行时路径调用（纯新增 + 测试），零行为变化。
- 回滚：删除两个新文件即可。

## 验收

- 测试全绿、`npm run check` 通过。
- 输出物可用于 Step 5 的"先诊断"：在真实会话里对每轮打印 capturePrefixShape（临时脚本放 /tmp，用后删除，符合 AGENTS.md 临时脚本规则），确认 system 段是否每轮变化。
