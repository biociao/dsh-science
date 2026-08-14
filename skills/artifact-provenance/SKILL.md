---
name: artifact-provenance
description: 把结果保存为版本化工件并记录完整溯源（等价于 Claude Science 的 Artifacts + Provenance）：何时归档、记录什么、如何复现。产出重要结果（数据表、图、模型、变异列表）时使用。
whenToUse: 生成了值得保留/复现/引用的结果时；写论文引用数据前；需要对比不同版本结果时。
---

# 工件与溯源（Artifacts & Provenance）

每一个值得保留的结果都保存为版本化工件：`artifacts/<name>/v<N>/`，附 artifact.json（版本索引）与 provenance.md（溯源日志）。

## 何时归档（判据）

- 论文/报告要引用的任何数字、表格、图
- 需要复现的分析输出（变异调用、差异表达表、组装结果）
- 可能迭代多版的产物（同一分析改参数再跑 = 新版本）

## 归档协议

1. 用 `artifact_save`，参数：
   - `name`：kebab-case 短名（如 `snp-call-gatk`）
   - `sources`：结果文件/目录（相对于项目根）
   - `command`：**产生该结果的完整命令或脚本路径**（复现的关键）
   - `inputs`：输入文件/数据（含版本，如 `data/raw/SRR123.fastq.gz`）
   - `notes`：参数、软件版本、注意事项
2. 修改同一分析后再次 `artifact_save` → 自动生成 v2，旧版本保留可回溯。
3. 版本间切换：`artifact_show <name> v<N>` 查看历史；复现：`artifact_reproduce <name>`。

## 溯源记录什么（缺一不可）

- 时间、产生者（会话）
- 命令/脚本（可重跑）
- 输入（含版本/哈希线索）
- 运行环境（平台 + 软件版本，配合 envs/ 的环境导出）
- 输出文件 + 每个文件的 SHA-256

## 复现规则

- 复现 = 用溯源记录重建环境 → 重跑命令 → 对比 SHA-256 一致。
- 环境重建见 conda-environments 技能（导出 yaml/lock，pin 版本）。
- 数据文件不在版本库：data-inventory 登记来源与校验值，复现时从原处恢复。

## 引用格式

论文/报告中引用数据时写：`artifact <name> v<N>`（如 `variant-table v3`），
并在方法节说明命令、参数、环境，使审稿人能复现。
