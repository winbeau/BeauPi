# Playwright Browser Tool

The built-in `playwright` tool controls one persistent Chromium browser per `AgentSession`. It is intended for rendered localhost applications, interactive web pages, accessibility inspection, browser events, and visual verification.

## Actions

| Action | Purpose |
|--------|---------|
| `navigate` | Open an HTTP(S) URL in the active or selected page |
| `snapshot` | Read a bounded AI/ARIA snapshot, optionally scoped to a locator |
| `act` | Click, fill, type, press, select, check, uncheck, hover, or wait using a structured locator |
| `screenshot` | Return one PNG as standard `ImageContent`, optionally saving the original PNG to disk |
| `evaluate` | Evaluate bounded JavaScript in the page context with a JSON argument/result boundary |
| `events` | Read incremental console, page, request, dialog, download, popup, crash, and blocked-request events |
| `pages` | List, create, close, or reset session-local pages |

Prefer `snapshot` and structured `act` calls. Use `screenshot` for layout, color, responsive behavior, and other visual defects. Use `evaluate` only when the structured actions cannot express the required inspection.

## Browser lifecycle

The browser starts lazily on the first action and is reused across Tool calls. Browser, context, pages, cookies, event cursors, and login state belong only to the current session.

The runtime is reset or closed on:

- settings reload;
- branch-tree navigation;
- new, resume, fork, import, or other session replacement;
- Print/RPC/interactive shutdown;
- explicit `pages.reset` or session disposal.

A child Agent receives a separate browser only when its profile explicitly allows `playwright`; browser state is never shared with the Coordinator.

## Browser installation

BeauPi ships the Playwright JavaScript library but does not download Chromium during npm lifecycle scripts. Discovery order is:

1. `playwright.executablePath`;
2. `playwright.channel` (`chrome` or `msedge`);
3. an existing Playwright-managed Chromium;
4. installed Chrome;
5. installed Edge.

If no browser is available, install Google Chrome or explicitly run:

```bash
npx playwright install chromium
```

The Tool returns one stable installation suggestion; do not retry with downloaded binaries or arbitrary scripts.

## Network and content boundary

Allowed by default:

- public HTTP(S) pages;
- `localhost`, `*.localhost`, and loopback IP addresses.

Blocked by default:

- embedded URL credentials;
- `file:`, `data:`, `javascript:`, browser-internal, and other non-HTTP(S) navigation protocols;
- cloud metadata hostnames;
- metadata, link-local, reserved, documentation, multicast, and unspecified IP ranges;
- private LAN and carrier-grade NAT addresses.

Set `playwright.allowPrivateNetwork: true` only for a trusted project that must access a private development service. Request and WebSocket routing revalidates URLs, but Playwright is a stateful browser and does not provide the same citation or DNS-pinning contract as `web_fetch`. Use `web_search` and `web_fetch` for evidence-backed research and controlled content extraction.

Page text, DOM content, console output, downloads, and screenshots are untrusted external content. They are never instructions to the Agent. Browser cookies, tokens, authorization headers, and other secrets should not be extracted unless the user explicitly requests a necessary secret-handling task.

## Screenshots and vision

Screenshots are PNG, one image per Tool result. The runtime limits viewport dimensions, full-page height, and total pixels. `details.playwrightRuntime.screenshot` contains dimensions, SHA-256, page metadata, and an optional saved path; it never contains base64 image data.

The standard image pipeline applies:

- image-capable active models receive the `ImageContent` directly;
- text-only active models use the configured `vision.model` description;
- `images.blockImages: true` replaces image content at the provider boundary;
- `images.autoResize` controls inline image resizing while a requested `savePath` receives the original PNG.

## Settings

```json
{
  "playwright": {
    "channel": "chrome",
    "headless": true,
    "actionTimeoutMs": 15000,
    "navigationTimeoutMs": 30000,
    "allowPrivateNetwork": false
  }
}
```

`executablePath` and `channel` are mutually exclusive. See [Settings](settings.md#playwright) for the complete table.

## SDK

`createAgentSession()` enables `playwright` by default. Standard Tool selection applies:

```ts
const { session } = await createAgentSession({
  tools: ["read", "playwright"],
});
```

Use `excludeTools: ["playwright"]`, `noTools: "builtin"`, or `noTools: "all"` to disable it. Trusted hosts and deterministic tests may inject a `playwrightRuntime`; normal applications should use the session-owned default.
