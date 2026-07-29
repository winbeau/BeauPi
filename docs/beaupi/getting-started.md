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

BeauPi 开发基线、Claude Code 风格 TUI、Task Ledger、任务可视化和 Document Runtime 已完成。后续按顺序推进：

1. 实现 Skill Registry。
2. 实现进程内子 Agent 和多 Agent Workflow。
3. 在策略系统稳定后实现搜索、远程执行和受控权限能力。
4. 功能稳定后再决定独立 npm 发行物和二进制方案。
