# 04 TUI Interaction 与 Keybindings

## 目标

实现“已填充命令 + 临时终端”一体化权限组件：第一帧直接用受控 PTY替换提示词编辑器并显示完整只读命令或批次；用户 Enter 后才执行，Escape取消；认证后继续attached并转发输入，直到command或交互式sudo shell退出，最终由Tool renderer显示结果。

## 现有接入点

- `QuestionSelectorComponent`：Focusable、Editor focus propagation、Abort、review和响应式布局参考。
- `InteractiveMode.showQuestionInteraction()`：Runtime handler绑定和Tool等待用户交互参考。
- `showExtensionCustom(..., { overlay: true })`：overlay焦点、尺寸、dispose和编辑器恢复。
- `BashExecutionComponent`/Tool renderer：最终 Transcript输出。

## Component 状态机

```text
staging -> waiting_for_user
  ├─ Enter -> starting -> authenticating/running
  └─ Escape -> cancelled（command未执行）
running
  ├─ direct terminal bytes -> pane
  ├─ password prompt remains -> keep terminal attached
  ├─ authentication completes -> remain attached for command/root shell
  ├─ command or `exit` -> complete
  └─ Abort/Escape -> cancelling -> terminate privilege flow
complete
  └─ Tool result renderer
```

### Staged 状态

- 第一帧已经是上下两条分割线之间的tmux pane，不再显示独立`Permission required`页面。
- `control.start()`只创建/占用pane并显示`$ <完整命令>`，wrapper停在门控read，sudo尚未执行。
- 命令只读、ANSI-aware wrap，不使用可编辑`Editor`，普通字符输入在此状态被忽略。
- Enter调用`control.execute()`释放门控；Escape调用cancel并关闭pane，command不会执行。
- `Local`或target+terminalId、执行提示和可配置keybinding显示在分割线标题/底部hint中。

### Running 状态

- 标题切换为 `Authenticating` 或 `Running`，交互式sudo shell继续显示实时pane内容和光标。
- 只渲染 pane capture，绝不把本地输入回显到 component state。
- 输入字节直接传给 `control.sendSensitive()`。
- sudo controlling TTY负责密码期间的 no-echo；component不保存 password buffer，wrapper不关闭整个root shell的回显。
- 显示 elapsed、target、cancel hint；Terminal output可滚动或只显示尾部窗口。
- tmux当前光标离开认证提示后仍继续UI timer/poll和输入转发，直到command完成或用户从交互式sudo shell执行`exit`。
- 如果没有密码prompt，pane直接进入running但不detach。Escape在running状态终止当前提权流程，不能留下隐藏root shell。

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

- `app.privilege.confirm`：默认 `enter`，waiting_for_user时执行已填充command。
- `app.privilege.cancel`：默认 `escape`，staged时取消且不执行；running时发送受控取消并等待cleanup。
- `app.privilege.scrollUp`/`scrollDown`：可复用 `tui.select.pageUp/pageDown` 或新增明确 action。
- `app.privilege.details`：可复用 `app.tools.expand` 展示完整command/audit details。

文档同步 `packages/coding-agent/docs/keybindings.md`。

## Layout

- 所有宽度都替换 editor，不使用overlay；上下两条分割线之间渲染tmux pane，避免原提示词输入框继续占据焦点或造成输入目标歧义。
- pane高度按可见输出行数增长，最小3行、最大12行且不超过终端高度的三分之一；render和tmux resize使用同一行数。
- 40/80/120/160列均保证 `visibleWidth <= width`。
- dark/light复用现有 accent/warning/error/muted/tool色，不先新增Theme token。
- Error、blocked、terminal recovery失败不可完全折叠。
- 组件必须实现 invalidate并停止poll timer。

## 用户输入安全

- component state不含input string、字符计数或last key。
- 不调用 `Editor.setText(password)`、clipboard、external editor或question notes。
- secure send失败时错误只包含bufferId/requestId，不包含input。
- debug/TUI raw ANSI log可能记录pane output，因此认证输入只能在sudo主动关闭TTY echo期间发送；component不得自行回显或缓存。
- 执行结束后不得继续接受input。

## 测试

- component首帧自动调用一次`control.start()`完成stage；Enter前`control.execute()`零调用，Enter后恰好一次。
- Escape staged command、cancel during prompt、AbortSignal、dispose。
- input只进入fake `sendSensitive`，render/cache/response无input。
- capture更新、terminal/root-shell exit、send failure、terminal recovery warning。
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
