# Step 05：PrivilegeRuntime 选择（A 保留 / B 删除）

## 状态

设计完成，待产品选择。依赖 Step 02、Step 04。

## 1. 为什么单独分叉

Core Policy 和 M13 PrivilegeRuntime 是不同机制：

- Core Policy：分类、advisory、confirmation 兼容接口；本计划删除。
- PrivilegeRuntime：sudo command staging、TTY、Enter/user-presence、audit、tmux terminal；是否保留不能由 Core Policy 删除自动推断。

## 2. 05A：保留 M13

保留：

- packages/coding-agent/src/core/privilege/*
- privileged_exec
- local/terminal Bash 的 sudo 自动路由
- TUI privilege terminal、audit、tmux adapter
- M13 docs/tests

解耦动作：

1. PrivilegeRuntime 从 core/privilege/shell-inspection.ts 导入 inspection。
2. 删除对 core/policy/index.ts 的 import。
3. 文档称“受控 sudo terminal UX”，不称 Core Policy authorization。
4. 普通工具仍全部直接执行；只有明确 sudo terminal 路径保留用户在场交互。
5. 测试确认 Core Policy 删除不改变 M13 审计、取消和 dispose 语义。

05A 文案必须明确：普通工具全授权，sudo 是独立用户在场终端流程。

## 3. 05B：删除 M13

删除/修改：

- packages/coding-agent/src/core/privilege/*
- privileged_exec tool definition/schema/registry/renderer
- tools/bash.ts 的 privilegeRuntime 路由和 sudo 保护异常
- remote/runtime.ts、remote/tools.ts 的 privilege route 依赖
- AgentSession、SDK、services 中 PrivilegeRuntime 创建和传递
- modes/interactive/components/privilege-terminal.ts
- privilege audit/terminal/remote tests
- M13 docs/plans/architecture sections

普通 Shell 直接执行所有 command，包括 sudo/su；不检查、拦截、预览或要求 Enter。

05B 验收：bash sudo id 进入普通 Bash executor；无 interaction_required、privileged_exec、privilege audit；root/普通用户行为只由宿主 OS 决定；RPC/print 不存在特例路径。

## 4. 选择规则

新对话实现本步骤前必须明确：

- 选择 05A：Core Policy 删除，M13 保留；或
- 选择 05B：Core Policy 与 M13 全部删除，所有 Shell 同权直通。

不得在 05A 顺手完成 05B，也不得未确认就删除 M13。
