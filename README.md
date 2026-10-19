# dsh-science 
[![npm version](https://img.shields.io/npm/v/dsh-science)](https://www.npmjs.com/package/dsh-science)
[![license](https://img.shields.io/npm/l/dsh-science)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](package.json)
[![dsh-plugin topic](https://img.shields.io/badge/GitHub-topic%3A%20dsh--plugin-181717)](https://github.com/topics/dsh-plugin)
---
<img width="865" height="795" alt="Screenshot 2026-08-14 at 19 49 06" src="https://github.com/user-attachments/assets/b6ef210f-6081-42b7-91fd-484f554c955e" />

**A Claude Science–style research workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — for genomics / pathogens / human health / bioinformatics projects.**

> One-liner: **dsh-science** — Claude Science-style research workbench for DSH: ReAct research-loop engine (research_* tools), versioned artifacts with provenance (artifact_* tools), an SSH remote-compute engine (remote_* tools, mirroring Claude Science's Computer / Remote compute clusters), a Biomni-style general-purpose biomedical agent mode (biomni_* tools, replicated from snap-stanford/Biomni), and 14 science skills for genomics / pathogens / bioinformatics.

- **ReAct research loop engine** — `research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review` / `research_report`, persisted in a `research-manifest.json` state machine (Question → Hypothesis → Experiment → Observe → Analyze → Conclude → Next Question).
- **Versioned artifacts with provenance** — `artifact_save` / `artifact_list` / `artifact_show` / `artifact_diff` / `artifact_verify` / `artifact_deprecate` / `artifact_reproduce`: every result saved as `artifacts/<name>/v<N>/` with per-file SHA-256, `artifact.json` provenance (command / inputs / environment / envFile) and an append-only `provenance.md`.
- **Remote compute engine (SSH / HPC clusters)** — 16 tools: `remote_host_add` / `remote_host_probe` / `remote_host_notes` / `remote_run` / `remote_status` / `remote_logs` / `remote_pull` / `remote_cancel` / `remote_exec` etc. Connect lab workstations or HPC clusters via `~/.ssh/config` aliases (nothing installed on the host, zero third-party deps). Long bioinformatics jobs run as detached processes on workstations or via `sbatch` on SLURM — they survive connection loss; submission asks for approval by default; `remote_status` batch-monitors and auto-transitions state (running → succeeded/failed/killed); `remote_pull` fetches outputs back (files over the size threshold stay on the host with their paths recorded).
- **Remote Hosts config UI (bundle/profile-level)** — a Settings > 远程主机 page (the analog of Claude Science's Settings > Compute > SSH hosts): list/add/probe/edit/remove hosts, plus each project's access allowlist and job summary. Host-side REST API (`webServer` route `/dsh-science/remote-hosts/*`, `engines/remote-hosts-ui.mjs`) + client bundle (`client/remote-hosts-ui/`, built by `scripts/build-client-bundle.mjs`) sharing the same data files as the remote engine. Requires a web-process restart to activate (see [docs/remote-hosts-ui.md](docs/remote-hosts-ui.md)).
- **Codex-style sidebar enhancement (bundle/profile-level)** — turns the DSH sidebar into the Codex three-tier layout — **Pinned → Workspaces → Recents** (Pinned is a sibling section above Workspaces; pinned projects expand inline to show their own sessions (first 5 + "show N more", matching native groups); Recents lists the latest sessions by time; all three section headers share one typography and collapse, including the native Workspaces section, and the whole middle area scrolls as one container so an expanded Pinned section never squeezes Workspaces/Recents away), with a pinned-projects section (right-click a workspace to pin; persists across restarts and can be collapsed), the workspace row's native "…" menu plus a right-click menu (pin/unpin, reveal in Finder / Explorer / file manager, open project dir, copy project path, open in a new session, expand/collapse sessions), and a hover status card (session count / running / last active / pinned — no action buttons). Pins are keyed by `workspaceId` in `$DSH_HOME/dsh-science/sidebar.json`; a host-side REST API (`webServer` route `/dsh-science/sidebar/*`, `engines/sidebar-ui.mjs`) persists pins and drives the OS file manager, while the client half (`client/remote-hosts-ui/src/sidebar.js`) augments the live DOM because `sidebar.workspaces` is a `single` slot (a MutationObserver restores the injection; if a DSH upgrade changes the anchors the feature degrades gracefully instead of crashing). Requires a web-process restart to activate (see [docs/sidebar.md](docs/sidebar.md)).
- **Research Workbench (multi-project classification & status)** — a Settings > 科研工作台 page plus `research_workbench` / `research_project_list` / `research_project_show` / `research_project_register` / `research_project_classify` tools. It auto-discovers every project folder (a directory with `research-manifest.json`) under a workbench root, keeps classification metadata (**category / tags / priority / lifecycle status / notes**) in `<workbench-root>/.dsh/workbench.json`, and aggregates each project's *live* status — loop phase, hypothesis & experiment status distribution, artifact count, pending reviews, remote job count, last activity. Group / filter / sort by category, status, priority, or tag, and get a global summary. The single-project Research loop engine (below) stays per-project; this workbench is the *umbrella* layer that makes many projects manageable. Host-side REST API (`webServer` route `/dsh-science/workbench/*`, `engines/workbench-ui.mjs`) + the same client bundle (see [docs/workbench.md](docs/workbench.md)).
- **Tech Roadmap (issue board → roadmap module)** — a top-level session view (技术路线图, next to 会话/轨迹, scoped to the Session's Workspace) plus `roadmap_init` / `roadmap_show` / `roadmap_node_add` / `roadmap_node_update` / `roadmap_node_history` / `roadmap_node_revert` / `roadmap_link` / `roadmap_apply` / `roadmap_layout` / `roadmap_render` tools. Every **step / issue / milestone** is a **node** on the canvas (custom **color / shape**, swimlane `track`, position & size, plus structured **IO contract** — `inputs` / `outputs` / `tool` / `command`; when a downstream node's `inputs` match an upstream node's `outputs`, that edge automatically carries the artifact name, nodes show a `⚙ tool` badge, and a "Data flow" tab summarises artifact transfers and tooling), and nodes are joined by **typed dependency edges** that express upstream/downstream logic — **serial / parallel / feedback / loop**. The canvas supports **drag, cursor-anchored wheel zoom, fit-to-view (and auto-fit on open), multi-select group drag** (Shift/⌘+click, Shift+drag marquee, select-all). **Auto-layout has switchable styles**: `compact` (default; columns follow upstream/downstream depth, swimlanes are interval-packed, long chains snake-wrap into bands so the graph fits roughly one screen), `horizontal` (one row per swimlane, clear hierarchy but long), and `vertical` (stages top-to-bottom, swimlanes side by side). The chosen style is persisted with the roadmap. **AI-assisted generation** comes in three flavours: call `roadmap_apply` from the session (idempotent incremental merge by `ref`/title), the canvas "AI 生成" button (host-side standalone LLM call), or "copy prompt to session" (zero model config). **Every node is version-managed**: semantic-field edits append a version (changed fields / author / note), **canvas drags never pollute the version history** (layout only), and revert is **append-only** — so you can trace the upstream/downstream logic of competing **analysis strategies, hyperparameters and tests** across project iterations. State lives in `<project-root>/.dsh/roadmap.json` (shared by the AI tools and the canvas), with one-click Mermaid/Graphviz export (see [docs/roadmap.md](docs/roadmap.md)).
- **Model Tier router (tiered, cross-provider)** — via the companion bundle [`dsh-model-tier`](packages/dsh-model-tier/): within one session, automatically routes auxiliary requests (session titles, compaction summaries) and subagent/background tasks to a **light tier**, keeps the main conversation on the **default tier**, and escalates complex work (deep subagent chains, very long inputs) to a **strong tier** — each tier may point at a **different provider** (e.g. strong GLM-5.3 / default deepseek-v4-flash / light minimax-M3), mirroring Claude Code's Opus/Sonnet/Haiku strategy. Built on DSH's native `agent/request` + `llm/stream` waterfall extension points; a no-op when the tier's provider is unregistered. Installed automatically with dsh-science, but also standalone-installable into any profile (`dsh plugin add dsh-model-tier`).
- **Independent auto-review engine (Scientific Reviewer, HOST plane)** — the analog of Claude Science's reviewer agent (actor-critic): watches main-session turn boundaries, fires on events (new artifact versions / hypothesis updates / manuscript changes), collects claims and execution records read-only, then runs an independent review call with the **review model explicitly set in the bundle config** — decoupled from the working model, so a small model can execute while a strong reasoning model reviews. Verdicts land in `reviews/Rnn/` + the manifest (supported/refuted/inconclusive can conclude a testing hypothesis); findings flow back to the main agent via a "pending reviews" notice appended to every `research_*` tool result, and fixes trigger automatic re-review. Optional `gate: true` blocks concluding a hypothesis whose latest review is needs-work/refuted (`ERR_REVIEW_GATE`).
- **14 science skills** — research-loop, science-project-setup, artifact-provenance, scientific-reviewer, literature-connector, parallel-delegation, manuscript-writing, bioinformatics-toolkit, conda-environments, data-inventory, remote-compute, biomni-agent, ngs-analysis-workbench, bioinformatics-habits (with 10 domain packs: genomics / transcriptomics / single-cell / epigenomics / microbiome / proteomics / metabolomics / spatial / multi-omics / statistical-genetics).
- **Biomni 模式（general-purpose biomedical agent mode, parallel to 科学模式)** — a second research ontology replicated from [snap-stanford/Biomni](https://github.com/snap-stanford/Biomni) + its [Science paper](https://www.science.org/doi/10.1126/science.adz4351): **retrieval-augmented planning + code-first execution + reflection**. Four zero-dep engines (`biomni-registry` / `biomni-retriever` / `biomni-plan` / `biomni-reflect`) maintain `.biomni/{registry.json,plan.json,reflect.jsonl}` and expose `biomni_resources_list` / `biomni_registry_add|remove|show` / `biomni_retrieve` / `biomni_plan_init|update|status` / `biomni_reflect|list`. Sells via the **科学模式-parallel `preset-biomni`** agent-preset (persona + engines) and is also mounted in the profile bundle (`cordis.patch.yml`). See [docs/biomni-mode.md](docs/biomni-mode.md).

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

The compatibility target is **DSH `0.2.0-rc.2`**. Presets are now registered by
declarative bundle rows; DSH no longer discovers them by scanning
`~/.dsh/.agent-presets/`. See [the migration notes](docs/dsh-0.2-compatibility.md)
for the changes and verification scope. The DSH integration checks use Node 22;
the standalone engine tests still support Node 18/20.

### Option A — profile bundle (community standard)

```bash
dsh plugin --profile web add dsh-science            # after npm publish
# or straight from GitHub:
dsh plugin --profile web add "github:biociao/dsh-science"
```

Restart the profile after installing or updating, then refresh the Web GUI.
A page refresh alone does not load new Host preset declarations or engine code.
The bundle inserts the research /
artifact / remote-compute engines, the research-workbench engine, the host-side
`workbench-ui` + `remote-hosts-ui` REST engines, and the scientific-reviewer engine
into the profile layer stack; the `research_*` / `artifact_*` / `remote_*` /
`research_project_*` tools become available to every agent on that profile.
The same bundle also registers **科学模式** and **Biomni 模式** in the preset picker.
If the picker is hidden, enable Developer tools (「显示代码工作视图」) in Settings.
Select a preset in a new blank session before sending the first message; started
sessions cannot switch presets. A profile with the full bundle does not need the
standalone preset installers in Option B.

### Option B — agent preset (full 科学模式 experience, per-agent)

```bash
bash scripts/install.sh            # 科学模式: local bundle, default profile web
bash scripts/install-biomni.sh     # Biomni 模式: local bundle, default profile web
# For development, link the engines instead of copying them:
bash scripts/install.sh link
# To select another profile:
DSH_PROFILE=my-profile bash scripts/install-biomni.sh link
```

These scripts create bundles under `$DSH_HOME/local-bundles/` (default
`~/.dsh/local-bundles/`) and register them with `dsh plugin --profile ... add`.
`copy` is the default; `link` links the engine directory for local development.
After installation, restart DSH, then create a session in the Web GUI and pick the **科学模式** preset — the
preset carries the research persona + engines with per-agent scoping.
(Or pick **Biomni 模式** for the general-purpose biomedical agent mode.)

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
5. Key claims are reviewed automatically by the scientific-reviewer engine (fired by
   new artifacts / hypothesis updates / manuscript changes; the review model is set
   explicitly in the bundle config). Verdicts land in `reviews/R0n/report.md` and flow
   back via the "pending reviews" notice appended to `research_*` tool results —
   address needs-work/refuted items and the fix triggers a re-review. If the engine is
   absent, follow the manual fallback in the `scientific-reviewer` skill and archive
   with `research_review`.

## Repository layout

```
dsh-science/
├── package.json          # dsh.bundle.patch -> root + science/biomni preset patches
├── cordis.patch.yml      # bundle patch: inserts the engines by subpath export + mounts dsh-model-tier
├── packages/
│   └── dsh-model-tier/   # 配套独立 bundle：模型分档路由（可单独 dsh plugin add）
├── engines/              # canonical engine sources (bundle form)
│   ├── core.mjs          #   shared core: locks, atomic writes, error codes, streaming sha256, structured tools, audit
│   ├── research-loop.mjs
│   ├── artifact-registry.mjs
│   ├── remote-compute.mjs#   SSH/local transports, host registry + probe, job submit/monitor/pull/cancel
│   ├── workbench.mjs     #   科研工作台：多项目分类/状态追踪（research_project_* 工具 + .dsh/workbench.json）
│   ├── remote-hosts-ui.mjs#  Remote Hosts 设置页的宿主 REST API（webServer 路由）
│   ├── workbench-ui.mjs  #   research-workbench settings page host REST API (webServer route /dsh-science/workbench/*)
│   ├── sidebar-ui.mjs    #   Codex-style sidebar enhancement host REST API (/dsh-science/sidebar/*: pin store + reveal/open)
│   ├── biomni-registry.mjs#  Biomni 模式：资源宇宙（工具/数据湖/软件库/Know-How + 运行时注入）
│   ├── biomni-retriever.mjs# Biomni 模式：检索增强规划（聚焦子集 + 计划骨架）
│   ├── biomni-plan.mjs   #   Biomni 模式：研究计划与状态清单（plan.json）
│   └── biomni-reflect.mjs#   Biomni 模式：反思/自批判日志（reflect.jsonl）
├── client/               # client 插件（设置页 UI，bundle/profile 级）
│   └── remote-hosts-ui/  #   src/index.js (Remote Hosts page) + src/workbench.js (workbench page) + src/sidebar.js (sidebar enhancement) · lib/client.js built bundle
├── preset/               # agent-preset form (mirrors engines/ via sync-engines.sh)
│   ├── agent.cordis.yml  #   editable preset plugin list (source for generated bundle)
│   ├── cordis.patch.yml  #   generated declarative @deepseek-ai/dsh-agent-preset row
│   ├── preset.yml
│   └── engines/          #   mirror — keep in sync: bash scripts/sync-engines.sh
├── preset-biomni/        # Biomni 模式 agent-preset form (parallel to 科学模式)
│   ├── agent.cordis.yml  #   editable Biomni persona + engine plugin list
│   ├── cordis.patch.yml  #   generated declarative @deepseek-ai/dsh-agent-preset row
│   ├── preset.yml
│   └── engines/          #   mirror — keep in sync: bash scripts/sync-engines.sh
├── skills/               # SKILL.md skills (incl. biomni-agent)
├── scripts/
│   ├── install.sh        # register local science preset bundle in a profile
│   ├── install-biomni.sh # register local Biomni preset bundle in a profile
│   ├── install-preset.mjs # shared copy/link installer (DSH_PROFILE defaults to web)
│   ├── build-preset-bundles.mjs # agent.cordis.yml -> declarative preset patches
│   ├── install-skills.sh # install skills -> ~/.dsh/skills
│   ├── sync-engines.sh   # mirror engines/ -> preset/engines/ + preset-biomni/engines/
│   ├── init-project.sh   # project skeleton without a science session
│   ├── build-client-bundle.mjs # wrap client src -> __ModuleLoader__ bundle (lib/client.js)
│   ├── smoke-test.mjs    # 188 checks against a temp workspace (node >= 18)
│   ├── biomni-smoke-test.mjs # 47 checks for the Biomni-mode engines + preset
│   └── stability-test.mjs# 25 concurrency/atomicity/stress checks (locks, lost-update, soak, migration)
└── test/verify-bundle.sh # isolated end-to-end bundle install + boot + client scan check
```

## Verification

```bash
node scripts/build-preset-bundles.mjs --check # generated patches match their source
node scripts/smoke-test.mjs       # engine logic + end-to-end loop + error codes + migration
node scripts/biomni-smoke-test.mjs# Biomni-mode engines (registry/retriever/plan/reflect) + preset checks
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
`node_modules`. The editable `preset/agent.cordis.yml` and
`preset-biomni/agent.cordis.yml` retain relative engine names; the preset bundle
generator rewrites these to package subpath exports inside `config.plugins`.
This is the preset registration form used by DSH `0.2.0-rc.2`.

**Bundle or preset — which should I use?**
- Bundle: tools available to every agent on the profile; one command installs
  the engines and registers both selectable presets.
- Preset installer: registers only the chosen mode's persona and plugins for
  per-agent use. Profile services such as the Web settings panels and model
  router come from the full bundle.
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
bash scripts/sync-engines.sh    # after editing engines/*.mjs — keeps preset/engines + preset-biomni/engines in sync
node scripts/build-preset-bundles.mjs # after editing either agent.cordis.yml
node scripts/smoke-test.mjs     # logic + static package checks
node scripts/biomni-smoke-test.mjs # Biomni-mode engine + preset checks
node scripts/stability-test.mjs # concurrency / atomicity / lock stability checks
bash test/verify-bundle.sh      # end-to-end bundle install + boot
```

**Workspace-isolation patch** — DSH's New Session used to fall back to the most
recently used Workspace, letting automation spawn sessions into unrelated
projects. `scripts/patch-session-isolation.mjs` applies the one-line guard
(idempotent, backs up first; re-apply after every `dsh` upgrade). See
[docs/workspace-isolation.md](docs/workspace-isolation.md).

```bash
node scripts/patch-session-isolation.mjs apply   # idempotent, backs up first
node scripts/patch-session-isolation.mjs status  # check current state
node scripts/patch-session-isolation.mjs revert  # restore pristine file
```

## Community

- Topic: [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)
- Curated lists: [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)

## License

MIT — see [LICENSE](LICENSE).
