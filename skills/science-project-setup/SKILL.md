---
name: science-project-setup
description: 初始化或整理一个科研项目：目录约定、研究清单（research-manifest.json）、数据与权限边界。新建项目、换工作区、或整理混乱的项目时使用。
whenToUse: 开始新科研项目、把已有材料组织成可运行的研究项目、或迁移项目目录时。
---

# 科研项目初始化与组织

项目根 = 工作区根（自动探测：含 `.dsh` 或 `.git` 的目录）。研究状态统一由 `research-manifest.json` 维护。

## 目录约定

| 目录 | 内容 | 是否入 git |
| --- | --- | --- |
| `experiments/<id>/` | 每个实验一个目录：design.md、log.md、code/、results/ | 代码入，大结果出 |
| `literature/` | 文献笔记、`references.bib`、检索记录 | 入 |
| `artifacts/<name>/` | 版本化工件：v<N>/、artifact.json、provenance.md | 入（小文件） |
| `analyses/` | 分析脚本（可复用流水线） | 入 |
| `figures/` | 成稿图表 | 入 |
| `manuscript/` | 论文草稿 | 入 |
| `reviews/<id>/` | 评审报告 | 入 |
| `data/` | 原始数据（测序、公共数据） | **不入 git**，用 data-inventory 登记 |
| `envs/` | 环境导出（conda yaml / lock 文件） | 入 |

## 初始化步骤

1. 若 `research-manifest.json` 不存在：`research_init`（title、domain、question）。
2. 写/更新项目 `README.md`：项目目标、数据来源、运行方式。
3. 检查 `data/`：登记数据清单（见 data-inventory 技能）。
4. 配置 `.gitignore`：排除 `data/`、大结果文件、临时文件。
5. 建立环境（见 conda-environments 技能）。

## 权限与沙箱（对应 Claude Science 权限卡片）

- 代码在沙箱运行。访问新目录、联网、安装包会触发审批——向用户说明申请什么、为什么。
- 默认只读写项目根；data/ 中外部授权的数据只读使用，不复制进 artifacts。
- 网络 deny-by-default：只允许包管理器与已批准的文献/数据库主机。

## 清单字段速览

`project`（标题/领域/状态）、`question`（核心问题）、`hypotheses[]`（id/text/status/experiments）、
`loop`（phase/iteration/history）、`experiments[]`、`artifacts[]`、`reviews[]`。
清单是机器与模型共用的真相来源：**所有状态变更走 research_* 工具，不要手改 JSON 结构**（追加式 log 文件除外）。
