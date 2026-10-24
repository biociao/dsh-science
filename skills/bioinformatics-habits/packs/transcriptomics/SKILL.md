---
name: omics-pack-transcriptomics
description: 转录组 pack（bioinformatics-habits 领域扩展）：bulk RNA-seq 的 FASTQ→count、表达矩阵 QC、差异表达与下游解释。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: bulk RNA-seq、count matrix、DESeq2/edgeR、差异表达、剪接/融合。
---

# 转录组 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：本地可执行 —— bulk RNA-seq 定量与 DE 本地 runner 可执行；剪接/融合/长读为规划级

## 适用场景

bulk RNA-seq 的 FASTQ→count、表达矩阵 QC、差异表达与下游解释。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| input_mode | raw_counts / normalized_expression / log_expression | 决定用 DESeq2/edgeR 还是 limma；用错会引入系统性偏差 |
| strandedness | forward / reverse / unstranded / unknown | 影响定量与计数正确性 |
| design_and_contrasts | 因子 + 对比表 | DE 的统计模型由设计矩阵决定 |
| replicates | 每组 n | n=1 无法估计离散度，只能给描述性结果 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| transcriptome | reference | transcriptome.fa、tx2gene.tsv | salmon_quant |
| annotation_gtf | annotation | genes.gtf | star、featurecounts |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| counts_qc | fastq、quantification、salmon | FastQC/MultiQC + Salmon | run_bulk_rnaseq_counts_qc.py | fastqc、multiqc、salmon |
| differential_expression | differential_expression、deseq2、deg | DESeq2 / edgeR / limma（自动选择） | run_bulk_rnaseq_de.py | rscript、deseq2、edger、limma |
| splicing | splicing、rmats、isoform | rMATS / SUPPA2 / IsoQuant | — | rmats、suppa、isoquant |
| fusion | fusion、star-fusion、arriba | STAR-Fusion / Arriba | — | star-fusion、arriba |

### essential questions

- **counts_qc**：单端还是双端？
- **counts_qc**：strandedness 是否已知？
- **counts_qc**：rRNA 去除方式？
- **differential_expression**：矩阵是 raw counts 还是已标准化？
- **differential_expression**：对比表与协变量怎么定义？
- **differential_expression**：低表达过滤策略？
- **splicing**：是否有生物学重复？
- **splicing**：注释版本？
- **fusion**：是否肿瘤样本？
- **fusion**：是否需要与 DNA 层面互证？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| mapping_rate | >70%（物种/建库依赖） | STAR/Salmon log | 是 |
| strandedness_check | 与声明一致；不一致则纠正或告警 | infer_experiment/ Salmon | 是 |
| rrna_fraction | <10%（视建库） | FastQ Screen/统计 | 否 |
| library_size | 满足 DE 检测目标 | counts 汇总 | 否 |
| sample_outlier | PCA/相关矩阵离群需解释 | PCA/correlation | 否 |
| design_rank | 设计矩阵满秩、无混杂 | R model.matrix | 是 |
| replicate_consistency | 组内相关高于组间 | 相关矩阵 | 否 |

## 决策点（影响生物学解释）

- raw counts 才能用 DESeq2/edgeR；TPM 只能做描述
- strandedness 推断错误会改变一半 reads 的归属
- contrast 编码错误是最常见的结论错误来源
- 批次与条件混杂时不能声称校正

## 高频坑

- 用 TPM 做 DE
- 设计矩阵不满秩
- contrast 写反
- 参考注释版本漂移
- 不检查样本离群

## 合规与边界

- 人类表达数据按受控/去标识要求处理
- 云上传需显式同意

## 输出契约（envelope 之上）

- 表达矩阵（tpm/num_reads/effective_length）
- DE 结果表 + 统计警告
- 设计诊断与 QC 图
- 分析方法与版本记录

## 交给下一个域

- 通路/富集分析
- multi-omics（蛋白/代谢联合）
