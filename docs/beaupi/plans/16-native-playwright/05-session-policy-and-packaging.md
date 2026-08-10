# 05 AgentSession、Policy 与 Packaging

状态：已定义。

## 目标

把PlaywrightRuntime接入真正的builtin Tool registry、AgentSession生命周期、SDK/CLI allowlist、Policy/Dynamic Tasks和Node/Bun发行链，避免实现成来源错误的SDK custom Tool或仅源码模式可用的功能。

## AgentSession 接入

修改：

- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-services.ts`
- `packages/coding-agent/src/core/tools/index.ts`
- `packages/coding-agent/src/index.ts`

新增 `CreateAgentSessionOptions.playwrightRuntime?`，用于fake测试和自定义host注入。默认Runtime按cwd/sessionId/settings创建，但保持lazy browser。

`AgentSessionConfig`和class增加唯一 `playwrightRuntime`。`_buildRuntime()`把 `createPlaywrightToolDefinition(runtime)`加入 `_baseToolDefinitions`，使sourceInfo为 `builtin`；不要通过 `customTools` 注入，否则 `getAllTools()` 会错误显示为SDK来源。

默认active列表加入 `playwright`；同步更新：

- `ToolName`/`allToolNames`
- CLI `--tools`、`--exclude-tools`、`--no-builtin-tools`
- SDK `tools`/`excludeTools`/`noTools`
- reload时registry重建
- custom extension同名覆盖及renderer slot继承

## 生命周期

- `AgentSession.dispose()` 幂等调用 `playwrightRuntime.dispose()`。
- `reload()` 在旧extension shutdown后reset browser/context，使更新后的settings和network policy生效；不让旧Page继续持有旧ctx。
- `/new`、resume、fork、clone、session switch由旧Session dispose，新的Session创建独立Runtime。
- branch tree navigation只改变会话branch，不恢复历史Page；推荐reset Runtime，避免浏览器状态与目标branch不一致。
- Print mode结束、RPC shutdown和SDK dispose均关闭browser。

## `isError` 与 Extension details

`AgentSession.afterToolCall`读取 `getPlaywrightRuntimeToolDetails()`：

- `ok: false`加入现有 `runtimeError`。
- Extension `tool_result`修改content/details后，重新 `attachPlaywrightRuntimeToolDetails()`。
- Policy finalize、Task Ledger和Tool renderer都消费同一权威details。

这与Search、Remote、Privilege、Workflow和Background保持同一模式。

## Policy

修改：

- `packages/coding-agent/src/core/policy/classifier.ts`
- `packages/coding-agent/src/core/policy/types.ts`（仅在需要新增kind时）

分类建议：

- navigate：network/browser navigation。
- snapshot、screenshot、events、pages.list：read-only browser inspection。
- act、evaluate、pages.new/close/reset：browser state mutation，但不是workspace mutation。
- screenshot有savePath：额外标记local workspace write/sensitive path。

Policy仍只产生advisory和失败分类；URL协议、metadata/private network硬阻止由Playwright network policy执行。

失败分类：browser missing/configuration、launch/configuration、navigation/network、timeout、cancelled、locator/command-like failure、browser disconnected/session_lost。

## Dynamic Tasks 与 Task Ledger

- `snapshot`、`screenshot`、`events`可以标记为verification Tool started/finished。
- `navigate`和`act`默认不标记workspace mutation。
- screenshot `savePath`成功才记录文件修改事实。
- 浏览器失败进入Task Ledger failures，但不从console文本猜测整个开发任务失败。
- 不为Playwright创建独立Task状态或Monitor record。

## AgentPool

受控子Agent默认Profile不自动获得Playwright。只有Profile `toolAllowlist`明确包含 `playwright` 时才启用；每个child创建独立Runtime/Browser，不共享Coordinator cookie、Page或event cursor。

## Settings

建议新增最小设置：

```json
{
  "playwright": {
    "executablePath": "/path/to/chrome",
    "channel": "chrome",
    "headless": true,
    "actionTimeoutMs": 15000,
    "navigationTimeoutMs": 30000,
    "allowPrivateNetwork": false
  }
}
```

规则：

- executablePath/channel二选一。
- headless第一版默认true；headed模式在TUI/桌面环境可显式开启。
- private network默认false，但localhost始终允许。
- project setting只有项目受信任时加载；显式browser executable仍需文档提示其代码执行边界。
- 不增加Playwright专属vision setting。

修改 `packages/coding-agent/docs/settings.md` 时同时补当前遗漏的 `vision.model` 文档。

## 依赖与锁文件

修改：

- `packages/coding-agent/package.json`
- `package-lock.json`
- `packages/coding-agent/npm-shrinkwrap.json`
- `packages/coding-agent/install-lock/package-lock.json`
- 必要时两个生成脚本的install-script allowlist

要求：

- 外部直接依赖精确版本。
- `npm install --ignore-scripts`。
- 生成shrinkwrap和install-lock，不手改生成文件。
- 审查Playwright transitive dependencies、bin、platform metadata和lifecycle script。
- 不加入自动下载browser的 `@playwright/browser-*` 包作为默认依赖。

## Bun standalone binary

Playwright不能只在Node npm包中工作。建议：

1. `browser-loader.ts`使用`createRequire`，不把Playwright路径烘焙成构建机绝对路径。
2. `scripts/build-binaries.sh`为每个平台归档复制 `node_modules/playwright` 和 `node_modules/playwright-core`，类似clipboard外置依赖策略。
3. browser binary不打进BeauPi归档；运行时使用Playwright cache或系统Chrome/Edge。
4. 编译后从仓库外运行binary，验证require解析、channel发现、launch、goto本地HTTP server、screenshot和close。
5. Windows x64/arm64、Linux x64/arm64、macOS x64/arm64至少有CI矩阵中的package/loader检查；真实launch按可用runner覆盖主要平台。

如果Bun compiled executable无法稳定加载Playwright package，停止并重新评估外置worker方案；不能悄悄让binary显示Tool但调用必失败。

## 文档与公开API

实现后更新：

- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/docs/settings.md`
- 新增 `packages/coding-agent/docs/playwright.md`
- `docs/beaupi/README.md`
- `docs/beaupi/requirements.md`
- `docs/beaupi/architecture.md`
- `docs/beaupi/roadmap.md`
- `docs/beaupi/milestones.md`
- `packages/coding-agent/CHANGELOG.md` 的 `[Unreleased] / Added`

文档必须区分：

- `web_fetch`：受控正文、引用、DNS pinning。
- `playwright`：有状态渲染与交互，不提供引用或完全相同的SSRF保证。
- browser library已内置，但Chromium/Chrome executable是运行时前置条件。

## 完成条件

- Tool source为builtin，默认/allow/exclude/no-builtin/custom override全部正确。
- 所有Session替换和dispose路径关闭browser。
- Policy、Task Ledger、Dynamic Tasks使用结构化details，不解析文字。
- npm锁、shrinkwrap、install-lock和Bun归档完整。
- Node与Bun从仓库外均能执行真实browser smoke。
