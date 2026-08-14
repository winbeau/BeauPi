# Step 04：删除 Policy 状态、UI、RPC、Settings、文档与测试

## 状态

设计完成，未实现。依赖 Step 03。

## 1. TaskLedger 和 Session

文件：packages/coding-agent/src/core/state/task-ledger.ts

删除 Core Policy details/import、TaskLedgerSnapshot.policy、policyRecords、beaupi.policy.fact rebuild/record 分支、getPolicyDetails/recordPolicy 和 policy 专用聚合。

文件中 projection: policy 若实际表示 Document Runtime 文档约束而非 Core Policy，不得机械删除；改为 contract/guidance 等准确名称并同步类型、测试、UI。

Session 旧 Policy details 不要求兼容读取；允许新 schema 忽略旧 details，除非 parser 必须保留才能加载文件。

## 2. Tool details 和 renderer

文件：packages/coding-agent/src/core/bash-executor.ts、core/tools/bash.ts、modes/interactive/components/tool-execution.ts

删除 PolicyToolDetails 附着、Policy action 读取和 setPolicyAction no-op。Bash renderer 只消费 Bash/Privilege details。BashResult 若有 policy 字段，改成 execution 或展开为 failureCategory/status。

## 3. Footer

文件：packages/coding-agent/src/modes/interactive/components/footer.ts

删除 policyRuntime.getAdvisories 和 policy: footer 行；保留 generic failure、task、workflow、background、monitor 状态。

## 4. Settings

文件：packages/coding-agent/src/core/settings-manager.ts

删除 PolicySettings import、settings policy 字段、getPolicySettings、Policy merge、sensitive paths/budget 默认值。逐项确认独立 Playwright/cache/Skill policy 不被误删。

## 5. RPC

文件：packages/coding-agent/src/modes/rpc/rpc-types.ts、rpc-mode.ts、相关 client/test/docs

删除 PolicyConfirmRequest、extension_ui_request.policyConfirm、policyDecision response、等待 Policy handler 的路径。

保留 askUserQuestion、extension UI、abort、backpressure 和 JSONL transport。

## 6. Exports 和文档

同步清理 core/index.ts、src/index.ts、package API/JSON docs、docs/beaupi/architecture.md 的 M10 Policy Engine 章节、M13 文档中对 Core Policy classifier 的引用、SDK policy 示例。

文档明确：BeauPi 是 trusted-local agent；工具调用不由 Core Policy 授权或阻断；Shell 使用宿主用户环境和权限；这不是 Web auth、sandbox 或安全承诺。

## 7. Tests

删除或重写 policy-runtime.test.ts、policy-renderer.test.ts、policy-rpc.test.ts、suite/policy-session.test.ts；footer fixture 删除 Policy advisory；privilege-routing 从 shell-inspection 导入；remote/playwright 保留独立行为。

新增：普通敏感路径/任意 cwd 不产生 Core Policy block；Tool 不经过 Policy wrapper；RPC 不发 policyConfirm；TaskLedger 不生成 beaupi.policy.fact。

## 8. 验收

Core Policy 目录可删除或最终无源码 import；源码无 PolicyRuntime、PolicyToolDetails、policyConfirm、POLICY_FACT_ENTRY_TYPE。仍保留的 policy 命名必须有独立功能注释。
