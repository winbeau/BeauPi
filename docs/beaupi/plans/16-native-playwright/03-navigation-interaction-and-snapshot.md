# 03 Navigation、Interaction 与 Snapshot

状态：已定义。

## 目标

在P1/P2 Runtime上实现页面导航、可访问性snapshot、结构化交互、受控evaluate、事件增量和多Page管理，使Agent无需生成任意Node Playwright脚本即可完成网页开发调试。

## 文件范围

新增或修改：

- `packages/coding-agent/src/core/playwright/locator.ts`
- `packages/coding-agent/src/core/playwright/operations.ts`
- `packages/coding-agent/src/core/playwright/tools.ts`
- `packages/coding-agent/src/core/playwright/renderer.ts`

测试：

- `packages/coding-agent/test/playwright-tool.test.ts`
- `packages/coding-agent/test/playwright-locator.test.ts`
- `packages/coding-agent/test/playwright-renderer.test.ts`

## Locator 解析

单一 `resolveLocator(page, target)` 负责全部target策略：

- role：`getByRole()` + name/exact
- text：`getByText()`
- label：`getByLabel()`
- placeholder：`getByPlaceholder()`
- testId：`getByTestId()`
- CSS：`locator()`
- `nth`在最后统一应用

不让每个action各自拼locator。错误必须区分0个命中、多个命中和actionability timeout；默认要求唯一目标，避免模型误点第一个匹配项。

## Navigate

步骤：

1. 校验URL和网络策略。
2. 获取或创建Page。
3. 应用可选viewport。
4. `page.goto()`，默认 `domcontentloaded`。
5. 收集最终URL、title、status、redirect信息和本次新增event。
6. 返回短摘要，不自动附加完整snapshot或screenshot。

HTTP 4xx/5xx不是Playwright API异常，但Tool details应保留status并以 `ok: true` 返回已完成navigation；Agent可据此判断页面错误。TLS、DNS、blocked target和timeout返回 `ok: false`。

## Snapshot

优先使用固定依赖版本公开类型中的AI/ARIA snapshot API，并允许boxes/depth。若API返回element refs但没有公开稳定的ref locator接口，第一版只把refs用于阅读，不允许把内部selector语法写入Tool contract。

输出格式：

```text
Page: main
URL: http://127.0.0.1:3000/
Title: App
Snapshot boundary: untrusted rendered page content

<bounded aria snapshot>
```

规则：

- 可选target时对局部locator生成snapshot。
- 默认depth有界，防止大型页面无限展开。
- 截断沿用50 KiB/2,000行；完整内容写临时文件。
- 页面文本中的“system prompt”“run command”等仍只是页面内容。

## Act

动作映射：

- click：locator.click
- fill：locator.fill
- type：locator.pressSequentially或固定版本公开等价API
- press：locator.press
- select：locator.selectOption
- check/uncheck：locator.check/uncheck
- hover：locator.hover
- waitFor：locator.waitFor

实现前检查node_modules实际类型，不为兼容旧版本保留两套API。

所有动作：

- 依赖locator auto-wait和actionability。
- 不默认force；只有未来明确需求才加入受限字段。
- 不使用固定sleep或自动重试不同selector。
- 完成后返回URL/title变化和event增量。
- 不自动截图，避免每次click产生大图片和视觉模型调用。

## Evaluate

- expression最多16 KiB，argument必须是JSON值。
- 在Page context执行，不使用Node `eval`/`new Function`。
- 输出经过稳定serializer：限制深度、数组项数、对象键数、字符串长度和总字符。
- 对undefined、NaN、Infinity等使用明确JSON兼容表示。
- DOM node、JSHandle、函数、symbol和循环引用返回 `serialization` diagnostic。
- 默认不记录expression结果到details，只在content返回有界文本。

`evaluate`属于高级逃生口；prompt要求优先snapshot和结构化act，不用evaluate重写普通click/fill流程。

## Events

输入cursor，输出 `(cursor, current]` 的event；省略时返回当前Page最近事件但不超过上限。结果包含nextCursor，模型后续只读取新增event。

Console log默认只保留warning/error；普通log可通过可选level显式请求。requestfailed只保留method、URL、failure text，不保留header/body。

## Pages

- list：Page ID、active、URL、title、closed。
- new：创建空白Page并设为active。
- close：关闭指定Page；最后一个Page关闭后自动新建main或保持空状态，二者需在实现前固定，推荐自动新建main。
- reset：清空Context和登录状态，重新创建main。

## Renderer

调用折叠行示例：

```text
Playwright[main](navigate http://127.0.0.1:3000)
Playwright[main](click role=button name="Save")
Playwright[main](snapshot)
```

结果折叠：

- navigate：`App · 200 · http://127.0.0.1:3000/`
- act：`clicked · URL unchanged · 1 console error`
- snapshot：`84 lines · Ctrl+O to expand`
- events：`3 new events · cursor 18`

必须使用M1 minimal Tool shell，80/120/160列不溢出；不重新实现图片渲染。

## 完成条件

- Fake Page下所有locator策略和action调用参数准确。
- 0/多匹配、timeout、navigation status、event cursor和serialization边界有定向测试。
- snapshot超限有完整文件路径，页面内容边界明确。
- Agent可以按 navigate→snapshot→act→events 的最短链调试网页。
