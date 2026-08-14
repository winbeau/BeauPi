# Step 01：Core Policy 依赖盘点与迁移清单

## 状态

设计完成，未实现。实现本步骤的目标是完成可复核的依赖清单；可先只提交清单或测试 fixture，不删除代码。

## 1. Core Policy 范围

待删除的核心目录：

- packages/coding-agent/src/core/policy/index.ts
- packages/coding-agent/src/core/policy/config.ts
- packages/coding-agent/src/core/policy/types.ts
- packages/coding-agent/src/core/policy/classifier.ts
- packages/coding-agent/src/core/policy/policy-runtime.ts

核心符号：

- PolicyRuntime、PolicyAuthorization
- PolicyAction、PolicyDecision
- PolicyToolDetails、PolicyAdvisory
- PolicyConfirmRequest/Response/Result、PolicyInteractionHandler
- POLICY_DETAILS_KEY、POLICY_FACT_ENTRY_TYPE
- classifyPolicyOperation、classifyPolicyFailure、policyFailureLimit
- policyShellPathReferences、policyPathRequiresConfirmation
- inspectShellPrivilege、hasPotentialShellPrivilege（先迁移，不能直接删除）

## 2. 已知消费者

| 区域 | 位置 | 迁移方向 |
|---|---|---|
| Session service | packages/coding-agent/src/core/agent-session-services.ts | 删除 PolicyRuntime 创建、字段和传递 |
| SDK | packages/coding-agent/src/core/sdk.ts | 删除 policy options、handler、mode、runtime 注入 |
| AgentSession | packages/coding-agent/src/core/agent-session.ts | 删除字段、订阅、wrap、authorize/finalize/fact 逻辑 |
| Settings | packages/coding-agent/src/core/settings-manager.ts | 删除 PolicySettings、字段和 getter |
| Agent pool | packages/coding-agent/src/core/agents/agent-pool.ts | 删除 policySettings 复制和 child option |
| Task Ledger | packages/coding-agent/src/core/state/task-ledger.ts | 删除 policy projection/records/facts；保留中性 execution records |
| Bash | packages/coding-agent/src/core/tools/bash.ts | 迁移 failure category；移除 Core Policy import |
| Bash executor | packages/coding-agent/src/core/bash-executor.ts | 移除 PolicyToolDetails 字段；使用中性结果 |
| Remote | packages/coding-agent/src/core/remote/runtime.ts、remote/tools.ts | 从新 shell-inspection 模块导入 |
| Privilege | packages/coding-agent/src/core/privilege/runtime.ts | 从新 shell-inspection 模块导入 |
| UI | modes/interactive/components/footer.ts、tool-execution.ts | 删除 advisory/action 展示和 no-op setter |
| RPC | modes/rpc/rpc-types.ts、rpc-mode.ts | 删除 policyConfirm request/response |
| Exports | core/index.ts、src/index.ts | 删除 Core Policy exports |
| Tests | packages/coding-agent/test/*policy*、test/suite/policy-session.test.ts | 删除或重写为 neutral execution tests |
| Docs | docs/beaupi/architecture.md、M13 docs、SDK docs | 删除 Policy Engine 章节和授权暗示 |

## 3. 不要误删的独立功能

全局搜索到 policy 不等于 Core Policy。默认保留并单独审查：

- packages/coding-agent/src/core/cache-policy.ts；
- packages/coding-agent/src/core/playwright/network-policy.ts；
- Skill allow/deny filtering；
- 外部容器化文档中的 policy-controlled sandbox；
- 其他明确属于独立子系统的 policy 字段。

若要连这些独立 policy 删除，另开范围明确的计划；本计划不猜测。

## 4. 盘点输出

实现后应有：

1. 符号到替代模块的迁移表；
2. 待删除文件列表；
3. 测试迁移表（delete/rewrite/retain）；
4. 保留的 policy 名称说明；
5. 一次全仓库 grep 结果作为验收基线。

## 5. 验收

- 每个 Core Policy import 有明确替代或删除动作。
- inspectShellPrivilege 和 hasPotentialShellPrivilege 已标记为必须迁移。
- 没有把 Playwright network policy 或 cache policy 误列为 Core Policy 删除对象。
