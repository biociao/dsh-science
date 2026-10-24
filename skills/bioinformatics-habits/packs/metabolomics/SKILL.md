---
name: omics-pack-metabolomics
description: 代谢组 pack（bioinformatics-habits 领域扩展）：LC-MS/GC-MS/NMR 的非靶向与靶向代谢组、注释与统计。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: 代谢组、metabolomics、LC-MS、GC-MS、NMR、MZmine、XCMS、GNPS、注释。
---

# 代谢组 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：规划级（先出计划与 QC 契约，runner 待补） —— 规划级：本 pack 提供 intake/资源/QC 契约；runner 与注册表待补

## 适用场景

LC-MS/GC-MS/NMR 的非靶向与靶向代谢组、注释与统计。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| platform | LC-MS / GC-MS / NMR / 其他 | 决定特征提取、对齐与注释策略 |
| mode | 正离子 / 负离子 / 双极性 | 加合物与离子模式影响注释 |
| qc_design | blank / pooled QC / 内标 | 没有 QC 无法评估漂移与污染 |
| targeted_or_untargeted | targeted / untargeted | 决定是否需要标准曲线与保留时间 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| spectral_library | database | library.mgf/tsv | annotation |
| adduct_rules | annotation | adducts.tsv | annotation |
| internal_standards | library | standards.tsv | quantification |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| untargeted | untargeted、mzmine、xcms | MZmine3 / XCMS | — | mzmine、xcms、ms-dial |
| annotation | annotation、gnps、sirius | GNPS / SIRIUS+CSI:FingerID | — | gnps、sirius |
| targeted | targeted、skyline、standard_curve | Skyline / 仪器软件 | — | skyline |
| statistics | statistics、fold_change、pathway | MetaboAnalyst / 自建 | — | rscript、metaboanalyst |

### essential questions

- **untargeted**：平台与离子模式？
- **untargeted**：对齐与峰检测参数？
- **annotation**：注释置信度如何报告（MSI 级别）？
- **annotation**：是否有标准品验证？
- **targeted**：标准曲线与内标？
- **targeted**：定量下限？
- **statistics**：归一化方法？
- **statistics**：多重检验校正？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| mass_error | <5 ppm（视平台与仪器） | 仪器/注释 | 是 |
| rt_drift | QC 样本保留时间漂移在阈值内 | QC 样本 | 是 |
| pooled_qc_rsd | 多数特征 RSD <20-30% | pooled QC | 是 |
| blank_subtraction | 空白中高响应特征需剔除/标记 | blank | 是 |
| feature_count | 与平台/方法匹配，异常低需排查 | 特征表 | 否 |
| is_recovery | 内标回收率在可接受范围 | 内标 | 否 |
| annotation_level | 每个注释标注 MSI 置信级别 | 注释流程 | 是 |

## 决策点（影响生物学解释）

- 没有 blank/pooled QC 不能声称数据可靠
- 注释等级（MSI）必须逐条标注
- 归一化方法改变结论，必须报告
- 靶向与非靶向的统计策略不同

## 高频坑

- 无 blank 与 pooled QC
- 注释等级不标
- 批次漂移未校正
- 过度归一化抹掉生物学差异
- 把 m/z 匹配当结构鉴定

## 合规与边界

- 临床代谢标志物 out of scope
- 样本来源伦理

## 输出契约（envelope 之上）

- feature table
- 注释表与置信度
- QC/漂移图
- 统计与通路结果

## 交给下一个域

- multi-omics（代谢-转录/微生物联合）
- 通路解释
