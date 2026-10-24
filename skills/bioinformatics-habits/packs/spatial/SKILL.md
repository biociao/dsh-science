---
name: omics-pack-spatial
description: 空间组学 pack（bioinformatics-habits 领域扩展）：Visium/Xenium/CosMx 等空间转录组的计数、影像配准、空间分析与去卷积。提供本域 intake 扩展、资源 bundle、pipeline 路由与 QC 判据；流程纪律以 core 为准。
whenToUse: 空间转录组、Visium、Xenium、CosMx、空间、image registration、deconvolution。
---

# 空间组学 Pack

> 本 pack 是 `bioinformatics-habits` core 的领域扩展，只提供「三张表」（输入 / 资源 / QC 判据）与本域决策点；**五段工作法与 12 条习惯仍以 core 为准**。

**成熟度**：规划级（先出计划与 QC 契约，runner 待补） —— 规划级：本 pack 提供 intake/资源/QC 契约；runner 与注册表待补

## 适用场景

Visium/Xenium/CosMx 等空间转录组的计数、影像配准、空间分析与去卷积。

## Intake 扩展（core 三件套之外）

| 字段 | 取值 | 为什么 blocking |
| --- | --- | --- |
| platform | Visium / Xenium / CosMx / 其他 | 决定计数与坐标格式 |
| image_and_alignment | 图像 + 配准结果 | 坐标与图像不对齐会导致空间结论错误 |
| roi | 组织区域定义 | 影响背景与非组织区域判定 |
| deconvolution_reference | 单细胞参考 / 无 | 决定能否做细胞类型去卷积 |

## 资源 bundle

| bundle | kind | 期望内容 | required_for |
| --- | --- | --- | --- |
| probe_set | library | probes.csv | xenium、cosmx |
| tissue_image | reference | tissue.tif | registration |
| sc_reference | database | reference.h5ad | deconvolution |

## Pipeline 路由

| pipeline | 触发词 | 首选工作流 | 本地 runner | 关键工具 |
| --- | --- | --- | --- | --- |
| visium_counts | visium、spaceranger | Space Ranger | — | spaceranger |
| xenium_panel | xenium、panel | Xenium Ranger + 下游分析 | — | xeniumranger |
| registration | registration、alignment、image | Space Ranger 内置 / 手动配准 | — | spaceranger、napari |
| deconvolution | deconvolution、cell2location、rctd | cell2location / RCTD | — | cell2location、spacexr |

### essential questions

- **visium_counts**：组织检测阈值？
- **visium_counts**：图像质量？
- **xenium_panel**：panel 与目标细胞类型匹配？
- **xenium_panel**：细胞分割方法？
- **registration**：配准误差如何评估？
- **registration**：是否有组织形变？
- **deconvolution**：参考数据来源？
- **deconvolution**：spot 多细胞混合程度？

## QC 判据

| 指标 | 规则 | 来源 | 阻塞 |
| --- | --- | --- | --- |
| spots_under_tissue | 比例合理，异常低提示组织检测失败 | Space Ranger | 是 |
| counts_per_spot | 按组织类型与 panel 设阈值 | 计数矩阵 | 是 |
| image_alignment | 配准误差在可接受范围 | 配准/qc | 是 |
| probe_efficiency | panel 检出率达标 | panel 统计 | 否 |
| off_tissue_fraction | 非组织区域 reads 低 | Space Ranger | 否 |
| spatial_autocorrelation | 关键基因呈空间结构（Moran's I） | squidpy | 否 |

## 决策点（影响生物学解释）

- spot 不是单细胞，不能按单细胞解释
- 图像配准误差影响所有空间结论
- 去卷积依赖参考质量
- 组织边界与 ROI 定义要写清

## 高频坑

- 跳过图像配准
- 把 spot 当单细胞
- 参考不匹配仍去卷积
- 忽略组织形变

## 合规与边界

- 人类空间数据的影像/隐私
- 临床病理 out of scope

## 输出契约（envelope 之上）

- counts + 坐标 + 图像
- 配准与 QC 产物
- 细胞类型比例
- 空间图与统计

## 交给下一个域

- multi-omics（空间 + 单细胞）
- 病理/影像联合分析
