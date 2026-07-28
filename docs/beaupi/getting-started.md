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

BeauPi 开发基线和 Claude Code 风格 TUI 已完成。后续按顺序推进：

1. 实现 Task Ledger 和 Todo 状态闭环。
2. 整合默认 System Prompt、文档发现与 Execution Contract。
3. 实现 Skill Registry。
4. 实现进程内子 Agent 和多 Agent Workflow。
5. 功能稳定后再决定独立 npm 发行物和二进制方案。
