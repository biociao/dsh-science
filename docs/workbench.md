# 科研工作台（Research Workbench）使用说明

> 一句话：**科研工作台**是科学模式的多项目管理层——当工作区里有多个科研项目子目录时，
> 它把它们聚合成一个可分类（分类/标签/优先级/生命周期状态/备注）、可追踪任务状态
> （循环阶段、假设/实验状态分布、工件数、待处理评审、远程作业、最近活跃）的「伞形」视图。
> 单项目的 ReAct 研究循环仍按项目各管各的；本工作台解决的是"项目一多就管不过来"的问题。

## 核心概念

- **工作台根（workbench root）**：一个"伞"目录，其下每个**直接子目录**如果含
  `research-manifest.json` 就是一个科研项目。默认取会话工作区根（从 cwd 向上找
  `.dsh`/`.git` 标记），也可以显式传 `root`。
- **注册表**：`<工作台根>/.dsh/workbench.json` 保存每个项目的分类元数据（跨会话持续），
  其余状态（阶段/假设/实验/工件/评审/作业）从各项目的清单与索引**实时读取**，不写回项目。
- **生命周期状态**（区别于 research-manifest 的 `project.status`）：`active / paused /
  finished / archived`，可在注册表显式设置；缺省由清单推导（`concluded` → `finished`）。
- **优先级**：`high / medium / low`；**分类**与**标签**自由命名，便于分组/筛选。

## 工具

| 工具 | 作用 |
|------|------|
| `research_workbench` | 总览：扫描发现所有项目 + 全局汇总（按分类/状态/优先级/标签 + 计数）。结构化 JSON。 |
| `research_project_list` | 筛选列表：按 `category / status / priority / tag / q` 过滤；`which=all` 连未分类的一并列出。 |
| `research_project_show` | 单项目详情：分类元数据 + 完整状态汇总。 |
| `research_project_register` | 显式登记一个项目目录（并可选填分类元数据）。 |
| `research_project_classify` | 更新分类元数据（patch：`category/tags/priority/status/notes/name`）。 |

所有工具返回结构化 JSON（`outputSchema`），可用作后续分析/写作的结构化输入。

## 典型用法

```text
# 1. 看总览（工作区里所有项目 + 汇总）
research_workbench  # root 默认 = 当前工作区根；也可传 root

# 2. 把项目归类（自动发现通常已收录；这里补充分类信息）
research_project_classify { path: "projA", category: "pathogen", tags: ["amr"], priority: "high", status: "active" }

# 3. 按分类/状态筛选
research_project_list { category: "genomics", which: "all" }
research_project_list { status: "running", priority: "high" }

# 4. 查看单个项目详情
research_project_show { path: "projA" }

# 5. 完成/停更后改生命周期状态
research_project_classify { path: "projA", status: "finished" }
```

## Web 面板

设置 > **科研工作台**（与「远程主机」同处一个设置页 bundle，需重启 web 进程生效）：

- 顶部设置**工作台根**（文件夹路径），点「加载」。
- 卡片汇总全局概况（项目数、假设/实验/工件、待处理评审、运行中作业）。
- 项目卡片按**分类**分组，每张卡显示状态徽标、阶段、假设/实验分布、工件数、待评审、
  运行中作业、最近活跃；点「分类」展开编辑（分类/标签/优先级/状态/备注）。
- 顶部筛选器按分类/状态/优先级过滤；「＋ 登记项目」手动登记一个目录。

宿主侧 REST API 在 `webServer` 路由 `/dsh-science/workbench/*`
（`engines/workbench-ui.mjs`），与 `research-workbench` 引擎（`engines/workbench.mjs`）
共用同一套注册表与状态汇总逻辑。

## 挂载位置

- `preset/agent.cordis.yml` → `science-research-workbench`（agent 工具，按 agent 隔离）。
- `cordis.patch.yml`（bundle）→ `science-research-workbench`（工具）+ `science-workbench-ui`
  （Web 面板宿主 REST API，仅 bundle 形态挂载，不进 preset）。

## 说明与边界

- 项目路径必须落在工作台根内（`ERR_PATH`），符合科学模式的**工作区隔离**规定。
- 注册表写操作带文件锁 + 原子写（复用 `engines/core.mjs`），并行 subagent 不丢更新。
- 生命周期状态/优先级有枚举校验（`ERR_VALIDATION`）；登记不存在的目录抛 `ERR_NOT_FOUND`。
- 只读扫描（读清单/工件/作业索引）不修改项目本身；分类元数据只写工作台自己的注册表。
