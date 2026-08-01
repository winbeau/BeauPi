# 04 TUI Interaction 与 Keybindings

## 目标

实现“询问 + 输入框 + 临时终端”一体化权限组件：先展示只读命令并等待用户 Enter，再用受控 PTY替换提示词编辑器；认证完成后 detach临时视图，command继续由 Monitor跟踪，最终由 Tool renderer显示结果。

## 现有接入点

- `QuestionSelectorComponent`：Focusable、Editor focus propagation、Abort、review和响应式布局参考。
- `InteractiveMode.showQuestionInteraction()`：Runtime handler绑定和Tool等待用户交互参考。
- `showExtensionCustom(..., { overlay: true })`：overlay焦点、尺寸、dispose和编辑器恢复。
- `BashExecutionComponent`/Tool renderer：最终 Transcript输出。

## Component 状态机

```text
review
  ├─ Enter -> starting -> authenticating/running
  └─ Cancel -> cancelled
running
  ├─ secure input -> pane
  ├─ password prompt remains -> keep terminal attached
  ├─ cursor leaves auth prompt -> detach view -> Monitor continues
  └─ Abort -> cancelling -> cancelled/failed
complete
  └─ Tool result renderer
```

### Review 状态

显示：

- `Permission required`、request source和“每条sudo命令都需要确认”。
- `Local` 或 target+terminalId。
- cwd。
- 完整命令（只读、ANSI-aware wrap）。
- 审计日志路径。
- “Authentication input is private and is not recorded.”
- Enter run、Cancel。

命令看起来像预填 shell line，但不使用可编辑 `Editor`；只有 Enter调用 `control.start()`。

### Running 状态

- 标题切换为 `Authenticating` 或 `Running as root`。
- 只渲染 pane capture，绝不把本地输入回显到 component state。
- 输入字节直接传给 `control.sendSensitive()`。
- sudo/outer wrapper负责 no-echo；component不保存 password buffer。
- 显示 elapsed、target、cancel hint；Terminal output可滚动或只显示尾部窗口。
- tmux当前光标离开认证提示后停止UI timer/poll并调用 done(response)；Runtime继续等待command完成。
- 如果没有密码prompt，pane进入稳定running状态后detach；密码错误并再次提示时保持attached。

## Handler

新增：

```typescript
AgentSession.setPrivilegeInteractionHandler(handler | undefined)
```

InteractiveMode在初始化时绑定 `showPrivilegeInteraction()`；local Bash、terminal_bash和显式privileged_exec共用该handler。print/JSON默认 unset；RPC第一版返回 interaction_required。SDK可显式注入 handler，但API不得提供 password或confirmation bypass字段。

handler必须：

- 监听 Tool AbortSignal。
- component关闭时取消 pending capture/send。
- Session replacement/reload/dispose时关闭 overlay并返回 cancelled。
- 不从 callback并发启动Agent turn。

## Keybindings

禁止硬编码。向 `DEFAULT_APP_KEYBINDINGS` 添加：

- `app.privilege.confirm`：默认 `enter`，review时启动。
- `app.privilege.cancel`：默认 `escape`，review时拒绝；running时发送受控取消并等待cleanup。
- `app.privilege.scrollUp`/`scrollDown`：可复用 `tui.select.pageUp/pageDown` 或新增明确 action。
- `app.privilege.details`：可复用 `app.tools.expand` 展示完整command/audit details。

文档同步 `packages/coding-agent/docs/keybindings.md`。

## Layout

- 所有宽度都替换 editor，不使用overlay；上下两条分割线之间渲染tmux pane，避免原提示词输入框继续占据焦点或造成输入目标歧义。
- pane高度按可见输出行数增长，最小3行、最大12行且不超过终端高度的三分之一；render和tmux resize使用同一行数。
- 40/80/120/160列均保证 `visibleWidth <= width`。
- dark/light复用现有 accent/warning/error/muted/tool色，不先新增Theme token。
- Error、blocked、echo recovery失败不可完全折叠。
- 组件必须实现 invalidate并停止poll timer。

## 用户输入安全

- component state不含input string、字符计数或last key。
- 不调用 `Editor.setText(password)`、clipboard、external editor或question notes。
- secure send失败时错误只包含bufferId/requestId，不包含input。
- debug/TUI raw ANSI log可能记录pane output，因此outer no-echo是强制条件。
- 执行结束后不得继续接受input。

## 测试

- Enter前 `control.start()`零调用；Enter后恰好一次。
- cancel before start、cancel during prompt、AbortSignal、dispose。
- input只进入fake `sendSensitive`，render/cache/response无input。
- capture更新、terminal exit、send failure、echo recovery warning。
- editor文本和焦点在overlay关闭后恢复。
- configurable keybindings，不能依赖hardcoded Enter/Escape。
- dark/light 40/80/120/160、CJK/emoji/长command/path。

## 完成状态

- [x] TUI交互设计
- [x] keybinding defaults/types/docs
- [x] PrivilegeTerminalComponent
- [x] InteractiveMode handler
- [x] run-mode boundaries
- [x] TUI tests
