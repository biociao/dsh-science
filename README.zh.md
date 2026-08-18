# dsh-science

[![npm version](https://img.shields.io/npm/v/dsh-science)](https://www.npmjs.com/package/dsh-science)
[![license](https://img.shields.io/npm/l/dsh-science)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](package.json)
[![dsh-plugin topic](https://img.shields.io/badge/GitHub-topic%3A%20dsh--plugin-181717)](https://github.com/topics/dsh-plugin)

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Science 式科研工作台** —— 面向基因组 / 病原体 / 人类健康 / 生物信息项目。

> 一句话介绍：**dsh-science** —— 面向 DSH 的 Claude Science 式科研工作台：ReAct 研究循环引擎（research_* 工具）、带溯源的版本化工件（artifact_* 工具）、SSH 远程计算引擎（remote_* 工具，对应 Claude Science 的 Computer / Remote compute clusters），以及面向基因组/病原体/生物信息的 11 个科研技能。

- **ReAct 研究循环引擎** —— `research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review` / `research_report`，状态持久化在 `research-manifest.json`（提问 → 假设 → 实验 → 观察 → 分析 → 结论 → 下一问题）。
- **版本化工件与溯源** —— `artifact_save` / `artifact_list` / `artifact_show` / `artifact_diff` / `artifact_verify` / `artifact_deprecate` / `artifact_reproduce`：结果存为 `artifacts/<name>/v<N>/`，附每文件 SHA-256、`artifact.json` 溯源（命令/输入/环境/envFile）与追加式 `provenance.md`。
- **远程计算引擎（SSH / 集群）** —— `remote_host_add` / `remote_host_probe` / `remote_host_notes` / `remote_run` / `remote_status` / `remote_logs` / `remote_pull` / `remote_cancel` 等 16 个工具：用 `~/.ssh/config` 别名连接实验室工作站或 HPC 集群（零安装、零第三方依赖），工作站以 detached 进程、SLURM 走 sbatch 运行长时生信任务，断连不杀；提交前默认要求审批，且首次使用某主机需项目级授权（审批后写入本项目白名单）；`remote_status` 批量监控并自动迁移状态（running→succeeded/failed/killed），结束后 `remote_pull` 拉回输出（超过阈值的大文件留在主机并记录路径）。
- **远程主机配置 UI（bundle/profile 级）** —— 设置面板新增「远程主机」页（对应 Claude Science 的 Settings > Compute > SSH hosts）：主机列表/添加/探测/编辑/移除，以及各项目访问白名单与作业摘要。宿主侧 REST API（`webServer` 路由 `/dsh-science/remote-hosts/*`，`engines/remote-hosts-ui.mjs`）+ 客户端 bundle（`client/remote-hosts-ui/`，由 `scripts/build-client-bundle.mjs` 生成），与远程引擎共用同一套数据文件。需重启 web 进程生效（见 [docs/remote-hosts-ui.md](docs/remote-hosts-ui.md)）。
- **模型分档路由（Model Tier）** —— 由配套 bundle [`dsh-model-tier`](packages/dsh-model-tier/) 提供：同一会话内自动把辅助请求（会话标题、压缩）与子任务分流到**轻量档**，主对话走默认档、复杂任务按规则升级到**强档**，各档位可指向**不同 provider**（如强档 GLM-5.3 / 主档 deepseek-v4-flash / 轻档 minimax-M3），对应 Claude Code 的 Opus/Sonnet/Haiku 分级策略；基于 DSH 原生 `agent/request` + `llm/stream` waterfall 扩展点，provider 未注册时自动 no-op。安装 dsh-science 自动携带，也可单独装到任意 profile（`dsh plugin add dsh-model-tier`）。
- **11 个科研技能** —— research-loop、science-project-setup、artifact-provenance、scientific-reviewer、literature-connector、parallel-delegation、manuscript-writing、bioinformatics-toolkit、conda-environments、data-inventory、remote-compute。

四个引擎插件**零第三方依赖**（只用 Node 内置模块 + 系统 OpenSSH，共享 `engines/core.mjs`），注册标准 cordis 工具；配套的 dsh-model-tier 路由同样是零依赖。
既可作 profile bundle 安装（`dsh plugin add`），也可作 agent preset（「科学模式」）安装。

### v0.2.0 新增：模型分档路由（配套 bundle dsh-model-tier）

对应 Claude Code 的 Opus/Sonnet/Haiku 分级策略：同一会话内，辅助请求（`purpose ∈
{session-title, compaction}`）与子任务（`session.meta.origin === 'subagent'`）自动分流到
**轻量档**；主对话保持各自会话的模型选择（不干预）；深链子任务（`delegationDepth ≥
subagentDepthStrong`）与超长输入（`escalateOnChars`，可选）升级到**强档**。还可选开启
LLM 前置分类器（`routing.classify`）：每次用户提问 / 子任务派发前按复杂度分类
（执行 / 主力 / 深思）再路由。各档位为 `{provider, model, reasoningEffort?}`，可跨
provider 配置。

以独立 bundle **[`dsh-model-tier`](packages/dsh-model-tier/)** 发布 —— dsh-science
依赖它并在自己的 `cordis.patch.yml` 里挂载，它也可以脱离 dsh-science 单独安装到任意
profile（`dsh plugin add dsh-model-tier`）：

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

- **HOST 平面**：挂在 profile bundle（`cordis.patch.yml`），非 agent preset；所有会话与子代理统一生效。
- **安全护栏**：tiers 未配置 → 惰性 no-op；目标 provider 未注册 → 不路由；轻档失败自动回退原路由（辅助功能不挂）。
- **验证**：`node packages/dsh-model-tier/test/model-tier.test.mjs`（路由决策矩阵单测，零依赖）+ `bash packages/dsh-model-tier/scripts/test-model-tier.sh`（E2E：轻档指向本地 mock LLM，断言标题请求真的被路由）。

### v0.2.0 新增：远程计算（Remote Compute）

对应 Claude Science 的 **Remote compute clusters / Computer** 能力，工作机制对照其官方文档：

- **主机注册与只读探测**：`remote_host_add` 用 `~/.ssh/config` 别名（或 user@host；ProxyJump 等由 OpenSSH 自动处理），可选覆盖 port/identityFile；注册即探测 CPU/内存/GPU/CUDA/conda/module/Apptainer/sbatch/scratch 目录/SLURM 分区（`remote_host_probe` 重探测）。主机注册表在 `$DSH_HOME/remotes/hosts.json`。
- **作业提交**：`remote_run` 把脚本与输入上传到 `<scratch>/<jobId>/`（默认 `~/dsh-scratch`）；工作站以 `nohup+setsid` detached 进程运行（断连不杀），SLURM 集群自动走 `sbatch`（可 `--time` 超时）；默认超时 30 分钟；提交前默认经审批（等价于 Claude Science 的 "Run this job on <host>?" 卡）。
- **监控与反应**：`remote_status` 批量探测（ps / squeue+sacct / done+exitcode 标记）并自动迁移状态；`remote_logs` 尾随日志；`remote_pull` 拉回输出、写 `pulled-manifest.json`（>100MB 大文件留在主机并记录路径）；`remote_cancel` 取消（进程组终止 / scancel）。作业注册表在 `<项目根>/.dsh/remotes/jobs.json`，跨会话持续。
- **主机 Details 文档**：`remote_host_notes` 维护每台主机的备注（环境激活方式、分区/账号、约定），模型提交作业前会参考。
- **项目级访问白名单（允许访问的服务器列表，按 project 隔离）**：任何会连接主机的操作（注册探测 / probe / exec / run）默认都要求主机已在本项目白名单（`.dsh/remotes/allowlist.json`）；**首次使用弹审批**，批准后按项目持久化（等价于 Claude Science 审批卡的 "This project" 作用域）。项目根按优先级探测 research-manifest.json（研究项目）→ .dsh（工作区）→ .git → 会话目录——**同一工作区里的多个研究项目各自独立**，授权不会跨项目泄漏（拿不到会话工作目录时授权路径 fail-closed）。`remote_host_allowlist` 审查、`remote_host_revoke` 撤销、`remote_host_allow` 显式授权（需审批）；`requireHostAccess: false` 关闭（无人值守）。

### v0.1.1 加固（鲁棒性更新）

- **并发安全**：manifest / 工件所有写操作经轻量文件锁（O_EXCL + 陈旧回收）串行 + 原子写（tmp+rename）——并行子代理不再互相覆盖 `research-manifest.json` / `artifacts.json`。
- **结构化错误码**：`ERR_NOT_INIT` / `ERR_NOT_FOUND` / `ERR_VALIDATION` / `ERR_PATH` / `ERR_QUOTA` / `ERR_LOCK_TIMEOUT` / `ERR_IO`，不再吞成无类型字符串。
- **假设状态机**（proposed → testing → supported/refuted/inconclusive）与**阶段只前进**（回退需配置 allowPhaseRewind）。
- **manifest ↔ 工件打通**：`research_state` 实时合并工件索引；`artifact_save` 回写清单 artifacts[]。
- **清单 schema v1→v2 迁移**（加载时迁移，下次写入持久化）。
- **工件升级**：流式 SHA-256（大文件）、相同内容硬链接去重、`artifact_diff` / `artifact_verify` / `artifact_deprecate`、envFile 与输入哈希溯源。
- **结构化 JSON 输出**（`research_report` / `artifact_diff` / `artifact_verify`）与审计日志 `<root>/.science.log`。

## 安装

### 方式 A —— profile bundle（社区标准）

```bash
dsh plugin --profile web add dsh-science            # npm 发布后
# 或直接从 GitHub：
dsh plugin --profile web add "github:biociao/dsh-science"
```

重启 profile（或刷新 Web GUI；新增引擎/改引擎代码需重启 profile）。bundle 会把三个引擎
（research-loop / artifact-registry / remote-compute）、远程主机配置 UI 与配套路由包
dsh-model-tier 插入 profile 层栈，
该 profile 上所有 agent 都能用 `research_*` / `artifact_*` / `remote_*` 工具与模型分档路由。

### 方式 B —— agent preset（完整「科学模式」，按 agent 隔离）

```bash
git clone https://github.com/biociao/dsh-science ~/.dsh/.agent-presets/science
# 或本地安装：
bash scripts/install.sh          # 复制安装（或：bash scripts/install.sh link）
```

在 DSH Web 新建会话并选择 **科学模式** preset —— preset 自带科研人格 + 引擎，按 agent 作用域隔离。

### 技能

11 个技能由项目根 `.dsh/skills/` 自动发现（把本仓库 `skills/` 放进你的项目即可），
或全机安装：

```bash
bash scripts/install-skills.sh          # -> ~/.dsh/skills（遵循 $DSH_HOME）
```

## 快速开始（首个会话）

1. `research_init` —— 创建 `research-manifest.json` 与项目骨架（`experiments/ literature/ artifacts/ analyses/ figures/ manuscript/ reviews/ data/ envs/`）。
2. 每次会话先 `research_state`；循环状态跨会话持续。
3. 跑循环：`research_hypothesis`（H1/H2/…）→ `research_experiment`（E01/…，创建 `experiments/<id>/{design.md,log.md,code/,results/}`）→ 跑代码 → `research_findings`（追加 log.md、更新假设状态、推进循环）→ 值得引用/复现的结果 `artifact_save`。
4. 需要 GPU/集群/专门环境时：`remote_host_add` 注册主机 → `remote_run` 提交远程作业（需审批）→ 定期 `remote_status` 监控、`remote_logs` 查日志 → 结束后 `remote_pull` 拉回输出 → `artifact_save` 归档。详见 [docs/remote-compute.md](docs/remote-compute.md) 与 remote-compute 技能。
5. 关键论断：提取论断 → 评审子代理对照执行记录核查（见 scientific-reviewer 技能）→ `research_review` 归档（写入 `reviews/R0n/report.md`）。

## 仓库结构

```
dsh-science/
├── package.json          # dsh.bundle.patch -> ./cordis.patch.yml（含 exports）
├── cordis.patch.yml      # bundle patch：按子路径导出插入引擎（+ dsh.client 客户端声明），挂载 dsh-model-tier
├── packages/
│   └── dsh-model-tier/   # 配套独立 bundle：模型分档路由（可单独 dsh plugin add）
├── engines/              # 引擎源（bundle 形态）
│   ├── core.mjs          #   共享核心：锁/原子写/错误码/流式哈希/结构化工具/审计
│   ├── research-loop.mjs
│   ├── artifact-registry.mjs
│   ├── remote-compute.mjs#   远程计算：SSH/local 传输、主机注册+探测、作业提交/监控/拉取/取消
│   └── remote-hosts-ui.mjs#  远程主机设置页的宿主 REST API（webServer 路由）
├── client/               # client 插件（设置页 UI，bundle/profile 级）
│   └── remote-hosts-ui/  #   src/index.js 源码 · lib/client.js 打包产物（build-client-bundle.mjs）
├── preset/               # agent-preset 形态（engines 镜像，用 sync-engines.sh 同步）
│   ├── agent.cordis.yml  #   引用 ./engines/*.mjs（相对路径，preset 挂载）
│   ├── preset.yml
│   └── engines/          #   镜像 —— 保持同步：bash scripts/sync-engines.sh
├── skills/               # 11 个 SKILL.md 技能
├── scripts/
│   ├── install.sh        # 安装 preset -> ~/.dsh/.agent-presets/science
│   ├── install-skills.sh # 安装技能 -> ~/.dsh/skills
│   ├── sync-engines.sh   # 镜像 engines/ -> preset/engines/
│   ├── init-project.sh   # 项目骨架（无需科学模式会话）
│   ├── build-client-bundle.mjs # client 源码 -> __ModuleLoader__ bundle（lib/client.js）
│   ├── smoke-test.mjs    # 125 项检查（临时工作区，node >= 18）
│   └── stability-test.mjs# 25 项并发/原子性/压力检查（锁/丢失更新/soak/迁移）
└── test/verify-bundle.sh # 隔离端到端 bundle 安装 + boot + client 扫描检查
```

## 验证

```bash
node scripts/smoke-test.mjs     # 引擎逻辑 + 端到端循环 + 错误码 + 迁移
node scripts/stability-test.mjs # 并发 / 原子性 / 锁 / 压力稳定性检查
bash test/verify-bundle.sh      # pnpm pack -> 隔离 profile -> 安装 -> boot 检查
```

三项均为发布检查清单内容，可在 CI 安全运行（两个测试脚本只写临时工作区；bundle 测试用隔离的 `$DSH_HOME`）。

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

分支模型与发布流程（main=发布 / dev=集成 / feat\*=新功能，tag 触发 npm 发布 + GitHub Release）：
见 [docs/branching.md](docs/branching.md)。

```bash
bash scripts/sync-engines.sh    # 修改 engines/*.mjs 后运行——保持 preset/engines 同步
node scripts/smoke-test.mjs     # 逻辑 + 静态包校验
node scripts/stability-test.mjs # 并发 / 原子性 / 锁稳定性检查
bash test/verify-bundle.sh      # 端到端 bundle 安装 + boot
```

## 社区

- Topic：[github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)
- 精选列表：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)

## 许可

MIT —— 见 [LICENSE](LICENSE)。
