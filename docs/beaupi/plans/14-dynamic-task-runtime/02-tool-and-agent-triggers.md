# 02 Tool 与 Agent Triggers

状态：已完成。

## 目标

注册 Coordinator-only `tasks_update`，让主 Agent在可执行用户任务的现有首次模型回合创建计划；纯问答和闲聊不要求计划，不启动额外预规划模型请求。

## Tool schema

`tasks_update` 参数：

```typescript
interface TasksUpdateInputV1 {
  version: 1;
  expectedRevision: number;
  reason: "initial_plan" | "work_started" | "plan_changed" | "blocked";
  goal: string;
  tasks: Array<{
    id: string;
    title: string;
    status: DynamicTaskStatus;
    dependsOn?: string[];
    matchHints?: string[];
    activity?: string;
    blockedBy?: string[];
  }>;
}
```

规则：

- `initial_plan` 只允许在无计划且 `expectedRevision: 0` 时创建。
- 其他 reason 需要已有计划并匹配 revision。
- Tool result 返回版本化 details、最新 snapshot、actual revision 和 diagnostics。
- Tool 不接受 Reviewer patch，不从 assistant 普通文本解析 JSON。
- `executionMode: "sequential"`；renderer 只读取 details。

## 动态 Tool registry

`tasks_update` 必须提供：

- name、label、description、TypeBox parameters。
- `promptSnippet`，使其进入 Available tools。
- prompt guidelines：主 Agent结构唯一作者、首次计划、重大更新、3–7 Task、禁止文件/命令粒度 Todo。
- `renderCall`/`renderResult`，显示 reason、revision、完成数或冲突诊断。

Coordinator 默认激活；`noTools: "builtin"` 或明确 denylist 可关闭。受控子 Agent无论 profile/custom allowlist 如何都硬排除：

- AgentPool reserved Tool names。
- child `excludeTools`。
- child Session 禁用 Dynamic Task trigger/runtime reviewer。

## 用户任务触发

`DynamicTaskRuntime.beginUserPrompt(text)` 使用保守的确定性分类：

- 明确实现、修复、修改、创建、调试、运行检查、调查或部署请求 => executable。
- 纯解释、定义、闲聊、简短事实问答 => non-executable。
- 分类只控制 prompt reminder，不自动创建 Task，也不阻止模型自行判断。

首次 Provider 请求前投影：

- executable + 无计划：要求本回合调用一次 `tasks_update(reason: "initial_plan")`，允许先粗粒度计划后只读 discovery。
- non-executable + 无计划：不显示 Todo requirement。
- 已有计划 + 新 executable 用户要求：提醒检查范围变化，必要时 `plan_changed`。

不调用独立模型分类器，不插入用户可见 JSON，不要求用户复制结构化数据。

## 首次动工

在 AgentSession现有 `beforeToolCall` 路径：

- Edit/Write 直接视为确定性 mutation。
- Bash/remote Bash/terminal Bash 复用 Policy classifier 的 `workspaceMutation`，不复制 shell parser。
- Runtime 尝试激活最匹配的可运行 pending Task；匹配使用 task title、matchHints、路径和命令短摘要。
- 无计划、无匹配或 Runtime 失败均不阻断 Tool。
- 自动激活后设置一次性 `task refresh` reminder，下一 Provider 请求要求主 Agent按需调用 `work_started`/`plan_changed`。

## 文件范围

新增：

- `packages/coding-agent/src/core/tasks/tools.ts`
- `packages/coding-agent/src/core/tasks/prompt-trigger.ts`

修改：

- `packages/coding-agent/src/core/tools/index.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/agents/agent-pool.ts`
- 必要的公共 index export。

## 失败回归

先新增/修改：

- `packages/coding-agent/test/dynamic-task-tools.test.ts`
- `packages/coding-agent/test/agent-session-dynamic-tools.test.ts`
- `packages/coding-agent/test/suite/dynamic-task-session.test.ts`
- `packages/coding-agent/test/suite/agent-session-prompt.test.ts`

覆盖 Tool metadata、严格参数、四种 reason、Coordinator-only、无额外 Provider call、纯问答不要求计划、首次 mutation 不阻断。

## 完成条件

- 主 Agent可在同一现有 turn内提交初始计划。
- 受控子 Agent无法看到或调用 `tasks_update`。
- 纯问答不创建 Runtime snapshot/Todo。
- 主 Agent忘记后续更新时 mutation 仍执行，下一请求收到短 reminder。
