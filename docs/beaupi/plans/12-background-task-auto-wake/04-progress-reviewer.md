# 04 Progress Reviewer

## 现有接入点

- `AgentPool.delegateTask()` 共享 Coordinator `ModelRuntime`、auth、并发槽与受控 ResourceLoader。
- AgentProfile 可限制 tool allowlist、文件修改、turn/token/time budget。
- faux provider 可断言上下文、调用次数、工具边界与 abort。

## 数据结构

- Review config：enabled、minimumIntervalMs、maxReviews、maxInputCharacters、timeoutMs。
- Review input：目标、上次摘要、新增日志片段、运行时、Monitor resources。
- `ProgressReviewV1`：state、summary、shouldWakeCoordinator、suggestedAction、reviewedAt、logHash。

## 生命周期

- 默认关闭；只有任务显式配置并且日志 hash 变化时检查。
- 满足最小间隔、剩余次数和输入预算后调用共享 AgentPool。
- 使用只读、无递归 Background/Workflow/Question/Delegate Tools 的受控 profile。
- 解析单个 `<progress_review>` JSON block 并严格校验。
- 失败只记录 diagnostic，按新 hash/间隔才允许下一次，不改变任务终态。

## 失败路径

- malformed/extra prose/timeout/provider failure -> review unavailable。
- AgentPool 饱和时 wall-clock timeout 包含排队时间。
- reviewer 失败不得触发无限重试或 BackgroundTask failed。

## 测试场景

- 默认零调用、hash 无变化零调用。
- 最小间隔、最大次数、输入字符截断、timeout。
- malformed/provider failure 后任务继续。
- profile 无写权限且不能递归 background/delegate/workflow。

## 完成状态

- [x] AgentPool/Profile/faux 审计
- [x] profile 与 parser
- [x] 预算执行
- [x] faux 调用/零调用测试
