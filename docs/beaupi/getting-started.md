# BeauPi 开发启动

## 当前里程碑

BeauPi 已在现有 `packages/coding-agent` 中完成基础品牌整合。当前最小可运行发行版为：

- 产品名：`BeauPi`
- 命令名：`beaupi`
- 应用配置名：`beaupi`
- 用户配置：`~/.beaupi/agent/`
- 项目配置：`.beaupi/`
- 内部 npm 包名暂时保持不变
- 不创建新的 BeauPi Package
- 开发时直接运行 TypeScript 源码，不要求先构建

## 安装依赖

```bash
npm ci --ignore-scripts
```

## 从仓库启动

```bash
./beaupi-test.sh
```

查看帮助和版本：

```bash
./beaupi-test.sh --help
./beaupi-test.sh --version
```

## 安装开发命令

```bash
./scripts/install-beaupi-dev.sh
```

脚本会创建：

```text
~/.local/bin/beaupi -> <repo>/beaupi-test.sh
```

之后可以从任意目录启动：

```bash
cd ~/Projects/your-project
beaupi
```

BeauPi 会保留调用时的当前工作目录，因此 Agent 操作的是 `your-project`，而不是 Pi 仓库。

## 配置位置

```text
~/.beaupi/agent/settings.json
~/.beaupi/agent/auth.json
~/.beaupi/agent/models.json
~/.beaupi/agent/sessions/
~/.beaupi/agent/extensions/
~/.beaupi/agent/skills/
```

项目配置：

```text
<project>/.beaupi/settings.json
<project>/.beaupi/extensions/
<project>/.beaupi/skills/
<project>/.beaupi/prompts/
<project>/.beaupi/themes/
```

环境变量：

```text
BEAUPI_CODING_AGENT_DIR
BEAUPI_CODING_AGENT_SESSION_DIR
BEAUPI_SEARXNG_ENDPOINT
BEAUPI_SEARXNG_API_KEY
```

## 文档驱动任务

M3 Document Runtime 会在普通编码任务开始前使用现有 ResourceLoader 的 AGENTS/CLAUDE 上下文，并自动发现当前项目的 README、CONTRIBUTING、`docs/**/*.md`、附近 Markdown 和最近 package.json scripts。当前任务会生成带内容 hash 和行号引用的精简 Execution Contract，不会把全部 docs 注入模型上下文。

可直接调用三个内置 Tool：

```text
docs_search(query, scope?)
docs_read(document, heading?, startLine?, endLine?, offset?, limit?)
docs_resolve_task(task, explicitDocuments?, refresh?)
```

Requirement、required check、completion criterion 和 stale/blocked 状态显示在现有 Task Ledger/Todo/Footer 中。`docs_read` 的大输出会沿用 Tool 截断并保留完整临时文件路径；URL 在 M3 返回 unsupported 诊断，不执行网络 fallback。详见 [Document Runtime 设计](./document-runtime.md)。

## 联网搜索

M8 默认注册两个结构化 Tool：

```text
web_search(query, maxResults?, includeDomains?, excludeDomains?)
web_fetch(url)
```

第一版只实现 SearXNG JSON API。最小全局配置：

```json
{
  "search": {
    "provider": "searxng",
    "searxng": {
      "endpoint": "https://search.example.com/search",
      "timeoutMs": 15000,
      "maxResults": 10
    },
    "cache": {
      "queryTtlMs": 300000,
      "fetchTtlMs": 900000
    },
    "budget": {
      "maxResultsPerSearch": 10,
      "maxQueriesPerTask": 6,
      "maxFetchesPerTask": 6,
      "maxProviderAttemptsPerTask": 6,
      "maxFetchBytes": 2097152,
      "maxInputCharactersPerTask": 60000,
      "timeoutMs": 15000,
      "maxRedirects": 5
    }
  }
}
```

endpoint 也可通过环境变量配置：

```text
BEAUPI_SEARXNG_ENDPOINT
```

如果 SearXNG 前置网关需要 API key，推荐只在环境变量中保存 secret：

```json
{
  "search": {
    "searxng": {
      "endpoint": "https://search.example.com/search",
      "apiKeyEnv": "MY_SEARXNG_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer "
    }
  }
}
```

未指定 `apiKeyEnv` 时，也可使用默认环境变量 `BEAUPI_SEARXNG_API_KEY`。API key、Authorization、Cookie 和完整敏感响应头不会写入 Session、Tool details、缓存或诊断。

`web_search` 只返回标题、URL、snippet 和搜索级引用；snippet 不是已验证正文。`web_fetch` 支持 HTML、纯文本和 JSON，返回正文级引用和 SHA-256 content hash。大正文只向模型返回最多 2,000 行/50 KiB，完整 Markdown 写入临时文件；同一任务内相同 content hash 不重复注入。

`web_fetch` 会拒绝 URL credentials、非 HTTP(S) 协议、localhost、loopback、私网、link-local、保留地址和云 metadata 目标，并在每次重定向后重新执行 DNS/IP 安全验证。PDF 提取不属于 M8。

达到 M8 query/fetch/Provider/字节/字符/timeout/redirect 预算或报告配置错误后，不应改用 curl、wget、Python、Node 或 Bash 重试等价网络操作。专用 Search Runtime 已确定性停止；通用 Bash 网络调用的强制阻断属于 M9 Policy Engine。

Coordinator 和受控 `researcher` 子 Agent 共享同一 Search Runtime/cache。可通过普通 Tool allowlist/denylist 明确启用或禁用 `web_search`、`web_fetch`。

## 开发检查

代码修改后：

```bash
npm run check
```

非 LLM 测试：

```bash
./test.sh
```

## 后续里程碑

BeauPi M0–M8 已完成。当前按优先主线推进：

1. M9：实现 Policy Engine、等价 fallback/失败预算和结构化 Git Tools。
2. M10：在稳定策略边界上实现多 Agent Workflow。
3. M11：扩展 Monitor Runtime，实现后台任务自动唤醒。
4. M12：最后实现受控权限能力。
5. 功能稳定后再决定独立 npm 发行物和二进制方案。

M5 的 `AgentPool`、M6 Monitor、M7 Remote Runtime 和 M8 Search Runtime 均复用当前进程的 AgentSession/ResourceLoader 生命周期；子 Agent 只通过结构化结果、引用和生命周期事件与 Coordinator 交互。
