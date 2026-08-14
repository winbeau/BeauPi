# Step 07：SessionPersistenceCoordinator 与 ExecutionJournal

## 状态

设计完成，未实现。依赖 Step 06。

## 1. 目标

保留 BeauPi 树形 Session、branch、leaf、compaction，同时为 JSONL 建立明确 append/recovery 语义；不改变工具权限。

## 2. Canonical Session

涉及 packages/agent/src/harness/session/session.ts、jsonl-storage.ts、packages/coding-agent/src/core/session-manager.ts。

冻结：parentId 是分支关系，leaf 是 active branch pointer，seq 是 persistence order，revision 是 storage version，cursor 是 projection position。

SessionManager 成为 coding-agent facade/adapter；树和 entry 语义只能由一个 canonical Session contract 定义。

## 3. PersistenceCoordinator

建议位于 packages/agent/src/harness/session/：

appendBatch(sessionId, events, expectedRevision?)
readAfter(sessionId, seq)
flush(sessionId)
inspect(sessionId)
repairTail(sessionId)

第一阶段：每 session 串行 append；batch append；记录 eventId/seq/schemaVersion/timestamp；revision/expected revision；只修复不完整最后一行；中间损坏 fail loudly；flush checkpoint 可测试观察。

不引入 SQLite、分布式锁、网络存储、DSH/Cordis。

## 4. ExecutionJournal

可先复用同一 JSONL storage，事件至少包括：

run/created
run/started
tool/claimed
tool/started
tool/checkpoint
cancel/requested
tool/completed
tool/failed
tool/unknown
run/settled

事件带 sessionId、runId、toolCallId/jobId、attempt、owner、idempotencyKey（需要副作用去重时）、causationId、seq。

规则：completed 不重复执行；cancel intent 先落盘再发 AbortSignal；外部副作用未知记录 unknown；unknown 不自动重放；replay 只恢复 BeauPi 状态，不重放 shell/network/file 副作用。

## 5. Compaction/branch

Compaction summary 仍是 Session 数据，不是 execution journal snapshot。Branch/fork 保留 origin/run 关系，不能因 fork 自动重跑历史 command。Projection 可记录 asOfSeq/projectionVersion，初版不要求持久化大型 cache。

## 6. 测试

batch append 顺序、seq 连续性、revision conflict、不完整尾行 repair、中间损坏 fail loudly、crash 后 nonterminal execution 状态、branch/compaction 不重复副作用、双 writer 串行化/冲突。

## 7. 验收

树/leaf/compaction 体验不变；reload 能确定性恢复尾部损坏；journal 能解释执行/取消/未知但不声称撤销外部副作用；不引入 permission/authorization/environment policy。
