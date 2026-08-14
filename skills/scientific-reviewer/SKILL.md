---
name: scientific-reviewer
description: 评审机制（等价于 Claude Science 的 Reviewer）：用子代理对照执行记录核查论断，减少错误。写论文关键论断、重大发现、或用户要求自查时使用。
whenToUse: 关键论断要写进论文/报告前；实验结论异常重要时；用户要求"检查/评审/核实"时。
---

# 科学评审（Reviewer）

评审 = 独立子代理对照**执行记录**（实验日志、工件溯源、代码）核查论断，不重跑分析。

## 评审触发点

- 论文草稿中的每个关键论断（结果节数字、机制解释）
- 假设状态被标记 supported/refuted 且将进入下游结论时
- 结果被用于决策（下轮实验设计、对外汇报）前

## 评审流程

1. **提取论断**：把要核查的主张写成清单，每条含：论断原文 + 声称的证据（实验 id / 工件名 vN）。
   例：`[claim-1] "样本组间差异显著 (p=0.003)" ← artifact diff-table v2`。

2. **收集执行记录**：
   - `experiments/<id>/design.md` + `log.md`（实际跑的命令与观察）
   - `artifact_show <name>`（溯源：命令/输入/环境/哈希）
   - 相关代码（analyses/ 或 experiments/<id>/code/）

3. **启动评审子代理**（用 subagent_fork 继承本会话上下文，或 subagent 带完整材料）：
   评审提示词包含：
   - 论断清单与声称的证据
   - 执行记录路径（让子代理自己读文件）
   - 核查标准：
     a. 论断 ↔ 代码/命令是否对得上（跑的是不是声称的分析）
     b. 数字 ↔ 结果文件是否一致（重新计算关键数值）
     c. 统计方法是否恰当（多重检验校正、效应量、样本量）
     d. 混淆变量与替代解释是否被讨论
     e. 是否区分了"结果"与"推测"
   - 输出格式：每条论断 verdict（supported / refuted / needs-work / unverifiable）+ 依据 + 问题清单

4. **归档**：`research_review`（target=论断/实验/工件，verdict，issues，summary）→ 写入 reviews/<id>/report.md。

5. **处置**：needs-work/refuted 的论断，回到研究循环修复（补分析、改措辞、降级为推测），再评审一次。

## 纪律

- 评审子代理**只读**执行记录，不重跑重分析（重跑属于研究循环）。
- 评审报告保留原始问题清单，不要只写结论。
- Reviewer 降低但不消除错误：论文定稿前人工终审不可省。
