# 06 Tests 与 Acceptance

## 测试原则

- 使用`packages/coding-agent/test/suite/harness.ts`和faux provider。
- 使用fake clock、fake PrivilegeTerminalAdapter、FakeSshTmuxAdapter和短本地tmux fixture。
- 不使用真实系统密码、真实sudoers修改、真实Provider/API key、付费模型或真实SSH server。
- 不通过分钟级sleep、提高全局timeout、删除测试或降低检查强度掩盖失败。

## Fixtures

### Fake Privilege Terminal

可控制：

- command尚未start、password prompt、running、exit marker。
- secure input bytes、send failure、capture frames、resize。
- sudo password prompt present/absent，用于模拟系统credential cache但不形成BeauPi授权。
- exit 0/nonzero、timeout、cancel、正常pane dead完成marker、pane lost和terminal recovery失败。

fake必须将input放在测试专用私有字段，生产result/details/log永不返回input。

### Short local tmux fixture

不调用真实sudo。使用测试helper：

1. 在PTY中执行`stty -echo`。
2. 输出模拟Password prompt。
3. 读取固定测试token。
4. 输出成功/失败内容并退出。
5. 测试断言token不在capture transcript、work log、audit、Session和Tool result。

若tmux缺失，fixture可明确skip；核心安全行为仍由fake tests覆盖。

## 测试分组

### 1. Contract/Policy

- strict schema/version/unknown fields。
- nested direct sudo识别。
- local Bash/terminal_bash的原执行器不直接执行sudo，而是自动路由；one-shot remote保持阻止。
- `privileged_exec`要求完整sudo command或批次，拒绝交互式root shell和其他unsupported identity switch。

### 2. Routing/Per-request

- local Bash和terminal_bash中的sudo自动进入同一fake PrivilegeRuntime。
- terminal_send的完整或分片sudo input在Enter前被拦截，pane收到Ctrl+U但收不到执行Enter。
- Enter前不执行；每个request都需要独立Enter确认。
- 系统credential已缓存、没有password prompt时仍显示权限框。
- 不存在`/mode`、once/session grant、expiry或confirmation bypass API。
- branch/reload/resume/dispose取消pending request且不恢复。

### 3. Secure tmux transport

- input只经child stdin，不在argv。
- buffer cleanup success/failure。
- raw CR/control bytes。
- capture/marker/exit/resize/cancel/lost。
- sudo密码期间不回显，认证后的普通shell输入正常回显。
- 独立tmux server继承环境、cwd、用户shell和慢zsh startup files。

### 4. Local/Remote executors

- local success/nonzero/timeout/cancel/truncate、多行staging、认证后detach和快速完成marker。
- remote existing terminal cwd/export/log/Monitor。
- terminal busy/disconnect/lost。
- root target redundant。
- no one-shot remote/password pipe fallback。

### 5. TUI

- waiting_for_user→authenticating/running→detach state，缓存credential稳定running路径和complete竞态。
- configurable confirm/cancel keys。
- editor preservation、Abort、dispose。
- user input不进入render/cache/response。
- dark/light与40/80/120/160列，无横向溢出。

### 6. Tool/Session/Audit

- `privileged_exec` details/content/isError/review usage；短成功直返，长输出或失败审阅。
- final Sudo Bash renderer复用Bash结果。
- Task Ledger/Monitor/Footer。
- 0600 JSONL、event顺序、redaction、audit failure。
- faux Coordinator下一turn收到结果但不收到input。
- controlled child无Tool。
- print/JSON/RPC默认interaction_required。

## 安全扫描断言

每个secret fixture token必须不出现在：

- Tool input/result/details。
- Agent messages和Session entries。
- Monitor record/activity/diagnostics。
- Task Ledger snapshot/Todo。
- pane transcript/work log/audit JSONL。
- thrown error/message/serialized RPC response。
- captured child argv。

允许出现的位置仅为fake adapter内部接收字节断言。

## 验收命令

1. 每个新增/修改测试文件定向运行并迭代到通过。
2. 相关Policy、Question、Bash、Remote、Monitor、Task Ledger、Footer和renderer回归定向运行。
3. 根目录运行`./test.sh`。
4. 根目录运行`npm run check`，修复全部error、warning和info。
5. `git diff --check`与secret fixture扫描。
6. 更新文档与计划实时状态。
7. 不提交，除非用户在实现对话明确要求。

## 完成定义

- 用户按Enter前不执行命令。
- 密码字节只进入secure PTY stdin路径。
- local Bash和terminal_bash的每个sudo request都逐次确认。
- local与remote terminal共享Broker且结果与Bash一致。
- noninteractive默认阻止。
- direct sudo不进入普通executor，也不能绕过PrivilegeRuntime。
- 不存在sudo mode/session grant，Session恢复不恢复pending request。
- 所有定向测试、`./test.sh` 和 `npm run check` 通过。

## 停止条件

- 需要真实密码或修改sudoers才能测试。
- 需要把input放入argv、env、临时明文文件、Session或日志。
- remote执行只能通过one-shot SSH密码管道完成。
- 必须新增native PTY依赖但尚未完成依赖/lifecycle/Bun审查。
- Monitor、Policy、Session、Task Ledger或Bash出现第二套事实源。

## 完成状态

- [x] 测试策略与安全矩阵设计
- [x] fake terminal/clock fixtures
- [x] contract/runtime/transport tests
- [x] local/remote executor tests
- [x] TUI/tool/session/audit tests
- [x] `./test.sh`
- [x] `npm run check`
- [x] 文档与最终验收
