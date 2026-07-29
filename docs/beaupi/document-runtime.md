# BeauPi Document Runtime

M3 在现有 `packages/coding-agent` Runtime 内提供本地文档发现、索引、引用和 Execution Contract。它不创建第二套 Session、ResourceLoader、Tool 执行链或 Plan Mode。

## 所有权与生命周期

- `AgentSessionServices` 为每个有效 cwd 创建一个 `DocumentRuntime`。
- `AgentSession` 通过该实例解析当前任务、构建精简 System Prompt，并在文件 Tool 结束后更新 stale 状态。
- `/new`、`/resume`、`/fork` 和 cwd 切换复用 `AgentSessionRuntime` 的服务重建逻辑。
- reload 清理有界索引缓存并重新验证当前 Contract。

`ResourceLoader.getAgentsFiles()` 是 AGENTS/CLAUDE 祖先上下文的唯一来源。Document Runtime 在此基础上发现项目 README、CONTRIBUTING、`docs/**/*.md`、附近 Markdown 和最近 package.json scripts。

## 发现范围与预算

自动发现只在当前项目根和 ResourceLoader 已有的全局上下文根内进行。项目根优先使用最近的 `.git`，否则使用最近的 package.json 或 cwd。`.git`、`node_modules`、构建输出、缓存和明显生成目录会被忽略。符号链接按 canonical path 去重；不可读文件、预算截断和 URL 输入都返回结构化诊断。

默认预算：

- 最多 256 个文件
- 单文件最多 512 KiB
- 单次索引最多 4 MiB
- 最多缓存 128 个已索引文档
- 单个 Contract 最多选择 12 个文档

M3 不获取 URL。URL 会产生 `unsupported_url` 诊断，等待未来 `web_fetch`。

## Markdown 引用

索引支持 ATX `#`–`######`、Setext heading 和 fenced code block。所有行号从 1 开始。Heading citation 包含完整 heading path、起止行、canonical document id、路径、display path 和内容 hash。

`docs_read` 支持：

- `heading` 或完整 heading path
- `startLine`/`endLine`
- `offset`/`limit`
- 稳定 document id 或本地路径

大输出沿用现有 Tool 截断模型，完整正文写入临时文件并在 details 中提供路径。

## Execution Contract

`docs_resolve_task` 使用同一个 Document Runtime 完成发现、排序和保守提取。Contract 包含：

- 任务文本和稳定任务签名
- 稳定 Contract id/version
- 关键文档和每个文档 hash
- requirement、来源 citation 和 required check 关联
- documented command、stop condition 和 completion criterion
- conflict、budget、unsupported URL 等诊断
- created/updated 时间和 active/stale 状态

Requirements 只来自优先 heading、Markdown 列表、明确模态语句、命令代码块和 package scripts。不能由确定性证据判断的条目保持 pending；冲突要求保留双方文本和引用，不静默覆盖。

Contract 的 `details.documentRuntime` 是版本化状态格式。自动任务解析还会把相同格式写入当前 Session branch 的 custom entry；模型调用 `docs_resolve_task` 后，其 Tool Result details 优先用于恢复。不存在独立 JSON 状态文件。

## 失效与证据

关键文档使用内容 hash，而非只使用 mtime。Prompt 前、reload、Session 恢复和关键文件修改后验证 Contract。关键文档变更会使 Contract stale，并从 System Prompt 移除旧约束；文档恢复为原 hash 后 Contract 恢复 active。非 Contract 文档变化不会使其失效。

Required check 只关联结构化 Tool/Shell 命令签名及 success/failed/cancelled 状态，不分析日志文案。Requirement、check 和 completion criterion 都投影到现有 `AgentSession.taskLedger` 与 `TaskLedgerWidget`；Document Runtime 不维护第二套 Todo 状态。

## 内置 Tools

| Tool | 用途 |
|---|---|
| `docs_search` | 按目录距离、文档类型、heading 命中和正文命中排序，返回摘要与 citations |
| `docs_read` | 按 document path/id、heading 或行范围读取，并返回 hash/citation details |
| `docs_resolve_task` | 生成或刷新当前任务的 Execution Contract，不启动 Agent 或调用 Provider |

三个 Tool 默认加入普通编码任务的内置 Tool 集合，也可以通过现有 `--tools`/`--exclude-tools` 机制配置。
