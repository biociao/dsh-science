// biomni-registry —— Biomni 模式的「资源宇宙」（Resource Universe）
//
// 对应 Biomni 的三个信息来源的合体：
//   - tool/tool_description/*.py + read_module2api()  ：工具（能力）的声明式元数据
//   - env_desc.data_lake_dict                          ：数据湖（策展数据集，带描述）
//   - env_desc.library_content_dict                    ：软件库（Python/R 包，带描述）
//   - know_how/*.md (loader.py)                        ：Know-How 库（最佳实践/协议/排障）
//
// 并扩展 A1.add_tool / add_data / add_software / add_mcp 的「运行时注入」能力：
// 会话可把自定义工具 / 数据 / 软件 / 知识库登记进宇宙，供检索层（biomni-retriever）
// 在后续执行中看到。
//
// 零第三方依赖（只用 node 内置模块），作为 Biomni 模式 preset 的本地插件被挂载。
// 它维护 <项目根>/.biomni/registry.json，首次读取时用内置策展目录（DEFAULT_CATALOG）
// 播种；写入经 withFileLock 串行 + 原子写（tmp+rename），读方永不见半截文件。
//
// 与科学模式的 research_* / artifact_* 不同，Biomni 模式不强调"可证伪假设/版本化工件"
// 的方式学，而是强调"检索增强规划 + 代码优先执行 + 反思"的通用研究本体——本引擎只
// 负责维护资源宇宙，工作流（检索/计划/反思）见 biomni-retriever / biomni-plan /
// biomni-reflect。

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "biomni-registry";

// 需要 tools 服务就绪后才应用（与其它工具插件一致）
export const inject = ["tools"];

const SCHEMA = 1;
const REGISTRY_FILE = "registry.json";
const BIOMNI_DIR = ".biomni";

const RESOURCE_TYPES = ["tools", "data_lake", "libraries", "know_how"];
const TYPE_LABEL = {
  tools: "工具（能力）",
  data_lake: "数据湖（策展数据集）",
  libraries: "软件库（Python/R 包）",
  know_how: "Know-How（最佳实践/协议）",
};

// ── 内置策展目录 ──────────────────────────────────────────────────────────────
// 播种值（首次初始化 registry.json 时克隆使用；之后以用户/会话本地为准，可用
// biomni_registry_remove 移除、biomni_registry_add 追加）。条目只要求 name + description；
// 其余字段（category / module / id / content / metadata）按类型可选。描述尽量具体，
// 以便检索层按关键词命中。

const DEFAULT_CATALOG = {
  // 工具（能力）：声明式描述"能做什么"，检索时按任务类型给出"优先聚焦哪些能力"。
  // 这些是给 agent 的"能力清单"，实际执行仍走 DSH 本会话已有的工具（bash/web_search/
  // subagent/fs 等）；这里表达的是"针对该任务应该优先调用的能力/模块"。
  tools: [
    { name: "code_exec", description: "编写并执行 Python/R/Bash 代码以处理数据、计算、可视化（写代码优先而非调固定函数）。", category: "execution" },
    { name: "code_r", description: "用 R 运行统计与生信分析（ggplot2/Seurat/DESeq2 等），适合 RNA-seq/检验/可视化。", category: "execution" },
    { name: "code_bash_cli", description: "用 Bash 调用生信命令行工具（samtools/bcftools/STAR/DESeq2/PLINK 等）处理大数据。", category: "execution" },
    { name: "query_db", description: "查询生物医学数据库（UniProt/GWAS Catalog/Ensembl/ClinVar/dbSNP/Open Targets/DisGeNET 等）。", category: "database" },
    { name: "literature", description: "检索与筛选文献（web_search / PubMed / bioRxiv），提取任务、数据库与软件。", category: "literature" },
    { name: "structure", description: "处理结构与化学信息（PDB/AlphaFold/分子 SMILES、对接、ADMET 预测）。", category: "structure" },
    { name: "genomics", description: "变异/基因/遗传分析：注释 (VEP)、GWAS、TWAS、连锁、基因集富集 (GSEA)。", category: "genomics" },
    { name: "omics", description: "单细胞/空间转录组/多组学：聚类、注释、差异、轨迹、整合去批次。", category: "omics" },
    { name: "pathology", description: "病理/影像定量：全载玻片图像 (WSI) 分析、分割、深度学习。", category: "pathology" },
    { name: "parallel", description: "把相互独立的任务拆成并行轨道（DSH subagent），各自落盘后合并。", category: "orchestration" },
  ],
  // 数据湖（策展数据集）：与 Biomni env_desc.data_lake_dict 同构，带描述。
  data_lake: [
    { name: "gtex_tissue_gene_tpm", category: "expression", description: "GTEx 人类组织的基因表达（TPM），跨组织表达谱。", path: "/public/.../gtex_tissue_gene_tpm.parquet" },
    { name: "depmap_crispr_gene_effect", category: "dependency", description: "DepMap CRISPR 基因效应（基因组范围敲除对癌细胞系存活的影响）。", path: "/public/.../DepMap_CRISPRGeneEffect.csv" },
    { name: "gnomad", category: "variants", description: "gnomAD 人群频率（pLoF/missense/synonymous 过滤后的变异）。", path: "/public/.../genebass_*.pkl" },
    { name: "clinvar", category: "variants", description: "ClinVar 临床意义注释（致病/良性变异）。", path: "/public/.../clinvar.pkl" },
    { name: "dbsnp", category: "variants", description: "dbSNP 变异位点与 rsID 注释。", path: "/public/.../dbsnp.pkl" },
    { name: "disgenet", category: "association", description: "DisGeNET 基因-疾病关联（多来源合并）。", path: "/public/.../DisGeNET.parquet" },
    { name: "msigdb", category: "geneset", description: "MSigDB 基因集（Hallmark/C2/C5/C8 等），用于富集分析。", path: "/public/.../msigdb_human_*.parquet" },
    { name: "go_plus", category: "annotation", description: "Gene Ontology 功能注释（BP/MF/CC）。", path: "/public/.../go-plus.json" },
    { name: "omim", category: "association", description: "OMIM 遗传病-基因关联。", path: "/public/.../omim.parquet" },
    { name: "protein_atlas", category: "expression", description: "Human Protein Atlas 蛋白表达数据。", path: "/public/.../proteinatlas.tsv" },
    { name: "cellxgene_census", category: "single_cell", description: "CZ Cell Census 单细胞数据集（h5ad），可下载子集。", path: "/public/.../czi_census_datasets_v4.parquet" },
    { name: "bindingdb", category: "drug", description: "BindingDB 蛋白-小分子实测结合亲和力，用于药物发现。", path: "/public/.../BindingDB_All_*.tsv" },
    { name: "gwas_catalog", category: "association", description: "GWAS Catalog 关联结果。", path: "/public/.../gwas_catalog.pkl" },
    { name: "hp_obo", category: "ontology", description: "HPO 表型本体（obographs），用于表型-基因关联。", path: "/public/.../hp.obo" },
  ],
  // 软件库（Python/R 包）：与 Biomni library_content_dict 同构。
  libraries: [
    { name: "scanpy", category: "single_cell", description: "单细胞基因表达分析（AnnData）的扩展工具包。", lang: "python" },
    { name: "anndata", category: "single_cell", description: "处理内存/磁盘上的注释数据矩阵（单细胞）。", lang: "python" },
    { name: "biopython", category: "bio", description: "生物计算工具集：序列解析、在线服务接口、生信程序。", lang: "python" },
    { name: "pysam", category: "genomics", description: "读写/操作 SAM/BAM/VCF/BCF 基因组数据。", lang: "python" },
    { name: "pyfaidx", category: "genomics", description: "FASTA 文件高效随机访问。", lang: "python" },
    { name: "pyranges", category: "genomics", description: "类 pandas 的区间操作库。", lang: "python" },
    { name: "pybedtools", category: "genomics", description: "BEDTools 的 Python 封装。", lang: "python" },
    { name: "gseapy", category: "enrichment", description: "GSEA 与富集分析及可视化。", lang: "python" },
    { name: "rdkit", category: "pharma", description: "化学信息学与机器学习：化学结构、药物发现。", lang: "python" },
    { name: "scikit-learn", category: "ml", description: "机器学习：分类/回归/聚类。", lang: "python" },
    { name: "statsmodels", category: "stats", description: "统计建模与计量经济学。", lang: "python" },
    { name: "scipy", category: "stats", description: "科学计算：优化/线性代数/积分/统计。", lang: "python" },
    { name: "pandas", category: "data", description: "数据分析与操作。", lang: "python" },
    { name: "numpy", category: "data", description: "科学计算基础：数组/矩阵/数学函数。", lang: "python" },
    { name: "matplotlib", category: "viz", description: "静态/动画/交互可视化。", lang: "python" },
    { name: "umap-learn", category: "dimred", description: "UMAP 降维。", lang: "python" },
    { name: "harmony", category: "batch", description: "单细胞数据去批次整合（Harmony 算法）。", lang: "python" },
    { name: "Seurat", category: "single_cell", description: "R 单细胞分析：QC/降维/聚类/注释/差异。", lang: "r" },
    { name: "DESeq2", category: "rnaseq", description: "R RNA-seq 差异表达分析。", lang: "r" },
    { name: "edgeR", category: "rnaseq", description: "R RNA-seq 差异表达分析（经验贝叶斯）。", lang: "r" },
  ],
  // Know-How 库：最佳实践/协议/排障。content 为要点；metadata 记录来源/许可。
  know_how: [
    {
      id: "kh-single-cell-annotation",
      name: "单细胞注释最佳实践",
      category: "single_cell",
      description: "单细胞聚类后如何标注细胞类型：marker 基因对照、双保险（自动+人工）、跨数据集一致性检查。",
      metadata: { license: "open", commercial_use: "允许", source: "Biomni know_how/single_cell_annotation.md" },
      content: "1) 先 QC（双胞/线粒体/低表达基因）；2) 降维聚类（harmony 去批次）；3) 用 marker 基因表反查细胞类型；4) 多个数据集交叉验证标注；5) 记录每类 marker 表达证据与不确定性。",
    },
    {
      id: "kh-sgrna-design",
      name: "sgRNA 设计要点",
      category: "crispr",
      description: "CRISPR 筛选 sgRNA 设计：靶向效率、脱靶控制、文库扩增与滴度。",
      metadata: { license: "open", commercial_use: "允许", source: "Biomni know_how/sgRNA_design_guide.md" },
      content: "1) 优先选择高活性+低脱靶的 spacer；2) 覆盖目标基因多个位点提高鲁棒性；3) 文库扩增用足量 PCR，避免偏倚；4) 滴度测定确保 MOI 合适；5) 设置对照（non-targeting sgRNA）。",
    },
    {
      id: "kh-variant-interpretation",
      name: "变异解读框架",
      category: "variants",
      description: "从 VCF 到致病性判断：注释（VEP）、人群频率、ClinVar/功能预测、ACMG 分级。",
      metadata: { license: "open", commercial_use: "允许", source: "dsh-science bioinformatics-toolkit" },
      content: "1) 用 VEP/annotate 变异注释（基因、功能后果、保守性）；2) 对照 gnomAD 人群频率过滤常见变异；3) 合并 ClinVar/dbSNP 已知注释；4) 功能预测（SIFT/PolyPhen/CADD）；5) 按 ACMG 规则分级，注明证据强度与不确定性。",
    },
    {
      id: "kh-data-lake-usage",
      name: "数据湖使用规范",
      category: "data",
      description: "如何使用策展数据集：只读、版本锁定、绝对路径，避免猜测路径。",
      metadata: { license: "internal", commercial_use: "允许", source: "DCS 公共库规范" },
      content: "1) 只读使用策展数据（DCS /public）；2) 用绝对路径，读目录 README 后确认；3) 版本锁定，记录来源；4) 数据不进版本库；5) 采样/预览后再做全量。",
    },
  ],
};

// ── 读写（写方持锁；首次播种）─────────────────────────────────────────────────

async function registryPath(root) {
  return path.join(root, BIOMNI_DIR, REGISTRY_FILE);
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CATALOG));
}

async function loadRegistry(root) {
  const p = await registryPath(root);
  const reg = await core.readJson(p, null);
  if (reg) return migrateRegistry(reg);
  // 首次：播种内置目录
  const seeded = {
    schema: SCHEMA,
    universe: cloneDefault(),
    updatedAt: core.nowISO(),
  };
  await saveRegistry(root, seeded);
  return seeded;
}

function migrateRegistry(reg) {
  let v = Number(reg?.schema) || 1;
  if (v < SCHEMA) {
    reg.schema = SCHEMA;
  }
  for (const t of RESOURCE_TYPES) {
    if (!Array.isArray(reg.universe?.[t])) reg.universe ??= {}, (reg.universe[t] = []);
  }
  return reg;
}

async function saveRegistry(root, reg) {
  reg.updatedAt = core.nowISO();
  await core.writeJsonAtomic(await registryPath(root), reg);
}

async function withRegistry(root, fn) {
  return core.withFileLock(await registryPath(root), async () => {
    const reg = await loadRegistry(root);
    const v = await fn(reg);
    await saveRegistry(root, reg);
    return v;
  });
}

async function resolveUniverse(reg) {
  return reg.universe;
}

// ── 查询/注入逻辑 ─────────────────────────────────────────────────────────────

function findResource(reg, type, name) {
  const arr = reg.universe?.[type] ?? [];
  return arr.findIndex(
    (r) => (r.name ?? r.id) === name || r.id === name,
  );
}

function describeResource(type, r) {
  return {
    name: r.name ?? r.id,
    description: r.description ?? "",
    category: r.category ?? "",
    ...(type === "know_how" ? { id: r.id, content: r.content, metadata: r.metadata } : {}),
    ...(r.path ? { path: r.path } : {}),
    ...(r.lang ? { lang: r.lang } : {}),
    ...(r.module ? { module: r.module } : {}),
  };
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const audit = async (args, exec) => {
    try {
      return await core.resolveRoot(args, exec, markers);
    } catch {
      return undefined;
    }
  };

  // biomni_resources_list：列出资源宇宙（可按类型过滤 / 关键词搜索）
  ctx.tools.register(
    core.makeTool({
      name: "biomni_resources_list",
      description:
        "列出 Biomni 模式的「资源宇宙」——工具（能力）、数据湖（策展数据集）、软件库（Python/R 包）、Know-How（最佳实践/协议）。可用 type 过滤类别、keyword 模糊搜索名称+描述。这是检索层（biomni_retrieve）与运行时注入（biomni_registry_add）的数据源。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        type: { type: "string", enum: RESOURCE_TYPES, description: "按类型过滤（tools/data_lake/libraries/know_how）" },
        keyword: { type: "string", description: "在名称+描述里搜索的关键词" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const reg = await loadRegistry(root);
        const universe = await resolveUniverse(reg);
        const keyword = (args?.keyword ?? "").trim().toLowerCase();
        const out = {};
        for (const t of RESOURCE_TYPES) {
          if (args?.type && args.type !== t) continue;
          let items = universe[t] ?? [];
          if (keyword) {
            items = items.filter((r) =>
              `${r.name ?? ""} ${r.description ?? ""}`.toLowerCase().includes(keyword),
            );
          }
          out[t] = items.map((r) => describeResource(t, r));
        }
        return {
          root,
          overview: {
            tools: (universe.tools ?? []).length,
            data_lake: (universe.data_lake ?? []).length,
            libraries: (universe.libraries ?? []).length,
            know_how: (universe.know_how ?? []).length,
          },
          universe: out,
          hint: "先用 biomni_retrieve 按任务做检索增强规划；再按需 biomni_registry_add 注入自定义资源。",
        };
      },
    }),
  );

  // biomni_registry_add：运行时注入自定义资源（工具/数据/软件/知识库）
  ctx.tools.register(
    core.makeTool({
      name: "biomni_registry_add",
      description:
        "向 Biomni 资源宇宙注入一个自定义资源（type ∈ tools/data_lake/libraries/know_how）。每个条目最少给 name + description；可按类型补 category/path/module/lang/id/content/metadata。注入后立即可被 biomni_retrieve 检索到。等价于 Biomni 的 A1.add_tool / add_data / add_software / add_mcp。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        type: { type: "string", enum: RESOURCE_TYPES, description: "资源类型" },
        item: {
          type: "object",
          additionalProperties: true,
          description: "资源条目 {name, description, category?, path?, module?, lang?, content?, id?, metadata?}",
        },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const type = args?.type;
        if (!RESOURCE_TYPES.includes(type)) throw core.sciErr("ERR_VALIDATION", `type 必须是 ${RESOURCE_TYPES.join("/")}`);
        const item = args?.item;
        if (!item || !item.name) throw core.sciErr("ERR_VALIDATION", "item 必填且须含 name");
        const name = typeof item.name === "string" ? item.name.trim() : "item";
        const entry = { name, description: item.description ?? "", ...(item.category ? { category: item.category } : {}) };
        for (const k of ["path", "module", "lang"]) if (item[k]) entry[k] = item[k];
        if (type === "know_how") {
          entry.id = item.id ?? `kh-${core.slugify(item.name, "doc", 40)}`;
          if (item.content) entry.content = item.content;
          else if (item.description) entry.content = item.description;
          if (item.metadata) entry.metadata = item.metadata;
        }
        const added = await withRegistry(root, (reg) => {
          const arr = reg.universe[type];
          const existing = findResource(reg, type, entry.name);
          if (existing >= 0) throw core.sciErr("ERR_CONFLICT", `资源已存在：${type}/${entry.name}`);
          arr.push(entry);
          return entry;
        });
        return { root, type, added: describeResource(type, added), note: "已注入，可用 biomni_retrieve 检索。" };
      },
    }),
  );

  // biomni_registry_remove：移除一个资源
  ctx.tools.register(
    core.makeTool({
      name: "biomni_registry_remove",
      description:
        "从 Biomni 资源宇宙移除一个资源（type + name 定位）。等价于 Biomni 的 remove_custom_tool / remove_custom_data / remove_custom_software。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        type: { type: "string", enum: RESOURCE_TYPES, description: "资源类型" },
        name: { type: "string", description: "资源名（name 或 know_how 的 id）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const { type, name } = args ?? {};
        if (!RESOURCE_TYPES.includes(type)) throw core.sciErr("ERR_VALIDATION", `type 必须是 ${RESOURCE_TYPES.join("/")}`);
        if (!name) throw core.sciErr("ERR_VALIDATION", "name 必填");
        const removed = await withRegistry(root, (reg) => {
          const idx = findResource(reg, type, name);
          if (idx < 0) throw core.sciErr("ERR_NOT_FOUND", `未找到资源：${type}/${name}`);
          const [r] = reg.universe[type].splice(idx, 1);
          return r;
        });
        return { root, removed: describeResource(type, removed) };
      },
    }),
  );

  // biomni_registry_show：查看单个资源详情
  ctx.tools.register(
    core.makeTool({
      name: "biomni_registry_show",
      description: "查看 Biomni 资源宇宙中单个资源的完整详情（type + name 定位；know_how 附全文内容）。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        type: { type: "string", enum: RESOURCE_TYPES, description: "资源类型" },
        name: { type: "string", description: "资源名（name 或 know_how 的 id）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const { type, name } = args ?? {};
        if (!RESOURCE_TYPES.includes(type)) throw core.sciErr("ERR_VALIDATION", `type 必须是 ${RESOURCE_TYPES.join("/")}`);
        if (!name) throw core.sciErr("ERR_VALIDATION", "name 必填");
        const reg = await loadRegistry(root);
        const idx = findResource(reg, type, name);
        if (idx < 0) throw core.sciErr("ERR_NOT_FOUND", `未找到资源：${type}/${name}`);
        return { root, type, resource: describeResource(type, reg.universe[type][idx]) };
      },
    }),
  );
}

export { apply, loadRegistry, registryPath, RESOURCE_TYPES, TYPE_LABEL, DEFAULT_CATALOG, describeResource };
