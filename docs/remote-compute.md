# Remote Compute（远程计算）——机制与设计

> 本文件解释 dsh-science 的 `remote_*` 工具组如何实现 **Claude Science 的
> "Remote compute clusters / Computer"** 能力，以及背后的工作机制与安全边界。

## 1. Claude Science 的机制（对照）

Anthropic 官方文档 *Run on a remote Linux server / Remote compute clusters* 描述的机制：

1. **主机注册**：从 `Settings > Compute > SSH hosts > Add SSH host` 添加。地址/用户/端口/
   ProxyJump 全部取自用户自己的 `~/.ssh/config`；用现有密钥或 ssh-agent 认证；
   **不在目标主机上安装任何东西**。可加备注（分区、账号、模块加载、能否装软件），
   可选覆盖 User / Port / IdentityFile。
2. **只读探测**：添加主机时探测 CPU、内存、GPU、CUDA 驱动、conda/module/Apptainer 是否存在、
   scratch 目录、是否有 `sbatch`；SLURM 集群读取分区。结果存为主机备注，可随时重探测。
3. **作业运行**：
   - 工作站：作业以 **detached 进程**运行；**断连不杀**（连接丢失后作业继续）。
   - SLURM 集群：作业经 **`sbatch`** 提交。
   - 作业目录建在 scratch 目录下；脚本与输入先复制到作业目录。
   - 提交前出现 "Run this job on <host>?" 审批卡，可授权 Once / This conversation /
     This project / Global。
   - 默认作业超时 30 分钟；更长的工作要提前告知。
   - 作业以**你的用户身份在主机上运行、不经沙箱**。
   - 完成后输出拉回会话；超过大小阈值（约 100MB）的文件留在主机并记录路径。
4. **主机 Details 文档**：每台主机的备注文档描述环境如何激活、数据/软件在哪、调度约定；
   Claude 边用边更新，用户也可随时编辑。

## 2. dsh-science 的对应实现

| Claude Science | dsh-science 工具 | 实现要点 |
| --- | --- | --- |
| Add SSH host + probe | `remote_host_add`（`remote_host_probe` 重探测） | 别名取 `~/.ssh/config`；一次 ssh 会话收集 UNAME/CPUS/MEM/GPU/CUDA/TOOL*/SCRATCH/SLURM/PART 并解析为结构化 JSON；`probeError` 记录探测失败但主机仍可注册 |
| Host Details 文档 | `remote_host_show` / `remote_host_notes` | 备注存于 hosts.json，可替换或追加 |
| Run job（工作站 detached） | `remote_run`（mode=direct） | `nohup + setsid` 脱离会话，stdin 从 /dev/null、输出重定向到日志文件；run.sh 先把 `$$` 写入 pid 文件再 cd/执行；结束写 `exitcode` + `done` 标记 |
| Run job（SLURM） | `remote_run`（mode=slurm / auto 自动识别） | `sbatch --parsable --chdir=... -o stdout.log -e stderr.log --time=...`；slurmJobId 持久化 |
| 审批卡 | `remote_run` 内置审批 | `ctx.approval.request`（approval 服务）；`approve:false` 跳过、`approve:true` 强制、缺省按 `config.requireApproval`（默认 true）；approval 服务不可用时 fail-closed |
| 超时 30 分钟 | `timeoutMinutes` | run.sh 内 `timeout ${m}m bash script.sh`（无 timeout 命令时降级）；SLURM 转 `--time` |
| 断连不杀 | detached 提交 | `nohup` 忽略 SIGHUP；`setsid` 建立独立会话（进程组可整体终止）；无 setsid（如 macOS）退化为纯 nohup |
| 并发上限 | `maxConcurrent`（默认 100） | 提交时统计该主机 running/submitted 作业数，超限抛 `ERR_LIMIT` |
| 监控 | `remote_status` / `remote_logs` / `remote_jobs` | 按主机**一次 ssh 会话**批量探测：direct 查 `kill -0` + done/exitcode；slurm 查 `squeue`/`sacct`；状态自动迁移并落盘（跨会话持续）；刚提交 20 秒内不误报 unknown |
| 输出回传 | `remote_pull`（`remote_status pull=true` 自动拉取） | 顶层条目按大小分流：≤阈值 scp 拉回 `<output>/`（默认 `analyses/remote/<jobId>/`）；>阈值（默认 100MB）留在主机、写入 `pulled-manifest.json`（拉了什么/留下什么/远程路径） |
| 取消 | `remote_cancel` | 有 setsid 会话：`kill -- -<pgid>` 整组终止；无则 `pkill -P` 子树 + `kill`；SLURM：`scancel` |

### 工具清单（16 个）

- 主机：`remote_host_add` `remote_host_list` `remote_host_show` `remote_host_probe`
  `remote_host_notes` `remote_host_remove`
- 授权（项目级访问白名单）：`remote_host_allowlist` `remote_host_allow` `remote_host_revoke`
- 命令：`remote_exec`（前台，默认 60s 超时，上限 600s，结构化输出）
- 作业：`remote_run` `remote_status` `remote_logs` `remote_pull` `remote_cancel`
  `remote_jobs`

## 3. 传输适配器与零依赖

引擎不引入任何第三方包，只用 Node 内置模块 + 系统 OpenSSH：

- `ssh`：执行远程命令（`-o BatchMode=yes` 防交互卡死、`ConnectTimeout=15`）；
  文件写入用 `ssh host 'cat > path'`（stdin 管道，脚本内容不进入命令行，杜绝注入）；
  目录/文件传输用 `scp -r`。
- `local`：`bash -c` + node fs —— 同一套作业/监控/拉取逻辑在本机执行，
  用于**演练与 CI 测试**（`transport: "local"`）。
- 路径安全：远程路径只允许安全字符子集（字母数字 `-_. /@:=+,%`，可 `~/` 开头），
  拒绝引号/空白/`$`/反引号/管道/重定向等元字符，从源头防 shell 注入；
  用户脚本内容一律经 stdin 落盘，绝不拼进命令行。

### 注册表与项目根

**项目根（project root）按优先级探测**：`research-manifest.json`（研究项目）→ `.dsh`（工作区）→ `.git`（仓库）→ 会话工作目录。白名单与作业注册表都挂在项目根下，因此：

- **同一工作区里的多个研究项目各自持有独立的白名单与作业注册表**（按 project 隔离）；
- 没有研究项目标记的目录回退到工作区根；
- 授权/作业路径在拿不到会话工作目录时 **fail-closed**（报错要求显式 `root=…`），绝不回退到进程级 cwd 造成跨项目共享。

- 主机：`$DSH_HOME/remotes/hosts.json`（默认 `~/.dsh/remotes`，`config.hostsDir` 可覆盖）
  —— 全机共享，与 Claude Science 的 Settings > Compute 一致。
- 作业：`<项目根>/.dsh/remotes/jobs.json` —— 随项目走、跨会话持续，
  与 `research-manifest.json` 同级的项目状态。写操作全部经 `withFileLock` + 原子写
  （复用 `engines/core.mjs`）。
- **访问白名单**：`<项目根>/.dsh/remotes/allowlist.json` —— **本项目允许访问的服务器列表**。
  首次使用某主机（注册探测 / probe / exec / run）默认弹审批，批准后按项目持久化；
  `remote_host_allowlist` 查看、`remote_host_allow`（需审批）显式添加、
  `remote_host_revoke` 撤销。等效于 Claude Science 审批卡的 "This project" 作用域；
  插件配置 `requireHostAccess: false` 可关闭（无人值守）。

## 4. 作业生命周期

```
remote_run ──► submitted（上传 script/inputs/env → 生成 run.sh → 提交）
                │
                ▼
          running（pid / slurmJobId 落盘）
                │ remote_status 轮询
                ├─► done+exitcode=0     ──► succeeded
                ├─► done+exitcode≠0      ──► failed   （remote_logs 查 stderr → 修脚本重提交）
                ├─► 进程被终止/无 done    ──► killed   （或 remote_cancel）
                └─► 20s 内无标记（刚提交）──► 保持 running
                ▼
          remote_pull ──► pulled-manifest.json（小文件回传 / 大文件留主机记录路径）
                ▼
          artifact_save（归档为版本化工件，记录 provenance）
```

## 5. 安全边界

- 远程作业以**连接用户的身份**在主机上运行，**不经沙箱**，可访问该账号能访问的一切。
- **项目级访问白名单**（默认开启）：任何会连接主机的操作（注册探测 / probe / exec /
  run）都要求主机已在本项目白名单内；首次使用弹审批（展示主机、将执行的命令/作业），
  批准后按项目持久化到 `allowlist.json`，`remote_host_allowlist` 可随时审查、
  `remote_host_revoke` 随时撤销。`requireHostAccess: false` 关闭（无人值守）。
- `remote_run` 每次提交默认要求作业审批：向用户展示主机、作业标题、超时、脚本开头，
  得到 `allowed-once` 才执行（等价于 Claude Science 的审批卡；首次使用时授权审批与
  作业审批合并为一次弹窗）。无人值守场景设 `requireApproval: false`。
- `remote_exec` 只应执行可信的短命令；长任务一律 `remote_run`。
- 密钥管理沿用 OpenSSH：`~/.ssh/config`、密钥文件、ssh-agent；
  引擎不在主机安装任何东西，也不保存任何凭据。

## 6. 测试

`scripts/smoke-test.mjs` 第 6 节用 `transport: "local"` 走完整生命周期
（注册→探测→提交→监控→日志→拉取→取消→失败分支→并发上限），第 7 节用审批桩验证
项目级白名单（首次使用授权、持久化、撤销、显式授权）；零网络依赖，CI 可直接运行。
真实 SSH 主机用 `remote_host_add`（alias 或 user@host）即可。
