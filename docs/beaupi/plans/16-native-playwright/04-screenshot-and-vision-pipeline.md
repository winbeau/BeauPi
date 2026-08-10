# 04 Screenshot 与 Vision Pipeline

状态：已定义。

## 目标

让 `playwright(action="screenshot")` 返回可持久化、可在TUI展示、可由主多模态模型或现有 `vision.model` 理解的图片结果，同时限制像素、内存、Session体积和重复视觉调用。

## 文件范围

修改：

- `packages/coding-agent/src/core/playwright/operations.ts`
- `packages/coding-agent/src/core/playwright/tools.ts`
- `packages/coding-agent/src/core/playwright/renderer.ts`
- 必要时复用 `packages/coding-agent/src/utils/image-process.ts`
- 必要时补充 `packages/coding-agent/src/utils/image-resize.ts` 的调用测试，不新增Playwright专属图片处理器

测试：

- `packages/coding-agent/test/playwright-screenshot.test.ts`
- `packages/coding-agent/test/playwright-vision-session.test.ts`
- 修改 `packages/coding-agent/test/tool-execution-component.test.ts`

## Screenshot 执行

1. 获取Page或target locator。
2. 在截图前读取viewport/目标bounding box和页面尺寸。
3. 拒绝超过安全像素预算的full-page截图，或按固定上限降级为viewport截图并返回hint；不能先生成超大Buffer再判断。
4. 调用Playwright PNG screenshot并获得Buffer。
5. 通过现有 `processImage(buffer, "image/png", { autoResizeImages })` 标准化、缩放和base64编码。
6. 生成SHA-256、原始/内联尺寸和可选保存路径。
7. 返回文本块 + 图片块。

建议限制：

- viewport最大3840×2160。
- full-page最大高度20,000 CSS px、最大原始像素40 MP；最终值在实现时结合Playwright实际类型和内存测试固定。
- 单次Tool只返回1张图片。
- screenshot固定PNG。

## Tool Result

```typescript
{
  content: [
    {
      type: "text",
      text: "Screenshot captured: page=main, 1440x900, url=http://127.0.0.1:3000/"
    },
    {
      type: "image",
      data: processed.data,
      mimeType: processed.mimeType
    }
  ],
  details: {
    playwrightRuntime: {
      version: 1,
      operation: "screenshot",
      ok: true,
      screenshot: {
        mimeType: "image/png",
        width: 1440,
        height: 900,
        sha256: "...",
        fullPage: false
      }
    }
  }
}
```

不在details中保存base64，不把完整图片额外写进custom entry或Task Ledger。

## 可选保存路径

- 只有调用显式提供 `savePath` 时落盘。
- 路径解析复用现有cwd/path helper，二进制写入必须进入同路径mutation queue。
- 工作区外路径和敏感路径由Policy分类并产生advisory；Tool仍遵循现有advisory-only策略。
- 保存原始PNG，Tool内联图片可以是经过 `images.autoResize` 缩小后的版本。
- 不默认向项目写 `.beaupi/screenshots`，避免无请求的工作区污染。

## 视觉模型接入

不在PlaywrightRuntime中创建VisionService或直接调用Provider。现有链路已经在 `createAgentSession()` 的 `convertToLlm` 包装中统一处理User/Tool Result图片：

- 当前模型 `input` 包含 `image`：直接把screenshot发给当前模型。
- 当前模型不支持图片且 `vision.model` 可用：`VisionService.describeImage()`调用配置的视觉模型，缓存相同图片hash，并把描述替换进主模型上下文。
- `images.blockImages: true`：图片被统一阻止，Playwright不绕过该设置。
- 视觉模型失败：主模型收到现有“image unavailable”文本。

这保证Read图片、剪贴板图片和Playwright截图遵循同一安全/配置语义。

## VisionService 通用改进边界

P4只补Playwright端到端回归，不为截图创建功能专属模型或prompt。若测试发现VisionService usage没有进入现有Session usage统计，应作为通用VisionService修复处理，不能只在Playwright Tool里做补偿性计费。

如未来需要“即使主模型支持图片也强制使用独立视觉模型”或自定义视觉问题，应另设通用 `VisionService.analyzeImage(image, prompt)` 里程碑；第一版不加入 `visionPrompt` 字段。

## TUI

`ToolExecutionComponent` 已自动：

- 检测Tool Result中的image blocks。
- Kitty环境必要时转换PNG。
- 按 `terminal.showImages` 和 `terminal.imageWidthCells` 展示。
- 无图片能力时显示mime/dimension fallback。

因此只实现Playwright文字renderer：折叠时显示 `Screenshot 1440×900 · main · App`，展开时显示URL、full-page、hash和保存路径。图片继续由通用组件追加，不能重复显示。

## Session 与缓存

- 图片仍按普通Tool Result写入Session JSONL；不新建图片数据库。
- VisionService按图片data hash缓存，重复相同截图不会重复调用视觉模型。
- Playwright Tool自身可记录最近screenshot hash用于UI提示，但不因hash相同省略本次图片，除非后续单独设计去重协议。
- Compact/resume保留历史图片消息，但实时Page状态不恢复。

## 完成条件

- fake screenshot Buffer正确变成PNG ImageContent且details无base64。
- text-only主模型场景中，faux vision调用一次并把页面描述送入下一次主模型请求。
- multimodal主模型场景中不调用独立vision model。
- `images.blockImages` 阻止截图外发。
- TUI有/无图片能力、折叠/展开、80/120/160列均正常。
- full-page像素预算、savePath、取消和图片处理失败返回结构化结果。
