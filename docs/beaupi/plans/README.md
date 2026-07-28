# Claude Code 风格 TUI 调整计划

## 目的

本目录存放 BeauPi 第一开发里程碑的全部实施计划。目标是在现有 Pi TUI 上重做视觉层，不复制 Runtime、Tool 执行逻辑或外部 React/Ink 组件。

总设计规范见 [Claude Code 风格 TUI](../ui-style.md)，里程碑见 [开发里程碑](../milestones.md)。本目录负责回答“按什么顺序修改哪些文件、保留哪些行为、如何测试和验收”。

## 阅读与实施顺序

1. [设计约束](./00-design-contract.md)
2. [现状与差距](./01-current-state-and-gaps.md)
3. [主题与视觉基础](./02-theme-and-visual-foundation.md)
4. [消息布局](./03-message-layout.md)
5. [Tool Shell 与生命周期](./04-tool-shell-and-lifecycle.md)
6. [Read、Search、List 与 Bash](./05-read-search-list-bash.md)
7. [Write 与 Edit](./06-write-and-edit.md)
8. [Structured Diff](./07-structured-diff.md)
9. [Footer 与状态数据](./08-footer-and-run-status.md)
10. [Compact、加载与重试](./09-compact-loading-and-retry.md)
11. [宽度、缓存与性能](./10-responsive-width-and-performance.md)
12. [未来组件视觉契约](./11-future-component-contracts.md)
13. [测试与视觉回归](./12-testing-and-visual-regression.md)
14. [实施批次与文件清单](./13-implementation-sequence.md)
15. [最终验收清单](./14-acceptance-checklist.md)

## 计划状态

| 计划 | 状态 | 前置条件 |
|---|---|---|
| 设计约束 | 已定义 | 无 |
| 现状盘点 | 已定义 | 无 |
| 主题与视觉基础 | 已完成（Batch 1） | 设计约束 |
| 消息布局 | 已完成（Batch 2） | 主题基础 |
| Tool Shell | 已完成（Batch 3） | 主题基础 |
| Read/Search/List/Bash | 已完成（Batch 4、9） | Tool Shell |
| Write/Edit | 已完成（Batch 5、6） | Tool Shell |
| Structured Diff | 已完成（Batch 6） | 主题基础、Write/Edit |
| Footer | 已完成（Batch 7） | 主题基础 |
| Compact/加载/重试 | 已完成（Batch 8） | 主题基础 |
| 宽度与性能 | 已完成（Batch 10） | 所有组件 |
| 未来组件契约 | 已定义接口 | 主题基础 |
| 测试与视觉回归 | 已完成（Batch 10） | 所有批次 |

M1 于 2026-07-28 完成验收；下一里程碑为 M2 Task Ledger。

## 第一轮完成边界

第一轮只改造当前已有真实界面：

- User/Assistant/Thinking 消息
- Tool Shell 和内建 Tool renderer
- Read、Write、Edit、Bash、Grep、Find、Ls
- Diff
- Footer
- Compact、Working、Retry、Branch Summary 状态
- 暗色与亮色主题
- Ctrl+O 展开和终端宽度处理

第一轮不实现 Task Ledger、Todo Runtime、子 Agent、Workflow、后台任务、SSH、sudo 或新搜索 Provider。只为这些未来组件定义可复用的视觉契约。

## 完成定义

全部计划只有同时满足以下条件才完成：

- 当前已有交互路径均使用统一视觉语言
- Write 动态行数、Ctrl+O 展开和 Pi 加载动画保留
- 暗色、亮色及 80/120/160 列可读
- 每条渲染行不超过 `render(width)` 的宽度
- 主题切换后缓存与预着色文本正确失效
- 相关单元测试、组件测试和 tmux 视觉回归通过
- `npm run check` 无错误、警告或 info
