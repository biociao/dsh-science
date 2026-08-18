---
name: remote-compute
description: 远程计算（对应 Claude Science 的 Remote compute clusters / Computer）：SSH 连接目标服务器（实验室工作站/HPC 集群），远程跑生信分析，并对长时进程与任务做有效监控与反应。
whenToUse: 分析需要 GPU、集群调度（SLURM）、专门软件环境或大数据量计算，而本地沙箱不满足时；任务可能运行数小时到数天时。
---

# 远程计算（Remote Compute）

本技能对应 Claude Science 的 **Remote compute clusters**（"Computer" 能力）：把作业放到能
通过 SSH 到达的机器（GPU 工作站或 HPC 登录节点）上运行。dsh-science 用 `remote_*` 工具组
实现同样的机制，依赖系统 OpenSSH（`ssh`/`scp`）与现有 `~/.ssh/config`、密钥/ssh-agent，
**不在目标主机上安装任何东西**。

## 工作机制速览

| 环节 | Claude Science | dsh-science 工具 |
| --- | --- | --- |
| 主机注册 | Settings > Compute > SSH hosts > Add | `remote_host_add`（alias 取自 `~/.ssh/config`，可选覆盖 port/identityFile） |
| 只读探测 | 记录 CPU/内存/GPU/CUDA/conda/module/Apptainer/sbatch/scratch/SLURM 分区 | `remote_host_add` 自动探测 / `remote_host_probe` 重探测 |
| 主机备注 | Details 文档（环境激活、分区、账号约定） | `remote_host_show` 查看 / `remote_host_notes` 维护 |
| 访问授权 | 审批卡 "Once / This conversation / This project / Global" | 首次使用弹审批 → 按**项目**持久化到 `.dsh/remotes/allowlist.json`；`remote_host_allowlist` 审查 / `remote_host_revoke` 撤销 |
| 提交作业 | 工作站 detached 进程；SLURM 走 sbatch；提交前审批卡 | `remote_run`（默认每次作业审批；`nohup+setsid` detached / `sbatch`；断连不杀） |
| 监控 | 作业面板、状态回传 | `remote_status`（批量探测，状态自动迁移）/ `remote_jobs` / `remote_logs` |
| 输出回传 | 完成后拉回；>100MB 留在主机并记录路径 | `remote_pull`（阈值默认 100MB，写 pulled-manifest.json） |
| 取消 | — | `remote_cancel`（进程组终止 / scancel） |
| 快速命令 | — | `remote_exec`（前台，默认 60s 超时） |

## 使用协议

### 1. 选主机 / 加主机

- 先 `remote_host_list` 看已注册主机、`remote_host_allowlist` 看本项目已授权主机；
  对候选主机 `remote_host_show` 读**备注**（Details）：环境如何激活、分区与账号、
  数据/软件在哪、有没有 sbatch。
- 没有合适主机时 `remote_host_add`：
  - `alias` 用 `~/.ssh/config` 里的别名（或 `user@host`；ProxyJump 等 OpenSSH 自动处理），
    一般**不要**在工具参数里写密码——配好密钥/ssh-agent 即可。
  - 添加即自动只读探测；**首次连接（注册+探测）会弹审批**，批准后该主机进入本项目
    白名单。探测失败也会注册（`probeError` 说明原因），可稍后 `remote_host_probe`。
  - 顺手用 `remote_host_notes` 把环境激活命令、分区、约定写进备注，之后每次都省事。

### 2. 提交作业（remote_run）

- 长时/重计算一律用 `remote_run` 提交为**后台作业**，不要用 `remote_exec` 跑长命令。
- `script`（内联）或 `scriptFile`（项目内文件）二选一；`inputs` 上传到作业目录的 `inputs/`
  子目录，脚本里用 `inputs/<名字>` 引用；`env` 传环境变量；`workdir` 指定运行目录。
- 脚本建议开头 `set -e`；把结果写到**作业目录下的相对路径**（如 `results/`），便于 `remote_pull`。
- `mode`：默认 auto（有 sbatch 自动走 SLURM，否则 detached）；显式 `slurm`/`direct` 可强制。
- 提交前默认弹审批（等价于 Claude Science 的 "Run this job on <host>?" 卡）——
  向用户说明**在哪台机器、跑什么、多久**。被拒绝就停手，不要反复重试。
- 超时：默认 30 分钟；**长任务（小时/天级）提交时显式给 `timeoutMinutes`**，并向用户说明。

### 3. 监控与反应（长任务的关键）

- 提交后按需 `remote_status`（可 `job=` 单查、`host=` 过滤、`pull=true` 结束自动拉回）。
  状态自动迁移 `running → succeeded / failed / killed` 并落盘，跨会话持续。
- `remote_logs` 看 stdout/stderr 尾部；**失败先看 stderr**：
  环境没激活？路径错？资源不够？修脚本后用同一流程重提交（新 jobId）。
- 长任务期间不要反复刷屏；隔一段时间查一次，记录状态变化即可。
- 结束后的反应链：`remote_status`（确认终态）→ `remote_pull`（拉回输出）→
  `artifact_save`（把结果归档为工件，记录 provenance）→ `research_findings`（记录观察/结论）。

### 4. 拉取与清理

- `remote_pull` 默认拉到 `analyses/remote/<jobId>/`，写 `pulled-manifest.json`
  （拉了哪些、哪些因超过阈值留在主机、远程路径是什么）。大文件用 `remote_exec`
  按需查看/转移，不要硬拉。
- 作业结束且结果归档后，可用 `remote_exec` 清理主机上的作业目录（如
  `rm -rf ~/dsh-scratch/J03`），保持 scratch 整洁。**清理前先确认输出已拉回**。

## 边界与安全

- **项目级访问白名单（按 project 隔离）**：任何会连接主机的操作（注册探测 / probe /
  exec / run）都要求主机已在本项目白名单（`.dsh/remotes/allowlist.json`）内；**首次使用
  会弹审批**，批准后按项目持久化。项目根按优先级探测 research-manifest.json（研究项目）
  → .dsh（工作区）→ .git → 会话目录——同一工作区里的多个研究项目各自独立，授权不跨项目
  泄漏。开始远程工作前先 `remote_host_allowlist` 查看；要收紧访问用 `remote_host_revoke`。
- 远程作业以**连接用户的身份**在主机上运行、**不经过沙箱**，能读写该账号能碰到的一切。
  只提交你理解并信任的脚本；`remote_run` 每次提交默认也要审批（首次使用时授权与作业
  审批合并为一次弹窗）。被拒绝就停手，不要反复重试，也不要试图绕过审批。
- 主机注册表在 `$DSH_HOME/remotes/hosts.json`（全机共享）；作业注册表与白名单在项目根
  `.dsh/remotes/` 下（随项目走）。
- 连接失败先查：密钥/ssh-agent 是否就绪、`ssh <alias>` 能否连通、主机是否在线。
- `transport: "local"` 的主机表示在本机 bash 执行，用于演练/CI，行为与 ssh 一致。
