// biomni-retriever —— Biomni 模式的「检索增强规划」引擎（Retrieval-Augmented Planning）
//
// 对应 Biomni model/retriever.py 的 ToolRetriever.prompt_based_retrieval：
// 拿到用户查询后，不把整个资源宇宙一股脑塞给模型，而是先 Select —— 从宇宙里
// 挑出与本次任务最相关的工具 / 数据湖 / 软件库 / Know-How，让推理只聚焦在子集上。
// 这解决两个问题：① 工具/数据空间过大时上下文爆炸；② 工具选择不可靠（图省事全给
// 反而迷惑模型）。
//
// Biomni 原版用 LLM 做 prompt-based retrieval（列全量资源→让 LLM 挑索引）。本引擎
// 在 DSH 里落地为确定性的领域启发式打分 + 关键词重叠（可用配置切换到 LLM 检索的
// 宿主侧增强），并封装成 biomni_retrieve 工具：返回分类型排序的聚焦子集 + 一条
// 建议的研究计划骨架（plan hint）。实际"是否采用/如何用"由 agent（上下文里的 LLM）
// 综合判断——这正是"检索增强"而非"检索替代"的含义。
//
// 确定性打分（无第三方依赖），规则对齐 Biomni prompt 里的启发式：
//   - 数据库类工具：永远高优先（general queries 优先给足数据库工具）
//   - 文献检索工具：永远包含
//   - 湿实验/序列类查询：额外包含分子生物学/基因组工具
//   - 数据湖：能提供有用信号的策展数据集
//   - 软件库：提供分析所需函数的库
//   - Know-How：相关协议/最佳实践/排障

import * as core from "./core.mjs";
import {
  loadRegistry,
  registryPath,
  RESOURCE_TYPES,
  describeResource,
} from "./biomni-registry.mjs";

export const name = "biomni-retriever";
export const inject = ["tools"];

// 停止词（打分时忽略无信息量的词）
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "at", "with",
  "by", "from", "is", "are", "be", "this", "that", "these", "those", "please",
  "how", "what", "which", "can", "you", "i", "we", "my", "me", "give", "do",
  "perform", "analysis", "using", "use", "given",
]);

// 主题 → 关键词（检测查询意图，命中则给对应 category 加权；中英混排）
const TOPICS = {
  single_cell: ["single-cell", "scrna", "scrna-seq", "celltype", "cell type", "annotation", "cluster", "annadata", "h5ad", "seurat", "scanpy", "umap", "cellxgene", "单细胞", "细胞类型", "聚类", "注释"],
  variants: ["variant", "vcf", "mutation", "snv", "indel", "gnomad", "clinvar", "dbsnp", "vep", "acmg", "germline", "somatic", "变异", "突变", "致病", "外显", "解读"],
  expression: ["expression", "tpm", "rna-seq", "transcriptome", "deg", "differential", "差异表达", "表达", "转录组"],
  enrichment: ["enrichment", "geneset", "gsea", "pathway", "gene set", "msigdb", "ontology", "go ", "富集", "通路", "基因集"],
  association: ["gwas", "association", "disease", "gene-disease", "disgenet", "omim", "ldl", "eqtl", "twas", "关联", "疾病"],
  drug: ["drug", "compound", "small molecule", "admet", "toxicity", "binding", "smiles", "repurposing", "pharmac", "药物", "化合物", "小分子", "毒性", "对接"],
  structure: ["structure", "pdb", "protein", "alphafold", "docking", "molecular", "3d", "fold", "conformer", "结构", "蛋白", "折叠"],
  pathology: ["pathology", "histology", "wsi", "slide image", "whole slide", "tissue", "segmentation", "病理", "组织", "影像", "分割"],
  crispr: ["crispr", "sgrna", "guide rna", "screen", "knockout", "depmap", "gene effect", "perturb", "敲除", "筛选", "依赖"],
  immunology: ["t cell", "b cell", "immune", "immunolog", "tcr", "bcr", "antibody", "mhc", "免疫", "抗体"],
  meta: ["meta-analysis", "systematic review", "aggregate", "pool", "reproduc", "荟萃", "系统评价"],
};

// 主题 → 计划骨架（检索后给 agent 的建议步骤，非强制）
const TOPIC_PLAN = {
  single_cell: [ "读取单细胞/空间数据 h5ad 并做 QC（双胞/线粒体/低表达）", "降维（harmony 去批次）+ 聚类", "用 marker 基因表反查并标注细胞类型", "差异/轨迹/富集分析，检验假设", "可视化+把关键结果落盘" ],
  variants: [ "把 VCF 变异做注释（VEP：基因/功能后果/保守性）", "对照人群频率（gnomAD/Genebass）过滤常见变异", "合并 ClinVar/dbSNP 已知注释", "功能预测 + ACMG 分级，标注不确定性", "汇总变异-基因-疾病证据" ],
  expression: [ "读取表达矩阵并做差异表达（DESeq2/edgeR/scanpy）", "多重检验校正，取显著基因", "富集分析（GSEA/通路）解释生物学", "可视化（火山图/热图）+落盘" ],
  enrichment: [ "选定基因集来源（MSigDB/GO/Reactome）", "做 ORA 或 GSEA 富集分析", "多检验校正，找出显著通路/功能", "解释并可视化（条形图/网络）" ],
  association: [ "检索基因/位点-疾病关联（GWAS Catalog/DisGeNET/OMIM/Open Targets）", "合并多来源证据", "评估统计显著性与效应方向", "汇总候选基因-疾病结论" ],
  drug: [ "从结构/SMILES 计算 ADMET 或药化性质（RDKit）", "检索药物-靶点/亲和力（BindingDB/Open Targets）", "预测或检索相互作用", "给出化合物属性与候选建议" ],
  structure: [ "获取结构（PDB/AlphaFold），查看 pLDDT 置信度", "分析结合位点/叠合/相互作用", "对接或物化性质分析", "可视化并总结结构-功能关系" ],
  pathology: [ "读 WSI/病理影像并做分割或定量", "提取形态学/免疫组化特征", "关联临床或分子特征", "可视化并落盘" ],
  crispr: [ "设计/检索 sgRNA 靶向库（CRISPick/Addgene）", "评估效率与脱靶", "筛选依赖（DepMap）识别候选基因", "总结候选与对照设置" ],
  immunology: [ "检索免疫相关基因/序列（TCR/BCR/抗体）", "注释免疫细胞类型", "关联免疫特征与表型", "总结免疫学结论" ],
  default: [ "明确问题并检索最相关工具/数据/软件", "写出计划（编号清单，标注完成状态）", "代码优先执行，捕获 observation", "每步后 reflection，必要时修正计划", "给出 solution" ],
};

function tokenize(s) {
  const str = String(s || "");
  const tokens = str.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // 中文：把连续 CJK 段切成 bigram（如 "单细胞" → ["单细","细胞"]），提高中文查询召回
  const cjk = str.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function tokensForQuery(query) {
  return tokenize(query).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /[\u4e00-\u9fff]/.test(t)));
}

function detectTopics(query) {
  const q = String(query || "").toLowerCase();
  const topics = [];
  for (const [topic, kws] of Object.entries(TOPICS)) {
    for (const kw of kws) {
      if (q.includes(kw)) {
        topics.push(topic);
        break;
      }
    }
  }
  return topics;
}

// 主题 → 应加权的资源类型/类别（工具能力在描述里写明了 category）
const TOPIC_TO_TOOLCAT = {
  single_cell: ["omics"],
  variants: ["genomics"],
  expression: ["omics", "genomics"],
  enrichment: ["omics", "genomics"],
  association: ["query_db", "genomics"],
  drug: ["structure"],
  structure: ["structure"],
  pathology: ["pathology"],
  crispr: ["genomics", "omics"],
  immunology: ["genomics", "omics"],
  meta: ["literature"],
};

function applyTopicBoost(topic, resourceType, resource) {
  // 工具：按 category 命中
  if (resourceType === "tools") {
    const cats = TOPIC_TO_TOOLCAT[topic] ?? [];
    if (cats.includes(resource.category)) return 4;
  }
  // 数据湖 / 软件库：按 category 命中
  const dataCatBoost = {
    single_cell: ["single_cell", "expression", "annotation", "geneset"],
    variants: ["variants", "association"],
    expression: ["expression", "single_cell"],
    enrichment: ["geneset", "annotation"],
    association: ["association", "variants"],
    drug: ["drug", "expression"],
    structure: ["expression", "drug"],
    pathology: ["dependency"],
    crispr: ["dependency", "geneset"],
    immunology: ["association", "expression"],
    meta: [],
  };
  if (resourceType === "data_lake" || resourceType === "libraries") {
    const cats = dataCatBoost[topic] ?? [];
    if (cats.some((c) => c === resource.category)) return 3;
  }
  return 0;
}

function scoreResource(queryTokens, topicSet, resourceType, resource) {
  const name = String(resource.name ?? resource.id ?? "").toLowerCase();
  const desc = String(resource.description ?? "").toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    if (name.includes(t)) score += 4;
    if (desc.includes(t)) score += 2;
  }
  // 部分匹配（token 作为词根出现在名称/描述）
  for (const t of queryTokens) {
    if (name.includes(t) || desc.includes(t)) score += 1;
  }
  // 主题加权
  for (const topic of topicSet) {
    score += applyTopicBoost(topic, resourceType, resource);
  }
  // 全局启发式（对齐 Biomni prompt 规则）
  if (resourceType === "tools") {
    if (resource.category === "database") score += 5; // 数据库工具永远高优先
    if (resource.category === "literature") score += 5; // 文献工具永远包含
    if (resource.category === "execution") score += 0; // 常规
  }
  return score;
}

function selectTop(items, scored, topK) {
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, topK)
    .map((s) => s.item);
}

function buildPlanHint(query, topics) {
  const topic = topics[0] ?? "default";
  const steps = TOPIC_PLAN[topic] ?? TOPIC_PLAN.default;
  return {
    topic: topics.length ? topics : ["default"],
    steps,
    note: "建议的计划骨架（可在 biomni_plan_init 后按实际调整；非强制）。",
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

  // biomni_retrieve：按任务做检索增强规划，返回聚焦子集 + 计划骨架
  ctx.tools.register(
    core.makeTool({
      name: "biomni_retrieve",
      description:
        "Biomni 模式的检索增强规划：给定任务 query，从资源宇宙（biomni_resources_list）里挑出最相关的工具/数据湖/软件库/Know-How 聚焦子集，并按检测到的任务主题给出研究计划骨架。返回 { focus, by_category, scores, plan_hint, rationale }。策略：检索 ≠ 替代——你作为 LLM 最终决定如何用这些资源；retriever 负责把推理聚焦到相关子集，避免上下文爆炸与工具选择不可靠。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        query: { type: "string", description: "用户的生物医学科研任务描述（如：对该单细胞数据做注释并生成假说）" },
        topK: { type: "integer", description: "每类最多返回条数（默认 4）" },
        mode: { type: "string", enum: ["auto", "generous", "strict"], description: "auto=默认打分；generous=宽松多选；strict=严格只选高相关（默认 auto）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const query = (args?.query ?? "").trim();
        if (!query) throw core.sciErr("ERR_VALIDATION", "query 必填");
        const topK = Number(args?.topK) > 0 ? Number(args.topK) : 4;
        const mode = args?.mode ?? "auto";
        const reg = await loadRegistry(root);
        const universe = reg.universe;
        const queryTokens = tokensForQuery(query);
        const topics = detectTopics(query);

        const focus = {};
        const scores = {};
        const byCategory = {};
        for (const type of RESOURCE_TYPES) {
          const items = universe[type] ?? [];
          const scored = items.map((item) => ({
            item,
            score: scoreResource(queryTokens, topics, type, item),
          }));
          // generous 放宽阈值，strict 收紧
          const threshold = mode === "generous" ? 0 : mode === "strict" ? 2 : 1;
          let selected = scored.filter((s) => s.score >= threshold);
          if (mode === "generous" && type === "tools" && selected.length < 4) {
            // 宽松模式：数据库/文献工具保底
            for (const it of items) {
              if ((it.category === "database" || it.category === "literature") && !selected.some((s) => s.item === it)) {
                selected.push({ item: it, score: 1 });
              }
            }
          }
          selected = selected.sort((a, b) => b.score - a.score).slice(0, topK + (mode === "generous" ? 4 : 0));
          focus[type] = selected.map((s) => describeResource(type, s.item));
          byCategory[type] = selected.map((s) => ({ name: s.item.name ?? s.item.id, score: s.score, category: s.item.category ?? "" }));
          scores[type] = selected.map((s) => ({ name: s.item.name ?? s.item.id, score: s.score }));
        }

        const plan_hint = buildPlanHint(query, topics);
        return {
          root,
          query,
          mode,
          detected_topics: topics,
          focus,
          by_category: byCategory,
          plan_hint,
          rationale:
            "retriever 用领域启发式+关键词重叠打分，从宇宙中选出相关子集；请你结合检测到的主题决定下一步（取出用数据库/文献工具、读数据湖、调用分析库、参考 Know-How）。随后用 biomni_plan_init 建计划、代码优先执行、每步 biomni_reflect 反思。",
        };
      },
    }),
  );
}

export { apply };
