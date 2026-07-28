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
  | { type: "npm"; package: string; version?: string }
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

交互选择：

- user/project scope
- 是否复制到托管目录或引用原路径
- 是否立即启用
- 冲突处理

### `/skill-enable <name>`

启用后执行 `ctx.reload()`。

### `/skill-disable <name>`

禁用但不删除文件，随后重载资源。

### `/skill-remove <name>`

默认只移除 Registry 引用；删除托管文件需要二次确认。

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

这样可以降低上下文体积并避免子 Agent 获得不必要能力。

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
7. 子 Agent 可配置独立 Skill allowlist。
8. URL 和项目 Skill 在加载前经过安全确认。
