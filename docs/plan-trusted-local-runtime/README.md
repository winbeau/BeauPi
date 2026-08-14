# BeauPi Trusted-Local Runtime 升级总计划

> 状态：已实现（Step 01–10 全部完成，2026）。
> 本计划已完成：Core Policy 与 M13 PrivilegeRuntime（05B）已删除，中性执行事实、ExecutionJournal、Tool Registry、本地 RPC 契约与 trusted-local 文档已落地；验收见各步骤报告。
> 适用仓库：/home/winbeau/Projects/pi

## 1. 目标

本计划以产品方明确的 trusted-local 设计为唯一前提，完成一次删减 Core Policy、收敛运行时契约、提升可维护性和恢复能力的升级：

1. 删除当前 Core PolicyRuntime 及其 advisory、confirmation、budget、sensitive-path 分类和伪授权接口。
2. 工具调用不经过授权门；普通工具默认直接执行，Core Policy 不得阻止、替换、暂停或要求确认。
3. Shell 继续继承 BeauPi 宿主进程的完整环境和用户权限；不加入 env scrub、workspace containment、OS sandbox 或网络/凭据降权。
4. 不建设 Web GUI、HMR 或 MCP。
5. 保留 CLI/TUI、SDK、现有 JSONL RPC、扩展、Skill、Provider、树形 Session、Compaction、Workflow 和 Background 能力。
6. 将仍然有用的失败分类、执行结果和运行状态改成中性的 execution/runtime 语义，不再挂在 Core Policy 名下。
7. 提升 Session 持久化、Run/Job 生命周期、工具注册一致性和本地 RPC 契约，但不改变执行权限模型。

## 2. 产品契约（后续步骤不可悄悄改变）

| 主题 | 固定行为 |
|---|---|
| 执行权限 | Agent 使用启动 BeauPi 的同一 OS 用户、cwd、环境和文件权限 |
| Shell 环境 | 保留当前宿主环境继承语义；不把 inheritEnv false 改成默认 |
| 工具授权 | 不存在 Core Policy authorization gate；普通工具调用默认执行 |
| Core Policy | 删除为独立运行时；不保留 confirmation handler、allow/deny/pause/replace 语义 |
| Web | 不做 Web server、Web GUI、HMR 或浏览器模块系统 |
| MCP | 不做 MCP client/server bridge |
| RPC | 仅保留本地 stdin/stdout JSONL embedding transport；不宣称网络认证或权限隔离 |
| Extension | 保留 trusted in-process TypeScript extension 模型；manifest 只用于组合和诊断，不是权限边界 |
| Session | 保留 branch/leaf/tree/compaction 产品语义；seq/revision 只服务持久化和恢复 |
| 默认 timeout | 本计划不借删除 Policy 之机改变 timeout 默认值 |

### PrivilegeRuntime 的范围分叉

现有 M13 PrivilegeRuntime 是独立的 sudo/TTY 用户在场流程，不是 Core PolicyRuntime。用户已明确要求删除 Core Policy；是否连 M13 的用户在场 sudo 流程一起删除，需要在 Step 05 明确选择：

- 05A：删除 Core Policy，保留 M13 作为独立 sudo terminal UX；
- 05B：删除 Core Policy 和 M13，sudo/su 等命令全部直通普通 Shell executor。

在 Step 05 选择前，不删除看起来是有意功能的 PrivilegeRuntime。

## 3. 明确不做

- OS sandbox、容器、VM、allowed-root、symlink containment、TOCTOU 防护；
- 默认环境最小化、凭据注入、网络限制或 root 降权；
- 默认新增 Shell timeout；
- Web、HMR、MCP、HTTP auth、CSRF、origin policy；
- 把本地 JSONL RPC 改成网络服务；
- 复制 DSH 的 Cordis、profile patch tree 或 package fragmentation；
- 用 event replay 自动重放外部副作用；
- 无明确选择地删除 PrivilegeRuntime、Playwright network policy、Skill filtering 或 cache policy。

资源和结果可靠性可以另行提升，但任何改变环境、权限、timeout 或授权语义的改动必须单独获准。

## 4. 步骤索引与依赖

| 步骤 | 内容 | 依赖 | 主要交付物 |
|---|---|---|---|
| 00 | 产品契约与实施规则 | 无 | 决策冻结、范围闸门 |
| 01 | Core Policy 依赖盘点与迁移清单 | 00 | 符号/文件/测试/文档清单 |
| 02 | 抽取中性执行事实 | 01 | shell inspection、failure classification 新归属 |
| 03 | 删除 PolicyRuntime 与 AgentSession 集成 | 02 | 不再有 Core Policy 执行路径 |
| 04 | 删除 Policy 状态、UI、RPC、Settings、文档和测试 | 03 | 清理全部 Core Policy surface |
| 05 | PrivilegeRuntime 选择（A 保留 / B 删除） | 02、04 | 明确 sudo 最终契约 |
| 06 | 中性执行结果与 Run/Job 生命周期 | 03、05 | execution facts、status、cancel/settlement |
| 07 | SessionPersistenceCoordinator 与 ExecutionJournal | 06 | crash-safe transcript/execution state |
| 08 | Tool Registry、Extension Manifest、Config Explain | 03 | 构造器一致性与组合诊断 |
| 09 | 本地 JSONL RPC 契约收敛 | 04、06、08 | version/correlation/typed error，不做网络 auth |
| 10 | 测试、文档、Changelog 与最终验收 | 全部 | 可独立验收的升级完成定义 |

建议顺序：00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10。

## 5. 实施纪律

- 每个步骤拆为小 commit；一个 commit 只完成一个迁移动作。
- 这是明确的 breaking change 计划：不承诺旧 Core Policy SDK/API/RPC 兼容。
- 代码修改后运行 npm run check；修改测试后运行对应单文件测试或受控测试，不运行未经请求的 npm test。
- 不修改 packages/ai/src/models.generated.ts 作为本计划手段。
- 每个新对话只实现当前步骤，并报告修改文件、check 和测试结果。
- 不用 policy、sandbox、authorization 等名称给中性执行事实制造安全暗示。

## 6. 全局完成定义

- 源码不存在 PolicyRuntime、policyHandler、policyInteractionMode、policyConfirm 等 Core Policy 执行接口。
- 普通 read/write/edit/bash/search/remote/workflow/background/custom tool 不经过 Core Policy wrapper，调用路径保持直接执行。
- Shell 继续继承宿主环境和权限；没有新增降权或 containment。
- Core Policy 相关 Footer、Tool details、TaskLedger projection、Session custom entry、RPC UI message、Settings 字段和公开 export 全部清理。
- PrivilegeRuntime 的保留或删除结果与 Step 05 选择一致，不能出现半残引用。
- 失败结果拥有中性、可审计的状态/分类；不再出现 PolicyToolDetails 或 policyCategory。
- Session 恢复、分支、Compaction、RPC、CLI/TUI 和现有扩展行为通过对应回归测试。
- 受影响 package 的 Unreleased changelog 记录 breaking changes。

## 7. 新对话实施模板

开始某一步时可直接使用：

> 请执行 docs/plan-trusted-local-runtime/<step-file>.md。先完整阅读该计划引用的源码和测试，再只实现本步骤；不要扩大范围，不改变 trusted-local 产品契约。完成后运行该步骤要求的 check/测试并汇报。
