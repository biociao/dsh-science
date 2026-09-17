---
name: biomni-agent
description: 执行 Biomni 式通用生物医学研究协议（检索增强规划 → 计划清单 → 代码优先执行 → 反思自批判 → 给出方案）。当面临一个广泛的生物医学科研任务、需要从资源宇宙里挑出相关工具/数据/软件/知识库再动手时使用。配合 biomni_* 工具维护 .biomni/ 下的 registry.json / plan.json / reflect.jsonl。
whenToUse: 新开一个跨子领域的生物医学任务、需要先做"检索增强规划"再执行、或任务需代码优先处理数据（单细胞注释、变异解读、表达分析、药物/结构等）时。
---

# Biomni 通用研究协议（Retrieval-Augmented Planning + Code Execution + Reflection）

Biomni 是一个通用生物医学 AI agent：不做任务专用流水线，而是用**检索增强规划**把推理聚焦到相关资源子集，然后**代码优先**执行、**每步反思**。核心哲学：别把整个工具/数据空间一股脑塞给模型（上下文爆炸 + 工具选择不可靠），而是先挑出与当前任务最相关的子集，再把推理交给模型。

## 工作流（每轮 ReAct = 检索 → 计划 → 执行 → 反思 → 方案）

1. **Retrieve（检索增强规划）** — 用 `biomni_retrieve <query>` 从资源宇宙（`biomni_resources_list` 可全量查看）里挑出相关的 **工具（能力）/ 数据湖（策展数据集）/ 软件库（Python/R 包）/ Know-How（协议）**，并拿到检测到的任务主题与建议计划骨架。这是"计划"的第一步：**先选对资源，再行动**。
2. **Plan（研究计划与状态）** — 用 `biomni_plan_init` 建一份编号清单（`[ ]`/`[✓]`/`[✗]`/`[…]`），它记录 ① 高层计划（可修订）② 哪些步骤完成/进行中/失败 ③ 每步后的结果与结论。**只有上一步已确认的观察才能写进结果**，不要臆测。每步后 `biomni_plan_update` 保持最新。
3. **Execute（代码优先）** — 处理实质数据/长序列/统计时**写代码而不是调固定函数**：用会话已有的 `bash` 执行 Python/R/Bash（基因组/单细胞等多用相应库），把结果作为 observation 收集。调用的分析库最好来自检索到的 libraries（scanpy/Seurat/DESeq2/pysam/rDkit…），数据来自 data_lake。
4. **Reflect（反思/自批判）** — 每步后用 `biomni_reflect` 记录：observation（客观输出）、reflection（意味着什么、问题处于什么状态）、diagnosis（出错则原因与修复）、nextAction。verdict ∈ ok/revise/rerun/blocked。反思链约束下一步——**发现异常就修正方案或重跑，而不是硬推**。
5. **Solution（给出方案）** — 当任务完成，给出贴合任务要求格式的答案，并落实到结果（数据表/图/结论写进项目目录）。

## 与资源宇宙交互

- `biomni_resources_list` — 查看当前资源宇宙（tools/data_lake/libraries/know_how），可按 type 过滤、keyword 搜索。
- `biomni_registry_add` — 运行时注入自定义资源（自定义工具/数据/软件/知识库），注入后立即可被检索到。
- `biomni_registry_remove` / `biomni_registry_show` — 移除 / 查看单个资源。
- **只读/版本锁定**：使用策展数据（尤其 DCS /public 公共库）时用绝对路径、读目录 README、版本锁定，数据不进版本库。

## 与科学模式（Claude Science-style）的关系

Biomni 模式与「科学模式」**并列**，是两种研究本体：
- **科学模式**：可证伪假设 → 实验 → 观察 → 分析 → 结论（research-manifest 状态机），偏方式学/论文，强调版本化工件与评审。
- **Biomni 模式**：通用任务 → 检索增强规划 → 计划清单 → 代码执行 → 反思（.biomni/ 状态），偏"宽任务快速上手与自批判执行"，不强制假设-实验框架。

两者可共用同一个项目根：Biomni 模式把中间结果（表/图/结论）落到项目目录（可用 `artifact_save` 归档、用 review 把关），科学模式负责系统化推进到论文。

## 边界与严谨

- 代码运行在沙箱中；访问新目录/网络/装包会触发审批，先说明你申请什么。
- **标记不确定性**：区分"分析结果"与"推测"；明确统计方法与多重检验校正；结论证据不足时降级为"待验证"并说明缺什么。
- 关键论断在写进论文/交付前应评审（scientific-reviewer / research_review）。
- 会话绑定在当前工作区，禁止跨工作区操作（详见科学模式 persona 的工作区隔离条款）。

## 示例节奏（一个会话）

```
biomni_retrieve "对该单细胞数据做注释并生成假说"
  → 得到聚焦子集（omics 工具 / cellxgene 数据 / scanpy 库 / 单细胞注释 know-how）
biomni_plan_init task="单细胞注释" steps=<来自 plan_hint>
  → 编号清单
# 读数据（bash 调 scanpy）→ biomni_plan_update addResult ...
# 聚类/标注 → biomni_plan_update ...
biomni_reflect observation=... reflection=... nextAction=...
  → 自批判链
biomni_plan_status → 展示完整 Research Plan and Status
# 完成：给出 solution，把关键图/表落到项目目录（可 artifact_save 归档）
```
