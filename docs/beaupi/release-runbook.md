# BeauPi 发布手册（Release Runbook）

> 本文档由 v1.2.5 首次发布的完整实战记录沉淀而成：正常流程 + 每一步踩过的坑与对策。
> 发布前先读本文档；遇到问题时按「故障与对策」逐条对照。

## 1. 发布全景

```
node scripts/release.mjs <major|minor|patch>
  ├─ 1. 检查工作区干净（未跟踪文件也会拒绝）
  ├─ 2. bump 版本（npm run version:xxx / npm version -ws）
  ├─ 3. CHANGELOG.md：[Unreleased] → [版本] - 日期（6 个包）
  ├─ 4. 重新生成产物：generate:models + check:model-data + shrinkwrap + install-lock
  ├─ 5. npm run check + build:offline + ./test.sh
  ├─ 6. commit "Release vX.Y.Z" + tag vX.Y.Z
  ├─ 7. 追加新的 [Unreleased] 区块
  ├─ 8. commit "Add [Unreleased] section for next cycle"
  └─ 9. git push origin main + git push origin vX.Y.Z
```

发布包（改名发布，`scripts/beaupi-distribution.mjs` 的 `BEAUPI_PACKAGES`）：

| 源码包 | npm 发布名 |
|---|---|
| `@earendil-works/pi-ai` | `@winbeau/beaupi-ai` |
| `@earendil-works/pi-agent-core` | `@winbeau/beaupi-agent-core` |
| `@earendil-works/pi-coding-agent` | `@winbeau/beaupi` |
| `@earendil-works/pi-tui` | `@winbeau/beaupi-tui` |
| `@earendil-works/pi-storage-sqlite-node` | `@winbeau/beaupi-storage-sqlite-node` |

> ⚠️ 验证发布结果时不要查 `npm view @earendil-works/pi-*`——该 scope 在 npm 上是无关的旧包（latest 0.84.1），
> 会误导排查。只查 `@winbeau/beaupi-*`。

npm 发布与 GitHub Release 由 GitHub Actions 执行：push `v*` tag 本应触发
`.github/workflows/build-binaries.yml`，但该 workflow 历史上**从未被 tag push 自动触发过**，
实际发布一律用 workflow_dispatch 手动触发：

```bash
gh workflow run build-binaries.yml --ref main -f tag=v1.2.5
gh run watch <run-id> --exit-status
```

## 2. 正常发布流程（推荐）

```bash
# 0) 前置：无未提交/未跟踪改动；docs/ 下临时文件先移走
git status --porcelain   # 必须为空
node scripts/release.mjs patch
```

脚本成功 = 两个 commit + tag 已推送。然后触发 CI 发布：

```bash
gh workflow run build-binaries.yml --ref main -f tag=vX.Y.Z
gh run list --workflow=build-binaries.yml --limit 3
```

### 发布后验证清单

```bash
for p in @winbeau/beaupi-ai @winbeau/beaupi-agent-core @winbeau/beaupi \
         @winbeau/beaupi-tui @winbeau/beaupi-storage-sqlite-node; do
  npm view "$p@<版本>" version
done
gh run list --workflow=build-binaries.yml --limit 2   # 全部 job success
# 抽查包内容（例：验证新类型字段已上线）：
npm pack @winbeau/beaupi-ai@<版本> && tar -xzf *.tgz && grep -l "ToolResultError" package/dist/types.d.ts
```

## 3. 故障与对策（v1.2.5 实战沉淀）

### 3.1 本地无外网：`generate:models` 网络超时

症状：`npm run generate:models` 报 `ETIMEDOUT`（models.dev / openrouter.ai 不可达），脚本退出。

对策：使用 offline 模式（用 checked-in 模型数据，跳过联网抓取）：

```bash
PI_RELEASE_OFFLINE_MODEL_DATA=1 node scripts/release.mjs patch
```

注意：offline 模式的模型数据若与在线最新不一致，CI 侧（有网）会重新 hydrate，
可能导致 CI check 失败——见 3.4。

### 3.2 release.mjs 中途失败后的恢复

症状：脚本已在步骤 2-3 改了版本号/CHANGELOG（未提交），失败退出；直接重跑会被
"Uncommitted changes" 拒绝。

对策：回滚后重跑（bump 是幂等的，重跑会再次 bump 同一目标版本）：

```bash
git checkout -- .
PI_RELEASE_OFFLINE_MODEL_DATA=1 node scripts/release.mjs patch
```

### 3.3 `./test.sh` 环境性失败

症状：无外网时 web-fetch-runtime / web-tools-session（网络断言）必挂；tmux 相关
（local-privilege-tmux）、时序类（agent-session-concurrent）、真实进程类
（llama-extension、background-runtime、extensions-discovery）轮换抖动，隔离复跑即过。

对策（仅在确认无真实回归时使用，官方支持）：

```bash
PI_RELEASE_OFFLINE_MODEL_DATA=1 PI_RELEASE_SKIP_TESTS=1 node scripts/release.mjs patch
```

判断标准：check + build:offline 在脚本内已通过；失败测试逐个 `node ../../node_modules/vitest/dist/cli.js --run test/xxx.test.ts` 隔离复跑全绿；失败文件与本次改动无交集。

### 3.4 CI Check 失败：模型数据漂移（测试引用过期模型 ID）

症状：publish-npm job 的 Check 步骤 `tsgo` 报
`Argument of type '"claude-opus-4-1-20250805"' is not assignable to parameter of type 'ModelId<...>'`
——CI 每次发布会在线 hydrate 模型数据（`npm run build` 内含 generate-models），
models.dev 上游已移除旧 ID，而测试仍引用旧 ID。与业务代码改动无关。

根因链：`packages/ai/src/providers/data/` 在 .gitignore 中（生成物不入库）→
本地 check 用的是本地生成的数据 → 与 CI 在线数据不一致。

修法（在有网环境执行）：
1. 在有网服务器（如 huawei2，见 3.5）上：同步源码 → `npm ci` → `npm run generate:models`
2. 把 `packages/ai/src/providers/data/` 拉回本地
3. `npm run check` 复现报错 → 把测试里的模型 ID 换成新数据中存在的等价 ID
   （google: gemini-2.0-flash → gemini-2.5-flash；anthropic: claude-opus-4-1-20250805 → claude-opus-4-5-20251101；
   opencode 的 grok-build-0.1 已从 openai-completions 变为 openai-responses，换用仍在 completions 分类的模型）
4. check + 相关测试验证 → 提交 → 重新走发布

### 3.5 有网环境：huawei2 服务器

本地无外网时，模型数据生成走 `huawei2`（`~/.ssh/config`，Host 124.71.228.242，User winbeau）：

```bash
# 同步源码（排除生成物/依赖）
rsync -az --delete --exclude node_modules --exclude .git --exclude dist --exclude '*.tgz' ./ huawei2:~/pi-gen/
# 远程：nvm + 走本机代理（RemoteForward 10808）访问外网；Node 24 原生 fetch 需 --use-env-proxy
ssh huawei2 'export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; \
  export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 NODE_OPTIONS=--use-env-proxy; \
  cd ~/pi-gen && npm ci --ignore-scripts && npm run generate:models'
# 拉回生成的数据
rsync -az huawei2:~/pi-gen/packages/ai/src/providers/data/ packages/ai/src/providers/data/
```

要点：huawei2 默认 PATH 无 node（nvm 管理，v24.15.0）；models.dev 直连不通，
必须经 `RemoteForward 10808` 的本机代理；`NODE_OPTIONS=--use-env-proxy` 让原生 fetch 走代理。

### 3.6 CI 发布被外部数据漂移挡住时的 recovery 路径

症状：本地已完成完整验证（check/test 全绿或仅环境抖动），但 CI Check 因上游数据
漂移失败（3.4），且当下无网络修数据。workflow 内置 recovery 开关（仅限恢复场景）：

```bash
gh workflow run build-binaries.yml --ref main -f tag=vX.Y.Z -f skip_validation=true
```

`skip_validation=true` 跳过 CI 的 Check/Test，但 Build（含在线 hydrate）与 Publish 照跑。
使用前提：本地已验证当前代码，跳过的是 CI 重复验证；3.4 的修法仍要尽快补上，
否则下次发布还会挂。

### 3.7 其他注意点

- 工作区必须完全干净：未跟踪文件（如 docs/ 下的临时计划目录）也会让脚本拒绝启动，
  先 `mv` 走、发布完移回。
- 发布脚本内部跑 `npm run build:offline`（不是 build），不要手工跑 `npm run build`（会联网 hydrate）。
- `npm test` 是被禁止的命令；脚本内用的是 `./test.sh`。
- 版本号惯例：跟随 repo 历史，逐次 patch 递增（v1.2.0 → v1.2.1 → ...）。
- 版本更新会改 package-lock.json、npm-shrinkwrap.json、install-lock 等大量产物文件，属正常。
