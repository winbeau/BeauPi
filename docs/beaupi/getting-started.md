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
      "maxResults": 10,
      "engines": ["bing", "yep"]
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

`engines` 可选，用于限定当前 SearXNG 实例已启用且稳定的搜索引擎；当默认引擎持续触发 CAPTCHA 或 rate limit 时，可选择实例中可用的引擎。SearXNG 返回全部引擎 suspended/unresponsive 且没有结果时，BeauPi 会返回结构化 `rate_limited`/`connection` 错误，不再误报为空搜索成功。

### 本地 SearXNG systemd 开机启动

本地 Docker Compose 实例固定放在：

```text
~/.local/share/searxng/compose.yml
~/.local/share/searxng/settings.yml
```

安装并立即启动 systemd user service：

```bash
./scripts/install-searxng-systemd.sh
```

脚本会安装 `~/.config/systemd/user/searxng.service`、启用 `default.target.wants`，执行幂等的 `docker compose up -d --remove-orphans`，并检查容器状态及 `http://127.0.0.1:8888/`。unit 在 Docker 尚未就绪时每 5 秒重试；容器运行后的异常恢复继续由 Compose 的 `restart: unless-stopped` 负责。

常用管理命令：

```bash
systemctl --user status searxng.service
systemctl --user restart searxng.service
systemctl --user reload searxng.service
journalctl --user -u searxng.service
```

开机但尚未登录时启动依赖 user lingering；可通过 `loginctl show-user "$USER" -p Linger` 检查，必要时执行 `loginctl enable-linger "$USER"`。WSL 必须在 `/etc/wsl.conf` 中启用 `systemd=true`。若当前 WSL 会话因 runtime bus 已失效而出现 `Failed to connect to bus`，安装脚本仍会创建 enablement symlink、确保容器当前运行，并在下一次 WSL/systemd 启动时加载该 unit。

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

`web_fetch` 会拒绝 URL credentials、非 HTTP(S) 协议、localhost、loopback、私网、link-local、保留地址和云 metadata 目标，并在每次重定向后重新执行 DNS/IP 安全验证。IPv4/IPv6 地址分别校验，避免 IPv4-mapped IPv6 规则误伤全部公网 IPv4；存在标准 `HTTP_PROXY`/`HTTPS_PROXY` 时，仍先验证目标 DNS，再通过固定目标 IP、原始 Host 和 TLS SNI 使用代理，避免代理侧重新解析绕过 SSRF 边界。PDF 提取不属于 M8。

达到 M8 query/fetch/Provider/字节/字符/timeout/redirect 预算或报告配置错误后，Search Runtime 自身不会改用 curl、wget、Python、Node 或 Bash 重试等价网络操作。如果 Agent 随后显式调用通用 Bash、Remote 或 terminal fallback，M10 Policy Runtime 只在 Footer 记录 advisory，不阻断执行；存在适用的专用 Tool 时也只提示推荐 Tool。

Coordinator 和受控 `researcher` 子 Agent 共享同一 Search Runtime/cache。可通过普通 Tool allowlist/denylist 明确启用或禁用 `web_search`、`web_fetch`。

## 执行策略

M10 默认通过现有 Tool 生命周期分类本地文件操作、Bash、Remote、terminal 和 Search。Policy authorization 对所有能够分类的受管操作都返回 `execute: true`，新的 Policy fact 统一记录 `decision.action: "allow"`。以下情况只产生非敏感 advisory：

```text
重复或等价失败检查
失败类别与 fallback 预算达到阈值
敏感路径、工作区外写入和 symlink 边界
能够明确解析为直接执行的 sudo/su/doas/pkexec
terminal 未知、超长或待处理输入状态
Search 失败后的 Shell/Remote/terminal 网络 fallback
存在更合适的专用 Tool
```

Policy 不显示确认选择框，不调用 SDK/RPC `policyHandler`，不因无交互通道暂停，也不向受控子 Agent 返回 `policyRequest`。Policy advisory 只显示在 Footer 工作区行，内容来自当前执行或最近 Policy fact；Tool renderer 和 Todo 不展示 Policy block/confirm/replace/pause 状态。

Policy fact 使用 `version: 1` details 写入正常 Session/Task Ledger 生命周期。恢复、Compact 和 branch 切换不读取全局隐藏状态，只从当前 branch 重建；旧 Session 中的 block/confirm/replace/pause action、status 和 confirmation details 继续可解析，但不影响当前执行或 UI。已配置 SSH Target 本身可以使用平台提供的 root 登录身份；本地或登录后的身份切换命令由执行后端按调用者权限处理，Policy 只做提示。

## 交互式询问

M9 默认在 Coordinator 注册：

```text
ask_user_question(questions)
```

一次可提交 1–4 个问题；每题包含不超过 12 个字符的唯一 header、2–4 个唯一选项和 `multiSelect`。UI 自动追加 `Other`，模型不得重复提供 `Other`/`其他` 等价选项。单选支持可选 Markdown preview；多选使用 Space 切换并显式进入下一题；多问题结束后进入 review/submit。每题还可通过 `N` 编辑 notes，并在 Other/notes 编辑器中使用现有外部编辑器键位。

默认问题键位：

```text
Up/Down                选项导航
Enter                  单选确认 / 多选进入下一题 / review 提交
Space                  多选切换
Tab/Right               下一题
Shift+Tab/Left          上一题
N                       编辑 notes
Escape/Ctrl+C           取消
Ctrl+G                  Other/notes 外部编辑器
```

所有问题动作都可在 `keybindings.json` 中通过 `app.question.*` 修改。答案以 `version: 1` Tool details 写入正常 Session 生命周期；Task Ledger 保留当前 branch 的精简 interaction facts，并只在等待回答时显示用户 Todo。

TUI 外运行不会读取 stdin：Print/JSON 和无 handler SDK 立即返回 `interaction_required`。SDK 可传 `questionHandler`；RPC 会发出 `method: "askUserQuestion"` 的 `extension_ui_request`，客户端必须以同一 `id` 返回 `answers`、`cancelled: true`、`rejected: true` 或结构化 `error`。受控子 Agent 永远不暴露该 Tool，只返回结构化 `<clarification_request>`。

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

BeauPi M0–M14 已完成。后续里程碑按以下方式推进：

1. M15、M16 等：按后续新增功能继续编号。
2. M Final：全部功能稳定后再决定独立 npm 发行物和二进制方案。

M5 的 `AgentPool`、M6 Monitor、M7 Remote Runtime、M8 Search Runtime、M9 Question Runtime、M10 Policy Runtime、M11 Workflow Runtime、M12 Background Runtime 和 M14 Dynamic Task Runtime 均复用当前进程的 AgentSession/ResourceLoader 生命周期；子 Agent 只通过结构化结果、引用、clarification request 和生命周期事件与 Coordinator 交互。
