---
name: scientific-reviewer
description: 评审机制（等价于 Claude Science 的 Reviewer）：HOST 平面 scientific-reviewer 引擎事件驱动地自动评审——独立评审模型对照执行记录核查论断，结论落盘 reviews/ 并回传主代理。处置评审意见、理解 gate 门禁、或引擎缺席时需手动评审时使用。
whenToUse: dashboard 或 research_* 工具结果出现「待处理评审」提醒时；需要理解/处置评审报告时；评审引擎未安装或被禁用、需要手动发起评审时。
---

# 科学评审（Reviewer）

评审 = **独立的评审模型**对照**执行记录**（实验日志、工件溯源、代码）核查论断，不重跑分析。评审的发起、物料、模型、结论都不经过主代理（actor-critic 结构）。

## 机制（引擎驱动，默认形态）

`scientific-reviewer` 引擎挂在 HOST 平面（bundle 的 cordis.patch.yml），自动运行：

1. **观察**：`agent/request` 钩子观察主会话 turn 边界（子代理会话不评审）。
2. **触发**（快照 diff，`<root>/.reviewer/state.json`）：新工件版本、假设更新（新 findings）、manuscript 变更；`minIntervalSec` 防抖。
3. **评审**：引擎只读收集论断+执行记录，用 **bundle config 里 `model` 显式指定的评审模型**发起独立 LLM 调用（与工作流模型解耦），按 5 条标准核查：
   a. 论断 ↔ 代码/命令对得上；b. 数字 ↔ 结果文件一致；c. 统计方法恰当（多重检验校正、效应量、样本量）；d. 混淆变量与替代解释；e. 区分「结果」与「推测」。
4. **落盘**：`reviews/Rnn/report.md` + manifest；supported/refuted/inconclusive 会终结 testing 假设。
5. **回传**：每个 `research_*` 工具返回尾部附「待处理评审」提醒；dashboard 显示「评审（M，待处理 N）」。

## 主代理的职责（advise 模式）

- **保证论断可审**：工件溯源齐全（artifact_save）、实验 log.md 完整、manuscript 数字可回溯——评审模型只读这些记录，记录缺失只会让论断被判 unverifiable。
- **处置待处理评审**：看到「待处理评审」提醒时，读 `reviews/Rnn/report.md` 的问题清单：
  - needs-work/refuted → 回研究循环修复（补分析、改措辞、降级为推测）；
  - 修复产生的新 findings/工件会自动触发复审，新 verdict 覆盖后待处理清零。

## gate 门禁（可选，config `gate: true`）

引擎写 `<root>/.reviewer/gate` 标记后，最新评审为 needs-work/refuted 的假设**禁止**经 research_findings 下结论（抛 ERR_REVIEW_GATE）。先处置评审意见，复审通过后再下结论。

## 手动兜底（引擎缺席/禁用，或用户要求即时评审）

引擎不可用时按原流程手动评审：

1. **提取论断**：论断清单 = 论断原文 + 声称的证据（实验 id / 工件名 vN）。
2. **收集执行记录**：`experiments/<id>/design.md` + `log.md`；`artifact_show <name>` 溯源；相关代码。
3. **启动评审子代理**：用 subagent_fork 继承上下文，或 subagent 带完整材料；**评审模型应强于执行模型**——派发时用 agentOptions 显式指定 `{provider, model}`（如强推理模型），不要默认继承会话模型。
4. **归档**：`research_review`（target=论断，verdict ∈ supported/refuted/inconclusive/needs-work/unverifiable，issues，summary）。

## 纪律

- 评审**只读**执行记录，不重跑重分析（重跑属于研究循环）。
- 评审报告保留原始问题清单，不要只写结论。
- Reviewer 降低但不消除错误：论文定稿前人工终审不可省。
