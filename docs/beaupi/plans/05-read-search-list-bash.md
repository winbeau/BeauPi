# Read、Search、List 与 Bash 计划

## 目标

统一高频只读和命令 Tool 的标题、结果摘要、聚合、折叠和运行中提示，降低重复行和上下文噪声。

## 显示名称

| 底层 Tool | 显示名称 |
|---|---|
| `read` | `Read` |
| `grep` | `Search` |
| `find` | `Find` |
| `ls` | `List` |
| `bash` | `Bash` |

底层名称、Schema 和执行逻辑不变。

## 单项样式

```text
● Read(src/auth/session.ts)
  ⎿  184 lines

● Search("refresh token" in src)
  ⎿  6 matches

● Bash(npm run check)
  ⎿  Completed in 12.4s
```

错误：

```text
✗ Bash(npm run check)
  ⎿  Command exited with code 1
      test/auth.test.ts:42 ...
```

## Read

- 标题保留 path 和 `:start-end`。
- 文档、Skill、Resource 紧凑分类继续保留，但采用统一 Tool 标题层级。
- 普通成功折叠状态显示行数或 image loaded，不显示全文。
- 展开后显示语法高亮内容。
- 截断、offset continuation 和非视觉模型提示必须可见。
- Read Error 不按文件扩展名做语法高亮。

## Search/Find/List

- 折叠时优先显示数量摘要。
- 无结果使用 dim，不使用绿色成功背景。
- 展开后显示有限结果；Tool context 中已截断内容仍保留告警。
- Search 的 pattern、path、glob 和 limit 按宽度降级。
- Find/List 路径使用 ANSI-aware truncate。

## Bash

- 标题显示命令；过长命令按可用宽度截断。
- 超过 2 秒显示 elapsed；继续复用当前每秒 invalidate。
- partial 输出显示最后 5 个视觉行，保留 100ms update throttle。
- 完成显示 elapsed 和必要摘要。
- 失败始终显示 exit/timeout/aborted 原因及尾部错误输出。
- 完整日志路径和 LLM context truncation 告警不可被普通折叠隐藏。
- `BashExecutionComponent`（用户 `!`/`!!` 模式）与 Bash Tool 使用相同结果 gutter 和状态语言，保留 exclude-from-context 区别。

## 连续调用聚合

目标：连续 Read/Search/List/Bash 可以显示为一组摘要，执行中展示当前项。

第一版聚合边界：

- 仅聚合相邻、无 Assistant 正文分隔的只读 Tool。
- Edit/Write、错误、权限等待和图片结果打断聚合。
- 每个 Tool Result 仍有独立 Session entry 和 ToolExecutionComponent 状态。
- 聚合只发生在展示层，不合并 Tool 调用或结果。
- Ctrl+O 展开时逐项显示。
- 当前操作提示至少显示约 700ms，避免快速 Tool 闪烁。

实现前先评估在 `InteractiveMode` 中增加 `ToolGroupComponent`，而不是让 ToolExecutionComponent 彼此搜索父容器。

## 文件

```text
core/tools/read.ts
core/tools/grep.ts
core/tools/find.ts
core/tools/ls.ts
core/tools/bash.ts
components/bash-execution.ts
components/tool-group.ts（计划新增）
interactive-mode.ts
test/tool-execution-component.test.ts
test/bash-execution-width.test.ts
```

## 测试

- 每个 Tool 的 collapsed/expanded/error/partial。
- 结果计数和 truncation 告警。
- Bash elapsed 使用 fake timers。
- 60/80/120 列命令与路径截断。
- 连续 Tool 聚合、错误打断、Assistant 正文打断。
- Session 恢复后的分组与实时事件分组一致。
- Ctrl+O 展开组内全部 Tool。

## 验收

高频只读操作保持紧凑；错误原因和截断信息不丢失；聚合不改变 Tool Runtime 或 Session 数据。
