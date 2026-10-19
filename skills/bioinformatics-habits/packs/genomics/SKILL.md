---
name: omics-pack-genomics
description: 基因组变异 pack（bioinformatics-habits 领域扩展）：种系与体细胞 SNV/indel、CNV/SV、变异注释与解读前置检查。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: WGS/WES/targeted panel、tumor-normal、germline、CNV/SV、VCF 注释。
---

# 基因组变异 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：本地可执行 —— germline / somatic / panel 的本地轻量 runner 可执行；WGS/WES 完整体检优先 nf-core/sarek

## 适用场景

种系与体细胞 SNV/indel、CNV/SV、变异注释与解读前置检查。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| sample_model | singleton / cohort / duo / trio / tumor_normal / tumor_only | 决定用 germline、joint calling 还是 somatic 模型 |
| assay | wgs / wes / targeted_panel | 决定 callable 区域、覆盖度目标与 PON 兼容性 |
| reference_build | GRCh38 / GRCh37 / mm10 / … | build 不一致会让坐标与 known-sites 全部失效 |
| matched_normal | true / false / unknown | 无配对正常时 somatic 结论强度与过滤策略不同 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| genome_core | reference | genome.fa、genome.fa.fai、dict | germline、somatic、cnv_sv |
| known_sites | database | dbsnp.vcf.gz、dbsnp.vcf.gz.tbi、mills.vcf.gz | germline_bqsr |
| panel_of_normals | panel | pon.vcf.gz、pon.vcf.gz.tbi | somatic |
| target_bed | annotation | targets.bed | wes、targeted_panel |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| germline | germline、wgs、wes、trio | nf-core/sarek | run_dna_germline_variants.py | nextflow、gatk、samtools、bcftools |
| somatic | somatic、tumor_normal、tumor_only、cancer_panel | nf-core/sarek | run_dna_somatic_variants.py | gatk、samtools、bcftools |
| umi_panel | umi、duplex、low_frequency | fgbio + Mutect2（本地） | run_dna_umi_panel_variants.py | fgbio、samtools、gatk |
| cnv_sv | cnv、sv、structural_variant | GATK gCNV / Manta / Delly | — | gatk、manta、delly |
| annotation | annotation、vep、snpeff | VEP / SnpEff | — | vep、snpeff |

### essential questions

- **germline**：是否 trio/cohort 需要 joint calling？
- **germline**：known-sites 与 build 是否匹配？
- **somatic**：tumor-only 还是配对？
- **somatic**：PON/germline resource 是否同 build？
- **somatic**：纯度与最低 AF 预期？
- **umi_panel**：consensus 还是 raw BAM？
- **umi_panel**：UMI 结构/tag 是什么？
- **cnv_sv**：是否有足够 cohort 做 gCNV？
- **cnv_sv**：是否需要 read-depth 校正？
- **annotation**：注释数据库/转录本版本？
- **annotation**：缓存与 build 是否匹配？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| mean_coverage | WGS ≥30x，WES ≥80x（目标区域），panel 按设计 | samtools depth/mosdepth | 是 |
| pct_target_ge_20x | ≥90%（WES/panel） | mosdepth | 是 |
| duplicate_rate | 按建库方式；异常偏高需提示 | picard/samtools markdup | 否 |
| contamination | <3%（verifyBamID/FREEMIX） | verifyBamID2 | 是 |
| ti_tv | WGS 全基因组约 2.0-2.1；显著偏离提示质量问题 | bcftools stats | 否 |
| tumor_purity | 低于 ~20% 时 somatic 结论降级 | ASCAT/Purple/估计 | 是 |
| vaf_distribution | 与预期 AF 目标一致；tumor-only 需显式 caveat | bcftools/自定义 | 否 |

## 决策点（影响生物学解释）

- 参考 build 与 known-sites / PON 必须来自同一 build 与 capture kit
- tumor-only 结果不能表述为 confirmed somatic
- joint calling 的 cohort 组成决定敏感度与假阳性
- 注释转录本版本影响 HGVS 与临床解读

## 高频坑

- 参考 build 不一致
- PON 跨 kit 复用
- 把 tumor-only 当配对结果
- 覆盖度不达标仍出结论
- 注释版本漂移未记录

## 合规与边界

- 人类遗传资源与隐私边界先确认
- 临床可操作性 out of scope，除非有验证过的临床流程
- 云上传需显式同意

## 输出契约（envelope 之上）

- variants/*.vcf.gz（raw/filtered）
- qc/coverage 与 contamination
- 变异计数与过滤原因表
- 注释产物与版本

## 交给下一个域

- 解读/临床路径（需独立验证）
- multi-omics（如与表达/甲基化联合）
