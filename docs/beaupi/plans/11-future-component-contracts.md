# 未来组件视觉契约

## 目的

M1 不实现 Task Ledger、子 Agent、Workflow 或后台任务 Runtime，但应定义这些功能未来接入时复用的视觉语言，避免重新设计 TUI。

## 统一状态

```typescript
type BeauPiActivityState =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
```

建议符号：

| 状态 | 符号 |
|---|---|
| pending | `○` 或终端 small square |
| active | `●` 或 active square |
| completed | `✓` |
| failed | `✗` |
| blocked | `!` |
| cancelled | `–` |

具体字符集中在共享 helper，不散落硬编码。

## Todo 契约

```text
Tasks
  ✓ Read authentication documentation
  ● Update token rotation
  ○ Run documented checks
```

组件输入只接收结构化 item：id、text、state、owner、dependencies、completedAt、source。排序和截断由组件完成，不访问 Task Ledger 内部。

M1 只提供 fixture renderer 或 helper 测试；真实 Widget 在 Task Ledger 里程碑实现。

## Agent 契约

```text
● Agent(reviewer) Reviewing changes
   └─ reviewer · 3 tool uses · 17.2k tokens
      ⎿  Reading src/auth/session.ts
```

输入：name、description、state、toolUses、tokens、currentActivity、children。默认不展示完整会话；Ctrl+O 扩展详情。

## Workflow 契约

```text
Workflow: implement-review
  ✓ inspect       8.2s
  ● implement    21.4s
  ○ review
```

输入为 DAG 节点的结构化快照。组件不负责调度，也不读取 Workflow Engine。

## Background 契约

```text
Background Tasks
● test-42  npm run test  04:12
✓ build-17 npm run build 01:48
! dev-03   npm run dev   stalled
```

Footer 只显示聚合计数；详细 Widget 使用相同状态符号。

## Permission 契约

```text
! Bash(sudo apt install curl)
  ⎿  Waiting for permission
```

M1 只为 Tool state 保留 `permission`，不实现 sudo 或确认策略。

## 共享规则

- 同一状态在 Tool、Todo、Agent、Workflow 和 Background 中使用同一颜色语义。
- 树形组件使用 `├─`、`└─`、`│` 和 `⎿`。
- Owner 在宽终端显示，窄于约 60 列隐藏。
- Error/blocked 原因不可完全折叠。
- Ctrl+O 继续作为全局详情展开键。
- 所有数据从结构化状态传入，不解析展示文本。

## M1 交付边界

允许新增：

- 状态类型
- symbol/gutter helper
- fixture 和纯 renderer 测试

不允许新增：

- Task Ledger 持久化
- Agent Pool
- Workflow scheduler
- Background process monitor
- sudo Policy
