

# dsh-science 
[![npm version](https://img.shields.io/npm/v/dsh-science)](https://www.npmjs.com/package/dsh-science)
[![license](https://img.shields.io/npm/l/dsh-science)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](package.json)
[![dsh-plugin topic](https://img.shields.io/badge/GitHub-topic%3A%20dsh--plugin-181717)](https://github.com/topics/dsh-plugin)
---
<img width="865" height="795" alt="Screenshot 2026-08-14 at 19 49 06" src="https://github.com/user-attachments/assets/b6ef210f-6081-42b7-91fd-484f554c955e" />

**A Claude Science–style research workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — for genomics / pathogens / human health / bioinformatics projects.**

> One-liner: **dsh-science** — Claude Science-style research workbench for DSH: ReAct research-loop engine (research_* tools), versioned artifacts with provenance (artifact_* tools), and 10 science skills for genomics / pathogens / bioinformatics.

- **ReAct research loop engine** — `research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review` / `research_report`, persisted in a `research-manifest.json` state machine (Question → Hypothesis → Experiment → Observe → Analyze → Conclude → Next Question).
- **Versioned artifacts with provenance** — `artifact_save` / `artifact_list` / `artifact_show` / `artifact_diff` / `artifact_verify` / `artifact_deprecate` / `artifact_reproduce`: every result saved as `artifacts/<name>/v<N>/` with per-file SHA-256, `artifact.json` provenance (command / inputs / environment / envFile) and an append-only `provenance.md`.
- **10 science skills** — research-loop, science-project-setup, artifact-provenance, scientific-reviewer, literature-connector, parallel-delegation, manuscript-writing, bioinformatics-toolkit, conda-environments, data-inventory.

Both engine plugins are **zero-dependency** (Node built-ins only, sharing `engines/core.mjs`) and register plain cordis tools. Installable either as a profile bundle (`dsh plugin add`) or as an agent preset (`科学模式`).

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

Restart the profile (or refresh the Web GUI). The bundle inserts the two engines
into the profile layer stack; the `research_*` / `artifact_*` tools become
available to every agent on that profile.

### Option B — agent preset (full 科学模式 experience, per-agent)

```bash
git clone https://github.com/biociao/dsh-science && cd dsh-science
# or from a local checkout:
bash scripts/install.sh          # copy   (or: bash scripts/install.sh link)
```

Then create a session in the DSH Web GUI and pick the **科学模式** preset — the
preset carries the research persona + engines with per-agent scoping.

### Skills

The 10 skills are discovered automatically from a project's `.dsh/skills/`
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
4. For key claims: extract the claim, have a review subagent check it against the
   execution records (see the `scientific-reviewer` skill), archive with
   `research_review` (writes `reviews/R0n/report.md`).

## Repository layout

```
dsh-science/
├── package.json          # dsh.bundle.patch -> ./cordis.patch.yml (+ exports)
├── cordis.patch.yml      # bundle patch: inserts the two engines by subpath export
├── engines/              # canonical engine sources (bundle form)
│   ├── core.mjs          #   shared core: locks, atomic writes, error codes, streaming sha256, structured tools, audit
│   ├── research-loop.mjs
│   └── artifact-registry.mjs
├── preset/               # agent-preset form (mirrors engines/ via sync-engines.sh)
│   ├── agent.cordis.yml  #   references ./engines/*.mjs (relative, preset mount)
│   ├── preset.yml
│   └── engines/          #   mirror — keep in sync: bash scripts/sync-engines.sh
├── skills/               # 10 SKILL.md skills
├── scripts/
│   ├── install.sh        # install preset -> ~/.dsh/.agent-presets/science
│   ├── install-skills.sh # install skills -> ~/.dsh/skills
│   ├── sync-engines.sh   # mirror engines/ -> preset/engines/
│   ├── init-project.sh   # project skeleton without a science session
│   ├── smoke-test.mjs    # 62 checks against a temp workspace (node >= 18)
│   └── stability-test.mjs# 25 concurrency/atomicity/stress checks (locks, lost-update, soak, migration)
└── test/verify-bundle.sh # isolated end-to-end bundle install + boot check
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
