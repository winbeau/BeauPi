# Step 08：Tool Registry、Extension Manifest 与 Config Explain

## 状态

设计完成，未实现。依赖 Step 03。

## 1. 目标

解决工具构造器/名称漂移和扩展加载顺序不可解释问题；metadata 只服务 composition、文档、诊断和测试，不是权限系统。

## 2. Tool Registry 单一来源

锚点：packages/coding-agent/src/core/tools/index.ts、tool-definition-wrapper.ts、AgentSession runtime/custom tool 合并。

设计：

1. 建立 definition-first registry record：name → definitionFactory → toolFactory → source。
2. allToolNames 从 registry 派生，不手写第二份。
3. runtime tools（background/workflow/remote/privilege/search）由各 runtime 注册，不冒充 core factory。
4. session 创建时检查重复名、缺 constructor、definition/tool name 不一致。
5. 用 unknown/泛型收窄关键 any 边界；不以 any 扩散修复。
6. 生成内部 Tool Manifest，包含 schema、sideEffect、result shape、supportsCancellation、timeout metadata。字段描述执行事实，不执行授权。

不做 Web catalog、MCP namespace、网络 capability gate。

## 3. Extension Manifest

为 ResourceLoader/extension 增加可选 metadata：id、version、source、dependencies、priority、conflicts、capabilities、trustLevel。

用途：解释加载顺序、transform/header precedence、activation duration/error、cleanup owner、开发诊断。capabilities 只说明会使用哪些宿主 API，不限制 trusted in-process 调用权限。

## 4. Config Explain

在现有 SettingsManager global/project 语义上增加 provenance：key、finalValue、source、precedence、overriddenBy。

可后续支持 replace/append/remove；先用测试冻结递归对象和数组 merge 语义，不复制 DSH patch tree。

## 5. 测试

registry 名称集合与 factory 一致；runtime tool 注册/注销更新 catalog；重复名产生确定诊断；extension priority/transform precedence golden fixture；activation error 有 source/duration；config explain 指出最终值来源；manifest/capability 不被当作 executor authorization。

## 6. 验收

allToolNames 不再有不可构造的静态漂移；Tool registry 可供 AgentSession、RPC、文档和测试复用；extension 调试不依赖隐式 discovery 顺序；没有 Web/MCP/Cordis。
