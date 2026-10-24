---
name: ngs-analysis-workbench
description: NGS 分析工作台策略（参考 Codex / OpenAI NGS Analysis Workbench）：把测序分析工程化为「inspect-first intake → 单一叶子路由 → 工具/资源双闸门 → plan-validate-execute → 统一 run envelope → 复核产物」的受控系统。设计或评审 NGS 流水线、给生信分析补闸门与留痕时使用。
whenToUse: 要设计/评审一条 NGS 分析流水线（BCL/FASTQ、变异、RNA-seq、单细胞、表观、扩增子/宏基因组）；担心"模型即兴写命令"不可复现；或需要把生信执行接进研究循环、工件溯源、远程计算时。
---

# NGS 分析工作台（NGS Analysis Workbench）

本技能整理自 OpenAI 官方插件 **Life Sciences NGS Analysis**（`openai/plugins` 仓库 `plugins/ngs-analysis`，v1.0.3，MIT）的工程策略。原插件形态：1 个 router + 17 个叶子技能 + 5 份注册表/schema + 16 个 Python runner + 内置 Snakefile/R 工作流。这里把它抽象成可移植的做法，供本仓库的科研循环复用。

> 需要跨领域（蛋白组、代谢组、空间组学等）复用的版本见 `bioinformatics-habits` 技能；本技能是它在 NGS 场景的具体实例。

## 一句话策略

> **LLM 只做决策（intake、路由、解释、风险提示），确定性脚本负责校验、执行、留痕。模型不即兴生成执行命令。**

由此带来三个直接结果：每个结论都能回溯到一次具体运行；换机器能复现；"跑不了"会被明确报出来，而不是悄悄降级成"看起来跑完了"。

## 分层架构

| 层 | 内容 | 职责 |
| --- | --- | --- |
| 清单层 | `plugin.json` | 技能目录、marketplace 分发、UI 元数据 |
| 路由层 | router + dispatcher + 叶子 `SKILL.md` | 把模糊请求收敛到**唯一**叶子流程；每个技能写死「必需输入 / 路由 / 决策点 / 输出契约」 |
| 注册表层 | `pipeline-registry` / `reference-registry` / `database-registry` / `intake-schema` / `run-envelope-schema` | 把"选哪个流程、缺什么、跑完长什么样"变成**数据**而不是模型记忆 |
| 执行层 | `run_*.py` runner + 共享 utils | 校验、dry-run、执行、写 envelope、生成复核产物 |
| 工作流层 | 内置 `Snakefile` / R 脚本 | 真正的计算：FastQC/MultiQC、Salmon、STARsolo、DADA2、DESeq2/edgeR/limma… |
| 契约层 | `tests/` | 用测试锁住 preflight 与 runner 的行为契约 |

## 六条核心策略

### 1. Inspect-before-ask（先看文件，再问最少的问题）

先扫输入，再提问；**文件能回答的字段绝不问用户**。

- 扫描对象：`RunInfo.xml`/`SampleSheet.csv`/`Data/Intensities/BaseCalls`、`*.fastq.gz`、`*.bam|*.cram`、`matrix.mtx`/`features.tsv`/`barcodes.tsv`/`*.h5ad`、sample sheet、target BED、参考 FASTA/GTF。
- 只补问：输入类型、assay、目标产物、物种/参考、单双端、必需的 assay 专属元数据、运行时约束（本地/HPC/云、容器、是否允许安装）。
- 人类数据：**先问是否允许上云**，再提 BaseSpace/Terra/DNAnexus。
- 输出路由结果必须带 `confidence` 与 `missing_essentials`，让人一眼看出"还差什么才能跑"。

### 2. 单一叶子路由（dispatcher → leaf）

`router` 只做分诊，不执行；分诊到唯一叶子（如 `dna_variant_calling → dna_somatic_variants`）。叶子技能四段式：

1. **Essential Inputs** —— 缺了就 blocking 的字段
2. **Route** —— 首选公开工作流（nf-core）+ 本地轻量 runner
3. **Decision Points** —— 真正影响生物学解释的检查（肿瘤/正常配对、PON 与 capture kit 匹配、strandedness、UMI）
4. **Outputs** —— 产物清单 + 必须写明的 caveat

注册表里每条 pipeline 固定字段：`route_when`（触发词）、`preferred_workflow`、`preferred_tools`、`local_executor`、`local_outputs`、`essential_questions`。**路由 = 查表，不是模型自由发挥。**

### 3. Public-first + 边界显式化

- 默认只用公开、可运行时安装的工具：nf-core、FastQC、MultiQC、fastp/cutadapt、STAR、Salmon、GATK4、samtools/bcftools、QIIME2、DADA2、Kraken2、HUMAnN。
- 对"可下载但非全开源 / EULA 绑定"的工具（BCL Convert、Cell Ranger、DRAGEN、Sentieon）：**先暴露许可边界，再讨论使用**。
- 云上传、账号体系、专有软件都不静默启用。

### 4. 双闸门：工具闸门 + 资源闸门

**工具闸门**（检查顺序固定）：

1. `command -v` / `shutil.which` 查可执行文件
2. Python 包 import（Python 系工具）
3. `conda/mamba/micromamba list`、`pip show`
4. 仅在用户允许时查包索引 / 容器 registry（`--network-checks`）
5. **先产出 install plan，再谈安装**
6. 只有用户显式批准才安装（`--install-missing --yes`）

install plan 落盘：`install_plan.json`（唯一权威）+ `install_commands.sh`。后者默认 **review-only**，需要显式环境变量（如 `NGS_RUN_INSTALL_COMMANDS=1`）才真执行。

**资源闸门**（参考/数据库与可执行文件分开管）：

- 把参考基因组、注释、known-sites、分类数据库抽象成 **bundle**：期望文件清单、`root_env`、体积、许可/版本 caveat、setup hint、被哪些 pipeline 依赖。
- 命令族：`list / check / plan / setup-plan / inventory / lock / verify-lock`。
- `plan` 输出 `resource_plan.json`、`resource_manifest.tsv`、`resource_env.sh`、`resource_readiness.md` + setup checklist；`setup-plan` 的 shell 骨架**默认注释掉下载命令**，大下载必须显式解除。
- 两种模式：`advisory`（默认；自定义/缩减参考也能规划，只告警）与 `required`（缺 bundle 就 block）。`--skip-resource-plan` **只能用于命令形状评审，不得据此声称 ready**。
- `lock` + `verify-lock`：快照资源清单并检测漂移，用于换机复现与交接。

### 5. plan → validate → dry-run → execute（默认不执行）

- runner 默认只做「校验 + 计划」，`--execute` 才真跑；dry-run 先行。
- `run_manifest.json` 里 `ready_to_execute = validation_ok && tool_preflight_ok`，不是"模型觉得可以"。
- 状态机：`prepared → validated → blocked / failed / completed`。
- 缺件直接 `blocked`，并写清 blocker（工具缺失 / 资源缺失 / 输入不合法），绝不带着缺件硬跑。

### 6. 统一 run envelope + 可复核产物

每次运行固定写同一套结构（schema 版本化）：

| 路径 | 内容 |
| --- | --- |
| `run_manifest.json` | run_id、lane、workflow、status、validation/preflight/execute 标志、inputs/outputs、method、audit |
| `config.json` | 本次参数 |
| `validation/` | `input_summary.json`、`validation_summary.json`、`tool_preflight.json` |
| `logs/` | 命令、耗时、returncode、stderr |
| `versions/software_versions.json` | 实际软件版本（不是期望版本） |
| `manifest/lineage.tsv` | 输入→输出：exists / bytes / sha256 / source_inputs |
| `artifact_index.json` | 逐文件 SHA256 + mtime（超大文件写明 skipped_reason） |
| `summary.md` | 给人看的执行摘要 |
| `resources/` | 资源闸门产物（plan / manifest / env / readiness / setup） |
| `visualizations/` | `index.html` + `visualization_manifest.json` |
| `notebooks/` | marimo 复核面板（包住产物，不替代 envelope） |
| `qc_interpretation.json` / `qc_verdict.json` | 机器可读的判据与 reason code |

manifest 中的 `audit` 必须含：插件版本、环境快照、输入 checksum、**`parameter_sha256`**（把 lane/workflow/inputs/outputs/method 一起哈希）、config 哈希。这样"同参数"是可验证的，而不是口头声明。

## 数据契约定型（可直接照抄的字段）

### intake（三件套必填）

```json
{
  "input_type": "bcl_run_folder | fastq | bam_or_cram | count_matrix | vcf | unknown",
  "assay": "wgs | wes | targeted_panel | bulk_rnaseq | scrnaseq | snrnaseq | atacseq | chipseq | cutandrun | cutandtag | amplicon_microbiome | shotgun_metagenomics | fastq_qc_only | unknown",
  "objective": ["qc", "variant_calling", "differential_expression", "..."],
  "organism": "...", "reference": {...}, "library": {"paired_end": true, "strandedness": "..."},
  "study_design": {"tumor_normal": true, "sample_model": "tumor_normal", "contrasts": []},
  "runtime": {"executor": "local|slurm|...", "container_engine": "docker|...", "can_install": false, "allow_cloud_upload": false},
  "routing_decision": {"pipeline_key": "...", "confidence": "high|medium|low", "missing_essentials": []}
}
```

### pipeline registry 条目

```json
{
  "display_name": "...",
  "route_when": ["somatic", "tumor_normal"],
  "preferred_workflow": "nf-core/sarek",
  "preferred_tools": ["nextflow", "gatk", "samtools"],
  "local_executor": "scripts/run_dna_somatic_variants.py",
  "local_outputs": ["run_manifest.json", "qc/somatic_qc_summary.json", "..."],
  "essential_questions": ["tumor-normal 还是 tumor-only？", "PON/known-sites 在哪？"]
}
```

### resource bundle

```json
{
  "bundle": "grch38_core",
  "kind": "reference",
  "root_env": "NGS_REF_GRCH38",
  "expected_files": ["genome.fa", "genome.fa.fai", "genes.gtf"],
  "required_for": ["dna_germline_variants", "atacseq_peaks_qc"],
  "license": "...", "size": "...", "setup_hint": "..."
}
```

### 执行协议（伪代码）

```python
intake = inspect(inputs) or ask_minimum()          # 1. 先看再问
route  = registry_lookup(intake)                   # 2. 查表路由，单叶子
tool_plan = preflight(route)                       # 3. 工具闸门（默认不装）
res_plan  = resource_plan(route, mode=advisory)    # 4. 资源闸门
valid     = validate_inputs(route, intake)         # 5. 输入校验
if not approved: emit(plans, valid); return        #    未批准：只交付计划
dry_run(); execute()                               # 6. 先 dry-run 再执行
write_envelope(manifest, lineage, index, versions) # 7. 统一信封
build_review_bundle(qc_verdict, reason_codes)      # 8. 可复核产物
archive_artifact()                                 # 9. 归档 + 溯源
```

## 红线（明确不做什么）

- **不静默降级**：缺 Kraken2 库就记 `not_available` + blocker；合成数据自动标 `review-only`，默认阻断 beta 多样性，除非显式 `--allow-synthetic-diversity`。
- **不自动安装、不自动大下载**：install/resource 的 shell 骨架默认 review-only。
- **原始测序数据只读**（除非用户明确要求写回）。
- **不夸大结论**：tumor-only 不写成 confirmed somatic；dispatch 不说成 execution；"命令形状正确"不说成"可执行"。
- **不越许可/隐私边界**：EULA、账号、云上传、人类数据外传都要显式确认。
- **临床可操作性 out of scope**：除非用户提供经过验证的临床解读流程。

## 成熟度分级（能力诚实）

不要给所有 lane 打同一个"支持"标签。照抄它的三档：

| 档位 | 含义 | 典型 lane |
| --- | --- | --- |
| 本地可执行 | 插件自有 runner，能出完整 envelope | FASTQ QC、bulk RNA-seq counts、DE、STARsolo、BAM→VCF 轻量检查、post-count scRNA QC |
| 可派发 | 能规划、能生成命令与资源计划，执行交给 nf-core | sarek、rnaseq、atacseq、ampliseq、taxprofiler |
| 仅 readiness | 只做输入校验 + 下一步 readiness 产物 | ATAC/ChIP 只到 QC 就绪、amplicon/shotgun 的 FASTQ 包 |

## 在 dsh-science 中落地（最小可用子集）

| Codex 策略 | dsh-science 现有接线 |
| --- | --- |
| intake 路由 | 新增本技能 + 一个 `intake` 字段约定（写进 `experiments/E01/design.md` 或项目管理文件） |
| 工具闸门 | 新增 `scripts/ngs_preflight.py`（PATH → import → conda/pip → install plan，默认不装） |
| 资源闸门 | 扩 `data-inventory`/`conda-environments`：写 `references/` bundle 清单 + `envs/` 锁文件 |
| run envelope | 用 `artifact_save`（版本+溯源+哈希）+ `research_findings`（观察/结论），目录 `experiments/E01/{code,results,log.md}` 补 `run_manifest.json` |
| dry-run / 批准 | 命令先落 `code/run.sh` 供 review，再执行；远程大任务走 `remote_run`（审批） |
| 复核产物 | `scientific-reviewer` 对照日志与工件评审；QC 判据写成 `qc_verdict.json` 式机器可读文件 |
| 成熟度诚实 | 在 design.md 标注本条流程是"本地可跑"还是"仅规划" |

**最小落地四步**：

1. 写 `intake-schema.yaml`（10 个字段即可，见上）+ `pipeline-registry.yml`（先 3 条 lane）。
2. 写 `ngs_preflight.py`：只做存在性检查 + install plan 输出，禁止自动安装。
3. 定 `run-envelope` 文件清单，先在一个 runner（FASTQ QC）上跑通。
4. 跑通后再铺 lane；每个 lane 上线前补契约测试。

## 评审一条 NGS 流程时的 checklist

- [ ] 有没有 intake 枚举？缺字段会不会明确输出 `missing_essentials`？
- [ ] 路由是查表还是模型自由发挥？是否只有一个叶子执行者？
- [ ] 有没有工具闸门？检查顺序是否 PATH → import → 包管理器？是否默认不装？
- [ ] 参考/数据库是否 bundle 化？`advisory` / `required` 模式是否分离？
- [ ] plan 与 execute 是否分离？默认是否 dry-run？`ready_to_execute` 是否有客观判据？
- [ ] 是否统一 envelope：manifest / lineage / artifact_index / versions / logs？
- [ ] 是否有 `parameter_sha256`、输入 checksum、环境快照？
- [ ] QC 是"有图"还是"有判据"（verdict + reason code）？
- [ ] blocker 是否显式（而不是 `not_available` 静默带过）？
- [ ] 成熟度是否诚实：哪些真能跑、哪些只是规划？
- [ ] 许可 / 云上传 / 人类数据边界是否在推荐前就说明？

## 反模式（看到就该修）

- 在 prompt 里塞一长串命令让模型照抄执行。
- "跑通了"就结束，没有 manifest、没有版本、没有 checksum。
- 装环境不审批、下载几百 GB 数据库没有 plan。
- QC 只有图没有阈值和结论。
- 把 "dispatch 到 nf-core" 说成 "已支持该分析"。
- 用 `--skip-resource-plan` 跑完然后声称资源就绪。
- 把原始数据当工作目录随便改。

## 参考

- 插件目录：<https://github.com/openai/plugins/tree/main/plugins/ngs-analysis>
- README（能力分级、依赖矩阵、运行示例）：<https://github.com/openai/plugins/blob/main/plugins/ngs-analysis/README.md>
- router 技能：<https://github.com/openai/plugins/blob/main/plugins/ngs-analysis/skills/ngs-analysis-router/SKILL.md>
- 插件清单：<https://github.com/openai/plugins/blob/main/plugins/ngs-analysis/.codex-plugin/plugin.json>
- OpenAI 插件页：<https://openai.com/zh-Hans-CN/business/plugins/ngs-analysis-workbench/>
- 官方 use case：<https://developers.openai.com/codex/use-cases/bulk-rna-seq-fastq-qc>
