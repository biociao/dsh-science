---
name: omics-pack-statistical-genetics
description: 统计遗传 pack（bioinformatics-habits 领域扩展）：GWAS、PRS、QTL 与孟德尔随机化的质控、建模与结果解释。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: GWAS、PRS、QTL、MR、summary statistics、PLINK、regenie、SAIGE。
---

# 统计遗传 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：规划级（先出计划与 QC 契约，runner 待补） —— 规划级：合规与受控访问是硬门槛；runner 与注册表待补

## 适用场景

GWAS、PRS、QTL 与孟德尔随机化的质控、建模与结果解释。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| data_access | 开放 / 受控（dbGaP/EGA）/ 本地 | 受控数据决定可执行边界与合规要求 |
| ancestry | 人群与 ancestry 组成 | 分层会制造假阳性 |
| phenotype_type | continuous / binary / survival | 决定模型与效应量解释 |
| imputation_and_ref | 参考面板与 imputation 状态 | 影响变异覆盖与可比性 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| reference_panel | database | 1000G/HRC 参考 | imputation、prs |
| ld_scores | database | eur.l2.ldscore.gz | prs |
| ancestry_reference | database | pca_loadings | gwas |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| gwas | gwas、association、regenie、saige | regenie / SAIGE / PLINK2 | — | regenie、saige、plink2 |
| prs | prs、polygenic、ldpred | PRS-CS / LDpred2 | — | prscs、ldpred2 |
| qtl_mr | qtl、eQTL、mendelian_randomization | QTLtools / TwoSampleMR | — | qtltools、twosamplemr |

### essential questions

- **gwas**：ancestry 与协变量？
- **gwas**：imputation 质量过滤？
- **prs**：目标人群 ancestry？
- **prs**：是否做外部验证？
- **qtl_mr**：工具变量假设是否成立？
- **qtl_mr**：水平多效性检验？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| hwe | p<1e-6 的变异剔除（视设计） | plink2 | 是 |
| maf | 按样本量设阈值 | plink2 | 是 |
| missingness | 变异/样本 call rate 达标 | plink2 | 是 |
| ancestry_pca | PCA 离群与分层检查 | plink2/regenie | 是 |
| lambda_gc | 接近 1；偏离需解释（分层/富集） | sumstats | 是 |
| relatedness | 近亲样本处理策略明确 | king | 否 |

## 决策点（影响生物学解释）

- 人群分层未校正的 GWAS 结论不可用
- 受控数据不得离开授权环境
- PRS 跨 ancestry 迁移性有限
- MR 需做多效性与弱工具检验

## 高频坑

- population stratification
- 表型编码错误
- summary stats 与 build 不匹配
- 把关联当因果

## 合规与边界

- 受控访问（dbGaP/EGA）与隐私是硬边界
- 个体级基因型数据不得外传/上云
- 结果再识别风险评估

## 输出契约（envelope 之上）

- sumstats + QQ/Manhattan
- PRS 与验证
- MR/QTL 结果
- QC 与合规记录

## 交给下一个域

- 功能验证
- clinical translation（需独立验证与监管路径）
