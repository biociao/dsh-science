---
name: conda-environments
description: 用 conda/mamba 管理可复现分析环境：创建、固定版本、导出 yaml/lock、恢复。需要装包、换环境、或保证分析可复现时使用。
whenToUse: 安装生物信息工具/Python/R 包、新建或恢复分析环境、复现他人/历史分析时。
---

# 环境管理（Conda Environments）

分析环境 = 可复现性的一半。所有环境固定版本并导出到 `envs/`。

## 创建环境

```bash
# 用 mamba 更快（如有）；装生信包建议 conda-forge + bioconda
conda create -n <env-name> -c conda-forge -c bioconda python=3.11 <packages...>
# 例：病原体分析常用组合
#   python=3.11 fastqc fastp bwa samtools bcftools gatk4 spades prokka iqtree
```

- 环境名与项目任务对应（如 `amr-wgs`、`phylo`），记到实验 design.md。
- 一次性脚本依赖尽量少；大而全的环境用 mamba 并行解决依赖。

## 固定与导出（每个环境必做）

```bash
conda activate <env-name>
conda env export --no-builds > envs/<env-name>.yml      # 人类可读
conda env export > envs/<env-name>.lock.yml             # 完整锁定（含构建号）
```

- `envs/<env-name>.yml` 与 `.lock.yml` 入 git；**锁定文件是复现基准**。
- 更新包后重新导出并提交，changelog 记录（`envs/CHANGELOG.md`）。

## 恢复环境

```bash
conda env create -f envs/<env-name>.lock.yml
# 或从 yml（不保证逐字节一致）：
conda env create -f envs/<env-name>.yml
```

- 恢复失败（源失效）→ 尝试 `--channel conda-forge --channel bioconda` 重试，或降级到 `.yml` 版本。
- 恢复后跑一次冒烟测试（如 `samtools --version`、`python -c "import <pkg>"`）。

## 与工件/论文联动

- `artifact_save` 的 provenance 里 environment 字段引用 `envs/<env-name>.lock.yml`。
- 论文方法节写：`分析环境见 envs/amr-wgs.lock.yml（conda env create -f …）`。
- 复现失败排查顺序：环境 → 参考版本 → 数据 → 参数。

## 纪律

- 不在基础环境装项目依赖（污染全局）；每个项目独立环境。
- 记录装包命令（含 -c 通道），不要只记"我装了 X"。
- 工具输出版本号留档（`samtools --version` 等）到实验 log.md。
