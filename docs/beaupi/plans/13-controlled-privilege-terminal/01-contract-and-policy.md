> 已移除：M13 受控 sudo 终端已在 Trusted-Local Runtime 升级中删除，本文保留为历史实施记录。

# 01 Contract 与 Policy Boundary

## 目标

建立严格的 M13 request/audit 数据契约，并把所有可确定解析的 sudo command 收敛到唯一 `PrivilegeRuntime` 路径，以此替代旧的 sudo mode/once/session grant 方案。

## 现有接入点

- `core/privilege/shell-inspection.ts` 识别 `sudo`、`su`、`doas` 和 `pkexec`，供 sudo 路由使用（Core Policy 分类器已随 Trusted-Local 升级移除）。
- M13 不恢复所有敏感操作的通用阻塞确认。
- Remote Runtime 当前通过 `assertNoPrivilegeChange()` 阻止 SSH/Terminal 直接提权。
- Local Bash 当前仍执行直接 sudo；M13 需要补齐窄范围执行边界。

## 类型与状态

新增 `core/privilege/types.ts`：

- `PrivilegeTargetV1`: local 或 terminal，terminal 包含 targetId/terminalId/monitorId。
- `PrivilegeRouteV1`: `explicit_tool | local_bash | terminal_bash`，记录请求来源但不改变执行语义。
- `PrivilegeRequestV1`: requestId、toolCallId、sourceTool、完整 sudo command、target、cwd、timeout、createdAt、logPath。
- `PrivilegeRequestStateV1`: waiting_for_user/starting/running/completed/failed/cancelled/blocked/interaction_required。
- `PrivilegeResultV1`: succeeded/failed/cancelled/blocked/interaction_required/interaction_error。
- `PrivilegeToolDetailsV1`: 严格版本、route/audit/monitor/log/truncation/diagnostic/review facts。
- `PrivilegeAuditEventV1`: requested/confirmed/started/completed/failed/cancelled/blocked。

所有 TypeBox object 使用 `additionalProperties: false`；所有 Session/audit parser 拒绝未知版本。

## Policy 边界

1. 提取可复用的 shell privilege inspection API，避免 `PrivilegeRuntime` 重写 parser。
2. 普通 local `bash` 和 `terminal_bash` 检测到 sudo executable 时：
   - 原执行器不得直接 spawn；
   - 自动构造 `PrivilegeRequestV1` 并调用同一个 `PrivilegeRuntime`；
   - 保留原 toolCallId、target、terminalId、cwd、timeout 和完整命令。
3. `terminal_send` 复用现有pending input classifier；在Enter提交前识别完整sudo command，禁止发送Enter并用Ctrl+U清理尚未执行的shell line，然后返回受控路径诊断。
4. `remote_exec`、`remote_bash` 和没有可控 PTY 的路径检测到 sudo 时不执行，返回要求使用现有 Terminal 路径的结构化诊断。
5. `privileged_exec.command` 必须包含可确定解析的 sudo；Runtime 不添加、删除或重排命令。
6. `sudo bash`、`sudo sh`、`sudo -i` 和 `sudo -s` 会被标记为 `interactive-root-shell` 并阻止，避免认证后detach留下隐藏root shell；`su`、`doas`、`pkexec`、其他身份切换和任意 namespace/chroot 能力同样保持 unsupported。
7. 已配置 SSH login identity 为 root 时不走 sudo broker；普通 Remote Tool 继续按受信任登录身份执行。

## Request 状态机

- 每个 request 初始为 `waiting_for_user`，不存在全局 user/sudo mode。
- TUI 进入时可以创建受控 command session 并只读 staging 完整文本；用户按 Enter 后才进入 `starting` 并释放执行门控。
- command start 后进入 `running`，最终只能进入 completed/failed/cancelled。
- 用户取消、handler 缺失、PTY 不可用或生命周期终止时进入 blocked/interaction_required/cancelled，不自动重试。
- 系统 sudo ticket 只影响 sudo 是否再次显示密码 prompt，不改变 BeauPi 的逐次确认状态机。
- Session custom entry 只记录非秘密 audit/result facts，不记录可恢复授权或 pending input。

## 交互契约

```typescript
interface PrivilegeInteractionHandler {
  (
    request: PrivilegeInteractionRequest,
    control: PrivilegeTerminalControl,
    signal: AbortSignal | undefined,
  ): Promise<PrivilegeInteractionResponse>;
}
```

`PrivilegeTerminalControl` 只暴露 start、execute、sendSensitive、capture、resize、cancel 和 wait；不暴露 transcript 文件写入或 password getter。

## 失败路径

- 无 handler/非交互 run mode：`interaction_required`，不执行。
- invalid target/command：严格 validation error。
- one-shot remote path无可控PTY：`terminal_required`，不执行。
- branch/rebuild 中存在旧 audit entry：仅投影历史，不恢复 pending request或授权。
- 同一 Tool call重复进入router时按requestId去重，不重复打开权限框。

## 测试

- direct sudo 在 local Bash和terminal_bash中不会进入原执行器，而是自动路由到fake PrivilegeRuntime。
- remote_exec/remote_bash无受控command session时不得执行sudo；terminal_send分片输入在Enter前被拦截并清理shell line。
- nested shell/quoted separator中的sudo继续被classifier识别并保留完整命令。
- `privileged_exec` 拒绝不含sudo、交互式root shell或包含unsupported identity switch的command，同时接受换行分隔的直接sudo批次。
- 每个request独立确认；不存在once/session mode、expiry或grant恢复。
- resume/Compact/branch不恢复pending request。
- controlled child profile不暴露 `privileged_exec`。

## 完成状态

- [x] 设计与接入点审计
- [x] 类型与严格 schema
- [x] Policy inspection/public boundary
- [x] request router/state machine
- [x] Session parser 与pending request清理
- [x] 定向 tests
