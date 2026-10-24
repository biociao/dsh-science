---
name: omics-pack-single-cell
description: 单细胞与单核 pack（bioinformatics-habits 领域扩展）：scRNA/snRNA 的 FASTQ→count、post-count QC、聚类注释与整合。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: scRNA-seq、snRNA-seq、10x、h5ad、细胞注释、doublet、ambient RNA。
---

# 单细胞与单核 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：本地可执行 —— STARsolo FASTQ→count 与 post-count QC 可本地执行；注释/整合视为可复核产物

## 适用场景

scRNA/snRNA 的 FASTQ→count、post-count QC、聚类注释与整合。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| chemistry | 10x 3'/5'、multiome、其他 | 决定 whitelist 与 barcode 结构 |
| expected_cells | 估计值或范围 | 影响 cell calling 与 doublet 预期 |
| tissue_and_reference | 组织 + 参考 atlas/标记 | 注释不能只靠通用 marker |
| raw_droplet_matrix | 有 / 无 | 有 raw matrix 才能做 emptyDrops 类校正 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| genome_gtf | reference | genome.fa、genes.gtf | fastq_to_count |
| barcode_whitelist | library | whitelist.txt | fastq_to_count |
| atlas_reference | database | reference.h5ad | annotation |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| fastq_to_count | fastq、starsolo、cellranger | STARsolo（容器） | run_scrnaseq_fastq_to_count.py | star、snakemake |
| post_count_qc | h5ad、matrix、qc | scanpy + scDblFinder/CellBender | run_scrnaseq_post_count_qc.py | python、scanpy、scvi-tools |
| annotation | annotation、clustering、umap | marker + reference mapping（Azimuth/scANVI） | — | scanpy、seurat、azimuth |
| integration | integration、harmony、scvi | Harmony / scVI | — | harmony、scvi-tools |

### essential questions

- **fastq_to_count**：chemistry 与 whitelist？
- **fastq_to_count**：预期细胞数？
- **fastq_to_count**：是否有 raw droplet matrix？
- **post_count_qc**：是否已做 doublet/ambient 校正？
- **post_count_qc**：线粒体阈值按组织定义？
- **annotation**：有无匹配参考？
- **annotation**：注释置信度如何评估？
- **integration**：批次与条件是否混杂？
- **integration**：整合会不会抹掉真实生物学差异？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| cells_recovered | 与上样量/预期同量级 | cellranger/STARsolo | 否 |
| median_genes_per_cell | 按组织定；过低提示空滴或降解 | scanpy | 是 |
| doublet_rate | 按 10x 回收率估计，>预期需去除 | scDblFinder | 是 |
| ambient_rna | SoupX/CellBender 估计污染比例并校正 | SoupX/CellBender | 否 |
| pct_mito | 按组织设阈值（如 10-20%） | scanpy | 是 |
| saturation | 测序饱和度足够检出中等表达基因 | STARsolo/Cell Ranger | 否 |
| batch_mixing | 整合前后比较，避免过度整合 | kBET/LISI | 否 |

## 决策点（影响生物学解释）

- cell calling 过滤阈值决定下游所有结论
- doublet 与 ambient 校正必须在校验集上复核
- 通用 marker fallback 不能当组织特异注释
- 整合程度以保留生物学差异为准

## 高频坑

- 不做空滴/环境 RNA 校正
- doublet 未去除
- 用 PBMC marker 注释所有组织
- 过度聚类/过度整合
- 细胞数当生物学重复数

## 合规与边界

- 人类单细胞数据的隐私与受控访问
- 细胞级数据再分发需评估

## 输出契约（envelope 之上）

- count matrix / h5ad
- QC 指标表
- cluster markers 与注释表
- UMAP/embedding 与复核面板

## 交给下一个域

- 细胞类型比例统计与统计检验
- multi-omics（CITE-seq/多组学）
