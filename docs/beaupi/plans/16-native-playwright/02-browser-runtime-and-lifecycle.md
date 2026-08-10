# 02 Browser Runtime 与 Lifecycle

状态：已定义。

## 目标

实现唯一 session-scoped `PlaywrightRuntime`，负责Playwright library加载、Chromium发现、Browser/Context/Page生命周期、串行执行、事件缓存和确定性清理。

## 文件范围

新增：

- `packages/coding-agent/src/core/playwright/browser-loader.ts`
- `packages/coding-agent/src/core/playwright/network-policy.ts`
- `packages/coding-agent/src/core/playwright/runtime.ts`
- `packages/coding-agent/src/core/playwright/adapter.ts`

测试：

- `packages/coding-agent/test/playwright-runtime.test.ts`
- `packages/coding-agent/test/playwright-network-policy.test.ts`

## 外部依赖加载

生产依赖使用精确版本 `playwright`，不使用 `@playwright/test`。

实现前必须：

1. 用 `npm install --ignore-scripts` 加入精确版本。
2. 完整检查 `node_modules/playwright` 和 `node_modules/playwright-core` 的实际类型与package metadata。
3. 不猜 `Page.ariaSnapshot`、AbortSignal、screenshot Buffer或browser channel API。
4. 若依赖有 lifecycle script，先审查，再显式更新 shrinkwrap/install-lock allowlist；不能静默加入。

为避免Node CLI启动时立即加载大型Playwright模块，并兼容Bun compiled binary，使用顶层 `import type` + `createRequire(import.meta.url)` 的同步懒加载器；不使用inline `await import()`。

## Runtime 状态

```typescript
class PlaywrightRuntime {
  private browser?: Browser;
  private context?: BrowserContext;
  private pages = new Map<string, PageRecord>();
  private activePageId?: string;
  private events: PlaywrightEventRecord[];
  private eventSequence: number;
  private disposed: boolean;
  private tail: Promise<void>;
}
```

`PageRecord`只保存Page引用、稳定pageId、创建时间、最近URL和事件listener清理函数。不要保存DOM、cookie或snapshot正文。

## Browser 解析顺序

1. 可信设置中的显式 `playwright.executablePath`。
2. Playwright managed Chromium的 `chromium.executablePath()`，但必须先确认文件存在。
3. 系统安装channel，按平台尝试 `chrome`，再尝试 `msedge`。
4. 全部失败返回 `browser_unavailable`，附一个安装建议。

第一版不自动联网下载browser，不调用sudo，不在Tool内部运行package manager。

## Context 默认值

- headless默认true。
- viewport默认1440×900。
- ephemeral context；不传用户数据目录，不复用个人Chrome profile。
- `acceptDownloads: false`；download事件记录并取消。
- 不授予geolocation、camera、microphone、clipboard等permissions。
- dialog默认dismiss并写事件；不让模型无限等待对话框。
- action timeout默认15秒；navigation timeout默认30秒。
- 默认不忽略HTTPS错误；后续可增加受控设置。

## Page registry

- 首次创建 `main`。
- `pages.new` 分配 `page-2`、`page-3` 等稳定ID。
- popup自动注册新Page并写event。
- close后从Map删除；关闭active Page时选择最早仍存活Page。
- `pages.reset` 关闭旧Context，清空Page和event状态后新建干净Context/main Page。
- Page crash/close/disconnect均更新Runtime状态；下次调用不能复用旧引用。

## 串行和取消

- Tool definition设置 `executionMode: "sequential"`。
- Runtime内部仍使用Promise tail串行，防止SDK直接调用或未来registry变化破坏顺序。
- 每个action绑定Tool AbortSignal和timeout。
- 取消时停止当前操作；必要时关闭受影响Page并在下次调用重建，不保留半完成navigation。
- `dispose()`幂等：拒绝新调用、abort active action、移除listener、关闭context和browser、清空registry。

Browser断开后允许下一次调用一次懒重启；同一调用不进行无界重试。

## 网络硬边界

允许：

- `http:`、`https:`
- `about:blank`
- localhost、`*.localhost`、127.0.0.0/8和`::1`
- 公网地址

默认阻止：

- URL credentials
- `file:`、`data:`、`javascript:`、`blob:`顶层导航、`chrome:`、`edge:`、extension协议
- metadata hostname和link-local/metadata IP
- RFC1918、CGNAT和ULA私有LAN；只有 `playwright.allowPrivateNetwork: true` 时允许，但metadata仍永远阻止

Context route拦截主文档和subresource，对每个HTTP(S) request执行URL/hostname/DNS分类。可以复用M8的地址分类常量，但不能声称具备 `web_fetch` 的固定DNS连接保证：Chromium最终连接仍由browser网络栈完成，存在验证与连接之间的DNS TOCTOU。文档必须明确 `playwright` 是有状态浏览器能力，不是citation-safe或SSRF-pinned fetch。

## Event ring buffer

捕获：

- console warning/error
- pageerror
- requestfailed
- dialog dismissed
- download blocked
- popup/page close/crash
- browser disconnected

每条event包含sequence、timestamp、pageId、kind、短消息和可选URL。禁止保存request headers、response body、cookie或postData。

## 完成条件

- Fake adapter下lazy launch、Page复用、popup、reset、crash、disconnect、cancel、dispose均确定。
- Session结束后无live browser/context/page引用。
- URL policy覆盖localhost/public/private/metadata/credentials/协议和redirect/subresource。
- browser缺失只返回一个结构化诊断，不产生重复spawn/download。
