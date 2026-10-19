// science-roadmap-ui —— 技术路线图 Web 画布面板的宿主侧（webServer REST API）
//
// 浏览器侧的「技术路线图」画布（client/remote-hosts-ui/src/roadmap.js）通过 fetch 调用本
// 插件注册的 HTTP 前缀路由 /dsh-science/roadmap/*，复用 roadmap 引擎（./roadmap.mjs）的
// 同一份数据文件 <项目根>/.dsh/roadmap.json —— 画布上的拖拽、缩放、颜色/形状、连线与版本
// 操作，和 AI 在会话里用 roadmap_* 工具做的改动，落的是同一个文件，互相实时可见。
//
// 除画布 CRUD 外，本层还提供两条「AI 辅助生成」通路：
//   prompt   把当前路线图 + 目标渲染成一段可直接粘贴到 DSH 会话的提示词（让会话里的 agent
//            调用 roadmap_apply 落盘）——不依赖任何模型配置，永远可用；
//   generate 宿主侧直接发起一次 LLM 调用（config.model 显式指定优先，否则回落全局默认模型），
//            要求模型只输出路线图 JSON 规格，解析后用 applySpec 原子落盘 —— 等价于
//            scientific-reviewer 的"引擎侧独立调用"模式。
//
// 零第三方依赖（node 内置模块）。作为 bundle 行挂载于 profile（cordis.patch.yml），不进
// agent preset（面板是 profile 级 UI）。

import path from "node:path";
import * as core from "./core.mjs";
import * as rm from "./roadmap.mjs";
import { isTrustedLocalRequest } from "./http-guard.mjs";

export const name = "science-roadmap-ui";
export const inject = ["webServer"];

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// 来源校验见 ./http-guard.mjs：桌面端（页面 origin 为 dsh-app://app，主进程转发到
// 本机 Host 时会删除 Origin）因此必须放行「无 Origin + 回环 Host」；跨站或不匹配的
// Origin 仍然拒绝。

const fail = (msg) => ({ ok: false, error: String((msg && msg.message) || msg).slice(0, 600) });
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

// ── AI 生成：提示词与输出解析 ───────────────────────────────────────────────

const SPEC_SHAPE = `{
  "doc": { "title": "路线图标题", "description": "一句话说明" },
  "nodes": [
    {
      "ref": "qc",                       // 本规格内的本地别名（edges 用它引用）
      "kind": "step",                    // step | issue | milestone
      "title": "数据质控",                // 必填，唯一可读标题
      "summary": "fastp + 去宿主",
      "status": "planned",               // planned | running | blocked | done | dropped
      "track": "数据",                    // 泳道 / 阶段
      "color": "#4f8ef7",                // #rrggbb 或调色板名
      "shape": "box",                    // box | round | pill | diamond | hexagon | circle | note
      "strategy": "分析策略说明",
      "params": { "q20": 0.9 },          // 超参
      "tests": ["per-base quality"],     // 测试
      "tags": ["qc"],
      "refs": { "experiment": "E01", "artifact": "tab@2", "hypothesis": "H1" }
    }
  ],
  "edges": [
    { "from": "qc", "to": "asm", "type": "serial", "label": "clean reads" }
  ]
}`;

function buildGeneratePrompt(goal, doc) {
  const existing = doc && doc.nodes.length
    ? doc.nodes.map((n) => `- ${n.id}｜${n.title}｜${n.kind}/${n.status}｜泳道 ${n.track}`).join("\n")
    : "（当前路线图为空）";
  const existingEdges = doc && doc.edges.length
    ? doc.edges.map((e) => `- ${e.from} —[${e.type}]→ ${e.to}${e.label ? "（" + e.label + "）" : ""}`).join("\n")
    : "（无）";
  return [
    "你是科研项目的技术路线图设计助手。请把下面的研究目标拆解成一条可执行、可迭代的技术路线图。",
    "",
    "## 研究目标",
    goal,
    "",
    "## 当前路线图已有节点（可复用其 title 使增量生成幂等；也可新建）",
    existing,
    "",
    "## 当前已有关系",
    existingEdges,
    "",
    "## 关系语义（必须严格使用这四种）",
    "- serial   串联：前者完成后后者才开始（严格顺序）",
    "- parallel 并联：两者可并行推进，无先后约束",
    "- feedback 反馈：下游结果回灌上游（例如评估结果反过来修正前处理）",
    "- loop     循环：回到更早节点形成迭代环（例如调参→重跑→再评估）",
    "",
    "## 要求",
    "1. 每个节点是 步骤/issue/里程碑；写清 策略(strategy)、超参(params)、测试(tests)，让不同分析策略的上下游逻辑关系可追溯。",
    "2. 节点数控制在 6~24 个；泳道(track) 按阶段划分（如 数据 / 组装 / 分析 / 验证）。",
    "3. 至少包含 1 条 parallel、1 条 feedback 或 loop，体现可并行与迭代。",
    "4. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块围栏。",
    "",
    "## JSON 结构",
    SPEC_SHAPE,
  ].join("\n");
}

// 从模型输出里抠出 JSON（容忍 ```json 围栏与前后废话）
export function extractSpec(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// 生成结果体检：形状 + 规模上限
function sanitizeSpec(spec, maxNodes) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("模型输出不是 JSON 对象");
  const nodes = Array.isArray(spec.nodes) ? spec.nodes.filter((n) => n && typeof n === "object" && str(n.title)) : [];
  if (!nodes.length) throw new Error("模型输出里没有带 title 的节点");
  if (nodes.length > maxNodes) throw new Error(`模型输出节点过多（${nodes.length} > ${maxNodes}），已拒绝`);
  const edges = Array.isArray(spec.edges)
    ? spec.edges.filter((e) => e && (typeof e.from === "string" || typeof e.from === "number") && (e.to === undefined || e.to === null || typeof e.to === "string" || typeof e.to === "number"))
    : [];
  return { doc: spec.doc && typeof spec.doc === "object" ? spec.doc : undefined, nodes, edges };
}

// ── 处理器 ─────────────────────────────────────────────────────────────────

function makeHandlers(config = {}, ctx) {
  const defaultRoot = str(config.roadmapRoot || config.defaultRoot || "");
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const layoutCfg = { ...rm.DEFAULT_LAYOUT, ...(config.layout || {}) };
  const lockOpts = { timeoutMs: config.lock?.timeoutMs ?? 10000, staleMs: config.lock?.staleMs ?? 30000 };
  const maxNodes = Number(config.ai?.maxNodes) || 40;
  const aiCfg = config.ai && typeof config.ai === "object" ? config.ai : {};
  const aiModel = aiCfg.model && typeof aiCfg.model === "object" ? aiCfg.model : {};

  const rootOf = (a) => {
    const r = str(a.root) || defaultRoot;
    if (!r) throw new Error("缺少项目根（root），请在面板顶部设置");
    return path.resolve(r);
  };

  const fileOf = (root) => rm.roadmapPath(root);

  // 所有写操作：持锁 → 读 → 变更 → 原子写（与引擎工具同一条写路径）
  const mutate = async (root, fn) => {
    const file = fileOf(root);
    return core.withFileLock(file, async () => {
      const doc = await rm.requireRoadmap(root);
      const out = await fn(doc);
      await rm.saveRoadmap(root, doc);
      return { rev: doc.rev, ...out };
    }, lockOpts);
  };

  const requireView = async (root) => {
    const doc = await rm.loadRoadmap(root);
    if (!doc) throw new Error(`路线图未初始化（缺 ${rm.roadmapPath(root)}）：先在画布上点「初始化」或用 AI 生成`);
    return { doc, view: rm.roadmapView(doc, layoutCfg) };
  };

  // 模型解析：config.ai.model 显式指定优先，否则回落全局默认模型
  const resolveModel = () => {
    if (aiModel.provider && aiModel.model) return { provider: aiModel.provider, model: aiModel.model, reasoningEffort: aiModel.reasoningEffort };
    try {
      const adm = ctx.get ? ctx.get("agentDefaultModel") : ctx.agentDefaultModel;
      const sel = adm?.currentSelection?.();
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model, reasoningEffort: aiModel.reasoningEffort };
    } catch {
      /* 服务不可用 */
    }
    return null;
  };

  const callModel = async (prompt) => {
    const model = resolveModel();
    if (!model) throw new Error("无可用模型：请在 cordis.patch.yml 的 science-roadmap-ui 行配置 ai.model {provider, model}");
    const llm = ctx.get ? ctx.get("llm") : ctx.llm;
    if (!llm?.stream) throw new Error("LLM 服务不可用");
    const timeoutMs = Number(aiCfg.timeoutMs) || 180000;
    const iter = llm.stream({
      provider: model.provider,
      model: model.model,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxTokens: Number(aiCfg.maxTokens) || 8000,
      temperature: 0,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    });
    let out = "";
    const consume = (async () => {
      try {
        for await (const chunk of iter) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
        }
      } finally {
        try { await iter.return?.(); } catch { /* 忽略 */ }
      }
    })();
    // 超时护栏：无论谁先完成都清掉定时器，避免残留 timer 挂住进程
    let timer = null;
    try {
      await Promise.race([
        consume,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`生成超时（${timeoutMs}ms）`)), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { text: out, model };
  };

  const author = (a) => str(a.author) || "human";

  return {
    async config() {
      const model = resolveModel();
      // provider 是否已注册：没注册时「AI 生成」必然失败，面板据此提前提示（仍可走「复制提示词」）
      let reachable = null;
      try {
        const llm = ctx.get ? ctx.get("llm") : ctx.llm;
        const providers = await Promise.resolve(llm?.listProviders?.() ?? []);
        if (Array.isArray(providers)) reachable = providers.some((p) => (p?.id ?? p) === model?.provider);
      } catch {
        /* 探测失败则不提示 */
      }
      return {
        ok: true,
        defaultRoot,
        roadmapFile: defaultRoot ? rm.roadmapPath(defaultRoot) : "",
        layout: layoutCfg,
        layoutStyles: rm.LAYOUT_STYLES,
        shapes: rm.SHAPES,
        kinds: rm.KINDS,
        statuses: rm.STATUSES,
        edgeTypes: rm.EDGE_TYPES,
        kindLabel: rm.KIND_LABEL,
        statusLabel: rm.STATUS_LABEL,
        edgeLabel: rm.EDGE_LABEL,
        ai: {
          configured: Boolean(aiModel.provider && aiModel.model),
          provider: model?.provider ?? null,
          model: model?.model ?? null,
          reachable,
          maxNodes,
        },
      };
    },

    async show(a) {
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      if (!doc) {
        return { ok: true, root, file: fileOf(root), initialized: false, roadmap: null };
      }
      return { ok: true, root, file: fileOf(root), initialized: true, roadmap: rm.roadmapView(doc, layoutCfg) };
    },

    async init(a) {
      const root = rootOf(a);
      const file = fileOf(root);
      const created = await core.withFileLock(file, async () => {
        const existing = await rm.loadRoadmap(root);
        if (existing) return false;
        const doc = rm.emptyDoc(root, str(a.title) || "技术路线图");
        if (str(a.description)) doc.description = str(a.description);
        rm.bumpRev(doc, { author: author(a), op: "init", target: "-", note: "面板初始化" });
        await rm.saveRoadmap(root, doc);
        return true;
      }, lockOpts);
      const { view } = await requireView(root);
      return { ok: true, root, file, created, roadmap: view };
    },

    async "node-add"(a) {
      const root = rootOf(a);
      const out = await mutate(root, async (doc) => {
        const node = rm.createNode(doc, a, { author: author(a), note: str(a.note) });
        if (a.pos && typeof a.pos === "object") node.pos = { x: Number(a.pos.x) || 0, y: Number(a.pos.y) || 0 };
        return { node };
      });
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "node-add", node: out.node.id });
      return { ok: true, root, ...out };
    },

    async "node-update"(a) {
      const root = rootOf(a);
      const id = str(a.node);
      if (!id) return fail("缺少 node");
      const out = await mutate(root, async (doc) => {
        const res = rm.patchNode(doc, id, a.patch && typeof a.patch === "object" ? a.patch : a, {
          author: author(a), note: str(a.note),
        });
        return { node: res.node, version: res.version };
      });
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "node-update", node: id });
      return { ok: true, root, ...out };
    },

    async "node-remove"(a) {
      const root = rootOf(a);
      const id = str(a.node);
      if (!id) return fail("缺少 node");
      const out = await mutate(root, async (doc) => rm.removeNode(doc, id, { author: author(a) }));
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "node-remove", node: id });
      return { ok: true, root, ...out };
    },

    async "node-history"(a) {
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      if (!doc) return fail("路线图未初始化");
      const id = str(a.node);
      const node = doc.nodes.find((n) => n.id === id);
      if (!node) return fail(`节点不存在：${id}`);
      const out = {
        ok: true,
        root,
        node: id,
        title: node.title,
        current: node.version,
        versions: node.versions.map((v) => ({
          version: v.version, at: v.at, author: v.author, note: v.note, change: v.change,
          changed: v.changed || [], title: v.snapshot?.title ?? "", status: v.snapshot?.status ?? "",
        })),
      };
      if (a.from !== undefined && a.to !== undefined) {
        out.diff = rm.versionDiff(doc, id, Number(a.from), Number(a.to));
      }
      return out;
    },

    async "node-revert"(a) {
      const root = rootOf(a);
      const id = str(a.node);
      const version = Number(a.version);
      if (!id) return fail("缺少 node");
      if (!Number.isFinite(version)) return fail("缺少 version");
      const out = await mutate(root, async (doc) => {
        const res = rm.revertNode(doc, id, version, { author: author(a), note: str(a.note) });
        return { node: res.node, revertedTo: res.revertedTo, version: res.version };
      });
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "node-revert", node: id, to: version });
      return { ok: true, root, ...out };
    },

    async link(a) {
      const root = rootOf(a);
      const action = str(a.action) || "add";
      const out = await mutate(root, async (doc) => {
        if (action === "remove") return rm.removeLink(doc, str(a.id), { author: author(a) });
        if (action === "update") return { edge: rm.updateLink(doc, a, { author: author(a) }) };
        return { edge: rm.addLink(doc, a, { author: author(a) }) };
      });
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "link-" + action });
      return { ok: true, root, ...out };
    },

    async apply(a) {
      const root = rootOf(a);
      let spec = a.spec;
      if ((!spec || typeof spec !== "object") && typeof a.specJson === "string" && a.specJson.trim()) {
        try { spec = JSON.parse(a.specJson); } catch (err) { return fail(`specJson 解析失败：${err.message}`); }
      }
      if (!spec || typeof spec !== "object") return fail("缺少 spec");
      const file = fileOf(root);
      const out = await core.withFileLock(file, async () => {
        let doc = await rm.loadRoadmap(root);
        if (!doc) {
          doc = rm.emptyDoc(root, spec.doc?.title);
          rm.bumpRev(doc, { author: author(a), op: "init", target: "-", note: "面板 apply 自动初始化" });
        }
        const res = rm.applySpec(doc, spec, {
          mode: str(a.mode) === "replace" ? "replace" : "merge",
          author: author(a),
          note: str(a.note),
          matchTitle: a.matchTitle !== false,
        });
        await rm.saveRoadmap(root, doc);
        return { rev: doc.rev, result: res, roadmap: rm.roadmapView(doc, layoutCfg) };
      }, lockOpts);
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "apply", created: out.result.created.length });
      return { ok: true, root, ...out };
    },

    async layout(a) {
      const root = rootOf(a);
      const mode = str(a.mode) === "manual" ? "manual" : "auto";
      const styleArg = str(a.style);
      const out = await mutate(root, async (doc) => {
        const style = rm.LAYOUT_STYLE_IDS.includes(styleArg) ? styleArg : rm.layoutStyleOf(doc);
        const positions = {};
        if (mode === "manual") {
          const input = a.positions && typeof a.positions === "object" ? a.positions : {};
          for (const [id, p] of Object.entries(input)) {
            const node = doc.nodes.find((n) => n.id === id);
            if (!node) continue;
            node.pos = { x: Math.round(Number(p?.x) || 0), y: Math.round(Number(p?.y) || 0) };
            positions[id] = node.pos;
          }
        } else {
          const auto = rm.autoLayoutPositions(doc, layoutCfg, { style });
          for (const node of doc.nodes) {
            if (!a.overwrite && node.pos) { positions[node.id] = node.pos; continue; }
            node.pos = auto[node.id];
            positions[node.id] = node.pos;
          }
          doc.layoutStyle = style;
        }
        if (a.viewport && typeof a.viewport === "object") {
          doc.viewport = { x: Number(a.viewport.x) || 0, y: Number(a.viewport.y) || 0, k: Number(a.viewport.k) || 1 };
        }
        if (mode === "auto" || rm.LAYOUT_STYLE_IDS.includes(styleArg)) doc.layoutStyle = style;
        // 与工具 path 一致：布局变更写一条 history（不进节点版本），便于回溯谁动了画布
        rm.bumpRev(doc, {
          author: "human",
          op: "layout",
          target: "-",
          note: `布局：${mode}${mode === "auto" ? `·${style}` : ""}（${Object.keys(positions).length} 节点，面板）`,
        });
        return { mode, style, moved: Object.keys(positions).length, positions, viewport: doc.viewport };
      });
      return { ok: true, root, ...out, rev: out.rev };
    },

    async viewport(a) {
      const root = rootOf(a);
      const out = await mutate(root, async (doc) => {
        if (a.viewport && typeof a.viewport === "object") {
          doc.viewport = { x: Number(a.viewport.x) || 0, y: Number(a.viewport.y) || 0, k: Number(a.viewport.k) || 1 };
        }
        return { viewport: doc.viewport };
      });
      return { ok: true, root, ...out };
    },

    async render(a) {
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      if (!doc) return fail("路线图未初始化");
      const format = str(a.format) === "dot" ? "dot" : "mermaid";
      const direction = ["LR", "TB", "RL", "BT"].includes(str(a.direction)) ? str(a.direction) : "LR";
      const text = format === "dot" ? rm.renderDot(doc, { direction }) : rm.renderMermaid(doc, { direction });
      return { ok: true, root, format, direction, text, nodes: doc.nodes.length, edges: doc.edges.length };
    },

    // 不依赖模型：把「目标 + 现有路线图」渲染成可粘贴到会话的提示词
    async prompt(a) {
      const goal = str(a.goal);
      if (!goal) return fail("缺少 goal（这次想生成/扩展什么）");
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      return { ok: true, root, prompt: buildGeneratePrompt(goal, doc), hasRoadmap: Boolean(doc) };
    },

    // 宿主侧 LLM 生成：模型输出 JSON 规格 → applySpec 原子落盘
    async generate(a) {
      const goal = str(a.goal);
      if (!goal) return fail("缺少 goal（这次想生成/扩展什么）");
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      let text = "";
      let model = null;
      try {
        const res = await callModel(buildGeneratePrompt(goal, doc));
        text = res.text;
        model = res.model;
      } catch (err) {
        return fail(err.message);
      }
      const parsed = extractSpec(text);
      if (!parsed) return fail(`模型输出没有可解析的 JSON 规格（返回 ${text.length} 字符）；可改用「复制提示词」交给会话里的 agent`);
      let spec;
      try {
        spec = sanitizeSpec(parsed, maxNodes);
      } catch (err) {
        return fail(err.message);
      }
      const file = fileOf(root);
      const out = await core.withFileLock(file, async () => {
        let d = await rm.loadRoadmap(root);
        if (!d) {
          d = rm.emptyDoc(root, spec.doc?.title || "技术路线图");
          rm.bumpRev(d, { author: "ai", op: "init", target: "-", note: "AI 生成自动初始化" });
        }
        const res = rm.applySpec(d, spec, {
          mode: str(a.mode) === "replace" ? "replace" : "merge",
          author: "ai",
          note: str(a.note) || `AI 生成：${goal.slice(0, 80)}`,
          matchTitle: a.matchTitle !== false,
        });
        await rm.saveRoadmap(root, d);
        return { rev: d.rev, result: res, roadmap: rm.roadmapView(d, layoutCfg) };
      }, lockOpts);
      core.appendAudit(root, { tool: "roadmap_ui", ok: true, op: "generate", created: out.result.created.length });
      return { ok: true, root, model, raw: text.length, ...out };
    },

    async mermaid(a) {
      const root = rootOf(a);
      const doc = await rm.loadRoadmap(root);
      if (!doc) return fail("路线图未初始化");
      return { ok: true, root, text: rm.renderMermaid(doc, { direction: str(a.direction) || "LR" }) };
    },
  };
}

const METHODS = [
  "config", "show", "init", "node-add", "node-update", "node-remove", "node-history",
  "node-revert", "link", "apply", "layout", "viewport", "render", "prompt", "generate", "mermaid",
];

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  const handlers = makeHandlers(config, ctx);
  const disposer = webServer.register({
    kind: "prefix",
    path: "/dsh-science/roadmap",
    async handler(req, res) {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "仅支持 POST" });
      if (!isTrustedLocalRequest(req)) return send(res, 403, { ok: false, error: "请求来源校验失败（Origin 与 Host 不一致，或 Host 不是本机回环地址）" });
      const name = (req.url || "").replace(/^\/dsh-science\/roadmap\/?/, "").split("/")[0];
      if (!name || !METHODS.includes(name)) return send(res, 404, { ok: false, error: `未知方法 ${name}` });
      try {
        const body = await readBody(req);
        const result = await handlers[name](body || {});
        send(res, 200, result);
      } catch (e) {
        send(res, 200, fail(e));
      }
    },
  });
  ctx.on("dispose", disposer);
}

export { apply, makeHandlers, buildGeneratePrompt, sanitizeSpec, METHODS };
