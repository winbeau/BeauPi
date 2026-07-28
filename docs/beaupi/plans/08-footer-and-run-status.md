# Footer 与最近运行状态计划

## 实施状态

已完成（Batch 7）。Footer 最多三行，并接入最近 Run 的 TPS、token、cache、elapsed 与完成状态；Session usage 使用增量缓存，Extension status 保持在工作区行。

## 目标

实现 BeauPi 三行 Footer，并以字段级降级替代整体粗暴截断。

## 完整布局

```text
38.8 tok/s · 4,272 out · 8,976 in · cache 537,088/0 · 550,336 total · 110.1s
~/Projects/pi (main)
↑120k ↓28k R1.2M CH98.9% $2.035 · 112k/272k 41.0% (auto)          gpt-5.6-sol · medium
```

## 数据模型

建议新增明确状态对象：

```typescript
type RecentRunStats = {
  status: "idle" | "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  firstOutputAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
};
```

数据由 AgentSession events 更新，不从 TUI 文本反向解析。

### TPS

- 完成后优先按 output tokens / 实际输出持续时间计算。
- 如果没有 `firstOutputAt`，使用 run elapsed，并明确统一算法。
- output 为 0 时不显示 TPS 行。
- 新 run 开始可保留上一条 completed，或显示 `running · 12.4s`；第一版优先保留上一条，减少 Footer 抖动。
- 不额外调用模型。

## 第一行：最近 Agent Run

字段优先级：

1. TPS
2. output
3. elapsed
4. cache read/write
5. input
6. total

全行 dim，TPS 可使用普通 text。

## 第二行：工作区

默认：

- cwd
- Git branch

仅在非默认状态追加：

- 权限模式
- remote target
- session name（保留现有能力，但按宽度降级）

## 第三行：Session 累计

左侧：

- input
- output
- cache read
- cache write（0 时隐藏）
- cache hit rate
- cost
- current context/window/percent/auto

右侧：

- model
- thinking level
- provider 仅在多 Provider 且宽度允许时显示

## 降级顺序

### 第一行

1. 隐藏 total
2. 隐藏 input
3. 隐藏 cache write
4. cache 合并缩写
5. 只保留 TPS、output、elapsed

### 第二行

1. 隐藏 session name
2. 隐藏默认 USER/local
3. 中间截断 cwd
4. 保留 branch 尽可能可见

### 第三行

1. 隐藏 cache hit rate
2. 隐藏 cost
3. 隐藏 cache write
4. 隐藏 provider
5. 缩短 model ID
6. context 百分比降为整数

任意情况下三行均不换行。

## 性能

当前 Footer 每次 render 遍历全部 Session entries。计划评估：

- Session 变化时更新累计 Usage snapshot；或
- 以 entries version 缓存计算结果。

Git branch 继续由 `FooterDataProvider` 缓存并订阅变化。

## Extension 状态兼容

当前 Extension statuses 可能增加额外一行。BeauPi 三行上限要求：

- 将 Extension statuses 合并到第二或第三行的可选字段；或
- 有显式高优先级状态时替换第一行，而不是增加第四行。

具体合并策略需保留 `setStatus()` 可见性。

## 文件

```text
components/footer.ts
core/footer-data-provider.ts
interactive-mode.ts
可能新增 core/recent-run-stats.ts
test/footer-width.test.ts
test/footer-data-provider.test.ts
```

## 测试

- 40/60/80/120/160 列。
- 无 usage、无 model、无 branch。
- cache read/write、subscription cost、多 Provider。
- running/completed/failed/aborted run。
- Context unknown after Compact。
- 宽字符 cwd、branch、session、model。
- Extension status 合并。
- 每行宽度与最多三行。

## 验收

Footer 完整模式严格三行；窄终端字段按确定顺序隐藏；最近运行统计和 Session 累计不混淆；不新增通知弹窗。
