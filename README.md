# dsh-science 
[![npm version](https://img.shields.io/npm/v/dsh-science)](https://www.npmjs.com/package/dsh-science)
[![license](https://img.shields.io/npm/l/dsh-science)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](package.json)
[![dsh-plugin topic](https://img.shields.io/badge/GitHub-topic%3A%20dsh--plugin-181717)](https://github.com/topics/dsh-plugin)
---
<img width="865" height="795" alt="Screenshot 2026-08-14 at 19 49 06" src="https://github.com/user-attachments/assets/b6ef210f-6081-42b7-91fd-484f554c955e" />

**A Claude Science–style research workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — for genomics / pathogens / human health / bioinformatics projects.**

> One-liner: **dsh-science** — Claude Science-style research workbench for DSH: ReAct research-loop engine (research_* tools), versioned artifacts with provenance (artifact_* tools), an SSH remote-compute engine (remote_* tools, mirroring Claude Science's Computer / Remote compute clusters), and 11 science skills for genomics / pathogens / bioinformatics.

- **ReAct research loop engine** — `research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review` / `research_report`, persisted in a `research-manifest.json` state machine (Question → Hypothesis → Experiment → Observe → Analyze → Conclude → Next Question).
- **Versioned artifacts with provenance** — `artifact_save` / `artifact_list` / `artifact_show` / `artifact_diff` / `artifact_verify` / `artifact_deprecate` / `artifact_reproduce`: every result saved as `artifacts/<name>/v<N>/` with per-file SHA-256, `artifact.json` provenance (command / inputs / environment / envFile) and an append-only `provenance.md`.
- **Remote compute engine (SSH / HPC clusters)** — 16 tools: `remote_host_add` / `remote_host_probe` / `remote_host_notes` / `remote_run` / `remote_status` / `remote_logs` / `remote_pull` / `remote_cancel` / `remote_exec` etc. Connect lab workstations or HPC clusters via `~/.ssh/config` aliases (nothing installed on the host, zero third-party deps). Long bioinformatics jobs run as detached processes on workstations or via `sbatch` on SLURM — they survive connection loss; submission asks for approval by default; `remote_status` batch-monitors and auto-transitions state (running → succeeded/failed/killed); `remote_pull` fetches outputs back (files over the size threshold stay on the host with their paths recorded).
- **Remote Hosts config UI (bundle/profile-level)** — a Settings > 远程主机 page (the analog of Claude Science's Settings > Compute > SSH hosts): list/add/probe/edit/remove hosts, plus each project's access allowlist and job summary. Host-side REST API (`webServer` route `/dsh-science/remote-hosts/*`, `engines/remote-hosts-ui.mjs`) + client bundle (`client/remote-hosts-ui/`, built by `scripts/build-client-bundle.mjs`) sharing the same data files as the remote engine. Requires a web-process restart to activate (see [docs/remote-hosts-ui.md](docs/remote-hosts-ui.md)).
- **Model Tier router (tiered, cross-provider)** — via the companion bundle [`dsh-model-tier`](packages/dsh-model-tier/): within one session, automatically routes auxiliary requests (session titles, compaction summaries) and subagent/background tasks to a **light tier**, keeps the main conversation on the **default tier**, and escalates complex work (deep subagent chains, very long inputs) to a **strong tier** — each tier may point at a **different provider** (e.g. strong GLM-5.3 / default deepseek-v4-flash / light minimax-M3), mirroring Claude Code's Opus/Sonnet/Haiku strategy. Built on DSH's native `agent/request` + `llm/stream` waterfall extension points; a no-op when the tier's provider is unregistered. Installed automatically with dsh-science, but also standalone-installable into any profile (`dsh plugin add dsh-model-tier`).
- **11 science skills** — research-loop, science-project-setup, artifact-provenance, scientific-reviewer, literature-connector, parallel-delegation, manuscript-writing, bioinformatics-toolkit, conda-environments, data-inventory, remote-compute.

All in-repo engine plugins are **zero-dependency** (Node built-ins + the system OpenSSH binaries, sharing `engines/core.mjs`) and register plain cordis tools; the companion `dsh-model-tier` router is likewise zero-dependency. Installable either as a profile bundle (`dsh plugin add`) or as an agent preset (`科学模式`).

### v0.2.0: Model Tier router (new, companion bundle)

Mirrors Claude Code's Opus/Sonnet/Haiku tiering: within one session, auxiliary requests (`purpose ∈ {session-title, compaction}`) and subagents (`session.meta.origin === 'subagent'`) are routed to the **light tier**; the main conversation keeps its own per-session model selection (never overridden); deep subagent chains (`delegationDepth ≥ subagentDepthStrong`) and very long inputs (`escalateOnChars`, opt-in) escalate to the **strong tier**. An optional LLM pre-classifier (`routing.classify`) grades each user prompt / subtask dispatch by complexity (light / default / strong) before routing. Each tier is `{provider, model, reasoningEffort?}` and may span providers.

Ships as the standalone bundle **[`dsh-model-tier`](packages/dsh-model-tier/)** — dsh-science depends on it and mounts it in its `cordis.patch.yml`, but it can equally be installed on its own into any profile (`dsh plugin add dsh-model-tier`):

```yaml
- id: model-tier
  name: dsh-model-tier
  config:
    tiers:
      strong: { provider: zai-coding-cn, model: glm-5.3 }
      default: { provider: deepseek-official, model: deepseek-v4-flash }
      light: { provider: opencode-go, model: minimax-m2.7 }
    routing:
      auxiliary: [session-title, compaction]
      subagents: light
      subagentDepthStrong: 3
```

- **Host plane** — mounted in the profile bundle (`cordis.patch.yml`), not the agent preset, so it applies to every session and subagent on the profile.
- **Safety rails** — no `tiers` configured → inert no-op; target provider unregistered → no routing; a failing light-tier call automatically falls back to the original route (auxiliary features never break).
- **Verified** — `node packages/dsh-model-tier/test/model-tier.test.mjs` (zero-dependency unit matrix) + `bash packages/dsh-model-tier/scripts/test-model-tier.sh` (E2E: light tier pointed at a local mock LLM; asserts the title request is actually routed).

### v0.2.0: Remote compute (new)

Mirrors Claude Science's **Remote compute clusters / Computer** capability, following its documented mechanism:

- **Host registration + read-only probe** — `remote_host_add` takes a `~/.ssh/config` alias (or `user@host`; ProxyJump etc. handled by OpenSSH), with optional port/identityFile overrides; probing records CPUs, memory, GPUs, CUDA driver, conda/module/Apptainer presence, scratch dirs, `sbatch` and SLURM partitions (`remote_host_probe` re-runs it). Host registry: `$DSH_HOME/remotes/hosts.json`.
- **Job submission** — `remote_run` copies script + inputs into `<scratch>/<jobId>/` (default `~/dsh-scratch`); workstations run it as a detached `nohup+setsid` process (connection-loss safe), SLURM clusters get `sbatch` (with `--time`); default job timeout 30 min; submission asks for approval by default (the analog of Claude Science's "Run this job on <host>?" card).
- **Monitoring & reaction** — `remote_status` batch-probes (ps / squeue+sacct / done+exitcode markers) and auto-transitions state; `remote_logs` tails logs; `remote_pull` fetches outputs and writes `pulled-manifest.json` (files > 100 MB stay on the host with recorded paths); `remote_cancel` kills (process group / scancel). Job registry: `<project>/.dsh/remotes/jobs.json`, persists across sessions.
- **Host Details document** — `remote_host_notes` maintains per-host notes (environment activation, partitions/account, conventions) that the model reads before submitting jobs.
- **Per-project access allowlist (allowed servers, isolated per project)** — every host-connecting action (add/probe, `remote_host_probe`, `remote_exec`, `remote_run`) requires the host to be in the project's allowlist (`.dsh/remotes/allowlist.json`) by default; **first use pops an approval dialog** and, on approval, persists the grant at project scope (the analog of Claude Science's "This project" approval scope). The project root resolves by priority: `research-manifest.json` (research project) → `.dsh` (workspace) → `.git` → session cwd — **multiple research projects in one workspace keep separate allowlists**; grants never leak across projects (authorization paths fail closed when no session cwd is available). Review with `remote_host_allowlist`, revoke with `remote_host_revoke`, pre-grant with `remote_host_allow` (approval-gated); disable with `requireHostAccess: false` for unattended runs.

### v0.1.1 hardening (robustness update)

- **Concurrency-safe state**: all manifest/artifact writes go through a lightweight file lock (O_EXCL + stale reclaim) and atomic tmp+rename — parallel subagents can no longer corrupt or lose updates on `research-manifest.json` / `artifacts.json`.
- **Structured error codes** (`ERR_NOT_INIT` / `ERR_NOT_FOUND` / `ERR_VALIDATION` / `ERR_PATH` / `ERR_QUOTA` / `ERR_LOCK_TIMEOUT` / `ERR_IO`) instead of opaque strings.
- **Hypothesis state machine** (proposed → testing → supported/refuted/inconclusive) and **forward-only phase transitions** (rewind requires config).
- **manifest ↔ artifacts linked**: `research_state` merges the artifact index; `artifact_save` writes back to the manifest.
- **Manifest schema v1→v2 migration** on load, persisted on next write.
- **Artifact upgrades**: streaming SHA-256 (big files), identical-content dedup via hardlink, `artifact_diff` / `artifact_verify` / `artifact_deprecate`, envFile + input hashes in provenance.
- **Structured JSON outputs** (`research_report`, `artifact_diff`, `artifact_verify`) and an audit log at `<root>/.science.log`.

## Install

### Option A — profile bundle (community standard)

```bash
dsh plugin --profile web add dsh-science            # after npm publish
# or straight from GitHub:
dsh plugin --profile web add "github:biociao/dsh-science"
```

Restart the profile (or refresh the Web GUI). The bundle inserts the three engines
into the profile layer stack; the `research_*` / `artifact_*` / `remote_*` tools
become available to every agent on that profile.

### Option B — agent preset (full 科学模式 experience, per-agent)

```bash
git clone https://github.com/biociao/dsh-science ~/.dsh/.agent-presets/science
# or from a local checkout:
bash scripts/install.sh          # copy   (or: bash scripts/install.sh link)
```

Then create a session in the DSH Web GUI and pick the **科学模式** preset — the
preset carries the research persona + engines with per-agent scoping.

### Skills

The 11 skills are discovered automatically from a project's `.dsh/skills/`
(drop this repo's `skills/` into your project), or install them machine-wide:

```bash
bash scripts/install-skills.sh          # -> ~/.dsh/skills (respects $DSH_HOME)
```

## Quick start (first session)

1. `research_init` — create `research-manifest.json` + the project skeleton
   (`experiments/ literature/ artifacts/ analyses/ figures/ manuscript/ reviews/ data/ envs/`).
2. Read `research_state` at the start of every session; the loop state persists
   across sessions.
3. Run the loop: `research_hypothesis` (H1/H2/…) → `research_experiment` (E01/…,
   creates `experiments/<id>/{design.md,log.md,code/,results/}`) → run code →
   `research_findings` (appends to log.md, updates hypothesis status, advances
   the loop) → `artifact_save` for anything worth citing or reproducing.
4. When GPU/cluster/specialized environments are needed: `remote_host_add` the host
   → `remote_run` a background job (approval required) → poll `remote_status` /
   `remote_logs` → `remote_pull` outputs when done → `artifact_save` to archive.
   See [docs/remote-compute.md](docs/remote-compute.md) and the `remote-compute` skill.
5. For key claims: extract the claim, have a review subagent check it against the
   execution records (see the `scientific-reviewer` skill), archive with
   `research_review` (writes `reviews/R0n/report.md`).

## Repository layout

```
dsh-science/
├── package.json          # dsh.bundle.patch -> ./cordis.patch.yml (+ dsh.client + exports)
├── cordis.patch.yml      # bundle patch: inserts the engines by subpath export + mounts dsh-model-tier
├── packages/
│   └── dsh-model-tier/   # 配套独立 bundle：模型分档路由（可单独 dsh plugin add）
├── engines/              # canonical engine sources (bundle form)
│   ├── core.mjs          #   shared core: locks, atomic writes, error codes, streaming sha256, structured tools, audit
│   ├── research-loop.mjs
│   ├── artifact-registry.mjs
│   ├── remote-compute.mjs#   SSH/local transports, host registry + probe, job submit/monitor/pull/cancel
│   └── remote-hosts-ui.mjs#  Remote Hosts 设置页的宿主 REST API（webServer 路由）
├── client/               # client 插件（设置页 UI，bundle/profile 级）
│   └── remote-hosts-ui/  #   src/index.js 源码 · lib/client.js 打包产物（build-client-bundle.mjs）
├── preset/               # agent-preset form (mirrors engines/ via sync-engines.sh)
│   ├── agent.cordis.yml  #   references ./engines/*.mjs (relative, preset mount)
│   ├── preset.yml
│   └── engines/          #   mirror — keep in sync: bash scripts/sync-engines.sh
├── skills/               # 11 SKILL.md skills
├── scripts/
│   ├── install.sh        # install preset -> ~/.dsh/.agent-presets/science
│   ├── install-skills.sh # install skills -> ~/.dsh/skills
│   ├── sync-engines.sh   # mirror engines/ -> preset/engines/
│   ├── init-project.sh   # project skeleton without a science session
│   ├── build-client-bundle.mjs # wrap client src -> __ModuleLoader__ bundle (lib/client.js)
│   ├── smoke-test.mjs    # 125 checks against a temp workspace (node >= 18)
│   └── stability-test.mjs# 25 concurrency/atomicity/stress checks (locks, lost-update, soak, migration)
└── test/verify-bundle.sh # isolated end-to-end bundle install + boot + client scan check
```

## Verification

```bash
node scripts/smoke-test.mjs       # engine logic + end-to-end loop + error codes + migration
node scripts/stability-test.mjs   # concurrency / atomicity / lock / stress stability checks
bash test/verify-bundle.sh        # pnpm pack -> isolated profile -> install -> boot check
```

All are part of the release checklist and are safe to run in CI (both test scripts
write only to a temp workspace; the bundle test uses an isolated `$DSH_HOME`).

## FAQ

**Why subpath exports and not relative paths in the bundle?**
`dsh plugin add` installs the package into the profile and its `cordis.patch.yml`
rows join the profile composition. The profile loader resolves a row `name`
relative to the **profile directory** (not the package), so `./engines/x.mjs`
fails with `ERR_MODULE_NOT_FOUND`. Referencing `dsh-science/engines/x.mjs`
(subpath export, `exports` in `package.json`) resolves from the profile's
`node_modules` and works — verified experimentally on dsh `0.1.0-rc.6`.
The agent-preset mount, by contrast, resolves relative names from the preset
directory, which is why `preset/agent.cordis.yml` can use `./engines/*.mjs`.

**Bundle or preset — which should I use?**
- Bundle: tools available to every agent on the profile; one command to install.
- Preset: the full 科学模式 experience (research persona, per-agent scoping).
  The persona row in `cordis.patch.yml` is commented out because a profile-wide
  persona would apply to all agents — uncomment it before publishing if that is
  what you want.

**Where do the skills come from?**
A project's `.dsh/skills/` is auto-discovered; `scripts/install-skills.sh` puts
them machine-wide in `~/.dsh/skills` (respecting `$DSH_HOME`).

## Development

Branching model & release workflow (main = release, dev = integration, `feat/*` = features,
tag-triggered npm publish + GitHub Release via Actions): see
[docs/branching.md](docs/branching.md).

```bash
bash scripts/sync-engines.sh    # after editing engines/*.mjs — keeps preset/engines in sync
node scripts/smoke-test.mjs     # logic + static package checks
node scripts/stability-test.mjs # concurrency / atomicity / lock stability checks
bash test/verify-bundle.sh      # end-to-end bundle install + boot
```

## Community

- Topic: [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)
- Curated lists: [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)

## License

MIT — see [LICENSE](LICENSE).
