# M16 原生 Playwright 工具实施计划

状态：已定义，等待实施。

## 目标

在现有 `packages/coding-agent` 中增加一个原生内置 `playwright` Tool，使 Agent 能在同一 Session 内持续控制真实浏览器，用于本地网页开发、交互调试、DOM/ARIA 检查、控制台错误检查和截图视觉验证。

本阶段不创建 Extension Package、第二套 Agent Runtime、后台浏览器守护进程或独立视觉 Agent。浏览器由唯一的 session-scoped `PlaywrightRuntime` 管理，截图继续走现有 Tool Result 图片链路：

```text
playwright(action=screenshot)
  -> ToolResultMessage.content: [TextContent, ImageContent]
  -> active model supports image: direct multimodal input
  -> active model is text-only: existing VisionService -> vision.model description
  -> main Agent continues with screenshot or description
```

因此，`playwright` Tool 本身不重复调用视觉模型，不增加 Playwright 专属模型设置，也不在主模型已能看图时产生双重视觉费用。

## 已确认设计决策

1. 工具名固定为 `playwright`；不再使用 Watch 命名。
2. 一个 Tool 使用严格 TypeBox discriminated union，不拆成十多个独立浏览器 Tool。
3. 第一版只支持 Chromium 内核；Firefox/WebKit 留到后续兼容阶段。
4. Browser、Context、Page 都属于当前 `AgentSession`，浏览器首次调用时才启动。
5. 浏览器页面跨 Tool call 保留，但 `/new`、resume、fork、Session replacement、dispose 后不恢复实时页面或登录状态。
6. 所有浏览器动作串行执行；同一 Assistant message 中不能并行修改同一 Page。
7. 优先用 ARIA snapshot 和结构化 locator；截图只用于布局、颜色、响应式和视觉缺陷判断。
8. 页面内容、DOM 文本、console 文本和截图均是不可信外部内容，不能作为 Agent 指令执行。
9. 第一版允许公网 HTTP(S) 和 localhost/loopback，默认阻止 URL credentials、`file:`、`data:`、`javascript:`、浏览器内部协议、云 metadata 和私有 LAN；私有 LAN 需显式设置开启。
10. 不静默下载浏览器，不在 npm lifecycle 中自动安装大型 Chromium；缺失时返回稳定诊断和单一安装建议。
11. 使用 Playwright Library 生产依赖，不引入 `@playwright/test` Test Runner。
12. Node npm 发行和 Bun standalone binary 都必须通过真实启动 smoke test后才能验收。

## 阶段概览

实施固定按 P1→P6 推进：

| 阶段 | 主要交付 | 稳定结果 |
|---|---|---|
| P1 | Tool contract、严格 schema、版本化 details、错误码 | 模型只看到一个有界、可验证的 `playwright` Tool |
| P2 | Browser loader、Session runtime、Page registry、网络边界 | 浏览器懒启动、跨调用复用并在 Session 结束时确定性关闭 |
| P3 | Navigate、snapshot、act、evaluate、events、pages | Agent 可完成页面检查与交互，不依赖任意 shell Playwright 脚本 |
| P4 | Screenshot、图片处理、TUI、vision.model 回退 | 截图可内联显示并被多模态或独立视觉模型理解 |
| P5 | AgentSession、Policy、Dynamic Tasks、SDK、依赖与发行 | Tool 成为真正 builtin，并覆盖 Node/Bun 分发路径 |
| P6 | Fake adapter、真实 Chromium、faux vision、恢复与安全测试 | 定向、非 E2E、真实浏览器和发行 smoke 全部闭环 |

## 稳定工具接口

建议第一版只暴露七个顶层 action，避免把整个 Playwright API 原样塞进 Tool schema：

```typescript
type PlaywrightInput =
  | NavigateInput
  | SnapshotInput
  | ActInput
  | ScreenshotInput
  | EvaluateInput
  | EventsInput
  | PagesInput;
```

### `navigate`

- 输入：`url`、可选 `pageId`、`waitUntil`、`timeoutMs`、viewport。
- 默认 `waitUntil: "domcontentloaded"`；不默认使用官方不推荐的 `networkidle`。
- 输出：最终 URL、title、主文档 HTTP status、重定向次数、当前 Page ID、console/page error 增量摘要。

### `snapshot`

- 输入：可选 `pageId`、target、depth、boxes、最大字符数。
- 默认生成面向 Agent 的 ARIA snapshot；若固定依赖版本的实际类型不支持 `mode: "ai"`，则在实现前升级到支持该 API 的精确版本，而不是手写不兼容替代协议。
- 输出应用现有 2,000 行/50 KiB 上限；完整超限 snapshot 写入临时文件并返回路径。

### `act`

- `kind`：`click`、`fill`、`type`、`press`、`select`、`check`、`uncheck`、`hover`、`waitFor`。
- target 只允许结构化策略：role/name、text、label、placeholder、testId、CSS，并支持可选 `nth`。
- 依赖 Playwright locator auto-wait；不提供任意 sleep action。
- 每次动作返回 target 摘要、URL/title 变化和新增 console/page error。

### `screenshot`

- 输入：可选 `pageId`、target、`fullPage`、viewport、可选 `savePath`。
- 第一版固定 PNG，不增加 JPEG quality、动画录制或视频。
- 输出：简短文本 + `ImageContent`；details 只保存 hash、尺寸、Page、URL、是否 full page 和可选保存路径，不重复保存 base64。

### `evaluate`

- 输入：JavaScript expression 和可选 JSON argument。
- 只在浏览器页面上下文执行，不能访问 Node、Agent 环境或本地文件系统。
- 结果必须可 JSON 序列化并受字符/深度上限；Handle、函数、循环对象和超限值返回结构化诊断。

### `events`

- 返回 console warning/error、page error、request failed、dialog、download blocked 等有界事件。
- 使用单调 cursor，只返回新增事件；不重复向上下文注入历史日志。

### `pages`

- `operation`：`list`、`new`、`close`、`reset`。
- 默认 Page ID 为 `main`；popup 和新 Page 使用稳定 session-local ID。
- `reset` 关闭旧 Context 并创建干净 Context，不恢复 cookie/localStorage。

## 版本化结果

```typescript
interface PlaywrightRuntimeToolDetailsV1 {
  version: 1;
  operation: PlaywrightInput["action"];
  ok: boolean;
  pageId?: string;
  url?: string;
  title?: string;
  durationMs: number;
  eventCursor?: number;
  snapshot?: {
    truncated: boolean;
    outputCharacters: number;
    fullOutputPath?: string;
  };
  screenshot?: {
    mimeType: "image/png";
    width: number;
    height: number;
    sha256: string;
    fullPage: boolean;
    savedPath?: string;
  };
  diagnostic?: {
    code:
      | "browser_unavailable"
      | "browser_launch"
      | "invalid_url"
      | "blocked_target"
      | "page_not_found"
      | "locator_not_found"
      | "navigation"
      | "timeout"
      | "serialization"
      | "cancelled"
      | "browser_disconnected"
      | "internal";
    message: string;
    suggestion?: string;
  };
}
```

预期运行失败返回 `ok: false` 的普通 Tool Result，保留 details 并由 AgentSession 设置 `isError`；只有 invariant 或编程错误继续抛异常。

## 生命周期

```text
createAgentSession
  -> create PlaywrightRuntime (browser not launched)
  -> register builtin playwright Tool
  -> first playwright call
      -> load Playwright library
      -> resolve Chromium executable/channel
      -> launch Browser
      -> create ephemeral BrowserContext
      -> create main Page
  -> later calls reuse Browser/Context/Page
  -> reload/reset/session replacement/dispose
      -> abort active action
      -> close pages/context/browser
      -> clear registry/events
```

Browser crash或断开时清除陈旧引用。下一次 Tool call允许一次懒重启；同一次失败动作不无限自动重试。

## 与现有系统的关系

- `web_search`/`web_fetch`：继续负责搜索、引用、正文和 SSRF-safe fetch；`playwright` 负责渲染、交互、本地开发和视觉检查。
- `background_start`：负责启动 `npm run dev` 等长驻开发服务器；`playwright` 不管理项目进程。
- `VisionService`：继续是 text-only 主模型的统一图片回退，不增加 `playwright.visionModel`。
- `ToolExecutionComponent`：已经能渲染任意 Tool image result；只需 Playwright 自定义文字 renderer，不增加第二套图片组件。
- `PolicyRuntime`：增加浏览器 action 分类与失败事实，但仍为 advisory-only；URL hard block在 Playwright 网络策略层完成。
- `DynamicTaskRuntime`：`snapshot`、`screenshot`、`events` 可作为 verification 事实；页面交互不算 workspace mutation。
- `AgentPool`：子 Agent 只有 Profile 明确 allowlist `playwright` 时才获得独立 Runtime，不共享 Coordinator Browser。

## 依赖关系

```text
P1 contract/schema
  -> P2 browser runtime/network policy
      -> P3 navigation/interaction/snapshot
          -> P4 screenshot/vision/TUI
              -> P5 AgentSession/SDK/package/Bun
                  -> P6 tests/acceptance
```

## 子计划索引

- [01 Tool Contract 与 Schema](./16-native-playwright/01-tool-contract-and-schema.md)
- [02 Browser Runtime 与 Lifecycle](./16-native-playwright/02-browser-runtime-and-lifecycle.md)
- [03 Navigation、Interaction 与 Snapshot](./16-native-playwright/03-navigation-interaction-and-snapshot.md)
- [04 Screenshot 与 Vision Pipeline](./16-native-playwright/04-screenshot-and-vision-pipeline.md)
- [05 AgentSession、Policy 与 Packaging](./16-native-playwright/05-session-policy-and-packaging.md)
- [06 Tests 与 Acceptance](./16-native-playwright/06-tests-and-acceptance.md)

## 明确不做

- 不实现 Watch/background auto-refresh Tool。
- 不实现浏览器录像、trace viewer、HAR、PDF、下载、文件上传或持久 Chrome profile。
- 不把网页正文当作可引用研究来源；需要引用仍使用 `web_fetch`。
- 不开放任意 Node Playwright 脚本执行。
- 不自动接受浏览器权限、下载或系统对话框。
- 不把 cookie、Authorization header、localStorage 或完整 DOM 默认写入 Session details。
- 不在第一版支持远程浏览器、CDP endpoint、Firefox 或 WebKit。

## 实施完成定义

- 主 Agent 可启动本地 dev server后，用 `playwright` 导航、snapshot、交互、检查 console并截图。
- 截图在图像模型中直接可见；text-only 主模型通过现有 `vision.model` 得到描述。
- `--tools playwright`、`--exclude-tools playwright`、`--no-builtin-tools`、SDK allowlist和自定义同名覆盖均行为正确。
- Session dispose、reload、branch/session replacement后无残留 Browser 进程或旧 Page 引用。
- Node npm CLI与Bun standalone binary均能加载 Playwright library并启动已安装的 Chromium/Chrome。
- 定向测试、`./test.sh`、`npm run check`和真实 Chromium smoke通过。
