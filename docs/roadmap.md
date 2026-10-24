# 技术路线图（Tech Roadmap）使用说明

> 一句话：**技术路线图**把 issue board 升级成一个科技项目路线图模块 —— 每个
> **步骤 / issue / step / milestone** 是画布上的一个**节点**，节点之间用**带类型的关系边**
> 表达上下游逻辑（串联 / 并联 / 反馈 / 循环）；每个节点**独立版本管理**，便于项目迭代时
> 理清不同**分析策略、超参、测试**的上下游关系。

## 核心概念

- **节点（node）**：路线图上的一个工作单元。字段：
  - `kind`：`step`（步骤）/ `issue` / `milestone`（里程碑）
  - `status`：`planned / running / blocked / done / dropped`
  - `track`：泳道 / 阶段（画布上按泳道画底纹；自动布局时按泳道做区间装箱，深度区间不重叠的泳道共享一行）
  - `color`：`#rrggbb` 或调色板名（如 `blue`、`amber-6`）；留空则按状态取色
  - `shape`：`box / round / pill / diamond / hexagon / circle / note`
  - `strategy`：分析策略说明；`params`：**超参**（自由 JSON）；`tests`：**测试**清单
  - `refs`：关联科学对象，如 `{ experiment: "E01", artifact: "tab@2", hypothesis: "H1" }`
  - `inputs / outputs`：输入/输出产物（字符串数组，如 `raw_reads.fastq`、`clean_reads.fastq`）
  - `tool`：软件/工具（如 `Phrap`、`GLIMMER 3 + tRNAscan-SE`）
  - `command`：命令或程序调用（可含占位符，便于复现）
  - `progress`：**执行进度** —— `{done, total, unit}`（完成样本数/总数，自动折算百分比）或
    `{percent}`（直接给百分比）；画布上按百分比**填充节点图形块**（裁剪进形状内部），
    未记录进度的节点不填充（不会把"没数据"误读成 0%）。`progress` 是**语义字段**，
    每次更新都会追加一个版本（谁在什么时候把进度从 30/120 推到 90/120 可回溯）。
  - `pos / size`：画布坐标与尺寸（**布局字段，不进版本**）
  - IO 传递：节点 A 的 `outputs` 与下游 B 的 `inputs` 同名时，A→B 的边自动携带该产物；
    画布节点显示 `⚙ 工具` 徽标，边无自定义标签时直接显示传递产物名，「数据流」页汇总
    产物传递（含无消费者/无生产者提示）与工具清单。
- **关系边（edge）**：四种语义，对应你要表达的上下游逻辑：

  | 类型 | 含义 | 画布/渲染表现 |
  |------|------|----------------|
  | `serial` **串联** | A 完成后 B 才开始（严格顺序） | 实线 + 箭头，Mermaid `-->` |
  | `parallel` **并联** | A 与 B 可并行推进，无先后约束 | 细线**无箭头** + `∥`，Mermaid `---` |
  | `feedback` **反馈** | 下游结果回灌上游（形成回路） | 虚线**反向箭头**，Mermaid `-.->` |
  | `loop` **循环** | 回到更早节点形成迭代环（调参→重跑→再评估） | 虚线环，Mermaid `-.->` |

  自环（`from == to`）只允许 `feedback` / `loop`（自反馈）；重复的同类关系会被拒。
- **版本管理（每个节点独立）**：只有**语义字段**进版本；`pos/size`（画布布局）与 `viewport`
  不进版本 —— **拖节点不会污染历史**。规则：
  - 新建节点 = `v1`；
  - 每次 `roadmap_node_update` 改语义字段 = 追加一个新版本（记录 `changed` 字段、作者、备注）；
  - `roadmap_node_revert` **不是**删除历史，而是"追加一个内容等于旧版本快照的新版本"
    （append-only，可再回滚回来）；
  - 全局 `history` 记录每次操作（谁在什么时候改了哪个节点），`rev` 单调递增。
- **数据文件**：`<项目根>/.dsh/roadmap.json`。AI（`roadmap_*` 工具）与 Web 画布写的是
  **同一个文件**，两边实时互相可见。

## 工具

| 工具 | 作用 |
|------|------|
| `roadmap_init` | 初始化路线图（已存在时幂等；`reset: true` 清空重建，历史保留）。 |
| `roadmap_show` | 读全图（节点 + 关系 + 坐标）+ 图分析（环、关键路径、根/叶、深度、上下游邻居）；传 `node` 附该节点上下游闭包与版本概览。 |
| `roadmap_node_add` | 新增节点（颜色/形状/泳道/策略/超参/测试/关联/坐标，新节点自动 `v1`）。 |
| `roadmap_node_update` | 更新节点（patch，含 `progress` 进度；`null` 清除）；`action: "remove"` 删除节点及其关系。 |
| `roadmap_node_history` | 节点版本历史；传 `from`/`to` 给出两版之间的字段级差异。 |
| `roadmap_node_revert` | 回滚到历史版本（追加式，历史不删）。 |
| `roadmap_link` | 维护关系边：`action: add/update/remove`，`type: serial/parallel/feedback/loop`。 |
| `roadmap_apply` | **AI 辅助生成 / 批量导入**：一次原子事务里按 spec 批量建节点 + 连边。 |
| `roadmap_layout` | 画布布局：`auto`（列=上下游深度，行=泳道）/ `manual`（写入拖拽坐标）+ 视口。 |
| `roadmap_render` | 渲染为 `mermaid` 或 `dot` 文本（可直接贴进 README / 论文方法学附图）。 |

所有工具返回结构化 JSON（`outputSchema`），可作后续分析/写作的结构化输入。

## AI 辅助生成

三条通路，按"是否需要模型"区分：

1. **会话内生成（推荐）**：让 agent 直接调 `roadmap_apply`，用 `ref` 做本地别名：
   ```json
   {
     "doc": { "title": "AMR 分析路线图" },
     "nodes": [
       { "ref": "qc",  "title": "数据质控", "kind": "step", "track": "数据", "params": { "q20": 0.9 } },
       { "ref": "asm", "title": "组装",     "kind": "step", "track": "组装", "strategy": "flye + prokka" },
       { "ref": "amr", "title": "耐药分型", "kind": "milestone", "track": "分析" }
     ],
     "edges": [
       { "from": "qc",  "to": "asm", "type": "serial", "label": "clean reads" },
       { "from": "asm", "to": "amr", "type": "serial" },
       { "from": "amr", "to": "qc",  "type": "feedback", "label": "分型异常回到质控" }
     ]
   }
   ```
   `mode: "merge"`（默认）按 `id` / `ref` / **同名 title** 认领已有节点 → 重复生成是**幂等**的
   （只更新、不重复建节点/边），适合"再扩一版"。`mode: "replace"` 先清空再重建（历史保留）。

2. **画布上的「AI 生成」按钮**：宿主侧直接发起一次 LLM 调用（`roadmap-ui` 的 `ai.model`
   显式指定；缺省回落全局默认模型），要求模型只输出上面的 JSON 规格，解析后
   **原子落盘**（`author: ai`）。等价于 scientific-reviewer 的"引擎侧独立调用"模式。

3. **「复制提示词给会话」**：不依赖任何模型配置 —— 把"目标 + 当前路线图 + 关系语义 + JSON
   结构"渲染成一段提示词，粘贴回 DSH 会话，由会话里的 agent 调 `roadmap_apply` 落盘。

## Web 画布

会话顶部的 **技术路线图** 视图（`conversation.view` 槽，与「会话」「轨迹」并列，排在「轨迹」之后；
改客户端 bundle 后需重启 web 进程生效）：

- **进度可视化（完成进度图）**：工具栏显示**总进度**条（全部"已知进度"节点的平均值 + 样本合计），
  侧栏默认打开「进度」页：总体完成度大号百分比、按**泳道 / 类型**分组进度条、以及**逐步进度**
  （点行直接定位到该节点）。画布上每个节点按自己的进度**从左向右填充**图形块（菱形/圆形等
  形状用 clipPath 裁剪，填充始终贴合形状），右下角角标显示 `v版本 · 进度%`。
  进度来源优先级：显式 `percent` > `done/total` 折算 > 状态推导（`done`=100%、`dropped`=0%）。
- **跟随项目**：项目根 = 当前会话所属 Workspace 的目录（`useWorkspaces` → `sessionIds`），
  同一项目下的所有会话共用 `<项目根>/.dsh/roadmap.json`；输入框只读并显示「跟随项目」。
  会话还没有归属项目时（例如空白草稿）回落到手动根目录（上次使用 → 插件配置 `roadmapRoot`）。
- **没有路线图就不显示这个标签页**：`conversation.view` 的 tab 列表由 `slots.entries()` **全局**生成
  （shell 没有"按会话过滤"的钩子），因此本模块只在**当前项目存在 `.dsh/roadmap.json`** 时才把入口
  注册进去，否则 `dispose` 掉 —— 标签页因此不出现。判定依据：当前会话所属 Workspace 的 `path`
  （`workspaces.list` + `uiWorkspace.mainReference.sessionId`）→ 调 `/dsh-science/roadmap/show`
  看 `initialized`。隐藏期间每 5s 轻量复查（本地 HTTP），所以 **AI 在会话里 `roadmap_init` 之后，
  标签页最多 5s 内自动出现**，不需要刷新页面。宿主没有 `workspaces` 服务时 fail-open（照常显示，
  避免把功能误藏起来）；欢迎页/未选会话时不显示。
- **画布交互**：拖空白处平移、滚轮**以光标为锚点**缩放（HUD 显示百分比、`⤢` 适应窗口）；
  拖节点改位置；右下角手柄改节点尺寸。画布高度随窗口自适应（`clamp(520px, 68vh, 920px)`），
  首次载入与「自动布局」后**自动适应窗口**，打开即可看到整张图；「收起侧栏」可让画布占满宽度，
  整图更容易一屏看全。
- **多选与整体拖动**：`Shift` / `⌘` / `Ctrl` + 点击加选或减选；在空白处 **`Shift`+拖动**框选
  （点工具栏「框选」可免按 Shift），或用「全选」按钮；选中后**拖动任一选中节点即可整体移动**，
  松手一次性落盘全部坐标。
- **自动布局样式（可切换）**：工具栏「布局」下拉，**选中即用客户端算法重排并落盘**（再把样式记到文档/本地，
  刷新或重开面板后仍沿用）；也可选好样式后点「自动布局」按钮重新应用：
  - `紧凑蛇形`（默认）：列=上下游深度 + 泳道区间装箱；深度过长时**自动换行（蛇形）**，奇数带
    反向，带尾到下一带开头的边上下相邻 —— 长链不会摊成一条 4000px 宽的扁平横带，而是接近一屏；
  - `横向泳道`：每条泳道单独一行、按深度从左到右，**层级最清晰**但图会很长（需要横向滚动/缩小）；
  - `纵向阶段`：阶段**自上而下**、泳道并排成列，适合窄高面板或按阶段通读。
  同一样式是确定性的：重复应用坐标不变。坐标由客户端计算（与宿主引擎同一套几何，测试逐样式比对），
  因此**即使宿主进程还没重启加载新引擎，切换样式也能立即生效**。
- **自定义颜色/形状**：属性面板里点色板或取色器（即时生效）、下拉选形状（矩形/圆角/胶囊/
  菱形/六边形/圆形/注释）——两者都即时落盘并各自产生一个版本。
- **连线**：先选中起点节点 → 在工具栏选关系类型（串联/并联/反馈/循环）→ 点「从选中节点连线」
  → 点目标节点。点已有连线可改类型/标签或删除。
- **版本**：属性面板改标题/状态/泳道/策略/超参/测试/标签/关联 → 「保存（新版本）」；
  「版本历史」列出每版的作者、备注、变更字段，可一键「回滚到此版」。
- **AI 生成**：填研究目标 → 「AI 生成」（宿主侧模型）或「复制提示词给会话」；
  也可直接把 JSON 规格粘进「导入规格」。
- **数据流**：侧栏「数据流」页按产物列出「上游 outputs → 下游 inputs」的传递关系、工具/软件清单
  （含 command）、产物生产者/消费者，以及无消费者/无生产者的孤儿产物提示。
- **导出**：「复制 Mermaid」把路线图渲染成 `flowchart` 文本贴进 README/论文；节点标签带
  `⚙ 工具`，边标签在无自定义文字时显示传递产物。
- 底部状态条显示节点/关系计数、四类关系分布、**关键路径**与检测到的**回路**。

宿主侧 REST API 在 `webServer` 路由 `/dsh-science/roadmap/*`（`engines/roadmap-ui.mjs`），
与 `science-roadmap` 引擎（`engines/roadmap.mjs`）共用同一套读写路径（同一个文件锁 + 原子写）。
路由的来源校验由 `engines/http-guard.mjs` 统一实现：浏览器要求 Origin 与 Host 同 authority；
DSH 桌面端（Electron）页面 origin 是 `dsh-app://app`，主进程转发到本机 Host 时会删除
`origin`/`sec-fetch-site`，因此「无 Origin + 回环 Host」必须放行 —— 这也是此前桌面端所有
面板报「非浏览器同源请求被拒绝」的根因（浏览器直连 `http://127.0.0.1:<port>` 不受影响）。

## 挂载位置

- `preset/agent.cordis.yml` → `science-roadmap`（agent 工具，按 agent 隔离）。
- `cordis.patch.yml`（bundle）→ `science-roadmap`（工具）+ `science-roadmap-ui`
  （画布宿主 REST API，仅 bundle 形态挂载，不进 preset）。
- 客户端：`client/remote-hosts-ui/src/roadmap.js` 注册 `conversation.view` 槽
  （id `roadmap`，order 20，排在「轨迹」之后），与「远程主机」「科研工作台」设置页
  共用同一个 client bundle（`dsh-science` 只允许一个 `dsh.client` 入口，见
  `scripts/build-client-bundle.mjs`）。

## 说明与边界

- **append-only**：节点版本与全局 history 只追加、不删除；回滚也是追加。这与
  `artifact-registry` 的"废弃 ≠ 删除"一致 —— 项目迭代的历史可完整回溯。
- **布局不进版本**：拖拽/缩放/连线（布局类）不产生节点版本，避免画布操作把语义历史淹掉。
- 写路径统一经文件锁 + 原子写（复用 `engines/core.mjs`），并行 subagent 与画布同时写不丢更新。
- 图分析：Tarjan 求强连通分量做**环检测**（反馈/循环回路、自环），凝聚图 DP 求**关键路径**；
  自动布局的"列"只由串联/并联决定（反馈/循环是回边，不会把列无限拉长）；列数超过换行阈值后
  按带折行（蛇形），带内泳道按深度区间装箱，避免泳道把画布撑高。缩放较小时自动隐藏边标签与
  节点副标题，避免 20+ 条标签糊满画布。
- 校验失败抛 `ERR_VALIDATION`（非法枚举/颜色/形状/重复边/自环约束），缺节点抛
  `ERR_NOT_FOUND`，未初始化抛 `ERR_NOT_INIT`。
- `roadmap_apply` 的 `replace` 会清空重建（历史仍在 `history`），慎用。
- AI 生成受 `ai.maxNodes`（默认 40）与 `ai.timeoutMs`（默认 180s）约束；模型输出解析失败
  时不会落盘，会提示改用"复制提示词"通路。
