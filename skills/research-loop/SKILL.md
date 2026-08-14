---
name: research-loop
description: 执行 Claude Science 式研究循环（ReAct：提问→假设→实验→观察→分析→结论→迭代）。当开始或继续一个科研任务、需要把研究推进到下一轮迭代时使用。配合 research_* 工具维护 research-manifest.json。
whenToUse: 开始新研究任务、继续未完成的科研项目、或需要系统化推进假设检验时。
---

# 研究循环（Research Loop, ReAct）

研究循环是科研项目的核心执行协议。每一轮迭代 = 一个完整的 Reason → Act → Observe 循环，结果落盘到研究清单（research-manifest.json），跨会话持续。

## 循环步骤

1. **Question** — 明确本轮要回答的问题。用 `research_state` 读取当前状态；问题不清晰时先用文献调研（literature-connector）收窄。
2. **Hypothesis** — 提出可证伪假设，用 `research_hypothesis` 登记（H1/H2/…）。好假设：可检验、有明确预期方向。
3. **Experiment** — 用 `research_experiment` 登记实验（E01/…），写清 design.md：目的、步骤、预期结果。**先写设计再写代码**。
4. **Act** — 写代码运行。代码放 `experiments/<id>/code/`，结果放 `experiments/<id>/results/`。每一步跑什么命令、参数是什么，写进 log.md。
5. **Observe** — 对照 design.md 的预期，记录实际观察（数值、图、表）。不要在此步下结论。
6. **Analyze / Conclude** — 用 `research_findings` 记录发现；conclusion 更新假设状态：
   - `supported`：数据支持假设（注明统计方法与显著性）
   - `refuted`：数据否定假设（说明哪个预期被违反）
   - `inconclusive`：无法判定（说明缺什么数据/检验）
7. **Next Question** — `research_findings` 的 nextQuestion 开启下一轮：更新研究问题、迭代数 +1。

## 阶段推进

用 `research_phase` 推进：literature → hypothesis → experiment → analysis → manuscript → concluded。结论证据不足时不要跳到 manuscript。

## 循环纪律

- 每轮迭代结束必须调用一次 `research_findings`（即使结论是 inconclusive），保证清单可追溯。
- 重要的中间产物（数据表、图、模型）立即用 `artifact_save` 归档（见 artifact-provenance）。
- 一个会话内推进多轮迭代时，用 `todo_write` 跟踪每轮步骤；跨会话的长研究目标用 `create_goal` 建立目标，让目标轮次驱动循环。
- 关键论断进入论文前必须评审（见 scientific-reviewer）。
- 遇到阻塞（数据缺失、工具问题）先记录到 log.md，再决定降级方案，不要静默跳过。

## 示例节奏（一个会话）

```
research_state → 明确问题
research_hypothesis → 登记假设
research_experiment → 创建 E01
写代码 → 运行 → 记录 log.md
research_findings (finding + conclusion + nextQuestion)
research_phase → 推进阶段
```
