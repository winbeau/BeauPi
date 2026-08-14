# Step 01 盘点报告：Core Policy 依赖与迁移清单

> 状态：已完成（只盘点，未删除任何代码）。
> 基线：`git status` 干净，仅存在未跟踪的计划文档；本步骤未修改任何源码/测试/文档。
> 仓库：/home/winbeau/Projects/pi

## 1. Core Policy 范围确认

待删除目录（5 个文件，2778 行）：

- `packages/coding-agent/src/core/policy/index.ts`（51 行，全部导出）
- `packages/coding-agent/src/core/policy/config.ts`（82 行：DEFAULT_POLICY_BUDGET、DEFAULT_POLICY_SENSITIVE_PATHS、resolvePolicyConfig、createPolicyConfigProvider）
- `packages/coding-agent/src/core/policy/types.ts`（289 行：PolicyToolDetails、PolicyConfirm*、PolicyAdvisory、PolicySettings、POLICY_* 常量、attach/get/policyFactsFromEntries）
- `packages/coding-agent/src/core/policy/classifier.ts`（1735 行：classifyPolicyOperation、classifyPolicyFailure、policyFailureLimit、policyShellPathReferences、policyPathRequiresConfirmation、inspectShellPrivilege、hasPotentialShellPrivilege）
- `packages/coding-agent/src/core/policy/policy-runtime.ts`（621 行：PolicyRuntime、PolicyAuthorization）

## 2. 符号 → 迁移表

| 符号 | 消费者（policy 目录之外） | 迁移 |
|---|---|---|
| `classifyPolicyFailure` | test/policy-runtime.test.ts:940 | Step 02 → 中性 `classifyExecutionFailure`（新 execution 模块） |
| `PolicyFailureCategory` | tools/bash.ts、classifier 内部 | Step 02 → `ExecutionFailureCategory` |
| `policyCategory`（BashToolExecutionError 字段、details 字段） | tools/bash.ts:59/62/65/581、bash-executor | Step 02 → `failureCategory` |
| `inspectShellPrivilege` | tools/bash.ts:18/617、remote/tools.ts:8/575、privilege/runtime.ts:5、modes/interactive/components/bash-execution.ts:11、test/privilege-routing.test.ts | Step 02 迁入中性 shell-inspection 模块；Step 05B 连同 M13 删除 |
| `hasPotentialShellPrivilege` | tools/bash.ts:18/103/447、remote/runtime.ts:8/151、remote/tools.ts:8/527、test/privilege-routing.test.ts | 同上 |
| `classifyPolicyOperation` | agent-session.ts:125/811（dynamicTaskRuntime 的 workspaceMutation 检测）、test/remote-tools.test.ts:271、test/playwright-tool.test.ts:188-212、test/policy-runtime.test.ts | Core Policy 语义删除；其中 `descriptor.workspaceMutation` 检测是 DynamicTaskRuntime 的真实依赖 → Step 03 提供中性 tool-kind 辅助函数（如 `isWorkspaceMutatingTool(toolName, args)`），不保留 Policy 命名 |
| `policyFailureLimit` | 外部 0 处 | 删除（budget 语义） |
| `policyShellPathReferences` | 外部 0 处 | 删除 |
| `policyPathRequiresConfirmation` | 外部 0 处 | 删除 |
| `PolicyRuntime`、`PolicyAuthorization` | agent-session-services.ts:12/49/91/175/214/237、agent-session.ts:129/300/403/539/546/724/896、sdk.ts:20/101/249/671、footer.ts:297 | 删除 |
| `PolicyToolDetails` + `attachPolicyToolDetails`/`getPolicyToolDetails`/`policyFactsFromEntries` | agent-session.ts:124/904/944/1102、task-ledger.ts:21/195/628/712/838/916/964/1016/1128/1168、bash-executor.ts:15/45、tool-execution.ts、test/policy-renderer.test.ts、test/suite/policy-session.test.ts | 删除；失败事实由 Step 02/06 中性执行结果替代 |
| `PolicyAdvisory`/`getAdvisories`、`POLICY_DETAILS_KEY`、`POLICY_FACT_ENTRY_TYPE` | footer.ts:297-340、task-ledger.ts、interactive-mode.ts:3183（case "policy"）、test/footer-width.test.ts | 删除 |
| `PolicyConfirmRequest/Response/Result`、`PolicyInteractionHandler` | rpc-types.ts:13/262、rpc-client.ts:64/552/566（cancelLegacyPolicyRequest）、sdk.ts:99、test/policy-rpc.test.ts、test/suite/policy-session.test.ts | 删除（RPC 保留其他 extension_ui_request 方法） |
| `PolicySettings`/`resolvePolicyConfig`/`createPolicyConfigProvider` | settings-manager.ts:12/136/1021、sdk.ts:253/333、agent-pool.ts:11/181/1247、agent-session.ts:131/543/816、test/remote-tools.test.ts:8 | 删除（含 settings `policy` 字段与 getPolicySettings） |
| `policyHandler` / `policyInteractionMode` | sdk.ts:99/105、agent-pool.ts:1269、test/suite/policy-session.test.ts | 删除 |
| `policySettings`（child option） | sdk.ts:333、agent-pool.ts:181/1247 | 删除 |

## 3. 待删除/新增文件

### 删除（Step 03/04）
- `packages/coding-agent/src/core/policy/`（整目录 5 文件）

### 新增（Step 02，中性执行模块）
- `packages/coding-agent/src/core/execution/`（建议）：failure classification（`ExecutionFailureCategory`、`classifyExecutionFailure`）、shell inspection（`inspectShellPrivilege`、`hasPotentialShellPrivilege`，05B 时再删）。命名不含 policy/authorization 暗示。
- Step 03：DynamicTaskRuntime 所需的中性 tool-kind 辅助函数（workspaceMutation）。

### 修改（按步骤）
| 文件 | 步骤 | 内容 |
|---|---|---|
| src/core/agent-session-services.ts | 03 | 删除 policyRuntime 创建/字段/传递（7 处） |
| src/core/sdk.ts | 03/04 | 删除 policyHandler/policyRuntime/policyInteractionMode 选项与注入（14 处） |
| src/core/agent-session.ts | 03 | 删除字段、bindSession、subscribe、finalizeTool、attach 逻辑；policy event → 删除；classifyPolicyOperation 调用 → 中性 tool-kind 辅助（60 处匹配中约 30 处为 Core Policy） |
| src/core/state/task-ledger.ts | 03/04 | 删除 policyRecords/getPolicyDetails/snapshot.policy/rebuild 分支/POLICY_FACT_ENTRY_TYPE 解析；保留中性 execution/failure records |
| src/core/tools/bash.ts | 02/05 | 迁移 failureCategory；05B 删除 privilege 路由门（103-104、447-451）与 privileged 渲染 |
| src/core/bash-executor.ts | 02/06 | policy 字段 → 中性 execution 结果 |
| src/core/remote/runtime.ts、remote/tools.ts | 02/05 | 从新 shell-inspection 模块导入；05B 删除 privilege 路由（527） |
| src/core/privilege/runtime.ts | 02/05 | 05B 整目录删除（8 文件 1727 行） |
| src/core/settings-manager.ts | 04 | 删除 PolicySettings 与 getPolicySettings |
| src/core/agents/agent-pool.ts | 04 | 删除 policySettings 复制与 child option、policyInteractionMode:"controlled" |
| src/modes/interactive/components/footer.ts | 04 | 删除 advisory 展示 |
| src/modes/interactive/components/tool-execution.ts | 04 | 删除 PolicyAction no-op setter |
| src/modes/interactive/components/bash-execution.ts | 02/05 | shell-inspection 导入迁移；05B 删除 Sudo 标题分支 |
| src/modes/rpc/rpc-types.ts、rpc-client.ts | 04 | 删除 policyConfirm 方法与 cancelLegacyPolicyRequest |
| src/core/index.ts:119、src/index.ts:234 | 04 | 删除 policy 导出（privilege 导出 Step 05B 删） |
| docs/beaupi/architecture.md、milestones.md、requirements.md、roadmap.md | 04/10 | 删除 Policy Engine 章节/M10 描述与授权暗示 |
| CHANGELOG.md（Unreleased） | 10 | 记录 breaking changes |

## 4. 测试迁移表

| 测试文件 | 处置 | 说明 |
|---|---|---|
| test/policy-runtime.test.ts（~940 行） | 重写/拆分 | classifyPolicyFailure 场景 → 中性 classifyExecutionFailure 测试（Step 02）；PolicyRuntime/advisory 场景删除；shell inspection 场景随 05A/05B 决定 |
| test/policy-renderer.test.ts | 删除（Step 04） | ToolExecutionComponent 的 PolicyToolDetails 渲染 |
| test/policy-rpc.test.ts | 删除（Step 04） | RpcClient policyConfirm 兼容路径 |
| test/suite/policy-session.test.ts | 删除/重写（Step 03/04） | session 级 policyHandler/fact 集成 → 若需保留，重写为中性 execution-facts 会话测试 |
| test/footer-width.test.ts | 修改（Step 04） | 仅移除 PolicyAdvisory 样本，保留 Footer 布局断言 |
| test/playwright-tool.test.ts | 修改（Step 02/03） | 移除 classifyPolicyOperation descriptor 断言（188-212），保留 Playwright 行为 |
| test/remote-tools.test.ts | 修改（Step 02/03） | 移除 classifyPolicyOperation/resolvePolicyConfig 断言（271），保留 remote 行为 |
| test/privilege-routing.test.ts | 删除（Step 05B） | privilege 路由边界 |
| test/suite/privilege-session.test.ts | 删除（Step 05B） | M13 session 集成 |
| test/cache-policy.test.ts | 保留 | 独立 cache policy 子系统 |

## 5. 保留的独立 policy 命名（不删）

| 位置 | 说明 |
|---|---|
| src/core/cache-policy.ts + test/cache-policy.test.ts | 独立 cache policy 子系统（deepseek-cache 计划） |
| src/core/playwright/network-policy.ts（14 处 policy） | PlaywrightNetworkPolicy，明确保留 |
| src/core/skill-registry.ts（43 处）、resource-loader.ts（SkillPolicyDiagnosticReason） | Skill allowlist/filtering，明确保留 |
| src/core/workflow/{workflow-runtime,builtins,types,schema}.ts | Workflow writePolicy/failurePolicy，明确保留 |
| src/core/compaction/compaction.ts、branch-summarization.ts | retry policy / compaction policy，明确保留 |
| src/core/documents/document-runtime.ts（4 处） | 文档/契约 policy 语义，独立子系统 |
| task-ledger.ts `projection: "task" \| "policy"`（151-165、1363-1526） | ⚠️ 见下方待确认项：语义是 ExecutionContract 文档项（requirements/required checks/completion criteria）的 Todo 投影标记，源自「scope required checks to task evidence / filter generic requirements」提交，不是 Core PolicyRuntime。**建议保留**，仅删除同文件中的 PolicyToolDetails records（policyRecords/snapshot.policy）。 |
| docs/beaupi/plans/13-controlled-privilege-terminal/*（6 文件）、controlled-privilege-terminal.md | M13 自己的契约/策略文档，Step 05B 时删除 |
| 外部容器化/部署文档中的 policy-controlled sandbox 描述 | 非本仓库代码，不动 |

## 6. 全仓库 grep 基线（Step 01 时点，排除 node_modules/dist/.git）

- src 中 policy 匹配文件（排除 core/policy 目录）top：agent-session.ts 60、skill-registry.ts 43、task-ledger.ts 25、workflow-runtime.ts 17、builtins.ts 17、sdk.ts 14、network-policy.ts 14、playwright/runtime.ts 12、workflow/types.ts 8、tools/bash.ts 7、compaction.ts 7、agent-session-services.ts 7、resource-loader.ts 6、footer.ts 5、rpc-types.ts 4、rpc-client.ts 4、workflow/schema.ts 4、settings-manager.ts 4、document-runtime.ts 4、branch-summarization.ts 4、agent-pool.ts 4、playwright/index.ts 3、diagnostics.ts 3、bash-executor.ts 3、tool-execution.ts 2。
- 关键符号外部出现次数：PolicyRuntime 25、PolicyToolDetails 26、policyInteractionMode 2、policyHandler 4、policySettings 3、PolicySettings 7、POLICY_FACT_ENTRY_TYPE 6、classifyPolicyFailure 2、classifyPolicyOperation 14、inspectShellPrivilege 18、hasPotentialShellPrivilege 10、PolicyAdvisory 4、PolicyFailure 6、attachPolicyToolDetails 11、getPolicyToolDetails 10、createPolicyConfigProvider 4、resolvePolicyConfig 12、PolicyInteractionHandler 13、policyCategory 7、policyConfirm 4。无外部消费者的符号：PolicyAuthorization、PolicyDecision、policyFailureLimit、policyShellPathReferences、policyPathRequiresConfirmation、policyFactsFromEntries、DEFAULT_POLICY_*、POLICY_DETAILS_KEY。
- 全仓库（ts/md/json）policy 匹配文件共 134 个（含计划文档与无关子系统）。

## 7. M13 Privilege 附带盘点（供 Step 05 使用）

- src/core/privilege/ 8 文件 1727 行：runtime.ts 616、terminal-adapter.ts 376、types.ts 362、tools.ts 169、fake-terminal-adapter.ts 106、index.ts 43、audit-writer.ts 55。
- 消费者：agent-session.ts、agent-pool.ts、bash-executor.ts（privilege 字段）、sdk.ts（privilegeHandler/privilegeRuntime）、remote/runtime.ts、remote/tools.ts、system-prompt.ts:136（提示文本提及 privileged_exec/Sudo Bash）、tasks/dynamic-task-runtime.ts、tasks/tools.ts、tools/bash.ts、tools/index.ts:164（"privileged_exec" 工具名）、state/task-ledger.ts（PrivilegeToolDetailsV1 records）、src/index.ts 导出、modes/interactive/components/privilege-terminal.ts、interactive-mode.ts。
- 05B 验收将覆盖：privileged_exec 无特殊路径、bash "sudo id" 走普通 Bash executor、privilege 路由门（bash.ts:103/447、remote/tools.ts:527）删除、privilege audit/terminal UI 删除。

## 8. 需要产品确认的项（不影响 Step 02 前进）

1. task-ledger `projection: "task" | "policy"` 字面量：证据表明是 ExecutionContract 文档项投影，非 Core Policy。默认按「保留」处理，仅删除 PolicyToolDetails records；如需改名（如 `"documented"`）放到 Step 04 顺带处理。
2. `classifyPolicyOperation` 的 `descriptor.workspaceMutation` 被 DynamicTaskRuntime 依赖：Step 03 将提供中性 tool-kind 辅助函数，不保留 Policy 命名（无需决策，仅记录）。
3. dist/ 目录中存在 policy 引用（构建产物）：后续步骤不手工修改 dist，由正式构建重新生成（本计划不运行 build）。
