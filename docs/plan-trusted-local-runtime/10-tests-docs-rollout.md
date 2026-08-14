# Step 10：测试、文档、Changelog 与最终验收

## 状态

设计完成，未实现。依赖全部前置步骤。

## 1. 测试分层

### Core Policy 删除

证明：PolicyRuntime 不创建/注入/调用；普通 Tool 只执行一次；敏感路径/任意绝对路径不产生 Core Policy block；无 handler 不触发 Core Policy interaction；RPC 不发 policyConfirm；TaskLedger 不写 beaupi.policy.fact。

### 中性执行结果

exit code、signal、duration、failureCategory 正确；cancelled/timed_out/failed 不互相伪装；stdout/stderr、truncation、full output path 保持既有产品语义；不新增默认 timeout 或 env scrub。

### Privilege 分支

05A：sudo inspection、staging、Enter、cancel、audit、dispose 保持；PrivilegeRuntime 不依赖 Core Policy。

05B：sudo 直通普通 Bash；无 privilege tool/UI/audit/interaction 残留。

### Session/Journal

append seq/revision/CAS、tail repair、branch/compaction、unknown external effect、stale continuation；不自动 replay 外部副作用。

### Tool/Extension/Config

registry completeness、extension order/error diagnostics、config provenance/merge semantics。

### Local RPC

typed command/error、event order/correlation/backpressure、shutdown/session replacement、无 Core Policy UI message。

## 2. 文档更新

- docs/beaupi/architecture.md
- docs/beaupi/controlled-privilege-terminal.md（05A）
- docs/beaupi/plans/13-controlled-privilege-terminal*.md（按 05A/B）
- packages/coding-agent/docs/security.md：trusted-local 边界，不把 Core Policy 写成授权
- packages/coding-agent/docs/rpc.md：local JSONL/no auth
- SDK/API 和配置文档：删除 policyHandler/policyInteractionMode/Core Policy settings
- roadmap/README 中 M10 Policy Engine 说明

## 3. Changelog

受影响 package 的 CHANGELOG.md 在 Unreleased 下记录 breaking changes：

- 删除 Core Policy Runtime、Policy settings、Policy SDK options、Policy RPC messages、Policy details。
- PolicyFailureCategory/policyCategory 改为中性 execution failure 名称。
- 05B 额外删除 PrivilegeRuntime/M13。
- Tool execution、Session、TaskLedger、RPC 使用中性 execution facts。
- trusted-local host environment/permission contract 保持不变。

不修改已发布章节。

## 4. 推荐 commit 批次

1. 文档计划（本轮只写计划）
2. extract shell inspection/failure classification
3. remove PolicyRuntime construction/execution hooks
4. remove Core Policy state/UI/RPC/settings/exports
5. choose/complete privilege branch
6. normalize execution result/status
7. add persistence coordinator/journal
8. repair tool registry and extension/config diagnostics
9. settle local RPC contract
10. docs/tests/changelog cleanup

每批只 stage 自己修改的明确路径，不做全仓库自动 stage。

## 5. 验证规则

代码修改后 npm run check；受影响单测从 package 根目录运行指定 Vitest；suite 使用 faux provider；不运行未经请求的 npm test 或完整 e2e；文档-only 变更不强制构建。

## 6. 最终 grep

Core Policy 删除后源码范围无：

PolicyRuntime
PolicyToolDetails
PolicyConfirmRequest
PolicyConfirmResponse
policyHandler
policyInteractionMode
policyConfirm
POLICY_FACT_ENTRY_TYPE
policyCategory

允许保留的独立名称必须在审计说明中列出：cache-policy、Playwright network policy、Skill filtering policy。

05A 允许 PrivilegeRuntime/M13；05B 则这些也必须为零。

## 7. 最终问题

1. Agent 是否仍以启动用户权限和环境运行？应是。
2. 是否存在 Core Policy block/confirm/replace/pause 路径？应否。
3. 是否新增 Web/MCP/网络 auth？应否。
4. Tool 结果是否说明真实执行状态？应是。
5. Session 崩溃/分支/Compaction 后能否区分 transcript 与 execution state？应是。
6. Tool registry 是否单一来源？应是。
7. Breaking changes 是否写入 Unreleased changelog？应是。
