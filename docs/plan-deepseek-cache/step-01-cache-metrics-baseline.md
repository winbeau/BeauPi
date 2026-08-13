# Step 1 — 命中率基线测量

## 目标

确认 DeepSeek 的缓存命中数据能正确解析并可见，为后续步骤建立"改造前 vs 改造后"对比基线。不改任何行为，只加测试。

## 背景事实（已核实）

- `packages/ai/src/api/openai-completions.ts:1315` `parseChunkUsage` 已把 `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` 映射为 `cacheRead`，`input = prompt - hit - write`。DeepSeek 返回 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，命中侧已解析，miss 侧由 `input` 推导（等价）。
- TUI footer 已有展示：`packages/coding-agent/src/modes/interactive/interactive-mode.ts:6296-6307`，当 `cacheRead > 0` 时显示 `Cached: N tokens (X%)`。
- 现有测试骨架可直接复用：`packages/ai/test/openai-completions-prompt-cache.test.ts`（`vi.mock("openai")` + `captureRequest` 模式）。

## 文件变更

### 新增 `packages/ai/test/openai-completions-deepseek-cache.test.ts`

复制 `openai-completions-prompt-cache.test.ts` 的 mock 骨架（`vi.hoisted` + `FakeOpenAI`），模型用 `getModel("deepseek", "deepseek-v4-flash")`（来自 `packages/ai/src/compat.ts`，返回真实 catalog 数据）。

用例列表：

1. `parses prompt_cache_hit_tokens into usage.cacheRead`
   - mock 流最后一 chunk 带 `usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }`
   - 断言最终 assistant 消息 `usage.cacheRead === 800`、`usage.input === 200`、`usage.totalTokens === 850`
2. `parses prompt_tokens_details.cached_tokens when hit field absent`（OpenAI 风格字段，覆盖现有分支不回归）
3. `derives input as prompt minus hit when miss field absent`（DeepSeek 旧响应只有 hit 字段）
4. `default short retention sends no prompt_cache_key for deepseek`（记录现状：默认行为不发送 key，属预期，DeepSeek 缓存是自动前缀匹配）
5. `sends thinking type deepseek when reasoning enabled`（仅记录基线，防止后续改动回归）
6. `assistant replay includes empty reasoning_content`（`requiresReasoningContentOnAssistantMessages` 基线回归测试：context 里放一条带 tool_calls 的 assistant 消息，断言请求 payload 中该消息含 `reasoning_content: ""`）

## 验收

- 新测试文件在 `packages/ai` 下通过：
  `node ../../node_modules/vitest/dist/cli.js --run test/openai-completions-deepseek-cache.test.ts`
- 手工基线：启动 TUI 用 DeepSeek 连跑 5 轮对话，记录每轮 footer 的 `Cached: N (X%)`。预期现状：命中很低或为 0（这就是要修的问题）。把数字记到 step-05 的验收对比里。

## 风险

无。纯新增测试，不触碰实现。

## 回滚

删除该测试文件即可。
