# 06 Tests 与 Acceptance

状态：已定义。

## 目标

用fake Playwright adapter、faux provider、本地HTTP server和可选真实Chromium完成Schema、Runtime、视觉回退、Session、Policy、TUI、Node/Bun发行验收。普通单元测试不依赖browser下载或真实付费Provider。

## 测试分层

### A. 纯单元测试

新增：

- `packages/coding-agent/test/playwright-schema.test.ts`
- `packages/coding-agent/test/playwright-details.test.ts`
- `packages/coding-agent/test/playwright-network-policy.test.ts`
- `packages/coding-agent/test/playwright-locator.test.ts`
- `packages/coding-agent/test/playwright-runtime.test.ts`
- `packages/coding-agent/test/playwright-tool.test.ts`
- `packages/coding-agent/test/playwright-screenshot.test.ts`

全部使用fake Browser/Context/Page/Locator，不启动真实browser。

覆盖：

- strict union、额外字段、条件字段、长度/数量/数字预算。
- lazy launch、单browser、Page registry、popup、active Page、reset、disconnect。
- sequential queue、AbortSignal、timeout、幂等dispose。
- localhost/public/private/metadata/credentials/协议和subresource policy。
- 所有locator策略、0个/多个匹配、auto-wait error映射。
- navigate 200/404/500、redirect、title/URL变化。
- snapshot/evaluate/events截断和完整文件路径。
- screenshot Buffer、尺寸/hash、processImage、savePath和像素预算。
- expected failure保持details并设置 `ok: false`。

### B. Session/faux provider测试

新增：

- `packages/coding-agent/test/suite/playwright-session.test.ts`
- `packages/coding-agent/test/playwright-vision-session.test.ts`

场景1：多模态主模型

```text
user asks to inspect local app
  -> model calls playwright navigate
  -> model calls snapshot
  -> model calls screenshot
  -> screenshot ImageContent enters next main-model context
  -> no VisionService fallback call
```

场景2：text-only主模型

```text
playwright screenshot Tool Result
  -> convertToLlm sees image
  -> VisionService resolves vision.model
  -> one completeSimple call receives screenshot
  -> main model receives bounded visual description
```

场景3：`images.blockImages=true`

- screenshot仍可由Tool生成/TUI显示。
- Provider请求不包含图片，且不绕过block设置。

场景4：registry/lifecycle

- sourceInfo为builtin。
- `--tools`等价SDK allowlist只启用playwright。
- exclude/no-builtin移除。
-同名Extension覆盖实现并按现有规则继承renderer slot。
- reload/new/resume/fork/tree/dispose没有旧Page泄漏。

### C. Policy、Ledger 与 renderer

修改：

- Policy classifier/runtime测试。
- Dynamic Task session测试。
- Task Ledger测试。
- `packages/coding-agent/test/tool-execution-component.test.ts`。

覆盖：

- navigate=network，snapshot/screenshot=read verification，act/evaluate=browser mutation。
- savePath产生文件修改事实。
- browser missing/timeout/network/disconnect失败分类。
- screenshot image由通用ToolExecutionComponent显示一次。
- dark/light × 40/80/120/160，所有行 `visibleWidth <= width`。
- collapsed/expanded snapshot、events和screenshot metadata。

### D. 真实 Chromium smoke

新增脚本或明确测试入口，只有检测到已安装browser或显式环境开关时运行；普通 `./test.sh` 不触发browser下载。

本地HTTP fixture必须包含：

- heading/button/input/select/checkbox。
- click后DOM变化。
- console warning/error和page error。
- popup。
- viewport响应式布局。
- 一张可验证尺寸的screenshot。

真实流程：

1. 启动127.0.0.1随机端口server。
2. launch Chromium/Chrome。
3. navigate。
4. snapshot。
5. fill/click/check/select/press。
6. events读取增量。
7. viewport screenshot和target screenshot。
8. pages popup/list/close/reset。
9. close browser并断言进程退出。

不访问公网，不使用用户真实profile，不登录真实网站。

### E. 发行 smoke

Node npm package：

- 从仓库外临时目录安装本地packed packages。
- 运行 `beaupi --help` 后运行Playwright smoke host或SDK脚本。
- 确认依赖可解析且browser能launch。

Bun binary：

- 从归档外目录运行binary。
- 确认外置 `playwright`/`playwright-core` package可解析。
- 运行同一本地server的navigate+screenshot smoke。
- 确认不依赖仓库node_modules或构建机绝对路径。

跨平台CI至少检查六个平台归档包含所需package；真实browser launch优先Linux和Windows，macOS按runner预算决定。

## 安全回归

- URL credentials拒绝。
- metadata hostname和169.254.169.254永远拒绝。
- localhost允许；RFC1918默认拒绝，显式设置后允许。
- `file:`/`data:`/`javascript:`顶层导航拒绝。
- redirect和subresource重新验证。
- download取消，dialog dismiss，permissions为空。
- event/details不含cookie、Authorization、request headers、postData、完整response body。
- evaluate不能访问Node globals或本地文件。
- screenshot savePath遵守workspace/sensitive path分类。
- dispose后任何调用稳定失败，不重启browser。

## 性能与资源

- browser未使用时零进程、零Playwright模块加载。
- 首次launch时间记录但不设置脆弱毫秒断言。
- 100次snapshot/event读取不增长listener数量。
- event ring buffer保持上限。
- 重复reset/dispose无orphan Chromium。
- full-page大页面在像素预算前拒绝，不产生超大Buffer。

## 执行命令

实施时按仓库规则：

1. 每个新增/修改测试文件从 `packages/coding-agent` 运行定向Vitest。
2. 真实browser smoke使用专用脚本/测试入口，不运行完整直接Vitest suite。
3. 从仓库根运行 `./test.sh`。
4. 从仓库根运行 `npm run check`，修复全部error、warning和info。
5. `git diff --check` 和 `git status --short`。
6. 因本功能修改发行链，Bun/本地release smoke需要用户明确允许构建后再运行；不得自行运行 `npm run build` 或 `npm test`。

## 验收矩阵

| 能力 | Fake | Faux model | Real Chromium | Node package | Bun binary |
|---|---:|---:|---:|---:|---:|
| schema/details | ✓ |  |  |  |  |
| lifecycle/pages | ✓ | ✓ | ✓ | ✓ | ✓ |
| navigation/locator | ✓ | ✓ | ✓ | ✓ | ✓ |
| snapshot/events | ✓ | ✓ | ✓ | ✓ | ✓ |
| screenshot/TUI | ✓ | ✓ | ✓ | ✓ | ✓ |
| vision fallback |  | ✓ | optional real image | ✓ | ✓ |
| network/security | ✓ |  | ✓ | ✓ | ✓ |
| session dispose | ✓ | ✓ | ✓ | ✓ | ✓ |

## 完成条件

- 所有定向测试通过。
- `./test.sh`和`npm run check`通过。
- 真实localhost Chromium场景完成交互、console检查和截图。
- text-only与multimodal视觉路径均有确定断言。
- Node和Bun发行物从仓库外可用。
- 无orphan browser、无secret details、无browser自动下载、无新增真实Provider依赖。
