# Step 5 — 系统提示词稳定化

## 目标

同一会话内，无论是否有动态任务计划，system prompt 在轮与轮之间**字节一致**；动态任务投影改放 user 消息（已获用户确认的行为变化）。本步最敏感，必须先完成 Step 4 的诊断能力再动手。

## 背景事实（已核实）

- `packages/coding-agent/src/core/system-prompt.ts` `buildSystemPrompt`：`toolsList` 按 `selectedTools` 传入顺序输出（L107-110）；尾部追加 `Current working directory: ...`（会话内稳定，可接受）；`executionContract` 来自 Document Runtime，文件未变时内容稳定（需诊断确认，不改代码）。
- `packages/coding-agent/src/core/agent-session.ts:1549` `_rebuildSystemPrompt(toolNames)`：`validToolNames` 按传入顺序 → `selectedTools` → 影响 prompt 内工具列表顺序。
- **动态任务投影是已确认的每轮抖动源**：`agent-session.ts:965-971`（`_installAgentNextTurnRefresh`）与 `:1883-1884`（`prompt()`）都把 `taskProjection` 拼进 system prompt：`` `${baseSystemPrompt}\n\n${taskProjection}` ``。投影内容来自 `dynamic-task-runtime.ts:412` `getPromptProjection`——每轮包含 `<dynamic_tasks revision="N">`，revision 随 tasks_update 变化 → system prompt 每轮变 → 前缀整体失效。这是"几乎没有缓存命中"的最大嫌疑（本会话自身就处于该场景）。
- `prompt()` 的用户消息构造点在 `agent-session.ts:1843-1857`（`userContent` 数组，其后还有 `_pendingNextTurnMessages` 注入）。
- 测试基建：`packages/coding-agent/test/suite/dynamic-task-session.test.ts` 已捕获 `firstSystemPrompt` / `secondSystemPrompt`（harness + faux provider，无真实 API）。

## 文件变更

### 1. `packages/coding-agent/src/core/system-prompt.ts` — 工具列表排序

`buildSystemPrompt` 内（约 L106）：

```ts
// 改前
const tools = selectedTools || ["read", "bash", "edit", "write"];
// 改后
const tools = [...(selectedTools ?? ["read", "bash", "edit", "write"])].sort();
```

纯函数内排序，测试直接覆盖，不依赖 AgentSession 实例。默认工具组顺序变为 `["bash","edit","read","write"]`（纯展示顺序，无语义影响）。

### 2. `packages/coding-agent/src/core/agent-session.ts` — 投影移出 system prompt

**改动点 A（`prompt()`，约 L1882-1884）**：

```ts
// 改前
const taskProjection = this.dynamicTaskRuntime?.getPromptProjection({ consumeReminder: true });
this.agent.state.systemPrompt = taskProjection ? `${baseSystemPrompt}\n\n${taskProjection}` : baseSystemPrompt;
// 改后
this.agent.state.systemPrompt = baseSystemPrompt;
const taskProjection = this.dynamicTaskRuntime?.getPromptProjection({ consumeReminder: true });
if (taskProjection) {
    userContent.push({ type: "text", text: taskProjection });
}
```

（`userContent` 在同函数上文 L1844 定义，投影作为该 user 消息的第二个 text block，位于用户原文之后。`consumeReminder: true` 保持。）

**改动点 B（`_installAgentNextTurnRefresh`，约 L965-971）**：

```ts
// 改前
context: {
    ...previousContext,
    systemPrompt: taskProjection ? `${baseSystemPrompt}\n\n${taskProjection}` : baseSystemPrompt,
    tools: this.agent.state.tools.slice(),
},
// 改后
context: {
    ...previousContext,
    systemPrompt: baseSystemPrompt,
    messages: taskProjection
        ? [
              ...previousContext.messages,
              { role: "user", content: [{ type: "text", text: taskProjection }], timestamp: Date.now() },
          ]
        : previousContext.messages,
    tools: this.agent.state.tools.slice(),
},
```

（追加到 messages 尾部 = append-only，历史前缀不被改写；`consumeReminder: true` 保持。）

**已知副作用（接受）**：有动态任务计划的会话，agent 内部轮次会在 transcript 中多出一条 user 消息展示任务状态。无任务计划时 `getPromptProjection` 返回 `undefined`，零影响。普通 user 消息路径的投影不可见（并入原文消息）。

### 3. 不改的部分（明确边界）

- 不动 `getPromptProjection` 的生成逻辑与 `<dynamic_tasks>` 文本。
- 不动 Document Runtime 的 execution contract 刷新逻辑（用 Step 4 诊断确认它文件未变时稳定即可）。
- 不动 cwd 段（会话内恒定）。
- 不动 agent loop / session 结构 / compaction。

## 测试

### `packages/coding-agent/test/system-prompt.test.ts` 追加

1. `sorts selectedTools alphabetically`：传入 `selectedTools: ["write","read","bash"]` + 对应 `toolSnippets` → 断言 prompt 中 `- bash:` 出现在 `- read:` 之前、`- read:` 在 `- write:` 之前。
2. `deterministic output for same options`：同参数两次调用 → 全等字符串。

### `packages/coding-agent/test/suite/dynamic-task-session.test.ts` 追加（用现有 harness 模式）

3. `task projection does not enter system prompt`：tasks_update 初始计划后触发第二轮 provider 请求 → `secondSystemPrompt === firstSystemPrompt`，且两者都不含 `<dynamic_tasks`。
4. `task projection is appended to user message`：第二轮请求的 user 消息文本含 `<dynamic_tasks revision=`。
5. `projection consumes refresh reminder once`（回归保护）：reminder 不跨轮重复出现（对应 `consumeReminder` 语义）。

若现有 suite 用例有断言 system prompt 含 `<dynamic_tasks` 的，同步更新断言（这是本步骤的目的）。

## 验证命令

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/system-prompt.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/suite/dynamic-task-session.test.ts
cd ../..
./test.sh
npm run check
```

## 风险与回滚

- 风险：中。system prompt 内容变化会轻微影响所有 provider 的输出风格；投影位置变化影响任务计划会话的模型行为。缓解：`./test.sh` 全量 + 手工 5 轮真实会话验证任务计划仍正常推进。
- 回滚：revert 本 commit（两处函数改动，互不牵连）。

## 验收

- 上述测试全绿、`./test.sh` 通过、`npm run check` 通过。
- 真实会话验证（配合 Step 1 基线对比）：连续 5+ 轮、含任务计划会话，footer `Cached: N (X%)` 从第 3 轮起稳定 ≥ 80%；用 Step 4 的 `capturePrefixShape` 确认 systemHash 跨轮不变。
