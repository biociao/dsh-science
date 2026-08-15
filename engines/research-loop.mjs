// science-research-loop —— 模仿 Claude Science 研究循环的持久化状态机（ReAct 引擎）
//
// 零第三方依赖（只用 node 内置模块），作为科学模式 preset 的本地插件被挂载。
// 它维护 <项目根>/research-manifest.json：研究问题、假设、实验、发现、循环阶段与历史，
// 让"提问 → 假设 → 实验 → 观察 → 分析 → 结论 → 下一个问题"的循环以结构化状态落盘，
// 跨会话持续（等价于 Claude Science 的 Project + 研究循环）。
//
// v0.1.1 修复（相对 v0.1.0，鲁棒性更新）：
//   A 并发一致性：所有写操作经 withFileLock 串行 + 原子写（tmp+rename），读方永不见半截；
//     ID 改由 nextSeqId（最大编号+1）而非数组长度；loop.iteration 语义统一为"已完成轮次"；
//     manifest schema 升级到 2，带 v1→v2 迁移（向后兼容）。
//   B 校验：假设状态机 proposed→testing→supported/refuted/inconclusive（禁止直跳结论）；
//     阶段只许前进（回退需 config.allowPhaseRewind）；research_review.verdict 枚举校验；
//     research_init 空问题给出警告。
//   C 打通 manifest ↔ artifacts：research_state 实时合并 artifacts/artifacts.json 展示，
//     artifact_save 会把工件登记回写 manifest.artifacts。
//   D 架构：错误码化（ERR_*，不再吞成无类型字符串）；research_state 支持 historyLimit 裁剪；
//     审计日志 <root>/.science.log；新增 research_report（结构化 JSON 输出）；
//     research_experiment 返回下一步建议。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "science-research-loop";

// 需要 tools 服务就绪后才应用（与其它工具插件一致）
export const inject = ["tools"];

// ── 常量 ────────────────────────────────────────────────────────────────────

const SCHEMA = 2;
const MANIFEST_FILE = "research-manifest.json";
const PHASES = ["literature", "hypothesis", "experiment", "analysis", "manuscript", "concluded"];
const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p, i]));
const HYP_STATUSES = ["proposed", "testing", "supported", "refuted", "inconclusive"];
const INITIAL_HYP_STATUSES = ["proposed", "testing"]; // 结论必须经 research_findings/review 产生
const REVIEW_VERDICTS = ["supported", "refuted", "inconclusive", "needs-work"];
const PHASE_LABEL = {
  literature: "文献调研",
  hypothesis: "假设提出",
  experiment: "实验设计",
  analysis: "数据分析",
  manuscript: "论文撰写",
  concluded: "已收束",
};
const STATUS_LABEL = {
  proposed: "已提出",
  testing: "验证中",
  supported: "获得支持",
  refuted: "被否定",
  inconclusive: "尚无定论",
  planned: "已规划",
  running: "运行中",
  concluded: "已结束",
};

// 假设状态机：允许的转移边。结论（supported/refuted/inconclusive）只能从 testing 产生；
// 终态可因新证据回到 testing（重新验证）。
const HYP_TRANSITIONS = {
  proposed: ["testing"],
  testing: ["supported", "refuted", "inconclusive"],
  supported: ["testing"],
  refuted: ["testing"],
  inconclusive: ["testing"],
};

// v1 → v2 迁移：补齐字段默认值（schema 2 起 artifacts/reviews 会真实写入与关联）
const MIGRATIONS = {
  1: (m) => {
    m.project = m.project ?? {};
    m.question = m.question ?? { text: "", updatedAt: "" };
    m.hypotheses = (m.hypotheses || []).map((h) => ({ reviews: [], ...h }));
    m.loop = m.loop ?? { phase: "literature", iteration: 0, history: [] };
    m.loop.history = Array.isArray(m.loop.history) ? m.loop.history : [];
    m.experiments = (m.experiments || []).map((e) => ({ reviews: [], ...e }));
    m.artifacts = Array.isArray(m.artifacts) ? m.artifacts : [];
    m.reviews = Array.isArray(m.reviews) ? m.reviews : [];
    return m;
  },
};

function migrateManifest(m) {
  let v = Number(m?.schema) || 1;
  while (v < SCHEMA) {
    const fn = MIGRATIONS[v];
    if (fn) m = fn(m);
    v += 1;
  }
  m.schema = SCHEMA;
  return m;
}

// ── manifest 读写（原子写；写方在调用处持锁）─────────────────────────────────

async function manifestPath(root) {
  return path.join(root, MANIFEST_FILE);
}

async function loadManifest(root) {
  const p = await manifestPath(root);
  const m = await core.readJson(p, null);
  if (!m) return null;
  try {
    return migrateManifest(m);
  } catch (err) {
    throw core.sciErr("ERR_IO", `研究清单迁移失败 ${p}：${err.message}`);
  }
}

async function saveManifest(root, m) {
  m.updatedAt = core.nowISO();
  await core.writeJsonAtomic(await manifestPath(root), m);
}

// 工件索引（来自 artifact-registry 的 artifacts/artifacts.json，只读合并展示）
async function loadArtifactIndex(root) {
  return core.readJson(path.join(root, "artifacts", "artifacts.json"), { artifacts: [] });
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function renderDashboard(m, artifactIndex) {
  const lines = [];
  lines.push(`# 研究项目：${m.project.title}`);
  lines.push(
    `领域：${m.project.domain} ｜ 状态：${m.project.status} ｜ 循环阶段：${PHASE_LABEL[m.loop.phase] ?? m.loop.phase}（迭代 ${m.loop.iteration}）`
  );
  lines.push("");
  lines.push("## 研究问题");
  lines.push(m.question.text ? m.question.text : "（尚未设定）");
  lines.push("");
  lines.push(`## 假设（${m.hypotheses.length}）`);
  if (m.hypotheses.length === 0) lines.push("（暂无）");
  for (const h of m.hypotheses) {
    lines.push(`- [${h.id}:${STATUS_LABEL[h.status] ?? h.status}] ${h.text}`);
  }
  lines.push("");
  lines.push(`## 实验（${m.experiments.length}）`);
  if (m.experiments.length === 0) lines.push("（暂无）");
  for (const e of m.experiments) {
    lines.push(`- [${e.id}:${STATUS_LABEL[e.status] ?? e.status}] ${e.title}（假设 ${e.hypothesis ?? "—"}）`);
  }
  lines.push("");
  const arts = artifactIndex?.artifacts ?? [];
  lines.push(`## 工件（${arts.length}）｜ 评审（${m.reviews.length}）`);
  if (arts.length > 0) {
    for (const a of arts.slice(-8)) {
      lines.push(`- ${a.name} v${a.latestVersion}${a.deprecated ? "（已废弃）" : ""}`);
    }
  }
  lines.push("");
  const hist = m.loop.history.slice(-6);
  lines.push("## 最近循环历史");
  if (hist.length === 0) lines.push("（暂无）");
  for (const h of hist) {
    lines.push(`- [迭代 ${h.iteration}｜${PHASE_LABEL[h.phase] ?? h.phase}] ${h.action}：${h.detail}`);
  }
  return lines.join("\n");
}

// 仪表盘统一入口：读取工件索引后渲染
async function dashboard(root, m) {
  const idx = await loadArtifactIndex(root);
  return renderDashboard(m, idx);
}

function appendHistory(m, action, detail, phase) {
  m.loop.history.push({
    iteration: m.loop.iteration,
    phase: phase ?? m.loop.phase,
    action,
    detail: String(detail).slice(0, 400),
    at: core.nowISO(),
  });
  const cap = 1000;
  if (m.loop.history.length > cap) m.loop.history.splice(0, m.loop.history.length - cap);
}

async function ensureProjectDirs(root) {
  for (const d of ["experiments", "literature", "artifacts", "analyses", "figures", "manuscript", "reviews", "data", "envs"]) {
    await fsp.mkdir(path.join(root, d), { recursive: true });
  }
}

// ── 阶段与假设状态机 ────────────────────────────────────────────────────────

function phaseIndex(p) {
  const i = PHASE_INDEX[p];
  if (i === undefined) throw core.sciErr("ERR_VALIDATION", `未知阶段 ${p}（可选：${PHASES.join(", ")}）`);
  return i;
}

// 隐式推进（工具自动触发）：只前进，绝不回退、不抛错
function advancePhaseIfForward(m, target) {
  const cur = phaseIndex(m.loop.phase);
  const next = phaseIndex(target);
  if (next > cur) m.loop.phase = target;
}

// 显式推进（research_phase）：只许前进；回退需 config.allowPhaseRewind
function advancePhaseExplicit(m, target, allowRewind) {
  const cur = phaseIndex(m.loop.phase);
  const next = phaseIndex(target);
  if (next < cur && !allowRewind) {
    throw core.sciErr(
      "ERR_VALIDATION",
      `不允许回退阶段：${m.loop.phase} → ${target}（可配置 allowPhaseRewind 开启回退）`
    );
  }
  m.loop.phase = target;
}

function setHypothesisStatus(h, to) {
  const allowed = HYP_TRANSITIONS[h.status] ?? [];
  if (!allowed.includes(to)) {
    throw core.sciErr(
      "ERR_VALIDATION",
      `假设 ${h.id} 不允许状态转移 ${h.status} → ${to}（允许：${allowed.join(", ") || "无"}；结论须先经 testing）`
    );
  }
  h.status = to;
  h.updatedAt = core.nowISO();
}

function findHypothesis(m, id) {
  const h = m.hypotheses.find((x) => x.id === id);
  if (!h) throw core.sciErr("ERR_NOT_FOUND", `假设 ${id} 不存在（当前假设：${m.hypotheses.map((x) => x.id).join(", ") || "无"}）`);
  return h;
}

function findExperiment(m, id) {
  const e = m.experiments.find((x) => x.id === id);
  if (!e) throw core.sciErr("ERR_NOT_FOUND", `实验 ${id} 不存在（当前实验：${m.experiments.map((x) => x.id).join(", ") || "无"}）`);
  return e;
}

// 所有状态变更的入口：加锁 + 加载 + 变更 + 原子保存（锁参数随 apply 配置）
function emptyManifest(title, domain, question) {
  return {
    schema: SCHEMA,
    project: {
      id: core.slugify(title, "research", 40),
      title: title || "未命名研究项目",
      domain: domain || "life-science",
      created: core.nowISO(),
      status: "active",
    },
    question: {
      text: question ? String(question).trim() : "",
      updatedAt: question ? core.nowISO() : "",
    },
    hypotheses: [],
    loop: {
      phase: "literature",
      iteration: 0,
      history: [],
    },
    experiments: [],
    artifacts: [],
    reviews: [],
    updatedAt: core.nowISO(),
  };
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const allowRewind = config.allowPhaseRewind === true;
  const lockOpts = {
    timeoutMs: config.lock?.timeoutMs ?? 10000,
    staleMs: config.lock?.staleMs ?? 30000,
  };

  const audit = async (args, exec) => {
    try {
      const root = await core.resolveRoot(args, exec, markers);
      return root;
    } catch {
      return undefined;
    }
  };

  const withManifestCfg = async (root, fn) =>
    core.withFileLock(
      await manifestPath(root),
      async () => {
        const m = await loadManifest(root);
        if (!m) throw core.sciErr("ERR_NOT_INIT", "项目未初始化，请先调用 research_init");
        const out = await fn(m);
        await saveManifest(root, m);
        return out;
      },
      lockOpts
    );

  // ── research_init：初始化/加载研究项目（等价于 Claude Science 的 Project）──
  ctx.tools.register(core.makeTool({
    name: "research_init",
    description:
      "初始化或加载科研项目（等价于 Claude Science 的 Project）。在项目根创建 research-manifest.json 研究清单，并建立 experiments/、literature/、artifacts/、analyses/、figures/、manuscript/、data/、envs/ 目录。已存在时幂等返回当前状态。研究循环开始时先调用本工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测：从工作目录向上找含 .dsh/.git 的目录）" },
        title: { type: "string", description: "项目标题（仅首次创建时生效）" },
        domain: { type: "string", description: "领域，如 bioinformatics / genomics / pathogen（仅首次创建时生效）" },
        question: { type: "string", description: "核心研究问题（仅首次创建时生效；留空会给出警告）" },
      },
    },
    presentTitle: "初始化科研项目",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const existing = await loadManifest(root);
      if (existing) {
        await ensureProjectDirs(root); // 幂等：目录缺失时补建
        return `项目已存在（${await manifestPath(root)}）。\n\n` + (await dashboard(root, existing));
      }
      const m = emptyManifest(core.optStr(args, "title", ""), core.optStr(args, "domain", "life-science"), args.question);
      await core.withFileLock(await manifestPath(root), async () => {
        await ensureProjectDirs(root);
        await saveManifest(root, m);
      }, lockOpts);
      const readme = path.join(root, "README.md");
      if (!existsSync(readme)) {
        await fsp.writeFile(
          readme,
          [
            `# ${m.project.title}`,
            "",
            `领域：${m.project.domain}`,
            "",
            "本目录是科研项目根。研究状态由 research-manifest.json 维护（由 research_* 工具更新）。",
            "目录约定：experiments/ 实验记录 ｜ literature/ 文献 ｜ artifacts/ 版本化工件与溯源 ｜",
            "analyses/ 分析脚本 ｜ figures/ 图表 ｜ manuscript/ 论文 ｜ data/ 数据 ｜ envs/ 环境记录。",
            "",
          ].join("\n"),
          "utf8"
        );
      }
      const warn = m.question.text ? "" : "\n⚠ 提示：未设置核心研究问题。可用 research_hypothesis 的 question 参数设置。\n";
      return `已初始化科研项目「${m.project.title}」（${root}）。\n${warn}` + (await dashboard(root, m));
    },
  }));

  // ── research_state：查看研究循环当前状态 ──
  ctx.tools.register(core.makeTool({
    name: "research_state",
    description:
      "查看科研项目当前状态（等价于 Claude Science 的项目视图）：研究问题、假设与状态、实验列表、循环阶段/迭代、最近历史（工件来自 artifacts 索引实时合并）。detail=true 时附研究清单 JSON（historyLimit 控制历史条数，默认 50，防止撑爆上下文）。开始任何研究任务前先调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        detail: { type: "boolean", description: "是否附清单 JSON（默认 false）" },
        historyLimit: { type: "integer", description: "detail=true 时历史条数上限（默认 50）" },
      },
    },
    presentTitle: "查看研究状态",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw core.sciErr("ERR_NOT_INIT", `项目未初始化（${root}）。请先调用 research_init 创建研究清单。`);
      let out = await dashboard(root, m);
      if (args.detail) {
        const limit = Number(args.historyLimit ?? 50);
        const view = {
          ...m,
          loop: {
            ...m.loop,
            history: m.loop.history.slice(-Math.max(0, Math.floor(limit))),
          },
        };
        out += "\n\n```json\n" + JSON.stringify(view, null, 2) + "\n```";
      }
      return out;
    },
  }));

  // ── research_hypothesis：登记假设（H1, H2, ...）──
  ctx.tools.register(core.makeTool({
    name: "research_hypothesis",
    description:
      "登记一条研究假设（ReAct 循环的 Hypothesis 步）：追加 H1/H2/… 到研究清单，可选设定核心研究问题与初始状态（仅 proposed/testing；结论必须经 research_findings 或 research_review 产生）。返回当前全部假设。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        text: { type: "string", description: "假设内容（一句话，可证伪）" },
        question: { type: "string", description: "（可选）设定/更新核心研究问题" },
        status: { type: "string", enum: INITIAL_HYP_STATUSES, description: "初始状态，默认 proposed" },
      },
    },
    presentTitle: "登记研究假设",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const text = core.requireStr(args, "text");
      const status = args.status ?? "proposed";
      if (!INITIAL_HYP_STATUSES.includes(status)) {
        throw core.sciErr("ERR_VALIDATION", `初始状态只能是 ${INITIAL_HYP_STATUSES.join("/")}（结论须经研究验证产生）`);
      }
      return withManifestCfg(root, async (m) => {
        const id = core.nextSeqId(m.hypotheses, "H");
        m.hypotheses.push({ id, text, status, experiments: [], reviews: [], updatedAt: core.nowISO() });
        if (args.question && String(args.question).trim()) {
          m.question = { text: String(args.question).trim(), updatedAt: core.nowISO() };
        }
        advancePhaseIfForward(m, "hypothesis");
        appendHistory(m, "hypothesis", `${id}：${text}`);
        return `已登记假设 ${id}。\n\n` + (await dashboard(root, m));
      });
    },
  }));

  // ── research_experiment：登记实验并创建实验目录 ──
  ctx.tools.register(core.makeTool({
    name: "research_experiment",
    description:
      "登记一个实验（ReAct 循环的 Experiment 步）：自动分配 E01/E02/… 编号，创建 experiments/<id>/ 目录（design.md 设计、log.md 日志、code/ 代码、results/ 结果），并写入研究清单。关联假设会推进到 testing 状态。返回实验路径与下一步建议。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        title: { type: "string", description: "实验标题" },
        hypothesis: { type: "string", description: "关联假设 id（如 H1），可为空" },
        objective: { type: "string", description: "实验目的（要检验什么）" },
        plan: { type: "array", items: { type: "string" }, description: "实验步骤列表（或单个字符串）" },
        status: { type: "string", enum: ["planned", "running", "concluded"], description: "初始状态，默认 planned" },
      },
    },
    presentTitle: "登记实验",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const title = core.requireStr(args, "title");
      const objective = core.optStr(args, "objective", "");
      const hyp = core.optStr(args, "hypothesis", "");
      const steps = core.asList(args.plan);
      return withManifestCfg(root, async (m) => {
        const expId = core.nextSeqId(m.experiments, "E", 2);
        const dir = path.join(root, "experiments", expId);
        await fsp.mkdir(path.join(dir, "code"), { recursive: true });
        await fsp.mkdir(path.join(dir, "results"), { recursive: true });
        const design = [
          `# 实验 ${expId}：${title}`,
          "",
          `- 假设：${hyp || "—"}`,
          `- 目的：${objective}`,
          `- 创建：${core.nowISO()}`,
          "",
          "## 设计",
          ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ["（待补充）"]),
          "",
          "## 预期结果",
          "",
          "## 观察（Observation）",
          "",
        ].join("\n");
        await fsp.writeFile(path.join(dir, "design.md"), design, "utf8");
        await fsp.writeFile(path.join(dir, "log.md"), `# 实验日志 ${expId}\n\n- 创建：${core.nowISO()}\n\n`, "utf8");
        await fsp.writeFile(
          path.join(dir, "README.md"),
          `# ${expId}：${title}\n\n- design.md 实验设计\n- log.md 运行日志与发现\n- code/ 代码\n- results/ 结果文件\n`,
          "utf8"
        );
        if (hyp) {
          const h = findHypothesis(m, hyp);
          if (h.status === "proposed") setHypothesisStatus(h, "testing"); // 关联实验即开始验证
          if (!h.experiments.includes(expId)) h.experiments.push(expId);
        }
        m.experiments.push({
          id: expId,
          title,
          hypothesis: hyp || null,
          status: args.status ?? "planned",
          created: core.nowISO(),
          updatedAt: core.nowISO(),
          reviews: [],
        });
        advancePhaseIfForward(m, "experiment");
        appendHistory(m, "experiment", `${expId}：${title}`, "experiment");
        const suggestion = [
          "下一步建议：",
          "1. 把代码写入 experiments/" + expId + "/code/ 并运行，结果放 results/。",
          "2. 运行后用 research_findings 记录观察（finding）；若可下结论，填 conclusion（supported/refuted/inconclusive）更新假设状态。",
          "3. 重要结果用 artifact_save 归档（artifacts/<name>/v<N>/）。",
        ].join("\n");
        return `已登记实验 ${expId}，目录：${dir}\n\n${suggestion}\n\n` + (await dashboard(root, m));
      });
    },
  }));

  // ── research_findings：记录观察与结论，推进循环 ──
  ctx.tools.register(core.makeTool({
    name: "research_findings",
    description:
      "记录实验观察与结论（ReAct 循环的 Observe/Analyze 步）：把 finding 追加到 experiments/<id>/log.md；conclusion 会更新关联假设状态（须经 testing；supported/refuted/inconclusive）并把循环推进到 analysis 阶段；nextQuestion 会更新核心研究问题并开启下一轮迭代（iteration +1）。返回更新后的状态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        experiment: { type: "string", description: "实验编号，如 E01" },
        finding: { type: "string", description: "观察/分析发现（对照实验设计）" },
        conclusion: { type: "string", enum: ["supported", "refuted", "inconclusive"], description: "对关联假设的结论（可选）：supported/refuted/inconclusive（须经 testing）" },
        nextQuestion: { type: "string", description: "（可选）下一轮研究问题，自动推进循环（iteration +1）" },
      },
    },
    presentTitle: "记录发现与结论",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const expId = core.requireStr(args, "experiment");
      const finding = core.requireStr(args, "finding");
      return withManifestCfg(root, async (m) => {
        const exp = findExperiment(m, expId); // 先校验实验存在，再写日志（未知实验不产生垃圾目录）
        // 提前校验结论转移是否合法（避免拒绝时留下半截日志）
        if (args.conclusion && exp.hypothesis) {
          const h0 = findHypothesis(m, exp.hypothesis);
          const allowed = HYP_TRANSITIONS[h0.status] ?? [];
          if (!allowed.includes(args.conclusion)) {
            throw core.sciErr(
              "ERR_VALIDATION",
              `假设 ${h0.id} 不允许状态转移 ${h0.status} → ${args.conclusion}（允许：${allowed.join(", ") || "无"}；结论须先经 testing）`
            );
          }
        }
        const logPath = path.join(root, "experiments", expId, "log.md");
        const stamp = core.nowISO();
        await fsp.mkdir(path.dirname(logPath), { recursive: true });
        await fsp.appendFile(logPath, `\n## ${stamp}\n\n${finding}\n`, "utf8");
        const notes = [`${expId}：${finding}`];
        if (args.conclusion) {
          exp.status = "concluded";
          exp.concludedAt = stamp;
          if (exp.hypothesis) {
            const h = findHypothesis(m, exp.hypothesis);
            setHypothesisStatus(h, args.conclusion);
            h.updatedAt = stamp;
            if (!h.experiments.includes(expId)) h.experiments.push(expId);
            notes.push(`假设 ${h.id} → ${STATUS_LABEL[args.conclusion]}`);
          }
          advancePhaseIfForward(m, "analysis");
        }
        if (args.nextQuestion && String(args.nextQuestion).trim()) {
          m.question = { text: String(args.nextQuestion).trim(), updatedAt: stamp };
          m.loop.iteration = (Number(m.loop.iteration) || 0) + 1; // 统一语义：已完成轮次
          notes.push(`下一轮问题：${m.question.text}`);
        }
        appendHistory(m, "findings", notes.join("；"), "analysis");
        return `已记录：${notes.join("；")}\n\n` + (await dashboard(root, m));
      });
    },
  }));

  // ── research_phase：显式推进循环阶段 ──
  ctx.tools.register(core.makeTool({
    name: "research_phase",
    description:
      "显式推进研究循环阶段：literature（文献调研）→ hypothesis（假设提出）→ experiment（实验设计）→ analysis（数据分析）→ manuscript（论文撰写）→ concluded（收束）。默认只允许前进，回退需配置 allowPhaseRewind。返回更新后的状态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        phase: { type: "string", enum: PHASES, description: "目标阶段" },
      },
    },
    presentTitle: "推进循环阶段",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const phase = core.requireStr(args, "phase");
      return withManifestCfg(root, async (m) => {
        const prev = m.loop.phase;
        advancePhaseExplicit(m, phase, allowRewind);
        if (phase === "concluded") m.project.status = "concluded";
        appendHistory(m, "phase", `${PHASE_LABEL[prev] ?? prev} → ${PHASE_LABEL[phase] ?? phase}`);
        return `循环阶段：${PHASE_LABEL[prev] ?? prev} → ${PHASE_LABEL[phase] ?? phase}\n\n` + (await dashboard(root, m));
      });
    },
  }));

  // ── research_review：登记评审记录（Reviewer 机制的落盘）──
  ctx.tools.register(core.makeTool({
    name: "research_review",
    description:
      "登记一次评审（等价于 Claude Science 的 Reviewer）：把评审结论写入 reviews/R01/…/report.md 并记入研究清单。verdict 枚举：supported / refuted / inconclusive / needs-work。可关联 hypothesis 与 experiment：对 testing 状态的假设，评审结论会更新其状态并记录评审 id。实际评审由科学评审技能（scientific-reviewer）发起子代理执行，本工具负责归档。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        target: { type: "string", description: "评审对象：claim/论断、实验 id、或工件名" },
        verdict: { type: "string", enum: [...REVIEW_VERDICTS, "pending"], description: "结论：supported / refuted / inconclusive / needs-work（缺省 pending）" },
        issues: { type: "array", items: { type: "string" }, description: "发现的问题列表" },
        summary: { type: "string", description: "评审摘要" },
        hypothesis: { type: "string", description: "（可选）关联假设 id，如 H1；testing 状态下会随 verdict 更新状态" },
        experiment: { type: "string", description: "（可选）关联实验 id，如 E01" },
      },
    },
    presentTitle: "登记评审",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const target = core.requireStr(args, "target");
      const verdict = args.verdict ?? "pending";
      if (![...REVIEW_VERDICTS, "pending"].includes(verdict)) {
        throw core.sciErr("ERR_VALIDATION", `verdict 只能是 ${REVIEW_VERDICTS.join(" / ")}`);
      }
      return withManifestCfg(root, async (m) => {
        const id = core.nextSeqId(m.reviews, "R", 2);
        const dir = path.join(root, "reviews", id);
        await fsp.mkdir(dir, { recursive: true });
        const report = [
          `# 评审 ${id}`,
          "",
          `- 对象：${target}`,
          `- 结论：${verdict}`,
          `- 时间：${core.nowISO()}`,
          "",
          "## 摘要",
          core.optStr(args, "summary", ""),
          "",
          "## 问题清单",
          ...(core.asList(args.issues).length ? core.asList(args.issues).map((x, i) => `${i + 1}. ${x}`) : ["（无）"]),
          "",
        ].join("\n");
        await fsp.writeFile(path.join(dir, "report.md"), report, "utf8");
        const notes = [];
        if (args.hypothesis) {
          const h = findHypothesis(m, args.hypothesis);
          if (!h.reviews.includes(id)) h.reviews.push(id);
          // 评审可终结"验证中"的假设；终态假设如需重新验证走 research_experiment
          if (h.status === "testing" && ["supported", "refuted", "inconclusive"].includes(verdict)) {
            setHypothesisStatus(h, verdict);
            notes.push(`假设 ${h.id} → ${STATUS_LABEL[verdict]}`);
          } else {
            notes.push(`假设 ${h.id} 已登记评审 ${id}（当前状态 ${STATUS_LABEL[h.status] ?? h.status}，不改变）`);
          }
        }
        if (args.experiment) {
          const e = findExperiment(m, args.experiment);
          if (!e.reviews.includes(id)) e.reviews.push(id);
        }
        m.reviews.push({ id, target, verdict, created: core.nowISO() });
        appendHistory(m, "review", `${id} 评审 ${target}：${verdict}`, "analysis");
        const extra = notes.length ? "\n" + notes.join("\n") : "";
        return `已登记评审 ${id} → ${path.join(dir, "report.md")}${extra}\n\n` + (await dashboard(root, m));
      });
    },
  }));

  // ── research_report：结构化项目报告（v0.1.1 新增）──
  ctx.tools.register(core.makeTool({
    name: "research_report",
    description:
      "生成科研项目结构化报告（JSON）：研究问题、假设与状态、实验、工件（合并 artifacts 索引）、评审、循环阶段/迭代。适合作为后续分析/写作的结构化输入，输出是 JSON 对象而非文本。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
      },
    },
    presentTitle: "生成结构化项目报告",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        project: { type: "object" },
        question: { type: "object" },
        hypotheses: { type: "array" },
        experiments: { type: "array" },
        artifacts: { type: "array" },
        reviews: { type: "array" },
        loop: { type: "object" },
        generatedAt: { type: "string" },
      },
      required: ["project", "loop", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw core.sciErr("ERR_NOT_INIT", `项目未初始化（${root}）。请先调用 research_init。`);
      const idx = await loadArtifactIndex(root);
      return {
        project: m.project,
        question: m.question,
        hypotheses: m.hypotheses,
        experiments: m.experiments,
        artifacts: idx.artifacts,
        reviews: m.reviews,
        loop: { phase: m.loop.phase, iteration: m.loop.iteration },
        generatedAt: core.nowISO(),
      };
    },
  }));
}

export { apply };
