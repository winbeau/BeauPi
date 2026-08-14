# Step 03：删除 PolicyRuntime 与 AgentSession 集成

## 状态

设计完成，未实现。依赖 Step 02。

## 1. AgentSessionServices

文件：packages/coding-agent/src/core/agent-session-services.ts

删除 PolicyRuntime、createPolicyConfigProvider import；policyRuntime option/field；new PolicyRuntime 创建；createAgentSessionFromServices 的传递。

不改变 SettingsManager、ResourceLoader、ModelRuntime、SearchRuntime 的创建顺序，除非类型检查要求最小调整。

## 2. SDK

文件：packages/coding-agent/src/core/sdk.ts

删除 PolicyRuntime、PolicyInteractionHandler import；policyHandler、policyRuntime、policyInteractionMode；创建/绑定 PolicyRuntime；AgentSession config 传递。

这是明确 breaking change，不保留 no-op compatibility option。

## 3. AgentSession 字段和流程

文件：packages/coding-agent/src/core/agent-session.ts

删除 Policy imports、config policyRuntime、readonly policyRuntime、unsubscribePolicyRuntime、bind/subscribe/setHandler；tool registry 的 policyRuntime.wrapTool；authorizeTool、noteThrownError、finalizeTool、attachPolicyToolDetails、POLICY_FACT_ENTRY_TYPE 写入；branch rebuild 的 policyRuntime.rebuild。

保留 Extension runner 的正常 wrapping、PrivilegeRuntime 独立路由（05B 另行删除）、TaskLedger/Monitor/Workflow/Background 的非 Policy 事实。

### Bash

executeBash 路径直接调用 BashOperations.exec 或 PrivilegeRuntime（05A）；记录通用 Bash execution result；保留 isError、output、exitCode、truncation、duration；不写 Policy details/custom entry。

如果通用 execution record 尚未在 Step 06 完成，允许先用最小中性结果完成，再由 Step 06 补全。

## 4. AgentPool

删除 PolicySettings import、policySettings dependency、child session 的 Policy settings 复制、policyInteractionMode controlled 等仅服务 Core Policy 的设置。

保留 child Agent 的 tool/profile/resource loader 和 Skill allowlist 逻辑。

## 5. 验收

- 普通 Tool execute 调用次数与删除前一致，每个调用只执行一次。
- PolicyRuntime 不再创建、注入、订阅或调用。
- createAgentSession/createAgentSessionServices 类型检查通过。
- 未选择 05B 时 sudo 仍按 M13 原路径，不因 Policy 删除而绕过或新增交互。
