---
name: omics-pack-multi-omics
description: 多组学整合 pack（bioinformatics-habits 领域扩展）：转录组/蛋白组/代谢组/表观组等已就绪产物的样本对齐、整合与联合分析。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: 多组学、multi-omics、整合、MOFA、mixOmics、联合分析。
---

# 多组学整合 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：规划级（先出计划与 QC 契约，runner 待补） —— 规划级：消费上游 evidence 包做整合；不直接处理 raw data

## 适用场景

转录组/蛋白组/代谢组/表观组等已就绪产物的样本对齐、整合与联合分析。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| layers | 参与整合的组学列表 | 决定整合方法与样本交集 |
| sample_overlap | same-sample / same-cohort / partial | 决定能否做样本级联合建模 |
| normalization | 各组学归一状态 | 未归一/已归一决定预处理步骤 |
| missingness | 缺失模式 | 缺失机制影响插补与结论 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| sample_map | annotation | sample_map.tsv | integration |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| integration | mofa、mixomics、wnn、integration | MOFA+ / mixOmics / Seurat WNN / muon | — | mofa、mixomics、seurat、muon |
| association | association、correlation、cross_omics | 相关/回归 + 多重检验 | — | rscript、python |

### essential questions

- **integration**：样本级还是队列级？
- **integration**：每层是否都已过 QC？
- **association**：混杂与批次？
- **association**：多重检验策略？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| sample_alignment_rate | 交集样本比例达标并记录 | sample_map | 是 |
| per_layer_qc | 每层都已通过各自 pack 的 QC | 上游 evidence | 是 |
| missingness_pattern | 缺失率与机制说明 | 矩阵 | 否 |
| batch_effect | 层内/层间批次已评估 | PCA | 否 |
| variance_explained | 因子解释度合理，避免过拟合 | MOFA+ | 否 |

## 决策点（影响生物学解释）

- 样本 ID 未对齐不能整合
- 层内 QC 未过不应进入整合
- 样本级 vs 队列级联合的统计含义不同
- 小样本整合极易过拟合

## 高频坑

- ID 不对齐
- 跳过层内 QC
- 把相关当因果
- 样本量不足仍做多因子模型

## 合规与边界

- 跨组学数据叠加提高再识别风险
- 受控数据不得混入开放分析

## 输出契约（envelope 之上）

- factors/loadings
- 整合 embedding
- 跨组学关联表
- 整合 QC 与 caveat

## 交给下一个域

- 生物学解释与验证实验
- manuscript 图表
