---
name: omics-pack-proteomics
description: 蛋白组 pack（bioinformatics-habits 领域扩展）：DDA/DIA 蛋白质组、PTM 富集与定量比较。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: 蛋白组、proteomics、DIA、DDA、MaxQuant、DIA-NN、磷酸化、PTM。
---

# 蛋白组 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：规划级（先出计划与 QC 契约，runner 待补） —— 规划级：本 pack 提供 intake/资源/QC 契约；runner 与注册表待补

## 适用场景

DDA/DIA 蛋白质组、PTM 富集与定量比较。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| acquisition | DDA / DIA / PRM / top-down | 决定搜索策略与是否需要谱图库 |
| enzyme_and_mods | 胰蛋白酶等 + 固定/可变修饰 | 直接影响肽段与 FDR |
| labeling | label-free / TMT / SILAC | 决定定量归一方式 |
| fdr_level | PSM / peptide / protein | 不同层级 FDR 不可混用 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| protein_fasta | reference | proteome.fa、contaminants.fa | search |
| spectral_library | library | library.dlib/tsv | dia |
| ptm_reference | annotation | ptm_sites.tsv | ptm |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| dda | dda、maxquant、fragpipe | MaxQuant / FragPipe | — | maxquant、fragpipe、comet |
| dia | dia、dia-nn、spectronaut | DIA-NN / Spectronaut | — | diann、spectronaut |
| ptm | phospho、ptm、localization | MaxQuant PTM / ptmRS | — | maxquant、ptmrs |

### essential questions

- **dda**：酶切与修饰？
- **dda**：FDR 层级？
- **dia**：谱图库来源？
- **dia**：仪器与梯度是否匹配？
- **ptm**：富集方法与输入量？
- **ptm**：定位概率阈值？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| psm_fdr | 1%（探索性可 5%，须写明） | search engine | 是 |
| protein_fdr | 与 PSM FDR 分开报告 | search engine | 是 |
| mass_accuracy | ppm 分布居中且窄 | search engine | 否 |
| missed_cleavages | 比例合理（酶切效率） | search engine | 否 |
| identifications_per_sample | 与上样量/梯度匹配 | 汇总 | 否 |
| qc_sample_cv | pooled QC 的 CV 达标 | QC 样本 | 是 |
| ptm_localization | 定位概率阈值（如 >0.75） | ptmRS | 否 |

## 决策点（影响生物学解释）

- PSM FDR 不等于 protein FDR
- DIA 谱图库必须与仪器/梯度匹配
- TMT 批次效应需在设计中控制
- PTM 结论必须带定位概率

## 高频坑

- 把 PSM FDR 当 protein FDR
- 无 QC 样本
- 谱图库与仪器不匹配
- TMT 批次与条件混杂
- 缺失值机制未说明

## 合规与边界

- 临床蛋白标志物 out of scope
- 样本来源伦理与许可

## 输出契约（envelope 之上）

- proteinGroups / report
- 肽段与 PTM 表
- QC 与 CV 统计
- 归一后的定量矩阵

## 交给下一个域

- multi-omics（蛋白-转录联合）
- 通路/网络分析
