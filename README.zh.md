# dsh-science

[![npm version](https://img.shields.io/npm/v/dsh-science)](https://www.npmjs.com/package/dsh-science)
[![license](https://img.shields.io/npm/l/dsh-science)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](package.json)
[![dsh-plugin topic](https://img.shields.io/badge/GitHub-topic%3A%20dsh--plugin-181717)](https://github.com/topics/dsh-plugin)

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Science 式科研工作台** —— 面向基因组 / 病原体 / 人类健康 / 生物信息项目。

> 一句话介绍：**dsh-science** —— 面向 DSH 的 Claude Science 式科研工作台：ReAct 研究循环引擎（research_* 工具）、带溯源的版本化工件（artifact_* 工具），以及面向基因组/病原体/生物信息的 10 个科研技能。

- **ReAct 研究循环引擎** —— `research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review`，状态持久化在 `research-manifest.json`（提问 → 假设 → 实验 → 观察 → 分析 → 结论 → 下一问题）。
- **版本化工件与溯源** —— `artifact_save` / `artifact_list` / `artifact_show` / `artifact_reproduce`：结果存为 `artifacts/<name>/v<N>/`，附每文件 SHA-256、`artifact.json` 溯源（命令/输入/备注/环境）与追加式 `provenance.md`。
- **10 个科研技能** —— research-loop、science-project-setup、artifact-provenance、scientific-reviewer、literature-connector、parallel-delegation、manuscript-writing、bioinformatics-toolkit、conda-environments、data-inventory。

两个引擎插件**零第三方依赖**（只用 Node 内置模块），注册标准 cordis 工具。
既可作 profile bundle 安装（`dsh plugin add`），也可作 agent preset（「科学模式」）安装。

## 安装

### 方式 A —— profile bundle（社区标准）

```bash
dsh plugin --profile web add dsh-science            # npm 发布后
# 或直接从 GitHub：
dsh plugin --profile web add "github:biociao/dsh-science"
```

重启 profile（或刷新 Web GUI）。bundle 会把两个引擎插入 profile 层栈，
该 profile 上所有 agent 都能用 `research_*` / `artifact_*` 工具。

### 方式 B —— agent preset（完整「科学模式」，按 agent 隔离）

```bash
git clone https://github.com/biociao/dsh-science ~/.dsh/.agent-presets/science
# 或本地安装：
bash scripts/install.sh          # 复制安装（或：bash scripts/install.sh link）
```

在 DSH Web 新建会话并选择 **科学模式** preset —— preset 自带科研人格 + 引擎，按 agent 作用域隔离。

### 技能

10 个技能由项目根 `.dsh/skills/` 自动发现（把本仓库 `skills/` 放进你的项目即可），
或全机安装：

```bash
bash scripts/install-skills.sh          # -> ~/.dsh/skills（遵循 $DSH_HOME）
```

## 快速开始（首个会话）

1. `research_init` —— 创建 `research-manifest.json` 与项目骨架（`experiments/ literature/ artifacts/ analyses/ figures/ manuscript/ reviews/ data/ envs/`）。
2. 每次会话先 `research_state`；循环状态跨会话持续。
3. 跑循环：`research_hypothesis`（H1/H2/…）→ `research_experiment`（E01/…，创建 `experiments/<id>/{design.md,log.md,code/,results/}`）→ 跑代码 → `research_findings`（追加 log.md、更新假设状态、推进循环）→ 值得引用/复现的结果 `artifact_save`。
4. 关键论断：提取论断 → 评审子代理对照执行记录核查（见 scientific-reviewer 技能）→ `research_review` 归档（写入 `reviews/R0n/report.md`）。

## 仓库结构

```
dsh-science/
├── package.json          # dsh.bundle.patch -> ./cordis.patch.yml（含 exports）
├── cordis.patch.yml      # bundle patch：按子路径导出插入两个引擎
├── engines/              # 引擎源（bundle 形态）
│   ├── research-loop.mjs
│   └── artifact-registry.mjs
├── preset/               # agent-preset 形态（engines 镜像，用 sync-engines.sh 同步）
│   ├── agent.cordis.yml  #   引用 ./engines/*.mjs（相对路径，preset 挂载）
│   ├── preset.yml
│   └── engines/          #   镜像 —— 保持同步：bash scripts/sync-engines.sh
├── skills/               # 10 个 SKILL.md 技能
├── scripts/
│   ├── install.sh        # 安装 preset -> ~/.dsh/.agent-presets/science
│   ├── install-skills.sh # 安装技能 -> ~/.dsh/skills
│   ├── sync-engines.sh   # 镜像 engines/ -> preset/engines/
│   ├── init-project.sh   # 项目骨架（无需科学模式会话）
│   └── smoke-test.mjs    # 23 项检查（临时工作区，node >= 18）
└── test/verify-bundle.sh # 隔离端到端 bundle 安装 + boot 检查
```

## 验证

```bash
node scripts/smoke-test.mjs     # 引擎逻辑 + 端到端循环（临时工作区）
bash test/verify-bundle.sh      # pnpm pack -> 隔离 profile -> 安装 -> boot 检查
```

两项均为发布检查清单内容，可在 CI 安全运行（smoke-test 只写临时工作区；bundle 测试用隔离的 `$DSH_HOME`）。

## FAQ

**bundle 里为什么用子路径导出而不是相对路径？**
`dsh plugin add` 把包装进 profile，其 `cordis.patch.yml` 的行加入 profile 组合。
profile 加载器把行的 `name` 按 **profile 目录**解析（不是包目录），所以
`./engines/x.mjs` 会 `ERR_MODULE_NOT_FOUND`；改用 `dsh-science/engines/x.mjs`
（子路径导出，走 `package.json` 的 `exports`）则从 profile 的 `node_modules`
解析、可用——已在 dsh `0.1.0-rc.6` 上实验验证。agent-preset 挂载则按 preset
目录解析相对名，因此 `preset/agent.cordis.yml` 可以用 `./engines/*.mjs`。

**bundle 还是 preset，怎么选？**
- bundle：一条命令装完，profile 上所有 agent 都能用工具。
- preset：完整「科学模式」体验（科研人格、按 agent 隔离）。`cordis.patch.yml`
  里的 persona 行默认注释——profile 级人格会影响该 profile 所有 agent，
  需要全 profile 应用时再取消注释发布。

**技能从哪来？**
项目根 `.dsh/skills/` 自动发现；`scripts/install-skills.sh` 全机安装到
`~/.dsh/skills`（遵循 `$DSH_HOME`）。

## 开发

```bash
bash scripts/sync-engines.sh    # 修改 engines/*.mjs 后运行——保持 preset/engines 同步
node scripts/smoke-test.mjs     # 逻辑 + 静态包校验
bash test/verify-bundle.sh      # 端到端 bundle 安装 + boot
```

## 社区

- Topic：[github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)
- 精选列表：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)

## 许可

MIT —— 见 [LICENSE](LICENSE)。
