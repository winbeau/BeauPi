# Step 02：抽取中性执行事实

## 状态

设计完成，未实现。依赖 Step 01。

## 1. 目标

在删除 Core Policy 前，把仍被普通执行路径和 PrivilegeRuntime 使用的事实迁出 Policy 命名空间：

1. Shell privilege inspection：只识别命令是否进入现有 privilege 路由。
2. Tool failure classification：只把失败映射为中性执行结果类别。

两者都不拥有授权能力。

## 2. Shell inspection 迁移

新文件建议：packages/coding-agent/src/core/privilege/shell-inspection.ts

从 core/policy/classifier.ts 移入：

- inspectShellPrivilege(command)
- hasPotentialShellPrivilege(command)
- 所依赖的纯解析 helper、类型和常量

修改消费者：

- packages/coding-agent/src/core/tools/bash.ts
- packages/coding-agent/src/core/privilege/runtime.ts
- packages/coding-agent/src/core/remote/runtime.ts
- packages/coding-agent/src/core/remote/tools.ts
- AgentSession 中仅用于 sudo 路由的 import

要求：不改变当前识别规则、opaque 行为、unsupported privilege 分类或 sudo 路由；inspection 结果不能叫 PolicyOperationAnalysis；不输出 allow/deny/confirm。

若 Step 05 选择 05B 删除 PrivilegeRuntime，该模块也随 sudo 路由一并删除。

## 3. Failure classification 迁移

新文件建议：

- packages/coding-agent/src/core/execution/failure-types.ts
- packages/coding-agent/src/core/execution/failure-classifier.ts

建议命名：

- PolicyFailureCategory → ExecutionFailureCategory
- classifyPolicyFailure → classifyExecutionFailure
- policyFailureLimit → 删除；若 Step 06 确认仍需要重试预算，改为 executionFailureLimit，并只服务明确的 retry/failure 机制

修改消费者：Bash、AgentSession、remote/search/background/workflow 中确实消费该分类的路径和测试。

BashToolExecutionError.policyCategory 改为 failureCategory；错误消息、exit code、cancelled/timeout 保持现有语义；不生成 PolicyToolDetails。

## 4. 直接删除而非迁移

- sensitive path/workspace outside confirmation 判断；
- shell path canonicalization 作为 Core Policy 输入；
- operation/equivalence signature；
- repeated operation、fallback/failure budget、dedicated tool advisory；
- PolicyOperationDescriptor、PolicyOperationAnalysis；
- policy facts 的 Session reconstruction。

## 5. 测试

保留/新增：sudo、unsupported、opaque、控制字符的 shell inspection；exit/timeout/abort/permission/missing-dependency 的 failure classifier；Bash 结果中的 failureCategory 和真实 exit code。

删除：requiresConfirmation、sensitive path、policy budget、policy action/fact 测试。

## 6. 验收

- 新模块不 import core/policy。
- 源码 grep 不再出现 PolicyFailureCategory 或 policyCategory。
- 普通 Bash 与 Privilege 路由行为不变。
- 失败分类只影响结果诊断，不影响是否执行。
