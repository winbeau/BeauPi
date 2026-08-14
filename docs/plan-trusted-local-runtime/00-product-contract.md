# Step 00：产品契约与实施规则

## 状态

设计完成，未实现。本步骤用于冻结决策，不直接改代码。

## 1. 目标

将后续实现切换到用户确认的 trusted-local 产品目标：BeauPi 不提供工具授权；Core Policy 删除；Shell 同权同环境；不做 Web/MCP。

## 2. 必须保留

- createAgentSession、CLI/TUI、print、JSONL RPC、SDK 入口。
- read、write、edit、bash、remote、search、workflow、background、custom tool 不由 Core Policy 拦截。
- getShellEnv/spawn 的环境继承语义；不将 inheritEnv false 变为默认。
- Extension 继续是 trusted in-process TypeScript；本计划不伪造进程隔离。
- 树形 Session、branch/leaf、Compaction、Task/Workflow/Background 继续使用现有模型。

## 3. 必须删除

- PolicyRuntime 的 authorizeTool、wrapTool、finalizeTool、noteThrownError 运行时流程。
- PolicyAction 的 block/confirm/replace/pause 当前决策语义。
- PolicyInteractionHandler、policyHandler、policyInteractionMode、policyConfirm RPC/UI。
- requiresConfirmation、sensitive path、workspace-outside、failure budget 等 Core Policy advisory。
- beaupi.policy.fact 和 PolicyToolDetails 作为 Session/TaskLedger 事实源。

## 4. 名称规则

- PolicyFailureCategory → ExecutionFailureCategory（仅在确实需要失败分类时保留）。
- BashToolExecutionError.policyCategory → failureCategory。
- inspectShellPrivilege/hasPotentialShellPrivilege → core/privilege/shell-inspection.ts；它们是 sudo 路由识别，不是授权。
- PolicyToolDetails 不改名继续存在；应删除，不能保留伪装成中性的 Policy details。
- policy 这个词在 Playwright network policy、cache policy、Skill filtering 等独立功能中可保留，但逐项确认。

## 5. Step 05 分支

### 05A：保留 M13

普通工具无 Core Policy 授权；sudo 仍由独立 PrivilegeRuntime 执行 Enter/interaction/user-presence。这是 TTY UX，不称为 Policy authorization。

### 05B：完全同权无交互

删除 PrivilegeRuntime、privileged_exec 和 sudo 自动路由。所有 Shell 文本直接交给普通 executor；Agent 与用户完全相同。

在没有明确选择前，Step 03/04 只清除 Core Policy，不擅自删除 M13。

## 6. 非目标

本计划不引入 authorization、approval、capability gate、sandbox、root restriction、Web/MCP、网络 RPC auth、默认 timeout 或环境变量策略改变。

## 7. 验收

- 实现对话开始前明确引用本文件中的 A/B 选择。
- 后续实现不出现顺便添加安全限制的未批准改动。
