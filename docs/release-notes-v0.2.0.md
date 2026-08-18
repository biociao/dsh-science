# dsh-science v0.2.0 Release Notes

> 对比 v0.1.1。本版本新增 3 个引擎（SSH 远程计算、远程主机配置 UI、模型分档路由）、
> 1 个技能（remote-compute）、配套客户端设置页，并修复 2 个项目根探测 bug。

## 亮点

- **SSH 远程计算引擎**（`remote_*` 工具组，16 个工具）：对应 Claude Science 的
  "Remote compute clusters" —— 把生信分析作业提交到实验室工作站 / HPC 集群，
  断连不杀、状态自动迁移、输出按需拉回。
- **远程主机配置 UI**：浏览器设置页（对应 Settings > Compute > SSH hosts），
  宿主侧 REST API + React 客户端 bundle，与 remote-compute 共用同一套数据文件。
- **模型分档路由引擎**：对应 Claude Code 的 Opus/Sonnet/Haiku 分级 —— 辅助请求
  （会话标题、压缩）与子任务自动走轻量档，主对话走默认档，复杂任务升级强档；
  各档位可指向不同 provider，零第三方依赖。
- **Bug 修复**：会话工作目录读取修正（`session.header.cwd`）、项目根探测不再把
  HOME 当项目根（避免命中 `~/.dsh` 把整个 home 当项目）。

---

## 一、SSH 远程计算（Remote Compute）

插件 id：`science-remote-compute`，引擎文件 `engines/remote-compute.mjs`。
零第三方依赖（Node 内置模块 + 系统 OpenSSH），**不在目标主机上安装任何东西**，
密钥管理沿用 `~/.ssh/config` / ssh-agent。

### 1. 前置准备：配置 SSH 别名

在 `~/.ssh/config` 里配好主机（引擎直接读别名）：

```sshconfig
Host gpu-workstation
    HostName 10.0.1.20
    User zhangsan
    IdentityFile ~/.ssh/id_ed25519

Host hpc-login
    HostName login.hpc.example.cn
    User zhangsan
    ProxyJump bastion
```

确保 `ssh gpu-workstation` 能免密登录（密钥或 ssh-agent）。**不要**把密码写进任何工具参数。

### 2. 注册主机（自动只读探测）

会话中让模型执行，或直接调用工具：

```
remote_host_add({ alias: "gpu-workstation" })
```

注册时自动探测：CPU/内存/GPU/CUDA 驱动/conda/module/Apptainer/scratch 目录/是否有
`sbatch`（SLURM 集群还会读分区列表）。结果存进主机备注，之后 `remote_host_show`
随时查看、`remote_host_probe` 重新探测。

**首次连接会弹审批**（项目级访问白名单）：批准后该主机写入本项目
`<项目根>/.dsh/remotes/allowlist.json`，之后同项目不再询问；`remote_host_allowlist`
审查、`remote_host_revoke` 撤销。授权**按项目隔离**，不跨项目泄漏。

探测失败主机仍会注册（`probeError` 记录原因），可稍后重探测。

### 3. 提交作业

```
remote_run({
  host: "gpu-workstation",
  title: "RNA-seq 质控 + 比对",
  script: `
set -e
source ~/.bashrc && conda activate rnaseq
fastqc inputs/*.fq.gz -o results/fastqc/
hisat2 -x refs/hg38 -1 inputs/R1.fq.gz -2 inputs/R2.fq.gz | samtools sort -o results/aligned.bam
`,
  inputs: ["data/R1.fq.gz", "data/R2.fq.gz"],   // 上传到作业目录 inputs/
  timeoutMinutes: 720                            // 长任务显式给超时（默认 30 分钟）
})
```

- `mode` 默认 `auto`：主机有 `sbatch` 自动走 SLURM（`sbatch --parsable`），否则以
  `nohup + setsid` detached 进程运行 —— **SSH 断连作业不中断**。
- 提交前默认弹审批（等价于 Claude Science 的 "Run this job on <host>?" 卡），展示
  主机、作业标题、超时、脚本开头，得到允许才执行。无人值守/CI 场景在
  `cordis.patch.yml` 里设 `requireApproval: false`、`requireHostAccess: false`。
- 脚本建议 `set -e` 开头，结果写到作业目录下的相对路径（如 `results/`）。
- 前台短命令用 `remote_exec`（默认 60s 超时，上限 600s），长任务一律 `remote_run`。

### 4. 监控 → 拉取 → 归档

```
remote_status({ host: "gpu-workstation" })        # 批量探测，running → succeeded/failed/killed 自动迁移
remote_logs({ job: "J03", tail: 100 })            # 失败先看 stderr
remote_pull({ job: "J03" })                       # 拉回输出到 analyses/remote/J03/
```

- `remote_pull` 按大小分流：≤100MB 的文件 scp 拉回本地；超过的留在主机并写入
  `pulled-manifest.json`（拉了哪些、留下哪些、远程路径）。
- 结束后的标准动作链：`remote_status`（确认终态）→ `remote_pull` →
  `artifact_save`（归档为版本化工件，记录 provenance）→ `research_findings`。
- 取消作业：`remote_cancel`（进程组终止 / `scancel`）。

### 5. 工具清单（16 个）

| 类别 | 工具 |
|---|---|
| 主机 | `remote_host_add` `remote_host_list` `remote_host_show` `remote_host_probe` `remote_host_notes` `remote_host_remove` |
| 授权 | `remote_host_allowlist` `remote_host_allow` `remote_host_revoke` |
| 命令 | `remote_exec`（前台短命令） |
| 作业 | `remote_run` `remote_status` `remote_logs` `remote_pull` `remote_cancel` `remote_jobs` |

详细机制与安全边界见 [docs/remote-compute.md](remote-compute.md)；模型的使用协议见
[skills/remote-compute/SKILL.md](../skills/remote-compute/SKILL.md)。

### 6. 远程主机配置 UI

对应 Claude Science 的 Settings > Compute > SSH hosts：

- 宿主侧 `engines/remote-hosts-ui.mjs` 注册 REST API（webServer 前缀路由
  `/dsh-science/remote-hosts/*`），读写与 remote-compute 同一套 `hosts.json` /
  `allowlist.json` / `jobs.json`，支持真实 ssh 只读探测。
- 客户端 bundle：`client/remote-hosts-ui/`（React），由
  `npm run build:client`（`scripts/build-client-bundle.mjs`）生成，
  `package.json` 的 `dsh.client` 声明注入 `@deepseek-ai/dsh-client-ui-slots`。

---

## 二、模型分档路由（配套独立 bundle：dsh-model-tier）

路由引擎以**独立 npm 包 `dsh-model-tier`**（`packages/dsh-model-tier/`）发布：
安装 `dsh-science` 会作为依赖自动携带并在其 `cordis.patch.yml` 中挂载；它也可以
脱离科学模式，**单独安装到任意 profile**（`dsh plugin add dsh-model-tier`）。
两种装法的条目 id 一致（`model-tier`），配置覆盖方式相同。
对应 Claude Code 的 Opus/Sonnet/Haiku 分级策略，挂在 **profile bundle 层**
（`cordis.patch.yml`）。

**启用方式（按会话 opt-in）**：引擎在会话模型选择器里注册虚拟 provider
**「智能分档」**，每个分档方案是它下面的一个"模型"。会话选中「智能分档 / 某方案」
才开启自动路由；**未选中的会话零路由**。选择仅当前会话生效——平台把选择写成
全局默认模型的副作用由引擎守卫自动回退。

### 1. 分档逻辑（作用于选中「智能分档」的会话）

| 请求类型 | 路由到 | 识别方式 |
|---|---|---|
| 辅助请求（会话标题、压缩摘要） | **轻档** | `GenerateOptions.purpose`（`session-title` / `compaction`） |
| 子任务（子代理 / 后台任务扇出） | **轻档** | 会话元数据 `origin: "subagent"` |
| 深链子任务（`delegationDepth ≥ N`，可选） | **强档** | `subagentDepthStrong` |
| 超长输入（单步用户消息 ≥ N 字符，可选） | **强档** | `escalateOnChars` |
| 主对话 | **主力档** | 其余请求 |

期望档位未配置时按 `default → light → strong` 回落；方案 id 失效回落「默认
方案」；`enabled: false` 或无可路由档位时透传全局默认模型。子代理若被显式配置
`agentOptions`（真实 provider/model），请求不经虚拟适配器 —— 显式选择天然优先。

**LLM 前置分类器（`routing.classify`，可选）**：每次用户提问 / 子任务派发前，
用一个小模型把任务按复杂度分类为 `light / default / strong` 再派发（简单执行、
命令监控 → 轻档；决策、推理、全局理解 → 强档）。结构规则优先（辅助请求与已升强
请求不分类）；按 (sessionId, 消息哈希) 缓存，同一轮提问只分类一次；失败 / 超时
自动回落结构档位。分类目标缺省用轻档模型，建议选非 thinking 模型。

**跨档位历史兼容**：混用档位后若 thinking 模式目标（如 DeepSeek）因历史工具调用
消息缺 `reasoning_content` 拒绝请求，引擎自动补占位推理块透明重试一次。

### 2. 配置示例

`cordis.patch.yml` 已随包插入以下示例（v0.2.0 默认）：

```yaml
- id: model-tier
  name: dsh-model-tier
  config:
    tiers:
      strong:                        # 强档：深链子任务 / 超长输入
        provider: zai-coding-cn
        model: glm-5.3
      default:                       # 主力档：选中「智能分档」会话的主对话
        provider: deepseek-official
        model: deepseek-v4-flash
      light:                         # 轻档：标题/压缩 + 子任务
        provider: opencode-go
        model: minimax-m2.7
    routing:
      auxiliary: [session-title, compaction]
      subagents: light
      subagentDepthStrong: 3         # 可选：深链子任务升强档
      # escalateOnChars: 40000       # 可选：超长输入升强档
      # classify: true               # 可选：LLM 前置分类器（按复杂度分档，缺省用轻档模型）
```

**安全护栏**：未配置任何档位时选择器里不出现方案（行为就是"没装"）；期望档位
未配置时按 `default → light → strong` 次序回落；`enabled: false` 或全部档位
不可用时透传全局默认模型。把档位改成你实际注册的 provider/model 即可。

### 3. 启用 / 升级

```bash
dsh plugin --profile web add "github:biociao/dsh-science"   # 安装或更新 bundle（自动携带 dsh-model-tier）
# 或单独安装路由包：dsh plugin --profile web add dsh-model-tier
# 重启 profile 后生效
```

已安装的老版本：升级包即可；或在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
里用 `- update: [{id: model-tier, config: ...}]` 覆盖档位。

### 4. 验证

```bash
node packages/dsh-model-tier/test/model-tier.test.mjs   # 单元测试：路由决策矩阵 + 回退逻辑（零依赖）
bash packages/dsh-model-tier/scripts/test-model-tier.sh # E2E：隔离 DSH_HOME 起 headless 会话，轻档指向
                                                        # 本地 mock LLM，断言标题请求真的打到 mock
```

详见 [packages/dsh-model-tier/README.zh.md](../packages/dsh-model-tier/README.zh.md)（含与 Claude Code 策略的对照表）。

### 5. 设置页 UI（智能分档）与模型选择器接入

设置 → **智能分档**（「模型」页的同级 section —— 内置模型页没有第三方注入槽位）。
以**方案**为单位管理：一个方案 = 已配置的 provider/模型到 **深思（强）/ 主力 /
执行（弱）** 三档的映射 + 路由规则；可保存多套方案，列表中的「默认」方案仅作
回落（会话选中的方案 id 失效时使用）。页面形态为方案列表 → 详情页（与「模型」
页 provider 卡片交互一致）。保存写入 `$DSH_HOME/model-tier.json`（schema 2），
路由引擎按 mtime **热加载，无需重启**；旧版扁平配置自动显示为「迁移的旧配置」
方案。

**模型选择器接入**：引擎把「智能分档」注册为会话模型选择器里的一个 provider
组，方案即其"模型"——选中某方案该会话即进入 auto 路由；聊天页输入框下方新增
路由读数（`conversation.composer.dock`），实时展示最近一次实际路由到的模型与
档位。宿主侧 REST API `/dsh-model-tier/*`（`engines/model-tier-ui.mjs`，含
`route-status` 读数接口）+ 客户端 bundle（`client/model-tier-ui/`）。

---

## 三、Bug 修复（`engines/core.mjs`）

- **`resolveCwd`**：会话工作目录改从 `agent.session.header.cwd` 读取。旧代码读的
  `agent.session.cwd` 不存在，导致永远回退 `process.cwd()`（宿主进程启动目录），
  项目根随之错位，所有依赖项目根的状态（作业注册表、白名单、工件）位置错误。
- **`findProjectRoot`**：HOME 永不作为自动探测的项目根。`~/.dsh` 是 DSH 自身配置
  主目录，旧逻辑会把任何从 home 下出发的探测命中 `~/.dsh`，把整个 home 当成
  "项目"并在其中脚手架目录。
- 新增 6 个远程相关结构化错误码：`ERR_HOST` / `ERR_SSH` / `ERR_ACCESS` /
  `ERR_LIMIT` / `ERR_APPROVAL` / `ERR_REMOTE`。

## 四、其他变更

- 新技能 `skills/remote-compute/`（技能总数 10 → 11）。
- 新文档：`docs/remote-compute.md`、`docs/remote-hosts-ui.md`、
  `docs/workspace-isolation.md`；路由文档随包迁移至 `packages/dsh-model-tier/README.zh.md`；
  `docs/workspace-isolation.md`；README（中英）与 `docs/topology.md` 同步更新。
- 冒烟测试扩充：`scripts/smoke-test.mjs` 新增第 6 节（`transport: "local"` 走完整
  远程作业生命周期）与第 7 节（审批桩验证项目级白名单），零网络依赖，CI 可直接跑。
- `package.json`：版本 0.2.0；新增 react 依赖与
  `@deepseek-ai/dsh-client-ui-slots` peer 依赖；新增 `build:client` /
  `check:client` 脚本；`exports`/`files` 纳入 `client/`。

## 升级注意

- remote-compute 默认开启两道审批（主机白名单 + 每次作业提交）。无人值守/CI 场景
  在 `cordis.patch.yml` 的引擎 config 里设 `requireApproval: false` 与
  `requireHostAccess: false`。
- 模型路由示例档位指向的 provider 若未注册即为 no-op，不影响现有行为；按需替换为
  你自己的 provider/model。
