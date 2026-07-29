# Skill 导入与注册

## 现有 Pi 能力

Pi 已实现 Agent Skills 标准和渐进式加载：

- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`
- 项目：`.pi/skills/`、祖先目录中的 `.agents/skills/`
- Package：npm、Git、本地路径
- Settings：`skills` 路径数组
- CLI：`--skill <path>`
- Extension：`resources_discover` 返回 `skillPaths`
- SDK：`skillsOverride`
- 调用：自动匹配或 `/skill:name`
- 重载：`/reload`

Pi 还可以直接加载 Claude Code 和 Codex 的 Skill：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

当前缺少的是类似 `pi.registerTool()` 的直接 `pi.registerSkill()` API，以及统一的导入、启停、来源和诊断 UI。

## BeauPi Skill Registry

Skill Registry 直接集成到现有 `packages/coding-agent`，优先复用 Skill discovery、Pi Package、`resources_discover` 和 `ctx.reload()`。只有现有生命周期无法满足 Registry 状态、冲突处理或子 Agent 过滤时，才对 ResourceLoader 和相关核心接口做小范围扩展。

```text
Skill Registry
├── Source Manager
├── Importer
├── Validator
├── Enable/Disable State
├── Collision Resolver
├── Security Review
└── Resource Discovery Adapter
```

## 托管目录

统一使用 BeauPi 路径：

```text
~/.beaupi/agent/skills/                 用户 Skill
~/.beaupi/agent/skills-registry.json   用户 Registry
.beaupi/skills/                         项目 Skill
.beaupi/skills-registry.json            项目 Registry
```

Registry 只记录元数据和启停状态，不把完整 Skill 内容塞进 settings。

## 来源

```typescript
type SkillSource =
  | { type: "local"; path: string }
  | { type: "git"; repository: string; ref?: string; subdirectory?: string }
  | { type: "npm"; package: string; version?: string; subdirectory?: string }
  | { type: "url"; url: string; sha256?: string }
  | { type: "external-directory"; path: string; harness?: "claude" | "codex" | "other" };
```

优先复用 Pi Package 安装器处理 npm/Git。单文件 URL 导入必须：

- 使用 HTTPS
- 展示内容预览
- 用户确认
- 可选或强制 SHA-256 pin
- 保存来源 URL 和获取时间
- 不自动执行附带脚本

## Registry Entry

```typescript
interface SkillRegistryEntry {
  id: string;
  name: string;
  source: SkillSource;
  scope: "user" | "project";
  path: string;
  enabled: boolean;
  pinnedRef?: string;
  sha256?: string;
  importedAt: number;
  updatedAt?: number;
  diagnostics: SkillDiagnostic[];
}
```

## Stage 1 Registry Core

状态：已完成（2026-07-29）。

- Registry 使用版本化、确定性排序的 JSON；user 路径为 `~/.beaupi/agent/skills-registry.json`，project 路径为 `.beaupi/skills-registry.json`。相对 `path` 和本地来源路径都以对应 Registry 所在目录为基准。
- 写入使用同目录临时文件、原子 rename 和进程间锁；缺失文件视为空 Registry，格式错误返回结构化诊断且不覆盖原文件。
- 校验复用现有 Pi Skill frontmatter 约束，并增加 `SKILL.md`、相对 Markdown 引用、脚本、可执行文件、来源、SHA-256 和更新能力诊断；校验只建立清单，不执行脚本。
- ResourceLoader 仍使用现有 Agent Skills discovery。存在有效 Registry 记录时，顺序为显式临时 Skill、project Registry、project 原生 Skill、user Registry、user 原生 Skill、Claude/Codex 外部目录；被 Registry 管理但 disabled/invalid 的路径不会通过原生自动发现重新出现。
- project Registry 文件本身触发现有项目信任流程；未受信任时不读取或投影 project Registry。
- Registry 冲突保留双方 entry、path 和 source，并在 Skill 进入 System Prompt 或 `/skill:name` 前产生结构化 collision 诊断。

本阶段不包含导入/获取、`/skills` 命令与 UI、更新、删除或子 Agent allowlist。

## Stage 2 导入、更新与受控 Skill

状态：已完成（2026-07-29）。

- `/skill-import` 接受本地路径、`file://`、`git:`、`npm:` 和 HTTPS 单文件来源；Git/npm 支持 `#subdirectory`，远程来源先进入权限为 0700 的临时 staging 目录。
- Git 使用无递归子模块、禁用 checkout hooks 的 staging；npm 使用 `--ignore-scripts`，不会执行包或 Skill 生命周期脚本。远程 Skill 不允许符号链接，并且不会复制 `.git` 或 `node_modules`。
- HTTPS 只允许无重定向的 HTTPS 响应，限制 2 MiB，计算并保存 SHA-256；所有交互式导入和更新都显示来源、固定 ref/hash、内容预览、脚本/可执行清单和安全风险后再确认。
- 导入通过原子复制和版本化 Registry 写入完成；同名、无 Skill、多个候选、frontmatter、引用、信任和 staging 路径错误都返回结构化诊断。
- `/skill-update` 只允许 Git/npm/HTTPS 来源，获取、校验、确认和目录替换均在 Registry 变更前完成；失败或取消保留旧 Skill 和旧 Registry entry。
- `/skills` UI、命令和 `ctx.reload()` 已接入真实 InteractiveMode 生命周期；用户和项目本地导入统一走安全审查，`file://` 仍按本地来源处理。
- `createSkillAllowlistOverride()` 提供受控 ResourceLoader 的 allow/deny 过滤接口：设置 `allow: []` 时默认不加载 Skill，deny 优先于 allow，未知 allow 名称产生错误诊断，供 M5 Agent Profile 直接复用。

## 命令

### `/skills`

打开 Claude Code 风格列表：

```text
Skills
  ✓ git-release          project  .beaupi/skills/git-release
  ✓ brave-search        user     ~/.beaupi/skills/brave-search
  ○ pdf-tools           user     disabled
  ! deploy-production   project  invalid frontmatter
```

支持：

- 搜索
- enable/disable
- 查看来源
- 查看诊断
- 打开 `SKILL.md`
- 更新和删除

### `/skill-import <source>`

示例：

```text
/skill-import ~/.claude/skills/review-pr
/skill-import git:github.com/user/agent-skills@v1
/skill-import npm:@team/beaupi-skills@1.2.0
/skill-import https://example.com/SKILL.md
```

交互行为：

- 通过命令参数选择 `user` 或 `project` scope；项目 scope 必须已经获得 project trust。
- 所有 `/skill-import` 来源复制到对应托管目录并立即启用；不支持静默引用外部目录或静默覆盖同名 Skill。
- 远程和本地交互式导入都必须先完成安全审查确认；取消时不写入文件或 Registry。
- 同名冲突直接停止并展示双方 Registry/discovery 来源。

### `/skill-enable <name>`

启用后执行 `ctx.reload()`。

### `/skill-disable <name>`

禁用但不删除文件，随后重载资源。

### `/skill-remove <name>`

默认只移除 Registry 引用；删除托管文件需要二次确认。

### `/skill-update <name>`

重新获取并原子替换一个 Git、npm 或 HTTPS Skill。更新前必须完成安全审查确认；本地、Claude Code 和 Codex 外部目录会返回不可更新诊断。

### `/skill-validate [name]`

校验：

- `SKILL.md` 是否存在
- frontmatter `name` 和 `description`
- 名称格式和长度
- description 长度
- 相对引用是否存在
- 脚本和可执行文件清单
- 名称冲突
- 来源是否可更新

## 动态注册流程

```text
用户导入 Skill
  ↓
Importer 获取或引用来源
  ↓
Validator 校验并生成诊断
  ↓
Registry 写入 scope 配置
  ↓
resources_discover 返回 enabled skillPaths
  ↓
ctx.reload()
  ↓
Skill 出现在系统提示和 /skill:name 中
```

ResourceLoader 集成层负责把 Registry 中已启用的路径合并到 Skill discovery。可以复用内置 `resources_discover` 生命周期，但 Registry 本身属于 BeauPi Coding Agent，而不是独立 Extension Package。

命令完成后：

```typescript
await ctx.reload();
return;
```

工具不能直接调用 `ctx.reload()`，如果模型需要安装 Skill，应由 Tool 请求用户确认后排队调用注册命令，或由专门的命令完成操作。

## 冲突规则

Pi 当前对同名 Skill 发出警告并保留先发现者。BeauPi 在进入 Pi discovery 前主动检测冲突。

默认优先级：

```text
显式临时 Skill
> 项目 Registry
> 项目原生 Skill
> 用户 Registry
> 用户原生 Skill
> 外部 Claude/Codex 目录
```

冲突时不静默覆盖，TUI 显示来源并让用户选择。选择结果记录为 Registry override。

## 子 Agent

Agent Profile 可以声明：

```yaml
skills:
  allow:
    - docs-research
    - code-review
  deny:
    - deploy-production
```

规则：

- 默认子 Agent 不继承全部用户 Skill
- Researcher 只加载搜索/文档 Skill
- Reviewer 只加载审查 Skill
- Implementer 加载项目开发 Skill
- 高权限或部署 Skill 默认只允许 Coordinator

M4 提供 `createSkillAllowlistOverride({ allow, deny })` 作为受控 `ResourceLoader` 的稳定过滤接口。`allow` 存在时只加载列出的名称，`allow: []` 表示不加载 Skill，`deny` 始终优先；未发现的 allow 名称会产生结构化错误诊断。M5 的 `AgentProfile` 负责把 profile 配置映射到这个接口。

这样可以降低上下文体积并避免子 Agent 获得不必要能力。M5 的 AgentPool 在创建受控 Session 时直接把 `AgentProfile.skillAllowlist` 映射到该过滤器；未提供 allowlist 时使用 `allow: []`，因此子 Agent 不继承 Coordinator 的全部 Skill。受控 Loader 不 reload 或扩展 Coordinator 的资源集合。

## 安全

Skill 可以包含脚本并指示模型执行任意操作，因此导入时必须展示：

- 来源和固定 ref/hash
- `SKILL.md` 内容摘要
- 附带脚本和二进制列表
- 请求使用的工具
- 是否包含 sudo、curl pipe shell、凭据和远程执行指令

项目 Skill 只有在项目被信任后加载。非交互模式下，未批准的新项目 Skill 默认禁用。

## Skill 与 Tool 的边界

使用 Skill：

- 开发规范
- 发布流程
- 故障排查方法
- 领域知识
- 文档导航

使用 Tool：

- SSH/tmux
- Git commit
- Web search/fetch
- 安装依赖
- 数据库操作
- 受控 sudo
- 需要结构化输入输出的操作

Skill 可以指导模型选择 Tool，但不能代替权限和执行策略。

## 后续核心 API

如果第一版验证后确实需要，可向 Pi 核心增加：

```typescript
pi.registerSkill(skill)
pi.unregisterSkill(name)
pi.getSkills()
```

但需要同时定义：

- 与 ResourceLoader 的合并顺序
- sourceInfo
- reload/session 生命周期
- 命令注册和碰撞
- RPC/JSON 模式行为

因此第一版优先使用现有 discovery 和 reload 生命周期，只有明确需要时才扩展核心接口。

## 验收标准

1. 能导入本地、Claude Code、Codex、Git 和 npm Skill。
2. 能选择 user/project scope。
3. 能 enable/disable 而不删除文件。
4. 导入后无需重启进程，通过 reload 生效。
5. `/skills` 展示来源、scope、状态和诊断。
6. 同名 Skill 不静默覆盖。
7. 子 Agent 可配置独立 Skill allowlist；M4 提供的 ResourceLoader allow/deny 接口已由 M5 AgentProfile 接入。
8. URL 和项目 Skill 在加载前经过安全确认；交互式本地 Skill 导入也经过同一安全审查。
