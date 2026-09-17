# Biomni 模式（Biomni Mode）

dsh-science 里与「科学模式」**并列**的第二种研究本体，复刻
[snap-stanford/Biomni](https://github.com/snap-stanford/Biomni) 与其
[Science 论文 (Huang et al., adz4351)](https://www.science.org/doi/10.1126/science.adz4351)
的通用生物医学 agent 设计哲学与架构，落地在 DeepSeek Harness 的 agent-preset + 引擎形态上。

> 一句话：**Biomni 模式 = 检索增强规划 + 代码优先执行 + 反思自批判**的通用 agent；
> 科学模式 = 可证伪假设 → 实验 → 结论（ReAct 状态机）的论文式 agent。二者共用 DSH 的
> 工具、沙箱、子代理与工作区隔离，但研究本体不同。

## 1. Biomni 的设计哲学（从源码 + 论文提炼）

Biomni 是"通用生物医学 AI agent"，核心三条：

1. **检索增强规划（Retrieval-Augmented Planning）**
   不把整个工具/数据/软件空间一股脑给模型。先用一个**检索层**（`ToolRetriever`）根据
   用户查询从资源宇宙里**挑出相关的子集**（工具/数据湖/软件库/Know-How），再让模型
   只在该子集上推理。解决两件事：① 上下文爆炸；② 工具选择不可靠。
2. **代码优先执行（Code-based Execution）**
   处理实质数据/长序列/统计时**写代码而不是调固定函数**（Python/R/Bash REPL，
   如 `run_python_repl` / `run_r_code` / `run_bash_script`），并自动捕获绘图。
3. **反思自批判（Reflection / Self-Criticism）**
   每轮工具执行后做一步"反思"：这个观察意味着什么？出错的原因与如何排除？据此修正
   下一步（actor-critic 的单 agent 落地）。`A1.configure(self_critic=True)` 还有独立
   的 self-critic 路由。

配套的**工程支撑**：
- **声明式元数据**：工具由 `tool_description/*.py` schema 描述（name/desc/参数），
  动态发现/校验/注入。
- **策展资源**：`data_lake_dict`（数据集+描述）、`library_content_dict`（软件+描述）、
  Know-How 库（协议/最佳实践，带许可元数据）。
- **运行时注入**：`add_tool()` / `add_data()` / `add_software()` / `add_mcp()`。
- **计划纪律**：`configure(plan=True)` 维持一份 "Research Plan and Status" 编号清单。
- **健壮性**：每个工具经 `multiprocessing` 包一层超时，防挂起。
- **环境可复现**：`biomni_env/` conda + R + CLI 工具安装脚本。

## 2. 映射（Biomni → dsh-science）

| Biomni 组件 | dsh-science 落地 | 说明 |
|---|---|---|
| `tool/tool_description/*` + `read_module2api()` | `engines/biomni-registry.mjs`（资源宇宙 `.biomni/registry.json`） | 工具（能力）的声明式目录，含内置播种目录 |
| `env_desc.data_lake_dict` | 同上 registry 的 `data_lake` 类目 | 策展数据集 + 描述 |
| `env_desc.library_content_dict` | 同上 registry 的 `libraries` 类目 | Python/R 软件库 + 描述 |
| Know-How loader | 同上 registry 的 `know_how` 类目 | 协议/最佳实践 + 许可元数据 |
| `A1.add_tool/add_data/add_software` | `biomni_registry_add / remove / show` | 运行时注入资源 |
| `model/retriever.ToolRetriever.prompt_based_retrieval` | `engines/biomni-retriever.mjs` → `biomni_retrieve` | 检索增强规划：领域启发式+关键词打分 + 主题检测 + 计划骨架（DH 里落入 agent 由 LLM 决定如何用，见下注） |
| `configure(plan=True)` | `engines/biomni-plan.mjs` → `biomni_plan_init/update/status` | Research Plan and Status 编号清单（`.biomni/plan.json`） |
| `configure(reflect=True)` / `self_critic` | `engines/biomni-reflect.mjs` → `biomni_reflect/list` | 反思/自批判（`.biomni/reflect.jsonl` 追加式） |
| code REPL（`run_python_repl`/`run_r_code`/`run_bash_script`）| 会话既有 `bash`（Run Python/R/Bash） | 代码优先执行；长任务用 `subagent` 拆分 | 
| `react.ReAct` / `a1.configure`（LangGraph） | DSH 原生 agent-loop + 会话工具 | ReAct 骨架由 harness 提供，Biomni 模式贡献 persona 与工作流 |
| `biomni_env/` | 项目 `envs/` + `conda-environments` 技能 | 环境可复现 |

> **关于检索层的实现注**：Biomni 原版用 LLM 做 prompt-based retrieval（列全量资源 → 让
> LLM 挑索引）。dsh-science 的 `biomni_retrieve` 落地为**确定性领域启发式 + 关键词重叠
> （含中文 bigram）打分**，规则对齐 Biomni prompt 里的启发式（数据库/文献工具永远优先、
> 湿实验序列类查询附基因组工具等），并返回检测到的任务主题与建议计划骨架。这正是
> "检索增强"而非"检索替代"——终端决策仍由 agent（上下文里的 LLM）给出。若需严格
> LLM 检索，可在 HOST 平面加一个用 `ctx.llm` 的增强引擎（见 `scientific-reviewer.mjs`
> 的宿主侧写法）。

## 3. 安装

```bash
# preset（Biomni 模式的完整体验：persona + biomni_* 工具）
bash scripts/sync-engines.sh        # 引擎镜像到 preset-biomni/engines
bash scripts/install-biomni.sh      # -> ~/.dsh/.agent-presets/biomni（遵循 $DSH_HOME）
# 技能
bash scripts/install-skills.sh      # 技能含 biomni-agent，装到 ~/.dsh/skills
```

然后 DSH Web 新建会话，选择 **Biomni 模式** preset（或把默认 preset 设为 biomni）。

Bundle 形态：`dsh plugin add dsh-science` 后，profile 的每个 agent 也会获得
`biomni_*` 工具（引擎在 `cordis.patch.yml` 以子路径导出挂载）；persona 仍走 preset。

## 4. 使用（一个会话）

```
biomni_retrieve "对该单细胞数据做注释并生成假说"
  → 聚焦子集（omics 工具 / cellxgene 数据 / scanpy 库 / 单细胞注释 know-how）+ 计划骨架
biomni_plan_init task="单细胞注释" steps=<来自 plan_hint>
  → 编号清单 [ ]
# 读数据（bash 调 scanpy）→ biomni_plan_update addResult "..."
# 聚类/标注 → biomni_plan_update ...
biomni_reflect observation=... reflection=... nextAction=...   # 每步自批判
biomni_plan_status → 展示 Research Plan and Status
# 完成后给出 solution，关键图/表落盘（可用 artifact_save 归档、research_review 把关）
```

## 5. 状态文件

全部在项目根 `.biomni/` 下（与 `.dsh/`、`research-manifest.json` 并存，不冲突）：
- `registry.json` — 资源宇宙（工具/数据湖/软件库/Know-How），首次播种内置目录。
- `plan.json` — 研究计划与状态（编号清单 + 结果与结论）。
- `reflect.jsonl` — 反思/自批判日志（追加式）。

## 6. 验证

```bash
node scripts/biomni-smoke-test.mjs   # 47 项：引擎元数据/工具注册/目录播种/注入/检索打分/计划状态机/反思日志/preset 静态校验
node scripts/smoke-test.mjs          # 科学模式回归（188 项，不受影响）
```

## 7. 与科学模式的关系

- **并列而非取代**：科学模式管"可证伪假设 → 实验 → 证据 → 论文"；Biomni 模式管
  "宽任务 → 检索 → 计划 → 代码执行 → 反思 → 方案"。两者可共用项目根。
- 用 `biomni_*` 快速产出的中间结果，可用 `artifact_save` 归档、`research_review` 把关，
  再由科学模式系统化推进到论文。
