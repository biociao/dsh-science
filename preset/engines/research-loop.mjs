// science-research-loop —— 模仿 Claude Science 研究循环的持久化状态机（ReAct 引擎）
//
// 该插件零第三方依赖（只用 node 内置模块），作为科学模式 preset 的本地插件被挂载。
// 它维护 <项目根>/research-manifest.json：研究问题、假设、实验、发现、循环阶段与历史，
// 让"提问 → 假设 → 实验 → 观察 → 分析 → 结论 → 下一个问题"的循环以结构化状态落盘，
// 跨会话持续（等价于 Claude Science 的 Project + 研究循环）。
//
// 模块导出：name / inject / apply —— cordis 插件约定（apply 即插件的入口函数）。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";

export const name = "science-research-loop";

// 需要 tools 服务就绪后才应用（与其它工具插件一致）
export const inject = ["tools"];

// ── 常量 ────────────────────────────────────────────────────────────────────

const PHASES = ["literature", "hypothesis", "experiment", "analysis", "manuscript", "concluded"];
const HYP_STATUSES = ["proposed", "testing", "supported", "refuted", "inconclusive"];
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

// ── 小工具 ──────────────────────────────────────────────────────────────────

const nowISO = () => new Date().toISOString();

function slugify(text, fallback) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

// 从会话 cwd 或进程 cwd 向上寻找项目根（含 .dsh 或 .git 标记的目录）
function resolveCwd(exec) {
  try {
    const c = exec?.agent?.session?.cwd;
    if (typeof c === "string" && c.length > 0) return c;
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

function findProjectRoot(start, markers) {
  let dir = path.resolve(start);
  for (;;) {
    for (const m of markers) {
      try {
        if (existsSync(path.join(dir, m))) return dir;
      } catch {
        /* 忽略 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

async function resolveRoot(args, exec, markers) {
  const base = args.root ? path.resolve(resolveCwd(exec), args.root) : resolveCwd(exec);
  return findProjectRoot(base, markers);
}

const MANIFEST_FILE = "research-manifest.json";

async function manifestPath(root) {
  return path.join(root, MANIFEST_FILE);
}

async function loadManifest(root) {
  const p = await manifestPath(root);
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`无法读取研究清单 ${p}：${err.message}`);
  }
}

async function saveManifest(root, m) {
  m.updatedAt = nowISO();
  const p = await manifestPath(root);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(m, null, 2) + "\n", "utf8");
}

function requireStr(args, key) {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`参数 ${key} 必填且不能为空`);
  }
  return v.trim();
}

function optStr(args, key, dflt) {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function emptyManifest(title, domain, question) {
  return {
    schema: 1,
    project: {
      id: slugify(title, "research"),
      title: title || "未命名研究项目",
      domain: domain || "life-science",
      created: nowISO(),
      status: "active",
    },
    question: {
      text: question ? String(question).trim() : "",
      updatedAt: question ? nowISO() : "",
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
    updatedAt: nowISO(),
  };
}

// 渲染"项目仪表盘"文本（工具返回给模型的精选信息）
function renderDashboard(m) {
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
  lines.push(`## 工件（${m.artifacts.length}）｜ 评审（${m.reviews.length}）`);
  lines.push("");
  const hist = m.loop.history.slice(-6);
  lines.push("## 最近循环历史");
  if (hist.length === 0) lines.push("（暂无）");
  for (const h of hist) {
    lines.push(`- [迭代 ${h.iteration}｜${PHASE_LABEL[h.phase] ?? h.phase}] ${h.action}：${h.detail}`);
  }
  return lines.join("\n");
}

function appendHistory(m, action, detail, phase) {
  m.loop.history.push({
    iteration: m.loop.iteration,
    phase: phase ?? m.loop.phase,
    action,
    detail: String(detail).slice(0, 400),
    at: nowISO(),
  });
  const cap = 1000;
  if (m.loop.history.length > cap) m.loop.history.splice(0, m.loop.history.length - cap);
}

async function ensureProjectDirs(root) {
  for (const d of ["experiments", "literature", "artifacts", "analyses", "figures", "manuscript", "reviews", "data", "envs"]) {
    await fsp.mkdir(path.join(root, d), { recursive: true });
  }
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

// 手写工具对象（等价于 defineTool 的产物）：参数为 JSON schema 子集
// （type/properties/required/additionalProperties/items/enum/const/oneOf）。
// execute 返回精选字符串；output.schema 固定为字符串，render 原样透传。
function makeTool({ name, description, parameters, execute, presentTitle }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args, exec) {
      let value;
      try {
        value = await execute(args, exec);
      } catch (err) {
        value = `错误：${err?.message ?? String(err)}`;
      }
      return String(value);
    },
    presentCall: (args) => ({
      card: "generic",
      title: presentTitle,
      kind: "other",
      rawInput: args,
    }),
  };
}

// 注册所有工具到 ctx.tools
function apply(ctx, config) {
  const markers = Array.isArray(config?.markers) && config.markers.length ? config.markers : [".dsh", ".git"];

  // ── research_init：初始化/加载研究项目（等价于 Claude Science 的 Project）──
  ctx.tools.register(makeTool({
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
        question: { type: "string", description: "核心研究问题（仅首次创建时生效）" },
      },
    },
    presentTitle: "初始化科研项目",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const existing = await loadManifest(root);
      if (existing) {
        return `项目已存在（${await manifestPath(root)}）。\n\n` + renderDashboard(existing);
      }
      const m = emptyManifest(optStr(args, "title", ""), optStr(args, "domain", "life-science"), args.question);
      await ensureProjectDirs(root);
      await saveManifest(root, m);
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
      return `已初始化科研项目「${m.project.title}」（${root}）。\n\n` + renderDashboard(m);
    },
  }));

  // ── research_state：查看研究循环当前状态 ──
  ctx.tools.register(makeTool({
    name: "research_state",
    description:
      "查看科研项目当前状态（等价于 Claude Science 的项目视图）：研究问题、假设与状态、实验列表、循环阶段/迭代、最近历史。detail=true 时附完整研究清单 JSON。开始任何研究任务前先调用。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        detail: { type: "boolean", description: "是否附完整清单 JSON（默认 false）" },
      },
    },
    presentTitle: "查看研究状态",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) {
        return `尚未初始化研究项目（${root}）。请先调用 research_init 创建研究清单。`;
      }
      let out = renderDashboard(m);
      if (args.detail) {
        out += "\n\n```json\n" + JSON.stringify(m, null, 2) + "\n```";
      }
      return out;
    },
  }));

  // ── research_hypothesis：登记假设（H1, H2, ...）──
  ctx.tools.register(makeTool({
    name: "research_hypothesis",
    description:
      "登记一条研究假设（ReAct 循环的 Hypothesis 步）：追加 H1/H2/… 到研究清单，可选设定核心研究问题与初始状态。返回当前全部假设。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        text: { type: "string", description: "假设内容（一句话，可证伪）" },
        question: { type: "string", description: "（可选）设定/更新核心研究问题" },
        status: { type: "string", enum: HYP_STATUSES, description: "初始状态，默认 proposed" },
      },
    },
    presentTitle: "登记研究假设",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw new Error("项目未初始化，请先调用 research_init");
      const text = requireStr(args, "text");
      const id = `H${m.hypotheses.length + 1}`;
      m.hypotheses.push({
        id,
        text,
        status: args.status ?? "proposed",
        experiments: [],
        updatedAt: nowISO(),
      });
      if (args.question && String(args.question).trim()) {
        m.question = { text: String(args.question).trim(), updatedAt: nowISO() };
      }
      appendHistory(m, "hypothesis", `${id}：${text}`);
      await saveManifest(root, m);
      return `已登记假设 ${id}。\n\n` + renderDashboard(m);
    },
  }));

  // ── research_experiment：登记实验并创建实验目录 ──
  ctx.tools.register(makeTool({
    name: "research_experiment",
    description:
      "登记一个实验（ReAct 循环的 Experiment 步）：自动分配 E01/E02/… 编号，创建 experiments/<id>/ 目录（design.md 设计、log.md 日志、code/ 代码、results/ 结果），并写入研究清单。返回实验路径与下一步建议。",
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
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw new Error("项目未初始化，请先调用 research_init");
      const title = requireStr(args, "title");
      const objective = optStr(args, "objective", "");
      const hyp = optStr(args, "hypothesis", "");
      if (hyp) {
        const known = m.hypotheses.some((h) => h.id === hyp);
        if (!known) throw new Error(`假设 ${hyp} 不存在（当前假设：${m.hypotheses.map((h) => h.id).join(", ") || "无"}）`);
      }
      const n = m.experiments.length + 1;
      const id = `E${String(n).padStart(2, "0")}`;
      const dir = path.join(root, "experiments", id);
      const steps = asList(args.plan);
      await fsp.mkdir(path.join(dir, "code"), { recursive: true });
      await fsp.mkdir(path.join(dir, "results"), { recursive: true });
      const design = [
        `# 实验 ${id}：${title}`,
        "",
        `- 假设：${hyp || "—"}`,
        `- 目的：${objective}`,
        `- 创建：${nowISO()}`,
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
      await fsp.writeFile(path.join(dir, "log.md"), `# 实验日志 ${id}\n\n- 创建：${nowISO()}\n\n`, "utf8");
      await fsp.writeFile(
        path.join(dir, "README.md"),
        `# ${id}：${title}\n\n- design.md 实验设计\n- log.md 运行日志与发现\n- code/ 代码\n- results/ 结果文件\n`,
        "utf8"
      );
      m.experiments.push({
        id,
        title,
        hypothesis: hyp || null,
        status: args.status ?? "planned",
        created: nowISO(),
        updatedAt: nowISO(),
      });
      m.loop.iteration = m.experiments.length;
      appendHistory(m, "experiment", `${id}：${title}`, "experiment");
      await saveManifest(root, m);
      return `已登记实验 ${id}，目录：${dir}\n\n` + renderDashboard(m);
    },
  }));

  // ── research_findings：记录观察与结论，推进循环 ──
  ctx.tools.register(makeTool({
    name: "research_findings",
    description:
      "记录实验观察与结论（ReAct 循环的 Observe/Analyze 步）：把 finding 追加到 experiments/<id>/log.md；conclusion 会更新关联假设状态（supported/refuted/inconclusive）并把循环推进到 analysis 阶段；nextQuestion 会更新核心研究问题并开启下一轮迭代。返回更新后的状态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        experiment: { type: "string", description: "实验编号，如 E01" },
        finding: { type: "string", description: "观察/分析发现（对照实验设计）" },
        conclusion: { type: "string", enum: HYP_STATUSES, description: "对关联假设的结论（可选）：supported/refuted/inconclusive" },
        nextQuestion: { type: "string", description: "（可选）下一轮研究问题，自动推进循环" },
      },
    },
    presentTitle: "记录发现与结论",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw new Error("项目未初始化，请先调用 research_init");
      const expId = requireStr(args, "experiment");
      const exp = m.experiments.find((e) => e.id === expId);
      if (!exp) throw new Error(`实验 ${expId} 不存在（当前实验：${m.experiments.map((e) => e.id).join(", ") || "无"}）`);
      const finding = requireStr(args, "finding");
      const logPath = path.join(root, "experiments", expId, "log.md");
      const stamp = nowISO();
      await fsp.mkdir(path.dirname(logPath), { recursive: true });
      await fsp.appendFile(logPath, `\n## ${stamp}\n\n${finding}\n`, "utf8");

      const notes = [`${expId}：${finding}`];
      if (args.conclusion) {
        exp.status = "concluded";
        exp.concludedAt = stamp;
        if (exp.hypothesis) {
          const h = m.hypotheses.find((x) => x.id === exp.hypothesis);
          if (h) {
            h.status = args.conclusion;
            h.updatedAt = stamp;
            if (!h.experiments.includes(expId)) h.experiments.push(expId);
            notes.push(`假设 ${h.id} → ${STATUS_LABEL[args.conclusion]}`);
          }
        }
        if (m.loop.phase === "experiment") m.loop.phase = "analysis";
      }
      if (args.nextQuestion && String(args.nextQuestion).trim()) {
        m.question = { text: String(args.nextQuestion).trim(), updatedAt: stamp };
        m.loop.iteration = (m.loop.iteration || 0) + 1;
        notes.push(`下一轮问题：${m.question.text}`);
      }
      appendHistory(m, "findings", notes.join("；"), "analysis");
      await saveManifest(root, m);
      return `已记录：${notes.join("；")}\n\n` + renderDashboard(m);
    },
  }));

  // ── research_phase：显式推进循环阶段 ──
  ctx.tools.register(makeTool({
    name: "research_phase",
    description:
      "显式推进研究循环阶段：literature（文献调研）→ hypothesis（假设提出）→ experiment（实验设计）→ analysis（数据分析）→ manuscript（论文撰写）→ concluded（收束）。返回更新后的状态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        phase: { type: "string", enum: PHASES, description: "目标阶段" },
      },
    },
    presentTitle: "推进循环阶段",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw new Error("项目未初始化，请先调用 research_init");
      const phase = requireStr(args, "phase");
      if (!PHASES.includes(phase)) throw new Error(`未知阶段 ${phase}（可选：${PHASES.join(", ")}）`);
      const prev = m.loop.phase;
      m.loop.phase = phase;
      if (phase === "concluded") m.project.status = "concluded";
      appendHistory(m, "phase", `${PHASE_LABEL[prev] ?? prev} → ${PHASE_LABEL[phase] ?? phase}`);
      await saveManifest(root, m);
      return `循环阶段：${PHASE_LABEL[prev] ?? prev} → ${PHASE_LABEL[phase] ?? phase}\n\n` + renderDashboard(m);
    },
  }));

  // ── research_review：登记评审记录（Reviewer 机制的落盘）──
  ctx.tools.register(makeTool({
    name: "research_review",
    description:
      "登记一次评审（等价于 Claude Science 的 Reviewer）：把评审结论写入 reviews/R01/…/report.md 并记入研究清单。实际评审由科学评审技能（scientific-reviewer）发起子代理执行，本工具负责归档。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        target: { type: "string", description: "评审对象：claim/论断、实验 id、或工件名" },
        verdict: { type: "string", description: "结论：supported / refuted / inconclusive / needs-work" },
        issues: { type: "array", items: { type: "string" }, description: "发现的问题列表" },
        summary: { type: "string", description: "评审摘要" },
      },
    },
    presentTitle: "登记评审",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const m = await loadManifest(root);
      if (!m) throw new Error("项目未初始化，请先调用 research_init");
      const target = requireStr(args, "target");
      const n = m.reviews.length + 1;
      const id = `R${String(n).padStart(2, "0")}`;
      const dir = path.join(root, "reviews", id);
      await fsp.mkdir(dir, { recursive: true });
      const report = [
        `# 评审 ${id}`,
        "",
        `- 对象：${target}`,
        `- 结论：${args.verdict ?? "pending"}`,
        `- 时间：${nowISO()}`,
        "",
        "## 摘要",
        optStr(args, "summary", ""),
        "",
        "## 问题清单",
        ...(asList(args.issues).length ? asList(args.issues).map((x, i) => `${i + 1}. ${x}`) : ["（无）"]),
        "",
      ].join("\n");
      await fsp.writeFile(path.join(dir, "report.md"), report, "utf8");
      m.reviews.push({
        id,
        target,
        verdict: args.verdict ?? "pending",
        created: nowISO(),
      });
      appendHistory(m, "review", `${id} 评审 ${target}：${args.verdict ?? "pending"}`);
      await saveManifest(root, m);
      return `已登记评审 ${id} → ${path.join(dir, "report.md")}\n\n` + renderDashboard(m);
    },
  }));
}

export { apply };
