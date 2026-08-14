---
name: bioinformatics-toolkit
description: 基因组/病原体/生物信息分析工具箱：常见任务的标准工具链、流程模板与坑（序列处理、比对、变异、组装、系统发育、NGS 质检）。做生物信息分析时使用。
whenToUse: 涉及序列、比对、变异调用、组装、系统发育、NGS 数据处理等生信任务时。
---

# 生物信息工具箱（Bioinformatics Toolkit）

面向基因组 / 病原体 / 人类健康方向的常用任务与工具链。**工具版本一律固定并记录到 envs/ 与实验 design.md**。

## 常用工具链（按任务）

| 任务 | 工具（示例） | 说明 |
| --- | --- | --- |
| 质检 | fastqc + multiqc | 原始数据先质检；记录碱基质量、接头、GC |
| 去接头/修剪 | fastp / trimmomatic | 参数记录到 log.md（长度、质量阈值） |
| 比对 | bwa mem（短读）、minimap2（长读/组装比对） | 记录参考基因组版本与索引 |
| 比对后处理 | samtools sort/index/flagstat、picard MarkDuplicates | 每次跑完 flagstat 留存 |
| 变异调用 | GATK HaplotypeCaller、freebayes、bcftools | 记录过滤标准（QUAL、DP、QD 等）与参考版本 |
| 变异注释 | snpEff / ANNOVAR / VEP | 记录数据库版本 |
| 组装 | SPAdes（细菌/短读）、flye（长读）、unicycler | 记录 k-mer 与覆盖度 |
| 基因组注释 | Prokka / bakta | 记录数据库版本 |
| 系统发育 | IQ-TREE / RAxML / FastTree | 记录模型选择（如 ModelFinder）与 bootstrap |
| 分型/流行病学 | MLST、SeroBA、Mykrobe（耐药）、cgMLST | 记录数据库版本与阈值 |
| 序列操作 | seqkit、samtools faidx | 切片、统计、格式转换 |
| 分析环境 | Python（pandas/biopython/scikit-bio）、R（tidyverse/ggplot2） | 环境用 conda 管理 |

## 流程模板（建议的目录内组织）

```
experiments/E01/
├── design.md      # 目的、参考版本、参数、预期
├── code/          # 脚本（可复现，含版本号）
├── results/       # 中间与最终结果（按步骤编号 01_/02_/...）
└── log.md         # 实际运行命令 + 输出摘要（flagstat、统计数）
```

## 数据规范

- 原始测序数据：`data/raw/`，只读，登记到 data-inventory（来源、下载命令、md5/sha256）。
- 参考基因组：记录版本与下载来源（如 `GCF_000000000.1`）。
- 公共数据库（NCBI/ENA/SRA/EBI）：记录 accession 列表文件。
- 样本清单：`data/samples.csv`（样本 id、批次、条件），所有分析以此为唯一事实来源。

## 常见坑

- **参考版本不一致** → 变异/比对不可比：每个实验 design.md 写明参考版本。
- **工具版本漂移** → 复现失败：envs/ 固定 conda 环境与 lock 文件。
- **未做多重检验校正** → 假阳性：差异分析用 BH-FDR；GWAS 类用严格阈值。
- **批次效应** → 结论偏差：多样本先查批次（PCA/UMAP），必要时校正。
- **污染/混合样本** → 病原体分析先用 kraken2/fastq screen 检查。
- **染色体 vs 质粒/噬菌体序列** → 组装后分类，别混在一起分析。
- 不确定某个软件用法时，先查其文档（`<tool> --help`、官网），不要凭记忆写参数。

## 复现优先

每完成一个关键步骤，把命令、参数、版本写入 log.md；最终结果 `artifact_save`（见 artifact-provenance）。
