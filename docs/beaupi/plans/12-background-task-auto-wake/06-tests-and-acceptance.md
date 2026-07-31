# 06 Tests 与 Acceptance

## 现有接入点

- `packages/coding-agent/test/suite/harness.ts` 与 faux provider。
- Monitor/remote fake adapters、可注入 clock、Workflow/Session branch 测试模式。
- 定向 Vitest 命令、`./test.sh` 和 `npm run check`。

## 测试数据与 fixtures

- Fake clock/scheduler：advance/runNext/runUntilIdle，无分钟级 sleep。
- Fake process/remote adapter：exit、disconnect、lost、cancel、resource/log facts。
- 确定性短本地进程：成功、非零、忽略 TERM、子进程树。
- faux reviewer responses：valid/malformed/error/timeout。

## 测试分组

1. Runtime/store/recovery。
2. Local/remote adapters 与 cancellation。
3. Trigger/Wake Queue/session injection。
4. Progress Reviewer budgets/zero-call。
5. Tools/details/Monitor interop。
6. Task Ledger/Todo/Footer/renderer widths。

## 验收命令

1. 修改的每个测试文件先定向运行。
2. 根目录运行 `./test.sh`。
3. 根目录运行 `npm run check`，修复全部 error/warning/info。
4. 只提交本轮明确修改的路径，不使用 `git add .` 或 `git add -A`。

## 停止条件

- 真实 Provider/API key/付费模型或真实 SSH server 成为必要条件。
- 只能通过提高全局 timeout、删除测试或降低检查强度通过。
- Monitor/Session/Task Ledger 出现重复状态源。

## 完成状态

- [x] 测试策略审计
- [x] 定向 runtime/tools/session/reviewer/TUI 测试
- [ ] `./test.sh`：全量运行两次；M12 测试均通过，但现有 `extensions-discovery`/`startup-session-name` 子进程超时和 `web-fetch-runtime` 本地网络超时在并行全量运行中不稳定；三个失败文件单独运行均通过
- [x] `npm run check`
- [x] 文档更新
- [x] 提交（本计划随 M12 实现提交）
