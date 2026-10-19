---
name: omics-pack-epigenomics
description: 表观组 pack（bioinformatics-habits 领域扩展）：ATAC-seq、ChIP-seq、CUT&RUN、CUT&Tag 与 DNA 甲基化的 QC、peak 与差异分析。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: ATAC-seq、ChIP-seq、CUT&RUN、CUT&Tag、peaks、FRiP、甲基化。
---

# 表观组 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：本地可执行 —— ATAC/ChIP/CUT&RUN/CUT&Tag 的本地 QC/peak runner 可执行；甲基化为规划级

## 适用场景

ATAC-seq、ChIP-seq、CUT&RUN、CUT&Tag 与 DNA 甲基化的 QC、peak 与差异分析。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| assay | atacseq / chipseq / cutandrun / cutandtag / methylation | 决定 peak 模式、对照与 QC 指标 |
| controls | input / IgG / 无 | 无对照时 peak 假阳性率显著升高 |
| peak_mode | narrow / broad | TF vs 组蛋白修饰的 peak 形状不同 |
| spike_in | 有 / 无 | 跨样本定量比较需要 spike-in 或等效归一 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| bowtie2_index | reference | genome.1.bt2、genome.2.bt2 | atac、chip |
| blacklist | annotation | blacklist.bed | atac、chip |
| tss_annotation | annotation | tss.bed | atac |
| spikein_reference | reference | spikein.fa | quantitative_comparison |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| atac | atac、accessibility | bowtie2 + MACS2 | run_atacseq_peaks_qc.py | bowtie2、samtools、macs2、deeptools |
| chip_cutrun | chipseq、cutandrun、cutandtag、peak_calling | bowtie2 + MACS2 | run_chip_cutrun_peaks_qc.py | bowtie2、samtools、macs2、bedtools |
| methylation | methylation、bisulfite、em-seq | Bismark / bwa-meth + methylKit | — | bismark、samtools、methylkit |
| differential | differential_accessibility、diffbind | DiffBind / DESeq2 | — | rscript、diffbind |

### essential questions

- **atac**：是否有生物学重复？
- **atac**：blacklist 与 TSS 是否按 build 提供？
- **chip_cutrun**：target 是 TF 还是组蛋白修饰？
- **chip_cutrun**：是否有 input/IgG 对照？
- **methylation**：bisulfite 还是 EM-seq？
- **methylation**：转化率对照结果？
- **differential**：consensus peak 如何定义？
- **differential**：重复数与离散度？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| frip | ATAC >0.3 常见；ChIP 视 target | bedtools/samtools | 是 |
| tss_enrichment | ATAC ≥2（视数据质量） | deeptools | 是 |
| insert_size | ATAC 呈核小体周期性 | picard/deeptools | 否 |
| library_complexity | NRF/PBC 不为低复杂度 | preseq | 否 |
| conversion_rate | 甲基化：>99%（视方法） | Bismark | 是 |
| replicate_concordance | 重复间 peak 重叠/相关达标 | IDR/相关 | 是 |
| blacklist_fraction | 过滤前后统计，异常高提示问题 | bedtools | 否 |

## 决策点（影响生物学解释）

- 无 input/control 的 ChIP peak 不能直接比较
- broad vs narrow 影响 peak 数量与解释
- 跨样本定量需要 spike-in 或明确归一假设
- 重复一致性不足时应降级结论

## 高频坑

- blacklist 未过滤
- 无对照仍做差异结合
- peak 数量当信号强度
- spike-in 与归一方式未记录

## 合规与边界

- 人类表观数据的隐私边界
- 云上传需显式同意

## 输出契约（envelope 之上）

- bigWig tracks
- peaks（narrowPeak/broadPeak）
- QC 汇总与浏览器 track 配置
- motif/注释 handoff

## 交给下一个域

- motif/转录因子分析
- multi-omics（表达联合）
