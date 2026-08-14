---
name: manuscript-writing
description: 论文撰写流水线：从工件与执行记录到可投稿草稿（结构、方法、结果、图表、引用、自查）。循环进入 manuscript 阶段时使用。
whenToUse: 研究循环推进到 manuscript 阶段、起草论文/报告、或需要把结果组织成可投稿手稿时。
---

# 论文撰写（Manuscript Pipeline）

从研究清单与工件出发逐节成稿，每一节都能回溯到执行记录。

## 前置检查（不满足先回循环）

- [ ] 每个关键论断已有 supported 状态且经过评审（见 scientific-reviewer）
- [ ] 引用的数据均已 `artifact_save`（论文引用格式：artifact <name> v<N>）
- [ ] 方法可复现：命令、参数、环境记录齐全（conda yaml / lock）
- [ ] 统计方法与多重检验校正已明确

## 成稿顺序

1. **大纲**：`manuscript/outline.md` —— 标题（暂定）+ 摘要要点 + 章节结构
   （引言 / 方法 / 结果 / 讨论 / 结论）。每节列出支撑证据（实验 id、工件名、文献 key）。
2. **方法（Methods）**：先写。逐条来自执行记录：数据来源（data-inventory）、
   环境与版本（envs/）、每步命令与参数、统计方法。可复现是硬标准。
3. **结果（Results）**：按假设组织。每段 = 论断 + 证据（figure/table + 数字）+ 统计。
   数字必须与工件一致（写完用 artifact_show 核对）。
4. **图表**：`figures/` 下编号 Figure 1/2/…，每图配标题与图注（说明统计与样本量）；
   图对应脚本放 `analyses/` 或实验结果目录，脚本产物与图版本一致。
5. **引言（Introduction）**：研究背景 + 缺口 + 本工作假设（引用 literature/references.bib）。
6. **讨论（Discussion）**：主要发现、局限、与文献关系、未来方向。区分"结果"与"推测"。
7. **摘要（Abstract）**：最后写，从结果节提炼。

## 引用

- 用 citation key（见 literature-connector）；正文出现即入 `literature/references.bib`。
- 预印本标注 preprint；无法核实来源的引用一律删除。

## 自查（投稿前）

1. 跑一轮 scientific-reviewer：把结果节的每条论断交给评审子代理对照执行记录核查。
2. 数字一致性：抽查每个数字都能在工件/日志中找到。
3. 复现试跑：至少一个关键分析按 provenance 重跑通过。
4. 对照期刊要求：字数、结构、参考文献格式。
5. `manuscript/` 下维护 `changelog.md`：每次修改记录日期与改动（对应版本化思想）。

## 纪律

- 不写没有证据支撑的句子；推测明确标注。
- 结果与讨论分离；负面/不显著结果如实报告。
- 每轮修改后更新 changelog，终稿前做一次全文一致性检查。
