---
name: bioinformatics-habits
description: 通用生信/组学分析习惯（跨领域）：INTAKE→ROUTE→GATE→RUN→EVIDENCE 五段工作法 + 12 条可核验习惯，适配基因组、转录组、单细胞、表观、微生物组、蛋白组、代谢组、空间组学、多组学与统计遗传等场景。开始任何组学分析、评审分析流程、或需要把"能跑"变成"可复现可交接"时使用。
whenToUse: 拿到测序/质谱/组学数据准备开跑；评审自己或他人的分析流程；需要在不同细分领域复用同一套闸门、留痕与 QC 判据时。
---

# 生信分析习惯（Bioinformatics Habits）

与领域无关的工作习惯。它不提供命令大全，只约束**怎么做决定、什么时候停、留下什么证据**。领域差异只落在三张表：**输入形态、资源形态、QC 判据**（见「域适配矩阵」）。

具体 NGS 实例见 `ngs-analysis-workbench` 技能；策略源自 OpenAI Codex 的 NGS Analysis Workbench（MIT）。

## 五段工作法

每个分析都走同一流程；**每段都有退出条件，不满足不进入下一段**。

| 阶段 | 做什么 | 退出条件 |
| --- | --- | --- |
| 1 INTAKE | 扫输入 → 写 intake → 列缺项 | input_type / assay / objective 确定；其余缺失显式列出 |
| 2 ROUTE | 查表选唯一路径 + fallback | 写清首选、备选、不选理由 |
| 3 GATE | 工具闸门 + 资源闸门 | 三态明确：ready / installable（待批准）/ blocked |
| 4 RUN | plan → validate → dry-run → execute | 每步可停；默认只到 dry-run |
| 5 EVIDENCE | envelope + QC 判据 + caveat → 归档 | 6 件证据齐；结论强度与证据匹配 |

## 12 条习惯

### 准备阶段

**H1 先看再问。** 先扫文件系统（扩展名、magic、`RunInfo.xml`、sample sheet、matrix 目录、raw 谱图、metadata），文件能回答的字段绝不问人。
- 判据：intake 里每个字段都能写出来源（file / user / default）。
- 反例：一上来发问卷问"物种？单双端？什么平台？"

**H2 最小充分提问。** 只问 blocking 字段，给默认值与影响说明；一次问完，不来回拉扯。
- 判据：`missing_essentials` 非空时，每项都说明为什么 blocking。
- 反例：把 20 个"可选"参数也问一遍。

**H3 查件优于装件。** 顺序固定：`command -v` → Python import → conda/mamba/pip →（用户同意后）包索引/registry。缺件先出 install plan，绝不自动安装。
- 判据：install plan 落盘且默认 review-only。
- 反例：直接 `conda install -y` 一堆包，或改系统 Python。

### 执行阶段

**H4 资源先对账。** 参考基因组/转录本/谱图库/分类库/panel/whitelist 都要 bundle 化：期望文件、根目录、体积、许可、版本。
- 判据：`advisory` 与 `required` 模式分开；缺 required 就 block，不硬跑。
- 反例：默认"基因组就在某处"，跑完才发现 build 不对。

**H5 计划先行。** plan / validate / dry-run / execute 四步分离，默认停在 dry-run；命令先落 `code/` 或 `scripts/` 供 review。
- 判据：`ready_to_execute` 有客观判据，不是"模型觉得行"。
- 反例：一条命令直接跑到底，失败了再猜。

**H6 单一执行者。** 一个分析只有一个路由落点；分诊（dispatcher）不执行，执行者不做二次分诊。
- 判据：能指出"这条流程由哪个脚本/环节负责"。
- 反例：模型现场拼 15 条命令，每条来自不同教程。

**H7 原始数据只读。** raw 数据入库（大小 + sha256），工作副本单独目录；任何写回都要显式要求。
- 判据：manifest 里 raw 的 checksum 前后一致。
- 反例：直接在 `data/raw/` 里 sort / rename / 覆盖。

**H8 版本固定。** 工具版本、参考版本、数据库版本、conda env/lock 全部进 `envs/` 与 manifest 的 `versions/`。
- 判据：只看 manifest 能重建同一环境。
- 反例：记录"bwa 最新版"。

### 收尾阶段

**H9 证据信封。** 每次运行固定 6 件：`run_manifest.json`、`versions/`、`artifact_index.json`（逐文件 SHA256）、`manifest/lineage.tsv`（输入→输出）、`qc_verdict.json`、`summary.md`；另加 `parameter_sha256` 与环境快照。
- 判据：任一图/表都能追溯到一次运行。
- 反例："跑通了"截图 + 一堆散落文件。

**H10 QC 要有判据。** 每个 QC 指标写成结构化记录：name / value / threshold / verdict / source；只有图没有阈值 = 没有 QC。
- 判据：verdict 能自动汇总成 pass/warn/fail。
- 反例：贴一张 FastQC 图，不写结论。

**H11 诚实边界。** 成熟度分三档（能执行 / 只能规划 / 只做就绪检查）；许可、云上传、人类隐私、临床用途必须先说；blocker 显式化，不静默降级。
- 判据：summary 里能看到"哪些没做、为什么"。
- 反例：把 dispatch 说成 execution；把 tumor-only 说成 confirmed somatic。

**H12 可交接。** 一页 summary + 复现命令 + 已知坑；换人/换机能在不问你一句的情况下重跑。
- 判据：新人照 summary 能复现首图。
- 反例：只有 agent 自己知道的上下文。

## 域适配矩阵

同一套习惯，只换三张表。下表是"换什么"的索引；每个域的具体 intake 字段、资源 bundle、pipeline 与 QC 阈值见对应 **domain pack**（下一节），不替代领域知识。

| 域 | 典型输入 | 资源/参考形态 | 必看 QC | 高频坑 |
| --- | --- | --- | --- | --- |
| 基因组变异 | FASTQ / BAM / CRAM / VCF | 参考 FASTA + known-sites + PON + target BED | 覆盖度、Ti/Tv、污染、可检出区域 | 参考 build 不一致；PON 跨 capture kit 复用 |
| 转录组 bulk | FASTQ / count matrix | 转录本 FASTA + GTF + 注释版本 | 比对率、strandedness、3' bias、设计矩阵/批次 | 只报 p 值；对比与设计矩阵写错 |
| 单细胞 / 空间转录组 | FASTQ / matrix / h5ad / 坐标+图像 | 参考 + whitelist + probe set + 组织图像 | 双细胞率、ambient RNA、饱和度、mito%、配准 | 不校正空滴/环境 RNA；图像未配准就分析 |
| 表观组 | FASTQ / BAM / bedMeth | index + blacklist + TSS + 转化率对照 | FRiP、TSS enrichment、insert size、转化率 | 无 input/control；blacklist 未过滤 |
| 微生物组 | FASTQ | 引物/taxonomy、分类库、宿主参考 | 深度、rarefaction、宿主污染、阴性对照 | 组成数据当绝对丰度；无阴性对照 |
| 蛋白组 | raw / mzML | 蛋白 FASTA + 酶切规则 + 谱图库 | FDR（PSM/peptide/protein 分开）、质量精度、missed cleavage、PTM 定位 | PSM FDR 当 protein FDR；谱图库与仪器不匹配 |
| 代谢组 | raw / mzML / NMR | 谱图库、加合物/离子模式、内标 | 质量误差、RT 漂移、pooled QC RSD、blank 扣除、注释置信度（MSI 级） | 无 blank/pooled QC；注释等级不标 |
| 多组学整合 | 上游 envelope / 矩阵 | 无（消费已就绪产物） | 样本对齐率、缺失模式、批次效应 | 样本 ID 未对齐就整合 |
| 统计遗传 | 基因型 / VCF / summary stats | reference panel、LD score、ancestry 参考 | HWE、MAF、PCA 祖先、lambda GC | 人群分层未校正；隐私/受控访问边界 |

## Domain packs（按需加载）

`packs/` 下每个域一个 pack，只实现 5 个 hook；**core 不感知具体域**。机读索引：`packs/index.json`。

| pack | 域 | 成熟度 | 路径 |
| --- | --- | --- | --- |
| genomics | 基因组变异（种系/体细胞/CNV/SV/注释） | 本地可执行 | `packs/genomics/` |
| transcriptomics | 转录组（bulk 定量/DE/剪接/融合） | 本地可执行 | `packs/transcriptomics/` |
| single-cell | 单细胞与单核（count/QC/注释/整合） | 本地可执行 | `packs/single-cell/` |
| epigenomics | 表观组（ATAC/ChIP/CUT&RUN/甲基化） | 本地可执行 | `packs/epigenomics/` |
| microbiome | 微生物组（扩增子/宏基因组） | 本地可执行 | `packs/microbiome/` |
| proteomics | 蛋白组（DDA/DIA/PTM） | 规划级 | `packs/proteomics/` |
| metabolomics | 代谢组（LC-MS/GC-MS/NMR） | 规划级 | `packs/metabolomics/` |
| spatial | 空间组学（Visium/Xenium/CosMx） | 规划级 | `packs/spatial/` |
| multi-omics | 多组学整合（消费上游 evidence） | 规划级 | `packs/multi-omics/` |
| statistical-genetics | 统计遗传（GWAS/PRS/QTL/MR） | 规划级 | `packs/statistical-genetics/` |

**加载规则**

- 先走 core 五段法；确定域后再读 `packs/<key>/SKILL.md`，机读字段读同目录 `registry.json`。
- 每次只加载 1 个（最多 2 个）pack；跨域时主域 pack + `multi-omics`。
- pack 之间冲突时，以更严格的 QC / 合规要求为准。
- NGS 域的 5 个 pack（genomics / transcriptomics / single-cell / epigenomics / microbiome）与 `ngs-analysis-workbench` 技能一一对应；后者提供更细的 runner 与 envelope 示例。

### Pack 接口（5 个 hook）

```yaml
intake_fields:   # 在 core 三件套之外追加的必填字段：name / values / blocking / why
resources:       # bundle → {kind, root_env, expected_files, required_for, notes}
pipelines:       # pipeline → {route_when, preferred_workflow, tools, local_runner, essential_questions, local_outputs}
qc_metrics:      # [{name, rule, source, blocking}]
compliance:      # [许可 / 隐私 / 临床 / 云上传边界]
```

新增 pack 的最小要求：`SKILL.md` + `registry.json`，并在 `packs/index.json` 登记；`node scripts/validate-skill-packs.mjs` 必须通过。

## 统一 evidence 包（域无关）

```text
<run_dir>/
├── run_manifest.json     # run_id/lane/status/inputs/outputs/method/audit
├── config.json
├── validation/           # 输入与工具校验
├── logs/                 # 命令、耗时、returncode、stderr
├── versions/             # 实际版本（工具/参考/数据库）
├── manifest/lineage.tsv  # 输入→输出 + exists/bytes/sha256
├── artifact_index.json   # 逐文件 SHA256 + mtime
├── qc_verdict.json       # [{name,value,threshold,verdict,source}]
├── resources/            # 资源闸门产物（plan/manifest/env/readiness）
├── visualizations/       # index.html + manifest
└── summary.md            # 一页交接：做了什么/没做什么/怎么复现
```

## 何时升级 / 停下来

- 要具体工具参数 → 查官方文档或 `--help`，**不凭记忆写参数**。
- 人类受控/临床数据 → 先确认合规与去标识边界，再谈分析。
- 跨多个域（≥3）→ 拆并行子任务，各自走五段法。
- 需要多轮迭代的项目 → 接 `research-loop` + `roadmap`，把假设与步骤版本化。
- 需要复用同一流程 → 抽成 domain pack（registry + runner），而不是复制 prompt。

## 与 dsh-science 工具接线

| 习惯 | 工具/约定 |
| --- | --- |
| 数据登记、只读 | `data/README.md` 或 `data/manifest.tsv`（data-inventory 约定） |
| 环境固定 | `envs/*.yaml` + lock（conda-environments 约定） |
| 证据归档 | `artifact_save`（版本 + 溯源 + SHA256） |
| 观察与结论 | `research_findings`、`experiments/E0n/log.md` |
| 远程大任务 | `remote_run`（审批）→ `remote_status` → `remote_pull` |
| 独立评审 | `scientific-reviewer`（对照日志与工件核查论断） |
| 周期推进 | `research-loop`、`roadmap_*` |

## 自查清单

- [ ] intake 每个字段都有来源？缺项都标了 blocking？
- [ ] 路由是查表还是现场发挥？能指出唯一执行者？
- [ ] 工具闸门跑过？install 需要批准？
- [ ] 资源 bundle 对过账？advisory/required 分清？
- [ ] 默认 dry-run？命令已落文件？
- [ ] raw 只读且 checksum 前后一致？
- [ ] 工具/参考/数据库版本进 manifest？
- [ ] 6 件证据齐？parameter hash 有？
- [ ] QC 有阈值与 verdict？
- [ ] 成熟度 / 许可 / 隐私 / 临床边界写清？
- [ ] 换人能否照 summary 重跑？
- [ ] 结论强度与证据匹配？

## 反模式

除 H1–H12 的反例外，三条总纲：

- **拿教程当流程**：把博客命令拼起来就开跑。
- **拿图当结论**：没有阈值、没有 verdict、没有 caveat。
- **拿"跑完"当"可交接"**：缺少 evidence 包与复现命令。

## 参考

- 策略来源：OpenAI Codex `ngs-analysis` workbench（MIT）
- 本仓库 NGS 实例：`ngs-analysis-workbench`（`skills/ngs-analysis-workbench/SKILL.md`）
- 域扩展：`packs/index.json` + `packs/<pack>/{SKILL.md,registry.json}`
- 契约校验：`node scripts/validate-skill-packs.mjs`
- 同仓配套技能：`research-loop`、`artifact-provenance`、`data-inventory`、`conda-environments`、`remote-compute`、`scientific-reviewer`
