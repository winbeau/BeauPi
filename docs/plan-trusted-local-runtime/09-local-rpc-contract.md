# Step 09：本地 JSONL RPC 契约收敛

## 状态

设计完成，未实现。依赖 Step 04、Step 06、Step 08。

## 1. 范围

只改进现有 stdin/stdout JSONL embedding transport：不启动 Web server，不支持 MCP，不添加网络认证，不把 RPC 当权限边界；工具继续按 trusted-local 同权执行。

锚点：packages/coding-agent/src/modes/rpc/rpc-types.ts、rpc-mode.ts、rpc-client.ts、docs/rpc.md。

## 2. 删除旧 Core Policy 协议

移除 PolicyConfirmRequest、extension_ui_request.policyConfirm、policyDecision response，以及等待 Core Policy handler 的路径。保留 askUserQuestion、extension UI、abort、stdout ownership、backpressure。

## 3. 本地协议字段

可增加：

hello: protocolVersion、serverVersion、capabilities、limits
request/response: requestId、command、success、typed error code/category
event: sessionId、runId、seq、correlationId
resume/query: afterSeq

是否默认发送 hello 由现有客户端迁移设计决定；字段演进遵循协议版本。

## 4. 错误和取消

稳定类别：invalid_command、unsupported_command、invalid_arguments、execution_failed、cancelled、timed_out、session_replaced、shutdown。

文档明确 accepted response 与后续 Agent event 关系；取消只表示请求/运行状态，不承诺外部副作用 rollback。

## 5. 背压和输出

复用 waitForRawStdoutBackpressure()；补单行/单事件最大尺寸、event ordering、request correlation、stdin end/shutdown pending request 结算测试。这是本地进程稳定性，不是网络安全。

## 6. 验收

unknown/unsupported command 返回结构化 error；不出现 Core PolicyConfirm；prompt/bash/abort/shutdown 顺序确定；backpressure 不丢 event；session replacement 后旧 event 不污染新 session；interactive/print/RPC Tool result 字段一致；无 Web/HMR/MCP 新依赖。
