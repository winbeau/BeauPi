<p align="center">
  <a href="https://github.com/winbeau/beaupi">
    <img alt="BeauPi, based on Pi" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@winbeau/beaupi"><img alt="npm" src="https://img.shields.io/npm/v/@winbeau/beaupi?style=flat-square" /></a>
</p>

# BeauPi

BeauPi is a WSL-first, document-driven terminal coding agent built on the Pi runtime. It adds native task planning, controlled sub-agents, workflows, background monitoring, SSH/tmux execution, web research, and per-request sudo control.

**Latest stable release:** [BeauPi 1.0.1](https://github.com/winbeau/beaupi/releases/tag/v1.0.1)

## Install

### npm (Node.js 22.19 or newer)

```bash
npm install -g @winbeau/beaupi
beaupi --version
```

BeauPi `1.0.1` runs an npm `postinstall` migration that directly replaces `~/.beaupi/agent/settings.json`, `models.json`, and `auth.json`. Existing files are backed up under `~/.beaupi/agent/backups/config-overwrite-v1.0.1/`; saved API keys and OAuth credentials must be configured again.

### Standalone binary (Linux and macOS)

```bash
curl -fsSL https://github.com/winbeau/beaupi/releases/latest/download/install.sh | sh
beaupi --version
```

The standalone installer verifies the selected archive against the release's `SHA256SUMS`, validates its layout, and installs it into a versioned directory. Windows x64/arm64 binaries, source archives, install lock files, and checksums are available on the [GitHub Releases page](https://github.com/winbeau/beaupi/releases).

Development and architecture documentation is under [docs/beaupi](docs/beaupi/README.md). BeauPi retains the upstream Pi runtime and MIT license; upstream project documentation is available at [pi.dev](https://pi.dev).

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Published Packages

| Package | Source | Description |
|---------|--------|-------------|
| **[@winbeau/beaupi](https://www.npmjs.com/package/@winbeau/beaupi)** | [packages/coding-agent](packages/coding-agent) | BeauPi terminal coding agent CLI |
| **[@winbeau/beaupi-ai](https://www.npmjs.com/package/@winbeau/beaupi-ai)** | [packages/ai](packages/ai) | Unified multi-provider LLM API |
| **[@winbeau/beaupi-agent-core](https://www.npmjs.com/package/@winbeau/beaupi-agent-core)** | [packages/agent](packages/agent) | Agent runtime with tool calling and state management |
| **[@winbeau/beaupi-tui](https://www.npmjs.com/package/@winbeau/beaupi-tui)** | [packages/tui](packages/tui) | Terminal UI library with differential rendering |
| **[@winbeau/beaupi-storage-sqlite-node](https://www.npmjs.com/package/@winbeau/beaupi-storage-sqlite-node)** | [packages/storage/sqlite-node](packages/storage/sqlite-node) | Node.js SQLite storage adapter |

For upstream Slack/chat automation and workflows, see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

BeauPi does not include a general-purpose permission sandbox for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox BeauPi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `beaupi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `beaupi` process in a local container for simple isolation.
- **OpenShell**: run the whole `beaupi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run BeauPi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "beaupi-${VERSION}-source.tar.gz"
cd "beaupi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Documented BeauPi npm installs, local release installs, and `beaupi update --self` run lifecycle scripts so the reviewed BeauPi `postinstall` migration can update user configuration.
- Development and CI dependency hydration still use `npm ci --ignore-scripts`; a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
