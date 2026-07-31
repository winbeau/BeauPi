# Terminal Bash 输出审阅与本地 tmux 持久连接计划

状态：已实施、验收并提交；等待用户确认最终差异后推送。

## 目标

1. `terminal_bash` 一次调用即可完成普通命令并把可行动结果送回主 Agent，不再要求随后调用 `terminal_status`、`terminal_capture` 才能理解结果。
2. 命令输出分两路：
   - 完整、脱敏后的命令输出持续写入工作日志。
   - `gpt-5.6-luna` 只把有用错误、关键警告、退出状态和必要下一步压缩后送入主 Agent 上下文。
3. Luna 报备文本的最后一个非空行由代码强制写成 `@<绝对日志路径>`，不依赖模型自行遵守。
4. Terminal 持久连接改为“本地 tmux pane 内运行 SSH”；`terminal_send`、`terminal_bash` 都通过本地 `tmux send-keys` 注入，远端不再要求安装或运行 tmux。
5. Tool 指令要求模型生成简洁 Shell：已知目录时使用单条 `cd <dir> && <command>`；不生成无意义的 echo、状态探测、重复 capture 或多层脚本包装。

## 当前实现结论

当前代码路径：

- `packages/coding-agent/src/core/remote/adapter.ts`
- `packages/coding-agent/src/core/remote/runtime.ts`
- `packages/coding-agent/src/core/remote/tools.ts`
- `packages/coding-agent/src/core/monitor/*`
- `packages/coding-agent/src/core/sdk.ts`

现状：

1. `OpenSshConnection.tmuxCreate/tmuxSend/tmuxExecute/tmuxCapture/tmuxStatus/tmuxClose` 都是通过 SSH 在远端执行 `tmux`，不是本地 tmux 内运行 SSH。
2. `terminal_bash` 复用了普通 Bash Tool 的输出累积、截断和错误抛出路径。非零退出时会抛异常，Agent Core 会把异常转换成裸错误文本，结构化 `terminalId`、`monitorId`、`logPath` 和后续嵌套模型 usage 可能丢失。
3. 当前日志位于 `<cwd>/.beaupi/remote-logs/<session>/<operation>.log`，但没有 Luna 审阅，也没有固定的 `@路径` 报备协议。
4. 当前 Tool 描述已经建议普通命令优先使用 `terminal_bash`，但没有严格约束命令应为一条简洁的工作目录切换与执行链。

因此，本次不是只改 renderer 或 prompt；需要调整 Terminal transport、Tool Result 错误语义、日志协议和一个受控的嵌套模型审阅器。

## 设计边界

- `remote_exec`、`remote_read/write/edit/bash` 继续使用直接 OpenSSH；只重做 `terminal_*` 持久连接。
- 不创建第二套 Agent、Session、Monitor 或 ResourceLoader。
- Terminal transport 不直接依赖模型。新增可注入的 `TerminalOutputReviewer` 接口，默认实现由现有 `ModelRuntime` 调用设置指定的小模型。
- `settings.json` 增加 `terminalOutputReview.model`，默认值为 `gpt-5.6-luna`。裸 model id 优先在主 Agent 当前 provider 下解析；也允许配置 `provider/model-id` 固定 provider。当前 provider 不可用时尝试另一已配置 provider，仍不可用则走确定性 fallback。
- Luna 不获得文件修改 Tool、Shell Tool 或主 Agent 完整上下文，只接收当前命令的受限日志材料和确定性元数据。
- 完整日志不进入主 Agent Tool Result `content`，也不复制进 Session `details`；Session 只保存摘要、日志路径、退出状态、审阅状态和 usage。
- 保留现有秘密脱敏；日志与 Luna 输入都使用脱敏后的内容。
- 不修改 `CHANGELOG.md`。

## 目标架构

```text
Coordinator
  └─ terminal_bash
      ├─ LocalTmuxSshTransport
      │   ├─ local tmux session/pane
      │   ├─ ssh process inside pane
      │   ├─ tmux send-keys command injection
      │   ├─ begin/end marker + exit code parsing
      │   └─ local incremental transcript/log
      ├─ WorkLogWriter
      │   └─ append redacted command/output/exit metadata
      └─ TerminalOutputReviewer
          └─ ModelRuntime -> gpt-5.6-luna
              └─ concise report for Tool Result content
```

## 实施步骤

### 1. 先补回归，确认“结果未进入主上下文”的具体断点

新增 faux-provider 回归：

1. Coordinator 调用 `terminal_create` 后调用 `terminal_bash`。
2. 成功命令的最终 Tool Result `content` 必须出现在下一次 Provider 请求上下文。
3. 非零退出、超时和 SSH 断线也必须保留摘要、`isError`、`exitCode`、`terminalId`、`monitorId`、`logPath`。
4. 普通命令完成后不调用 `terminal_status` 或 `terminal_capture`，主 Agent 仍能继续判断。

如果问题实际位于 Tool bridge 而不是仓库内 `terminal_bash`，先修 bridge，再继续后续重构；不靠额外 status/capture 绕过。

### 2. 把 Terminal transport 改为本地 tmux + pane 内 SSH

重构 remote adapter，拆开“直接 SSH 命令”和“持久 Terminal”职责：

- `terminal_create`
  - 本地创建受控 tmux session。
  - pane 的主进程使用 `exec ssh <trusted target args>`，继续复用系统 OpenSSH 配置、Agent 和 known_hosts。
  - SSH 建立后在远端 shell 中进入 target 的 `remoteCwd`。
  - 只有 readiness marker 成功后才返回 terminal 已运行。
- `terminal_send`
  - 本地执行 `tmux send-keys -l ...`；Enter、Ctrl-C 等特殊输入走明确的按键分支。
- `terminal_bash`
  - 生成随机 begin/end marker，通过本地 tmux 注入一条协议命令。
  - 命令在同一个远端交互 shell 中执行，继承并保留 cwd/export 环境。
  - 从本地 pane transcript 中解析 marker 间输出和退出码；无需远端 `tmux wait-for`、远端 helper 目录或远端 tmux。
- `terminal_capture`
  - 从本地 pane 做增量 capture，继续使用 cursor/hash；完整 transcript 留在本地日志。
- `terminal_status`
  - 以本地 tmux session/pane 是否存在为确定性事实；pane 以 `exec ssh` 启动，SSH 退出时 session/pane 进入 lost/closed。
- `terminal_close`
  - 关闭本地 tmux session，并同步 Monitor 生命周期。

内部 marker/wrapper 由 transport 生成，不要求主 Agent 编写；Tool call 中仍只出现用户任务需要的简洁命令。

### 3. 工作日志协议

建议默认路径：

```text
<cwd>/.beaupi/terminal-logs/<session-id>/<terminal-id>/工作日志.log
```

每次 `terminal_bash` 追加：

```text
[timestamp] terminal=<id> target=<id>
command=<redacted command>
exit=<code|timeout|cancelled|disconnected>
--- output ---
<redacted output>
--- end ---
```

规则：

- 单 terminal 单工作日志，按命令追加，不覆盖历史。
- 文件创建权限限制为当前用户可读写。
- Tool `details` 只保存绝对路径，不保存完整日志正文。
- Monitor 使用同一路径或关联 transcript 路径，避免重复写两份等价完整输出。
- 超时、取消和断线也必须先 flush 已捕获输出，再返回结果。

### 4. Luna 输出审阅器

新增小接口，便于 fake 测试且避免 transport 依赖 AgentPool：

```typescript
interface TerminalOutputReviewer {
  review(input: TerminalReviewInput, signal?: AbortSignal): Promise<TerminalReviewResult>;
}
```

默认 `LunaTerminalOutputReviewer`：

- 通过现有 `ModelRuntime` 解析 `terminalOutputReview.model`；默认 `gpt-5.6-luna`，优先使用主 Agent 当前 provider。
- 单次无 Tool 的 `completeSimple` 调用，不创建完整子 Agent Session。
- 调用条件固定为：非零退出、超时、SSH 断线，或命令输出超过 100 行。短成功命令不调用模型，直接返回确定性一句话。用户取消沿用 abort，不再启动审阅请求。
- 只传入：命令摘要、退出状态、运行时间、日志路径和受限日志材料。
- 输入先做确定性裁剪：错误关键词附近窗口、stderr、头尾片段；不把无限长日志整体发送给 Luna。
- 输出要求：
  - 成功且无异常：一句简短完成状态。
  - 有错误：保留原始关键错误行、失败阶段、最小必要上下文和一个建议动作。
  - 不复述长进度日志，不编造未出现的结论。
- 代码清理模型输出，并强制最后一个非空行为 `@<absolute-log-path>`。
- 将嵌套调用 `usage` 写入 Tool Result，进入 Session/Footer 使用统计。

审阅失败时不丢命令结果：使用确定性 fallback（退出状态 + 有界错误尾部 + `@路径`），并在 `details.review` 标记 `fallback` 与失败原因。

### 5. Tool Result 与错误语义

不再让预期的命令非零退出直接穿过通用 Bash 异常路径并丢失 details。

`TerminalBashToolDetails` 增加：

```typescript
{
  operation: "terminal_bash";
  ok: boolean;
  terminalId: string;
  monitorId: string;
  logPath: string;
  exitCode: number | null;
  review: {
    model: string;
    status: "completed" | "fallback" | "skipped";
    inputTruncated: boolean;
  };
}
```

AgentSession 在 finalize Tool Result 时根据该结构化 `ok` 设置 `isError`，同时保留 `content`、`details` 和 `usage`。只有参数非法、内部 invariant 破坏等编程错误继续抛异常。

主 Agent 实际看到的 `content` 示例：

```text
`npm run check` 失败。TypeScript 在 src/foo.ts:42 报 TS2322；先修正 string 到 number 的赋值，再重跑该检查。
@/workspace/.beaupi/terminal-logs/<session>/<terminal>/工作日志.log
```

### 6. Shell 脚本规范

更新 `terminal_bash` 的 description/prompt guidelines：

- 普通命令只调用一次 `terminal_bash`，不要再组合 `terminal_send` + `terminal_capture`。
- 已知目标目录：`cd <workdir> && <command>`。
- 当前目录已经正确：直接 `<command>`。
- 只有目录确实未知时才单独执行一次 `pwd`；确认后复用该事实，不重复探测。
- 执行脚本：`cd <workdir> && bash <script>`。
- Git clone：`cd <parent-dir> && git clone <repo>`。
- 不添加解释性 `echo`、重复 `pwd`、`set -x`、人为 sleep、额外 status/capture 或多层 `bash -lc`。
- 多个必要步骤可用一条短的 `&&` 链；不要生成带大量注释和容错分支的临时脚本。

### 7. 测试

定向测试：

- local tmux adapter 参数与 session 生命周期。
- pane 内 SSH readiness、断线、重连边界。
- `send-keys` 字面量、多行、Enter、Ctrl-C。
- marker 解析、命令 echo 去除、cwd/export 持久化、退出码。
- 成功、非零退出、超时、取消、SSH 断线时日志 flush。
- Luna 在失败或输出超过 100 行时审阅；100 行以内的成功输出不调用模型。
- 长日志裁剪、模型错误 fallback、usage 统计。
- Luna 报备最后一行严格为 `@绝对路径`。
- Tool Result 在下一次 faux-provider 上下文中可见，且不包含完整长日志。
- 主流程不调用 `terminal_status`/`terminal_capture` 也能继续。
- Monitor 状态、logPath、cursor/hash 与本地 tmux 生命周期一致。
- 真实 E2E 使用现有受信任 SSH alias，在本机 tmux 中启动 SSH，验证命令、cwd/export、日志和关闭；不使用真实付费 Luna，模型审阅用 fake provider，除非用户另行要求真实模型 smoke test。

实施后运行：

1. 修改的定向 Vitest。
2. `npm run check`。
3. 用户确认后再决定是否运行 `./test.sh`；仓库 CONTRIBUTING 要求提交 PR 前两者都通过，但当前任务不创建 PR。

## 预计修改文件

核心候选：

- `packages/coding-agent/src/core/remote/types.ts`
- `packages/coding-agent/src/core/remote/adapter.ts`（可能拆为 direct-ssh 与 local-tmux transport）
- `packages/coding-agent/src/core/remote/runtime.ts`
- `packages/coding-agent/src/core/remote/tools.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- 新增 `packages/coding-agent/src/core/remote/output-reviewer.ts`

测试候选：

- `packages/coding-agent/test/remote-tools.test.ts`
- 新增 local tmux transport/faux-provider 回归测试
- `packages/coding-agent/test/m7-remote.e2e.test.ts`

文档候选：

- `docs/beaupi/requirements.md`
- `docs/beaupi/architecture.md`
- `docs/beaupi/roadmap.md`
- `docs/beaupi/milestones.md`
- `packages/coding-agent/docs/sdk.md`（若公开新的注入配置）

## 提交与推送

协商确认后再实施。完成代码和检查后：

1. 只 stage 本次修改文件。
2. 提交信息建议：`feat(coding-agent): review terminal output through local tmux ssh`
3. 提交前展示 `git status`、定向测试和 `npm run check` 结果。
4. 只有用户再次确认最终 diff 后才 push；不创建 PR，除非已有 maintainer `lgtm` 且用户明确要求。

## 已确认决策

1. 审阅模型可以在 `settings.json` 配置；默认使用 `gpt-5.6-luna`，优先跟随主 Agent 当前 provider。
2. 只有失败或日志超过 100 行时调用审阅模型；短成功命令走确定性摘要。
3. 每个 terminal 使用一份追加式 `工作日志.log`，路径为 `<cwd>/.beaupi/terminal-logs/<session-id>/<terminal-id>/工作日志.log`。
4. 工作目录已由上下文明确时不执行 `pwd`，直接使用 `cd <workdir> && <command>`；只有目录未知时才探测一次。
5. 按用户原始要求，本地 tmux 内直接运行 SSH，完全替换远端 tmux；远端不再要求安装 tmux。

## 实施结果

- `OpenSshConnection` 的 terminal transport 已改为本地 tmux；pane 使用 `exec ssh` 进入远端登录 shell，远端 tmux helper、`tmux wait-for` 和临时命令目录已删除。
- 当前命令输出由权限受限的本地 pane transcript 完整收集，不依赖 tmux history 行数；关闭 terminal 或 dispose 时删除 transcript。脱敏后的命令、输出、退出状态和耗时按 terminal 追加到 `工作日志.log`。
- 新增 `TerminalOutputReviewer` 和默认 `LunaTerminalOutputReviewer`。`terminalOutputReview.model` 默认 `gpt-5.6-luna`，失败或输出超过 100 行时审阅；未设置额外 `maxTokens` 硬限制。
- Tool Result 只返回审阅摘要或确定性 fallback，代码清理模型自报路径并强制最后一行为 `@<绝对日志路径>`；review usage 进入 Session 使用统计。
- `terminal_bash` 的非零退出、超时、取消和断线使用结构化结果，不再经过会丢失 details 的通用 Bash 异常路径。AgentSession 根据 Remote `details.ok` 设置 `isError`。
- Tool prompt 已要求已知目录时直接使用 `cd <workdir> && <command>`，禁止普通命令后的额外 status/capture、重复 `pwd`、说明性 echo、sleep 和嵌套 `bash -lc`。
- 文档已同步更新 requirements、architecture、roadmap、milestones 和 settings。

验收记录：

1. 定向测试：5 个文件、60 个测试通过。
2. 完整非 E2E：`./test.sh` 最终 226 个文件、1938 个测试通过；首次并发计时用例偶发失败，单独重跑及完整重跑均通过。
3. `npm run check`：无错误、warning 或 info。
4. 真实 SSH E2E：`h100-server` 通过，包括本地 tmux + SSH、cwd、命令、增量 capture、连接重建、关闭和 5,000 行完整日志。
