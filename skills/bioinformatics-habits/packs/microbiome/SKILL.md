---
name: omics-pack-microbiome
description: 微生物组 pack（bioinformatics-habits 领域扩展）：16S/18S/ITS/COI 扩增子与 shotgun 宏基因组的分类、多样性与功能分析。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: 16S、扩增子、shotgun metagenomics、Kraken2、DADA2、QIIME2、alpha/beta diversity。
---

# 微生物组 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：本地可执行 —— 16S/宏基因组 FASTQ 包与 Kraken2/DADA2 路径可执行；功能推断为规划级

## 适用场景

16S/18S/ITS/COI 扩增子与 shotgun 宏基因组的分类、多样性与功能分析。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| marker | 16S V3-V4 / V4 / ITS / 18S / COI | 决定引物、分类库与 denoising 参数 |
| primers | 序列或试剂盒 | 引物不匹配会系统性丢失类群 |
| controls | 阴性/阳性对照有无 | 没有对照无法评估污染 |
| absolute_quantification | 有 / 无（qPCR/内标） | 否则只能做相对丰度 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| taxonomy_classifier | database | classifier.qza 或 silva.fa | amplicon |
| kraken2_db | database | hash.k2d、opts.k2d、taxo.k2d | shotgun_taxonomy |
| host_reference | reference | host.fa | host_depletion |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| amplicon | 16s、amplicon、its、qiime2、dada2 | QIIME2 / DADA2 | run_amplicon_microbiome.py | qiime2、dada2、cutadapt |
| shotgun_taxonomy | shotgun、metagenomics、kraken2、bracken | KneadData + Kraken2 + Bracken | run_shotgun_metagenomics.py | kneaddata、kraken2、bracken |
| functional | humann、functional、pathway | HUMAnN / MetaPhlAn | — | humann、metaphlan |

### essential questions

- **amplicon**：引物与 marker？
- **amplicon**：是否有阴性对照？
- **amplicon**：分类库版本？
- **shotgun_taxonomy**：宿主去除参考？
- **shotgun_taxonomy**：Kraken2 库版本与体积？
- **functional**：是否需要通路级结论？
- **functional**：数据库版本？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| read_depth | 扩增子 ≥10k/样本；宏基因组按目标检测限 | seqkit/multiqc | 是 |
| rarefaction | 达到平台期才做多样性比较 | QIIME2 | 是 |
| host_contamination | 宏基因组宿主 reads 比例达标 | kneaddata | 是 |
| negative_control | 对照中不得出现高丰度 ASV/物种 | 对照样本 | 是 |
| asv_retention | denoising 后保留比例合理 | DADA2/QIIME2 | 否 |
| diversity_saturation | alpha 多样性随深度饱和 | rarefaction | 否 |

## 决策点（影响生物学解释）

- 相对丰度不能当绝对丰度
- rarefy 与否要在方法里写明
- 引物/数据库版本决定可比性
- 无对照时污染无法排除

## 高频坑

- 组成数据做常规检验
- 无阴性对照
- 分类库版本漂移
- 引物 mismatch 导致类群缺失
- 把 beta 多样性差异当因果

## 合规与边界

- 人类微生物组数据可能涉及隐私
- 数据库许可（SILVA/GTDB/Kraken2）

## 输出契约（envelope 之上）

- ASV/OTU 表与 taxonomy
- alpha/beta diversity 与 PCoA
- 物种/功能丰度表
- 对照与污染评估

## 交给下一个域

- 统计建模（compositional）
- multi-omics（宿主-微生物联合）
