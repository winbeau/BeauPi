# Step 2 — 稳定工具序列化（核心）

## 目标

相同工具集合，无论注册顺序、schema 键序如何，序列化到 wire 的 `tools` 数组**逐字节一致**。全局生效（所有走 openai-completions 的 provider）。

## 背景事实（已核实）

- `packages/ai/src/api/openai-completions.ts:1278` `convertTools(tools, compat)`：`tools.map(...)` 按 `context.tools` 插入顺序输出，`parameters` 原样透传，无任何规范化。两处调用点：`buildParams` 的 active tools（L721）与 kimi deferred tools（L1263）。
- `strict` 判定（`resolveJsonSchemaStrictSampling`，`constrained-sampling.ts:84`）只读 `tool.constrainedSampling` 配置，与 `parameters` 内容无关 → 规范化不影响 strict 逻辑。
- grammar 工具分支不输出 `parameters` → 规范化对它是 no-op。
- 移植来源：DeepSeek-Reasonix `internal/provider/schema_canonicalize.go`（140 行，MIT）。其算法已逐行审计，语义保持。
- Pi 侧 `tool.parameters` 已是 JS 对象（TypeBox schema），不需要 Go 版的 JSON 字节解析层。

## 文件变更

### 1. 新增 `packages/ai/src/api/schema-canonicalize.ts`

文件头注释（模板见 step-06）：

```ts
// Adapted from DeepSeek-Reasonix internal/provider/schema_canonicalize.go
// (MIT, Copyright (c) 2026 Reasonix Contributors)
```

导出：

```ts
export function canonicalizeToolSchema(raw: unknown): unknown
```

算法（Go → TS 逐条对应）：

1. `raw === undefined || raw === null` → 返回 `{ properties: {}, type: "object" }`（键按字母序：properties 在 type 前）。
2. `raw` 为数组 → 逐元素递归。
3. `raw` 为普通对象 → `canonicalizeObject`：
   - 对键 `properties` / `patternProperties` / `$defs` / `definitions` / `dependentSchemas`：值若为对象，对其每个子 schema 递归；否则整体递归。
   - 键 `dependentRequired`：值必须是普通对象，否则删除；对象内每个值是数组则按 `JSON.stringify` 比较排序，非数组删除该键。
   - 键 `required`：是数组 → 按 `JSON.stringify` 比较排序；不是数组 → 删除该键（OpenAPI 风格 `"required": true` 会拖垮整个 tool 列表）。
   - 其余键：值递归。
   - 最后重排键序：`Object.fromEntries(Object.entries(obj).sort())`（键名字典序，含 `$`、大小写，用默认字符串比较即可，保证确定性）。
4. 根对象处理（对应 Go `ensureRootObjectProperties`）：递归后若无 `type` → 补 `"object"`；若 `type === "object"` 且无 `properties` → 补 `{}`。显式非 object 根类型（如 `{"type":"string"}`、boolean schema）不补、不改语义，原样返回（已重排键序）。
5. 其余原始值（string/number/boolean）→ 原样返回。

关键性质（必须用测试锁死）：
- 幂等：`canonicalize(canonicalize(x))` 深等于 `canonicalize(x)`。
- 键序不变性：两个只有键序不同的输入 → 完全相同的输出。
- 语义保持：不删除任何合法 schema 信息（唯一"删除"是非法 `required`/`dependentRequired` 形态，与 donor 一致）。

### 2. 修改 `packages/ai/src/api/openai-completions.ts`

- `convertTools`（L1278）改两处：
  1. 函数开头：`const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));`（**不原地排序**，不 mutate `context.tools`），后续 `map` 遍历 `sorted`。
  2. function 分支的 `parameters: canonicalizeToolSchema(tool.parameters) as Record<string, unknown>`（替换现在的原样透传）。
- 顶部新增导入：`import { canonicalizeToolSchema } from "./schema-canonicalize.ts";`（顶层导入，禁止 inline import）。
- grammar 分支不动。

## 测试

### 新增 `packages/ai/test/schema-canonicalize.test.ts`

移植 donor `schema_canonicalize_test.go` 的用例矩阵，加键序用例：

1. `empty object becomes {properties:{},type:"object"}`：输入 `{}`、`undefined`、`null` 三种 → 输出一致。
2. `missing root type gets object type`：`{properties:{a:{type:"string"}}}` → 输出含 `type:"object"`。
3. `required array is sorted and invalid required removed`：`{type:"object",required:["b","a"],properties:{...}}` → `required:["a","b"]`；`required: true` → 键被删除。
4. `dependentRequired arrays sorted, non-object entries removed`：混合合法/非法输入。
5. `property named "required" inside properties is not confused`：`{properties:{required:{type:"string"}}}` → 内层 `required` 属性保留为普通 schema 属性（递归路径隔离）。
6. `nested defs, definitions, patternProperties, dependentSchemas are canonicalized`：嵌套对象键序也被重排。
7. `legacy tuple items array is recursed, not mangled`：`items:[...]` 数组逐元素递归。
8. `explicit non-object root type is preserved without properties`：`{type:"string"}` → 无 `properties` 键。
9. `boolean schema passes through`：`true` / `false` 原样。
10. `idempotence`：对一组代表性 schema，二次规范化深等于一次规范化。
11. `key order invariance`：同一 schema 的两种键序写法 → 深等于同一输出。
12. `primitives pass through`：字符串/数字原样。

### 新增（或追加到）`packages/ai/test/openai-completions-tool-choice.test.ts`

复用其 `vi.mock("openai")` 骨架，新增 describe：

1. `sorts tools by name in payload regardless of registration order`：两个注册序（`["zeta","alpha"]` 与 `["alpha","zeta"]`）的 context → 捕获 payload，`params.tools` 名称序都是 `["alpha","zeta"]`。
2. `canonicalizes parameters key order on the wire`：同一工具 schema 两种键序 → 两次请求的 `JSON.stringify(params.tools)` 完全相等。
3. `strict flag survives canonicalization`：带 `constrainedSampling` 的 json_schema 工具 → `strict: true` 仍在，且 schema 已规范化。
4. `grammar tools are unaffected`：grammar 工具输出仍为 `type:"custom"`，无 `function.parameters`。

## 验证命令

```bash
# 包目录内跑两个相关测试
cd packages/ai
node ../../node_modules/vitest/dist/cli.js --run test/schema-canonicalize.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/openai-completions-tool-choice.test.ts
# 回到 repo 根：全量非 e2e + check
cd ../..
./test.sh
npm run check
```

## 风险与回滚

- 风险：所有 openai-completions provider 的 `tools` 数组顺序和 schema 字节变化。语义保持（排序+规范化），但若个别 provider 对工具顺序敏感（理论上不应），test.sh 会暴露。
- 若某现有测试断言了旧顺序/旧字节：更新断言（这是本步骤的目的），不要反向恢复旧行为。
- 回滚：revert 本 commit（新增文件 + 一处函数改动）。

## 验收

- 上述 4 条测试命令全绿。
- `npm run check` 无 error/warning/info。
