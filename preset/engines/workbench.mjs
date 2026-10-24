// science-research-workbench —— 科研工作台：多项目分类与状态追踪（ReAct 引擎配套）
//
// 解决"一个项目根 = 一个 research-manifest.json"带来的单项目视角盲区：当工作区里
// 有多个科研项目子目录时，工作台把它们聚合成一个可分类、可追踪的管理层。
//
// 数据模型（零第三方依赖，只用 node 内置模块 + ./core.mjs）：
//   - 工作台注册表  <工作台根>/.dsh/workbench.json
//       { schema, root, projects:[{ path, category, tags[], priority, status, notes,
//                                   registeredAt, updatedAt }], updatedAt }
//     保存分类元数据（分类/标签/优先级/生命周期状态/备注），跨会话持续。
//   - 项目发现：扫描工作台根的直接子目录里含 research-manifest.json 的项目，自动收录；
//     注册表的 path 即使暂缺 manifest 也保留（标记 hasManifest:false）。
//   - 状态汇总（每个项目，读取式聚合，不写回项目）：
//       清单 research-manifest.json → 循环阶段/迭代、项目状态、假设状态分布、实验状态分布、
//       评审与待处理评审；artifacts/artifacts.json → 工件总数；.dsh/remotes/jobs.json →
//       远程作业状态分布；lastActive 取 manifest.updatedAt 或目录 mtime。
//
// 工具：research_workbench（总览）/ research_project_list（筛选列表）/
//       research_project_show（单项目详情）/ research_project_register（登记）/
//       research_project_classify（分类/状态 patch）。全部支持结构化 JSON 输出。
//
// 宿主侧（webServer REST API，供 Web 工作台面板使用）复用本引擎导出的函数：
//   loadRegistry / saveRegistry / discoverProjects / projectView /
//   classifyProject / removeProject / workbenchSummary / workbenchRoot
//   —— 见 engines/workbench-ui.mjs。

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "science-research-workbench";
export const inject = ["tools"];

// ── 常量 ────────────────────────────────────────────────────────────────────

const REGISTRY_SCHEMA = 1;
const REGISTRY_RELPATH = path.join(".dsh", "workbench.json");
const STATUSES = ["active", "paused", "finished", "archived"];
const PRIORITIES = ["high", "medium", "low"];
const DEFAULT_PRIORITY = "medium";
const DEFAULT_STATUS = "active";
const REVIEW_PENDING = ["needs-work", "refuted"];

const STATUS_LABEL = {
  active: "进行中",
  paused: "已暂停",
  finished: "已结束",
  archived: "已归档",
};
const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" };
const PHASE_LABEL = {
  literature: "文献调研",
  hypothesis: "假设提出",
  experiment: "实验设计",
  analysis: "数据分析",
  manuscript: "论文撰写",
  concluded: "已收束",
};
const JOBS_ORDER = ["running", "submitted", "succeeded", "failed", "killed", "unknown"];

// ── 注册表读写（原子写；写方在调用处持锁）────────────────────────────────────

function registryPath(root) {
  return path.join(root, REGISTRY_RELPATH);
}

async function loadRegistry(root) {
  const file = registryPath(root);
  const data = await core.readJson(file, null);
  if (!data) {
    return { root, file, schema: REGISTRY_SCHEMA, projects: [], categories: [], updatedAt: core.nowISO() };
  }
  const projects = Array.isArray(data.projects) ? data.projects : [];
  return {
    root,
    file,
    schema: Number(data.schema) || REGISTRY_SCHEMA,
    projects,
    categories: Array.isArray(data.categories) ? data.categories : [],
    updatedAt: data.updatedAt || core.nowISO(),
  };
}

async function saveRegistry(root, reg) {
  reg.updatedAt = core.nowISO();
  await core.writeJsonAtomic(registryPath(root), reg);
}

// ── 项目发现与状态汇总 ──────────────────────────────────────────────────────

// 路径越界防护：项目路径必须落在工作台根内（并行/外链项目不纳入，符合工作区隔离）。
function assertWithinRoot(root, p) {
  const abs = path.resolve(root, p);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw core.sciErr("ERR_PATH", `项目路径越出工作台根：${p}`);
  }
  return abs;
}

function relPath(root, abs) {
  const r = path.relative(path.resolve(root), path.resolve(abs));
  return r || ".";
}

async function readJsonSafe(p) {
  return core.readJson(p, null);
}

// 每个项目的状态汇总（读取式，不写回项目）
async function projectStatus(root, pathAbs, regEntry) {
  const manifest = await readJsonSafe(path.join(pathAbs, "research-manifest.json"));
  const artifactIdx = await core.readJson(path.join(pathAbs, "artifacts", "artifacts.json"), { artifacts: [] });
  const artifacts = Array.isArray(artifactIdx.artifacts) ? artifactIdx.artifacts : [];
  const jobsDoc = await core.readJson(path.join(pathAbs, ".dsh", "remotes", "jobs.json"), { jobs: [] });
  const jobs = Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : [];

  const hypotheses = Array.isArray(manifest?.hypotheses) ? manifest.hypotheses : [];
  const hypByStatus = { total: hypotheses.length, proposed: 0, testing: 0, supported: 0, refuted: 0, inconclusive: 0 };
  for (const h of hypotheses) if (hypByStatus[h.status] !== undefined) hypByStatus[h.status] += 1;

  const experiments = Array.isArray(manifest?.experiments) ? manifest.experiments : [];
  const expByStatus = { total: experiments.length, planned: 0, running: 0, concluded: 0 };
  for (const e of experiments) if (expByStatus[e.status] !== undefined) expByStatus[e.status] += 1;

  const reviews = Array.isArray(manifest?.reviews) ? manifest.reviews : [];
  const pendingReviews = reviews.filter((r) => REVIEW_PENDING.includes(r.verdict)).length;

  const jobByStatus = {};
  for (const j of jobs) jobByStatus[j.state] = (jobByStatus[j.state] || 0) + 1;

  // lastActive：manifest.updatedAt 优先，其次工件/作业 updatedAt，最后目录 mtime
  let lastActive = manifest?.updatedAt || "";
  if (!lastActive) {
    try {
      const st = await fsp.stat(pathAbs);
      lastActive = st.mtime.toISOString();
    } catch {
      lastActive = "";
    }
  }

  // 生命周期状态：注册表显式设置优先；否则由清单推导（concluded → finished）
  const manifestStatus = manifest?.project?.status;
  const phase = manifest?.loop?.phase || "literature";
  let status = regEntry?.status || DEFAULT_STATUS;
  if (!regEntry?.status) {
    status = manifestStatus === "concluded" || phase === "concluded" ? "finished" : DEFAULT_STATUS;
  }

  return {
    path: relPath(root, pathAbs),
    hasManifest: Boolean(manifest),
    title: manifest?.project?.title || regEntry?.name || path.basename(pathAbs),
    domain: manifest?.project?.domain || "",
    category: regEntry?.category || "",
    tags: Array.isArray(regEntry?.tags) ? regEntry.tags : [],
    priority: regEntry?.priority || DEFAULT_PRIORITY,
    status,
    notes: regEntry?.notes || "",
    registeredAt: regEntry?.registeredAt || "",
    updatedAt: regEntry?.updatedAt || "",
    manifest: manifest
      ? {
          projectStatus: manifestStatus || "",
          phase,
          iteration: Number(manifest?.loop?.iteration) || 0,
          created: manifest?.project?.created || "",
          updatedAt: manifest?.updatedAt || "",
        }
      : null,
    counts: {
      hypotheses: hypByStatus,
      experiments: expByStatus,
      artifacts: artifacts.length,
      activeArtifacts: artifacts.filter((a) => !a.deprecated).length,
      reviews: reviews.length,
      pendingReviews,
    },
    jobs: { total: jobs.length, by: jobByStatus },
    lastActive,
  };
}

// 发现项目 = 注册表登记的 path（保留，即使缺 manifest）+ 扫描根的直接子目录（含 manifest 的自动收录）
async function discoverProjects(root, reg) {
  const seen = new Map(); // abs → regEntry
  // 注册表可能被手工编辑成越出根的超链接路径；越界的条目跳过（fail-open），不拖垮整个工作台
  const safeAbs = (p) => {
    try { return assertWithinRoot(root, p); } catch { return null; }
  };
  for (const p of reg.projects) {
    const abs = safeAbs(p.path);
    if (!abs) continue;
    const exists = await fsp.stat(abs).then(() => true).catch(() => false);
    if (exists) seen.set(abs, p);
  }
  // 扫描直接子目录（深度 1）
  const children = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const c of children) {
    if (!c.isDirectory()) continue;
    const abs = path.join(root, c.name);
    if (seen.has(abs)) continue;
    const hasManifest = await fsp.stat(path.join(abs, "research-manifest.json")).then(() => true).catch(() => false);
    if (hasManifest) seen.set(abs, null);
  }

  // 保证根内所有已登记 path 都被访问（即使目录不存在也保留为 hasManifest:false）
  for (const p of reg.projects) {
    const abs = safeAbs(p.path);
    if (abs && !seen.has(abs)) seen.set(abs, p);
  }

  const views = [];
  for (const [abs, entry] of seen) {
    const e = await projectStatus(root, abs, entry);
    views.push(e);
  }
  // 排序：生命周期进行中优先，其次 lastActive 倒序
  const alive = (s) => (s === "active" ? 0 : s === "paused" ? 1 : s === "finished" ? 2 : 3);
  views.sort((a, b) => {
    const d = alive(a.status) - alive(b.status);
    if (d !== 0) return d;
    return String(b.lastActive).localeCompare(String(a.lastActive));
  });
  return views;
}

function summarize(projects) {
  const byCategory = {};
  const byStatus = {};
  const byPriority = {};
  const total = { hypotheses: 0, experiments: 0, artifacts: 0, reviews: 0, pendingReviews: 0 };
  const runningJobs = { running: 0, submitted: 0, failed: 0 };
  for (const p of projects) {
    byCategory[p.category || "(未分类)"] = (byCategory[p.category || "(未分类)"] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    byPriority[p.priority || DEFAULT_PRIORITY] = (byPriority[p.priority || DEFAULT_PRIORITY] || 0) + 1;
    total.hypotheses += p.counts.hypotheses.total;
    total.experiments += p.counts.experiments.total;
    total.artifacts += p.counts.artifacts;
    total.reviews += p.counts.reviews;
    total.pendingReviews += p.counts.pendingReviews;
    runningJobs.running += p.jobs.by.running || 0;
    runningJobs.submitted += p.jobs.by.submitted || 0;
    runningJobs.failed += p.jobs.by.failed || 0;
  }
  const withManifest = projects.filter((p) => p.hasManifest).length;
  return {
    projects: projects.length,
    withManifest,
    unregistered: projects.filter((p) => !p.registeredAt).length,
    byCategory,
    byStatus,
    byPriority,
    total,
    runningJobs,
  };
}

// ── 分类 / 登记 / 移除 ───────────────────────────────────────────────────────

function cleanPatch(patch = {}) {
  const out = {};
  if (patch.category !== undefined) out.category = String(patch.category).trim();
  if (patch.tags !== undefined) {
    out.tags = core.asList(patch.tags).map((x) => x.toLowerCase());
  }
  if (patch.priority !== undefined) {
    const pr = String(patch.priority).trim().toLowerCase();
    if (!PRIORITIES.includes(pr)) throw core.sciErr("ERR_VALIDATION", `优先级只能是 ${PRIORITIES.join("/")}`);
    out.priority = pr;
  }
  if (patch.status !== undefined) {
    const st = String(patch.status).trim().toLowerCase();
    if (!STATUSES.includes(st)) throw core.sciErr("ERR_VALIDATION", `生命周期状态只能是 ${STATUSES.join("/")}`);
    out.status = st;
  }
  if (patch.notes !== undefined) out.notes = String(patch.notes);
  if (patch.name !== undefined) out.name = String(patch.name).trim();
  if (Array.isArray(patch.categories)) out.categories = patch.categories.map((x) => String(x).trim()).filter(Boolean);
  return out;
}

function ensureEntry(reg, rel) {
  let e = reg.projects.find((x) => x.path === rel);
  if (!e) {
    e = {
      path: rel,
      category: "",
      tags: [],
      priority: DEFAULT_PRIORITY,
      status: DEFAULT_STATUS,
      notes: "",
      registeredAt: core.nowISO(),
      updatedAt: core.nowISO(),
    };
    reg.projects.push(e);
  }
  return e;
}

// 登记/更新分类元数据（原子写 + 锁）；返回该项目的最新视图
async function classifyProject(root, relOrAbs, patch, lockOpts) {
  const abs = assertWithinRoot(root, relOrAbs);
  const rel = relPath(root, abs);
  const exists = await fsp.stat(abs).then(() => true).catch(() => false);
  if (!exists) throw core.sciErr("ERR_NOT_FOUND", `项目目录不存在：${rel}`);
  const cl = cleanPatch(patch || {});
  return core.withFileLock(registryPath(root), async () => {
    const reg = await loadRegistry(root);
    if (cl.categories !== undefined) reg.categories = cl.categories;
    const e = ensureEntry(reg, rel);
    if (cl.name !== undefined) e.name = cl.name;
    if (cl.category !== undefined) e.category = cl.category;
    if (cl.tags !== undefined) e.tags = cl.tags;
    if (cl.priority !== undefined) e.priority = cl.priority;
    if (cl.status !== undefined) e.status = cl.status;
    if (cl.notes !== undefined) e.notes = cl.notes;
    e.updatedAt = core.nowISO();
    await saveRegistry(root, reg);
    core.appendAudit(root, { tool: "research_project_classify", ok: true, project: rel });
    const view = await projectStatus(root, abs, e);
    return { ...view, root, registryFile: reg.file };
  }, lockOpts);
}

async function removeProject(root, relOrAbs, lockOpts) {
  const abs = assertWithinRoot(root, relOrAbs);
  const rel = relPath(root, abs);
  return core.withFileLock(registryPath(root), async () => {
    const reg = await loadRegistry(root);
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((x) => x.path !== rel);
    await saveRegistry(root, reg);
    core.appendAudit(root, { tool: "research_project_remove", ok: true, project: rel });
    return { removed: reg.projects.length < before, path: rel, registryFile: reg.file };
  }, lockOpts);
}

// ── 工作台根探测 ─────────────────────────────────────────────────────────────

// 默认：会话 cwd / args.root 向上找最近 .dsh/.git 标记为工作台根（即"伞"目录）。
// 若 cwd 本身是一个项目子目录，会爬到伞目录，这正好把兄弟项目纳入管理。
async function workbenchRoot(args, exec, markers) {
  return core.resolveRoot(args, exec, markers);
}

// 总览（结构化）；只读
async function workbenchOverview(args, exec, markers) {
  const root = await workbenchRoot(args, exec, markers);
  const reg = await loadRegistry(root);
  const projects = await discoverProjects(root, reg);
  return {
    root,
    registryFile: reg.file,
    categories: reg.categories,
    summary: summarize(projects),
    projects,
    generatedAt: core.nowISO(),
  };
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const lockOpts = {
    timeoutMs: config.lock?.timeoutMs ?? 10000,
    staleMs: config.lock?.staleMs ?? 30000,
  };

  const audit = async (args, exec) => {
    try {
      return await core.resolveRoot(args, exec, markers);
    } catch {
      return undefined;
    }
  };

  // ── research_workbench：总览仪表盘 ──
  ctx.tools.register(core.makeTool({
    name: "research_workbench",
    description:
      "科研工作台总览：扫描工作区（工作台根）下的科研项目子目录（含 research-manifest.json），聚合每个项目的状态（循环阶段、假设/实验状态分布、工件数、待处理评审、远程作业、最近活跃），按分类/状态/优先级汇总。用于多项目分类管理与任务状态追踪。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "工作台根（伞目录，默认自动探测：从工作目录向上找含 .dsh/.git 的目录）" },
      },
    },
    presentTitle: "科研工作台总览",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" },
        registryFile: { type: "string" },
        categories: { type: "array" },
        summary: { type: "object" },
        projects: { type: "array" },
        generatedAt: { type: "string" },
      },
      required: ["root", "summary", "projects", "generatedAt"],
    },
    async execute(args, exec) {
      return workbenchOverview(args, exec, markers);
    },
  }));

  // ── research_project_list：筛选列表 ──
  ctx.tools.register(core.makeTool({
    name: "research_project_list",
    description:
      "科研项目列表（带筛选）：列出工作台根下的科研项目及其状态汇总。可按 category/status/priority/tag 筛选，按 q 搜索标题/领域/标签；which=all 连未分类的一并列出（默认只列已分类+已登记）。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "工作台根（默认自动探测）" },
        category: { type: "string", description: "按分类筛选（空=全部）" },
        status: { type: "string", enum: [...STATUSES], description: "按生命周期状态筛选" },
        priority: { type: "string", enum: PRIORITIES, description: "按优先级筛选" },
        tag: { type: "string", description: "按标签筛选" },
        q: { type: "string", description: "按标题/领域/标签关键字搜索" },
        which: { type: "string", enum: ["classified", "all"], description: "classified=已分类+已登记（默认）；all=含未分类" },
      },
    },
    presentTitle: "科研项目列表",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" },
        count: { type: "number" },
        projects: { type: "array" },
        generatedAt: { type: "string" },
      },
      required: ["root", "count", "projects", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await workbenchRoot(args, exec, markers);
      const reg = await loadRegistry(root);
      const projects = await discoverProjects(root, reg);
      const filtered = projects.filter((p) => {
        if (args.which !== "all" && !p.registeredAt) return false;
        if (args.category && p.category !== args.category) return false;
        if (args.status && p.status !== args.status) return false;
        if (args.priority && p.priority !== args.priority) return false;
        if (args.tag && !p.tags.includes(String(args.tag).toLowerCase())) return false;
        if (args.q) {
          const q = String(args.q).toLowerCase();
          const hay = `${p.title} ${p.domain} ${p.path} ${p.tags.join(" ")}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      return { root, count: filtered.length, projects: filtered, generatedAt: core.nowISO() };
    },
  }));

  // ── research_project_show：单项目详情 ──
  ctx.tools.register(core.makeTool({
    name: "research_project_show",
    description:
      "单个科研项目详情：给出分类元数据 + 完整状态汇总（清单摘要、假设/实验状态分布、工件、评审、远程作业、最近活跃）。path 为项目目录（相对工作台根或绝对，须在工作台根内）。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "工作台根（默认自动探测）" },
        path: { type: "string", description: "项目目录（相对工作台根，须在根内）" },
      },
    },
    presentTitle: "科研项目详情",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" },
        registryFile: { type: "string" },
        project: { type: "object" },
        generatedAt: { type: "string" },
      },
      required: ["root", "project", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await workbenchRoot(args, exec, markers);
      const p = core.requireStr(args, "path");
      const abs = assertWithinRoot(root, p);
      const exists = await fsp.stat(abs).then(() => true).catch(() => false);
      if (!exists) throw core.sciErr("ERR_NOT_FOUND", `项目目录不存在：${p}`);
      const reg = await loadRegistry(root);
      const rel = relPath(root, abs);
      const entry = reg.projects.find((x) => x.path === rel) || null;
      const view = await projectStatus(root, abs, entry);
      return { root, registryFile: reg.file, project: view, generatedAt: core.nowISO() };
    },
  }));

  // ── research_project_register：登记项目 ──
  ctx.tools.register(core.makeTool({
    name: "research_project_register",
    description:
      "把项目目录登记到科研工作台（写入 .dsh/workbench.json 注册表）。自动扫描通常已收录子目录；本工具用于显式登记尚未被扫描到的项目（或为已扫描项目补登记分类元数据）。path 须在工作台根内；可选传 category/tags/priority/status/notes。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "工作台根（默认自动探测）" },
        path: { type: "string", description: "项目目录（相对工作台根，须在根内）" },
        category: { type: "string", description: "分类（可选）" },
        tags: { type: "array", items: { type: "string" }, description: "标签（可选）" },
        priority: { type: "string", enum: PRIORITIES, description: "优先级（可选，默认 medium）" },
        status: { type: "string", enum: STATUSES, description: "生命周期状态（可选，默认 active）" },
        notes: { type: "string", description: "备注（可选）" },
        name: { type: "string", description: "显示名（可选，覆盖清单标题）" },
      },
    },
    presentTitle: "登记科研项目",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" },
        registryFile: { type: "string" },
        project: { type: "object" },
        registered: { type: "boolean" },
        generatedAt: { type: "string" },
      },
      required: ["root", "project", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await workbenchRoot(args, exec, markers);
      const p = core.requireStr(args, "path");
      const view = await classifyProject(root, p, {
        category: args.category,
        tags: args.tags,
        priority: args.priority,
        status: args.status,
        notes: args.notes,
        name: args.name,
      }, lockOpts);
      return { root, registryFile: view.registryFile, project: view, registered: true, generatedAt: core.nowISO() };
    },
  }));

  // ── research_project_classify：更新分类/状态 ──
  ctx.tools.register(core.makeTool({
    name: "research_project_classify",
    description:
      "更新一个项目的分类元数据（patch）：category/tags/priority/status/notes/name。path 为项目目录；只传要改的字段。status ∈ active/paused/finished/archived；priority ∈ high/medium/low。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "工作台根（默认自动探测）" },
        path: { type: "string", description: "项目目录（相对工作台根）" },
        category: { type: "string", description: "分类（如 genomics / pathogen / review）" },
        tags: { type: "array", items: { type: "string" }, description: "标签（整体替换）" },
        priority: { type: "string", enum: PRIORITIES, description: "优先级" },
        status: { type: "string", enum: STATUSES, description: "生命周期状态" },
        notes: { type: "string", description: "备注" },
        name: { type: "string", description: "显示名" },
      },
    },
    presentTitle: "分类科研项目",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" },
        registryFile: { type: "string" },
        project: { type: "object" },
        generatedAt: { type: "string" },
      },
      required: ["root", "project", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await workbenchRoot(args, exec, markers);
      const p = core.requireStr(args, "path");
      const view = await classifyProject(root, p, {
        category: args.category,
        tags: args.tags,
        priority: args.priority,
        status: args.status,
        notes: args.notes,
        name: args.name,
      }, lockOpts);
      return { root, registryFile: view.registryFile, project: view, generatedAt: core.nowISO() };
    },
  }));

  return {
    // 供宿主侧 UI 引擎复用
    registryPath: (r) => registryPath(r),
    loadRegistry,
    saveRegistry,
    discoverProjects,
    projectStatus,
    summarize,
    classifyProject,
    removeProject,
  };
}

// 供宿主侧 UI 引擎（workbench-ui.mjs）复用：这些函数不依赖 ctx/工具的注册，
// 只做注册表读写、项目发现、状态汇总与分类变更（均在应用层带锁/原子写）。
export {
  apply,
  registryPath,
  loadRegistry,
  saveRegistry,
  discoverProjects,
  projectStatus,
  summarize,
  classifyProject,
  removeProject,
  workbenchOverview,
  assertWithinRoot,
  relPath,
  STATUSES,
  PRIORITIES,
  REVIEW_PENDING,
};
