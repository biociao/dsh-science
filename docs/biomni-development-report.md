# 开发报告：Biomni 模式（复刻 snap-stanford/Biomni 的通用生物医学 agent harness）

- 项目：`dsh-science`（DeepSeek Harness 的 Claude Science 式科研工作台）
- 分支：`feat/sci-workbench`
- 需求：调研 Biomni 的设计哲学与架构，把它的 harness 模式复刻为 dcs-science 中与「科学模式」并列的一个「Biomni 模式」
- 结论状态：**已实现并通过全部测试**（新增 47 项 Biomni 校验 + 既有 332 项无回归）

---

## 1. 背景与目标

`dsh-science` 已有「科学模式」（`preset/`）：可证伪假设 → 实验 → 观察 → 分析 → 结论的 ReAct 状态机（`research_*`），偏"方式学 + 论文"。

本次需要再提供一种**与它并列**的研究本体：复刻
[snap-stanford/Biomni](https://github.com/snap-stanford/Biomni) 及其
[Science 论文 (Huang et al., 2025, adz4351)](https://www.science.org/doi/10.1126/science.adz4351)
的通用生物医学 agent 设计哲学与架构，落地成 DSH 的 agent-preset + 引擎形态。

**目标**：不是做任务专用流水线，而是复刻"通用 agent"的 harness 模式——检索增强规划 +
代码优先执行 + 反思自批判，并能被用户作为独立模式选择使用。

## 2. 调研：Biomni 的设计哲学与架构

### 2.1 设计哲学（从源码 + 论文提炼）

Biomni 的立身之本是 **"通用"**：一个 agent 横跨多个生物医分子领域，不做定制流程。
三条核心：

1. **检索增强规划（Retrieval-Augmented Planning）**
   数据源：(a) `tool/tool_description/*.py` + `read_module2api()`（工具声明式元数据）；
   (b) `env_desc.data_lake_dict`（策展数据集 + 描述）；(c) `env_desc.library_content_dict`
   （Python/R 软件库 + 描述）；(d) Know-How 库（协议/最佳实践，带许可元数据）。
   行为：`ToolRetriever.prompt_based_retrieval` 在 `react.go()`/`A1.go()` 里先按用户查询
   用 LLM **挑出相关子集**，再让推理只聚焦子集。这同时解决上下文爆炸与工具选择不可靠。

2. **代码优先执行（Code-based Execution）**
   `react.py`/`a1.py` 的 `execute` 节点把 `<execute>` 里的代码交给
   `run_python_repl` / `run_r_code` / `run_bash_script`（默认 600s 超时、多进程包装），
   自动捕获绘图。强调"遇到实质数据/长序列/统计就写代码，而不是调固定函数"。

3. **反思自批判（Reflection / Self-Criticism）**
   `configure(reflect=True)` 注入"每轮工具后反思"：观察意味着什么 → 出错原因/如何排除 →
   修正下一步；`A1.configure(self_critic=True)` 还有独立 self-critic 路由；`plan=True`
   维持 "Research Plan and Status" 编号清单（`[ ]`/`[✓]`/`[✗]`）。

工程支撑：声明式 schema、运行时注入（`add_tool/add_data/add_software/add_mcp`）、
每工具超时包装、可复现环境（`biomni_env/` conda + R + CLI 工具）。

### 2.2 关键实现读到的代码

| 文件 | 作用 |
|---|---|
| `biomni/agent/react.py` | LangGraph `StateGraph`（agent/tools 两节点 + `should_continue` 条件边）实现 ReAct；`_add_timeout_to_tools` 超时包装；`configure(plan/reflect/data_lake/library_access)` 修改 system prompt |
| `biomni/agent/a1.py` | A1 agent：`_generate_system_prompt`（含 `<think>/<execute>/<solution>` 标签约定）；`_prepare_resources_for_retrieval`；`go()` 入口；self-critic 路由 |
| `biomni/model/retriever.py` | `ToolRetriever.prompt_based_retrieval`：列全量资源→LLM 挑索引→返回子集 |
| `biomni/agent/function_generator.py` | `FunctionGenerator`：task → 独立 Python 脚本 |
| `biomni/env_desc.py` | `data_lake_dict` / `library_content_dict`（带描述的策展资源） |
| `biomni/config.py` | `default_config`（llm / path / timeout / use_tool_retriever / commercial_mode） |

## 3. 架构映射：Biomni → dcs-science

| Biomni 组件 | dcs-science 落地 | 说明 |
|---|---|---|
| `module2api` / `tool_description/*` / `data_lake_dict` / `library_content_dict` / Know-How | `engines/biomni-registry.mjs`（`.biomni/registry.json`，内置播种目录）| 资源宇宙，`biomni_resources_list` 查看 |
| `add_tool/add_data/add_software/add_mcp` | `biomni_registry_add / remove / show` | 运行时注入资源 |
| `ToolRetriever.prompt_based_retrieval` | `engines/biomni-retriever.mjs` → `biomni_retrieve` | 检索增强规划：领域启发式 + 关键词/中文 bigram 打分 + 主题检测 + 计划骨架 |
| `configure(plan=True)` | `engines/biomni-plan.mjs` → `biomni_plan_init/update/status` | Research Plan and Status（`.biomni/plan.json`）|
| `configure(reflect=True)` / `self_critic` | `engines/biomni-reflect.mjs` → `biomni_reflect/list` | 反思/自批判（`.biomni/reflect.jsonl`）|
| code REPL（`run_python_repl` 等） | 会话既有 `bash`（+ 长任务 `subagent`）| 代码优先执行 |
| LangGraph ReAct | DSH 原生 agent-loop + 会话工具 | 骨架由 harness 提供，Biomni 模式贡献 persona + 工作流 |
| `biomni_env/` | 项目 `envs/` + `conda-environments` 技能 | 环境可复现 |

**取舍**：Biomni 原版用 LLM 做 prompt-based 检索；dsh-science 落地为**确定性领域启发式 +
关键词（含中文 bigram）打分**，规则对齐 Biomni prompt 的启发式（数据库/文献工具永远优先、
湿实验序列类查询附基因组工具等）。保留"检索增强而非检索替代"——最终决策仍由 agent（LLM）
给出。要严格 LLM 检索可在 HOST 平面加一个用 `ctx.llm` 的引擎（参考 `scientific-reviewer.mjs`）。

## 4. 实现（文件清单）

### 新增

| 文件 | 说明 |
|---|---|
| `engines/biomni-registry.mjs` | 资源宇宙引擎（`name`/`inject:["tools"]`/`apply`）|
| `engines/biomni-retriever.mjs` | 检索增强规划引擎 |
| `engines/biomni-plan.mjs` | 研究计划与状态引擎 |
| `engines/biomni-reflect.mjs` | 反思/自批判引擎 |
| `preset-biomni/preset.yml` | preset 元数据（name=Biomni 模式）|
| `preset-biomni/agent.cordis.yml` | Biomni persona + 4 引擎 + 标准工具栈 |
| `preset-biomni/engines/*` | 引擎镜像（core + 4 个 biomni 引擎，保持 SHA-256 一致）|
| `skills/biomni-agent/SKILL.md` | 工作流技能（检索→计划→执行→反思→方案）|
| `scripts/biomni-smoke-test.mjs` | 47 项 Biomni 校验 |
| `scripts/install-biomni.sh` | 安装 preset 到 `~/.dsh/.agent-presets/biomni` |
| `docs/biomni-mode.md` | 设计哲学/映射/使用/验证文档 |
| `docs/biomni-development-report.md` | 本报告 |

### 修改

| 文件 | 改动 |
|---|---|
| `cordis.patch.yml` | 增加 4 个 biomni 引擎行（bundle 形态子路径导出）|
| `package.json` | 描述/关键词/exports(`./preset-biomni/*`)/files(`preset-biomni`)/test 脚本 |
| `scripts/sync-engines.sh` | 同步 engines → 同时镜像 preset/ 与 preset-biomni/ |
| `README.md` / `README.zh.md` | 新增 Biomni 模式特性、安装、仓库结构、验证 |

### 注册的工具（10 个）

`biomni_resources_list` / `biomni_registry_add` / `biomni_registry_remove` /
`biomni_registry_show` / `biomni_retrieve` / `biomni_plan_init` / `biomni_plan_update` /
`biomni_plan_status` / `biomni_reflect` / `biomni_reflect_list`。

### 状态文件（项目根 `.biomni/`）

`registry.json`（首次播种内置目录）、`plan.json`（计划清单 + 结果与结论）、
`reflect.jsonl`（追加式反思日志）。与 `.dsh/`、`research-manifest.json` 并存不冲突。

## 5. 工程决策与约束

- **零第三方依赖**：4 个引擎与 science 引擎一样只用 node 内置模块，共享 `engines/core.mjs`
  （`withFileLock`/原子写/`ERR_*`/流式哈希/`makeTool`）。
- **不发布 service**：引擎只 `ctx.tools.register(...)`，不发布服务，因此在 preset 里
  **可松散放置**（符合 DSH 的 realm 规则 —— 与 science preset 的引擎一致）。
- **相对路径挂载**：preset 挂载一律 `./engines/*.mjs`（preset 目录内解析）；bundle 用子路径
  导出 `dsh-science/engines/*.mjs`（从 profile 的 node_modules 解析），跨模块相对引用
  `./core.mjs`、`./biomni-registry.mjs` 在包内解析，两种形态都可用。
- **计划状态机**：`biomni_plan_init`/`update`/`status` 落盘 `plan.json`，步骤状态
  pending/in_progress/done/failed；结果只允许写"已确认观察"，防止臆测。
- **反思日志**：`reflect.jsonl` 追加式写（经文件锁串行），损坏行跳过，绝不静默覆盖。
- **中文支持**：检索打分把连续 CJK 段切成 bigram + 主题检测接入中文关键词，提高中文查询召回。

## 6. 验证结果

| 测试 | 结果 |
|---|---|
| `node scripts/biomni-smoke-test.mjs` | **47 通过 / 0 失败**（引擎元数据、10 工具齐全、目录播种、注入/移除/冲突码、检索打分与主题、计划状态机、反思日志、preset 静态校验）|
| `node scripts/smoke-test.mjs` | 188 通过 / 0 失败（科学模式无回归；`cordis.patch.yml` 子路径静态检查通过）|
| `node scripts/stability-test.mjs` | 25 通过 / 0 失败 |
| `node packages/dsh-model-tier/test/model-tier.test.mjs` | 87 通过 / 0 失败 |
| `node test/scientific-reviewer.test.mjs` | 32 通过 / 0 失败 |
| 引擎独立 import | 4 个引擎在 `engines/` 与 `preset-biomni/engines/` 均正常（name/apply 存在）|
| `install-biomni.sh`（临时 `DSH_HOME`）| 复制安装成功，preset 目录完整，镜像 SHA-256 一致 |
| YAML | `preset-biomni/agent.cordis.yml` 的 `!!js` 方言与已知良好的 science preset 一致（DSH 自定义 tag，非错误）|

**合计**：新增 47 项 + 既有 332 项，全部通过，无回归。

## 7. 使用方式

```bash
bash scripts/sync-engines.sh        # 引擎镜像到 preset-biomni/engines
bash scripts/install-biomni.sh      # -> ~/.dsh/.agent-presets/biomni（遵循 $DSH_HOME）
bash scripts/install-skills.sh      # 技能含 biomni-agent，装到 ~/.dsh/skills
```

DSH Web 新建会话选 **Biomni 模式**；或 `dsh plugin add dsh-science` 让 profile 每个 agent 获得
`biomni_*` 工具（persona 走 preset）。

一个会话的示例节奏：

```
biomni_retrieve "对该单细胞数据做注释并生成假说"
  → 聚焦子集 + 计划骨架
biomni_plan_init task=... steps=<来自 plan_hint>
biomni_plan_update ... addResult "..."      # 每步更新清单
biomni_reflect observation=... reflection=... nextAction=...
biomni_plan_status
```

## 8. 本地实装测试结果（2026-09）

> 说明：本机 headless 会话**不暴露 preset 内挂载的本地引擎工具**——用同样方式起
> 「科学模式」会话也看不到 `research_*` 工具（只有 bash/fs/subagent/workflow 等通用工具）。
> 这是 headless 的宿主行为，不是 Biomni preset 的缺陷。要在真机看到 preset 引擎工具，须在
> **Web 会话**（GUI 选择预设）里验证。

实测（本机 DSH，`DSH_HOME=~/.dsh`，版本 `0.1.1-rc.1`）：

| 验证项 | 结果 |
|---|---|
| `bash scripts/install-biomni.sh` | ✅ 复制安装到 `~/.dsh/.agent-presets/biomni`（agent.cordis.yml + engines/core + 4 个引擎，镜像 SHA-256 一致）|
| 预设名录识别 | ✅ `discoverPresets`（user 根 + shipped 根）列出 `user biomni` / `user science`，`broken=-no-`（组合文件在加载器方言里可解析、含命名行）|
| headless 会话启动（`dsh --profile headless`，默认 preset 临时切到 biomni）| ✅ preset 能**组装并运行**——模型成功返回。首次响应有 LLM 首 token 延迟（30–80s，provider 波动），100s 内正常返回 |
| 引擎工具在 headless 出现 | ⚠️ 未出现（`biomni_*` / `research_*` 都未暴露——headless 不加载 preset 本地引擎，见上方说明）|
| 引擎独立 load + 工具注册 | ✅ `node scripts/biomni-smoke-test.mjs`（47/47）|
| 设置还原 | ✅ `~/.dsh/settings.yaml` 的 `agent-presets.default` 测试后恢复为 `standard`（未改动用户默认预设）|

**结论**：Biomni 预设**可安装、可被 DSH 识别、可在会话中组装运行**，引擎逻辑与工具注册经
独立 smoke 验证。唯一未能在自动化下确证的是"Web GUI 会话中引擎工具是否出现"——该步需在
GUI 选择「Biomni 模式」预设后人工/端到端确认（与已发布的「科学模式」同一套机制，结构等价，
故预期可用）。

## 9. 实测发现的 Bug 与修复（关键）

用户在 **Web 会话**（GUI 选「Biomni 模式」）调用工具时报告：
`Invalid schema for function 'biomni_plan_init': schema must be a JSON Schema of 'type: "object"', got 'type: null'.`

**根因**：dsh-science 的引擎用自定义 `engines/core.mjs#makeTool` 注册工具，`parameters` 直接返回
**扁平参数表**（`{paramName: {type,description,...}}`）。而 DSH 原生 `defineTool` 会先把扁平表编译成
**object-rooted JSON Schema**（`{type:"object", properties, required}`，见 dsh-tools 的
`parameterSchemaSpecToJsonSchema`）再注册。注册后扁平表被原样当函数 schema 传给 LLM provider，
provider 要求顶层 `type:"object"`，于是报 `got type: null`。native 工具（走 defineTool）不受影响；
**所有 dsh-science 引擎工具**（research_*/artifact_*/remote_*/workbench/biomni_*）都命中此问题。

**修复**（`engines/core.mjs`）：
- 新增 `compileParams(spec)`：把扁平参数表编译成 `{type:"object", properties, required}`，
  并递归处理 `items`/`properties`/`oneOf`、收集 `required`、保留 `description`/`enum`；对已是
  object-rooted 的 schema 直接透传。行为对齐 dsh 的 `parameterSchemaSpecToJsonSchema`。
- `makeTool` 改为用 `compileParams(parameters)`。
- 顺带修复：DSH 编译器/LLM 要求 `type:"object"` 参数显式声明 `additionalProperties`；
  给 `biomni_registry_add.item` 加上 `additionalProperties: true`。

**回归护栏**：`scripts/smoke-test.mjs` 与 `scripts/biomni-smoke-test.mjs` 各加一条断言——
所有注册工具的 `parameters` 必须 `type:"object"` 且有 `properties`；防范此问题再现。

**验证**：修复后所有工具 46/46 均 object-rooted；`smoke-test 189`、`biomni-smoke 48`、
stability 25、model-tier 87、reviewer 32 全绿；已把修复后的 preset 重新装回
`~/.dsh/.agent-presets/biomni`（安装副本注册 10/10 工具均 object-rooted）。

## 10. 局限与后续

- **检索层为确定性启发式**（非 LLM 检索）。后续可用 `ctx.llm` 在 HOST 平面加一个"LLM
  prompt-based retrieval"增强；也可接入 embedding/向量检索（如 `model/retriever.py` 另一分支）。
- **引擎工具的真机显示待 GUI 确认**：确证需在 Web GUI 选择「Biomni 模式」预设（headless
  不加载 preset 本地引擎，无法据此判定）。建议正式使用前在 GUI 里开一个 Biomni 会话，
  确认右侧工具列表出现 `biomni_*`。
- **工具注册时序**：4 个引擎挂进 profile bundle 后，profile 上任意 agent（含纯编码 agent）
  都会看到 `biomni_*` 工具（与 `research_*`/`artifact_*`/`remote_*` 一致）；若只想在
  Biomni 模式暴露，可把引擎从 `cordis.patch.yml` 移除、仅保留在 preset 中。
- **headless 不暴露预设引擎**：若要自动化回归，可避开 headless，改为在引擎层直接
  `apply({tools})` 断言工具注册（`biomni-smoke-test.mjs` 已覆盖），或接真实的 Web 会话。
- **默认播种目录为示例**：registry 的 `data_lake` 中 `path` 含 `/public/...` 占位路径，
  实际使用需按 DCS/数据湖实际路径修正。
