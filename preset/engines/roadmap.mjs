// science-roadmap —— 技术路线图：节点 / 上下游关系 / 版本管理（零第三方依赖）
//
// 把 issue board 升级为「技术路线图」：每个 步骤/issue/step/milestone 是路线图上的一个
// **节点**（可自定义颜色、形状、泳道 track、画布位置），节点之间用**带类型的边**表达上下游
// 逻辑关系：
//   serial   串联：A 完成后 B 开始（严格顺序，实线箭头）
//   parallel 并联：A 与 B 可并行推进（无先后约束，无箭头 + ∥）
//   feedback 反馈：下游把结果回灌给上游（虚线反向箭头，形成回路）
//   loop     循环：回到更早节点形成迭代环（虚线环，A/B 测试 → 调参 → 重跑）
//
// 数据模型 <项目根>/.dsh/roadmap.json（原子写 + 文件锁，跨会话持续）：
//   {
//     schema: 1, title, description, rev,
//     viewport: { x, y, k },                       // 画布视口（拖拽/缩放持久化）
//     nodes: [Node], edges: [Edge],
//     history: [{ rev, at, author, op, target, note }],
//     updatedAt
//   }
//   Node = {
//     id, kind: step|issue|milestone, title, summary, status, track, color, shape,
//     pos: {x,y}, size: {w,h},                     // 画布布局（不进版本）
//     tags: [], strategy,                          // 分析策略
//     params: {},                                  // 超参（自由 JSON）
//     tests: [],                                   // 测试
//     refs: {},                                    // 关联：{experiment:E01, artifact:x@2, hypothesis:H1}
//     owner, version, versions: [NodeVersion], createdAt, updatedAt
//   }
//   NodeVersion = { version, at, author, note, change: create|update|revert|remove,
//                   changed: [字段], snapshot: { 语义字段 } }
//   Edge = { id, from, to, type, label, color, style, createdAt, updatedAt }
//
// 版本管理（对应「每个步骤/issue 都能版本管理，便于项目迭代」）：
//   - **只有语义字段进版本**（kind/title/summary/status/track/color/shape/tags/strategy/
//     params/tests/refs/owner）；画布布局（pos/size）与 viewport 不进版本 —— 拖节点不会污染
//     历史版本。
//   - 每次 node_update 追加一个版本；node_revert 是「追加一个内容等于旧版本快照的新版本」，
//     append-only，永不删除历史（与 artifact-registry 的"废弃≠删除"一致）。
//   - history 是全局操作日志（谁在什么时候改了哪个节点的什么），rev 单调递增。
//
// 工具（全部结构化 JSON 输出）：
//   roadmap_init / roadmap_show / roadmap_node_add / roadmap_node_update /
//   roadmap_node_history / roadmap_node_revert / roadmap_link / roadmap_apply /
//   roadmap_layout / roadmap_render
//
// 宿主侧（webServer REST API，画布用）复用本引擎导出的函数，见 engines/roadmap-ui.mjs。

import path from "node:path";
import * as core from "./core.mjs";

export const name = "science-roadmap";
export const inject = ["tools"];

// ── 常量 ────────────────────────────────────────────────────────────────────

const ROADMAP_SCHEMA = 1;
const ROADMAP_RELPATH = path.join(".dsh", "roadmap.json");

const KINDS = ["step", "issue", "milestone"];
const STATUSES = ["planned", "running", "blocked", "done", "dropped"];
const SHAPES = ["box", "round", "pill", "diamond", "hexagon", "circle", "note"];
const EDGE_TYPES = ["serial", "parallel", "feedback", "loop"];

const KIND_LABEL = { step: "步骤", issue: "issue", milestone: "里程碑" };
const STATUS_LABEL = { planned: "计划", running: "进行中", blocked: "受阻", done: "完成", dropped: "放弃" };
const EDGE_LABEL = { serial: "串联", parallel: "并联", feedback: "反馈", loop: "循环" };

const DEFAULT_KIND = "step";
const DEFAULT_STATUS = "planned";
const DEFAULT_SHAPE = "box";
const DEFAULT_TRACK = "主线";
const DEFAULT_COLOR = "";

// 语义字段（进版本）。pos/size（画布布局）刻意不在其中。
const SEMANTIC_FIELDS = [
  "kind", "title", "summary", "status", "track", "color", "shape",
  "tags", "strategy", "params", "tests", "refs", "owner",
  // I/O 契约与工具：把「输入 → 输出、用什么软件/命令」写进节点本身，画布/导出/MCP 都能看到
  "inputs", "outputs", "tool", "command",
  // 执行进度：完成样本数/百分比（画布上以进度条填充节点图形块）
  "progress",
];
// 画布布局字段（不进版本，但会被持久化）
const LAYOUT_FIELDS = ["pos", "size"];

// 节点默认尺寸（画布用；也是自动布局的间距依据）
const DEFAULT_SIZE = { w: 200, h: 68 };
// 画布布局：节点默认 200×68；列距/行距/泳道距/换行带间距都要给连线留出余量。
const DEFAULT_LAYOUT = { colGap: 250, rowGap: 96, marginX: 60, marginY: 60, trackGap: 118, bandGap: 84 };

// 自动布局里决定"列"的边类型：只有串联/并联表达正向推进；反馈/循环是回边，不推深度。
const FLOW_EDGE_TYPES = ["serial", "parallel"];

const MAX_HISTORY = 2000;

// ── 小工具 ──────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function optStrWithDefault(args, key, dflt) {
  const v = args?.[key];
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

function enumParam(args, key, allowed, dflt) {
  const v = args?.[key];
  if (v === undefined || v === null || v === "") return dflt;
  const s = String(v).trim();
  if (!allowed.includes(s)) {
    throw core.sciErr("ERR_VALIDATION", `${key} 非法：${s}（可选 ${allowed.join(" / ")}）`);
  }
  return s;
}

// 颜色：十六进制（#rgb/#rrggbb/#rrggbbaa）或调色板 token（如 blue / amber-6）
function normColor(v, key = "color") {
  if (v === undefined || v === null || v === "") return DEFAULT_COLOR;
  const s = String(v).trim();
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(s)) return s.toLowerCase();
  if (/^[a-z][a-z0-9-]{0,23}$/.test(s)) return s;
  throw core.sciErr("ERR_VALIDATION", `${key} 必须是 #rrggbb 或调色板名（如 blue）：${s}`);
}

// 自由 JSON 参数：接受对象，也接受 JSON 字符串（AI 传参方便）
function normJsonObject(v, key) {
  if (v === undefined || v === null || v === "") return undefined;
  if (isObj(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (isObj(parsed)) return parsed;
    } catch {
      /* 落到下面报错 */
    }
  }
  throw core.sciErr("ERR_VALIDATION", `${key} 必须是对象或 JSON 对象字符串`);
}

function normPoint(v, key, fields) {
  if (!isObj(v)) throw core.sciErr("ERR_VALIDATION", `${key} 必须是对象 ${fields.join("/")}`);
  const out = {};
  for (const f of fields) {
    const n = Number(v[f]);
    if (!Number.isFinite(n)) throw core.sciErr("ERR_VALIDATION", `${key}.${f} 必须是有限数`);
    out[f] = Math.round(n);
  }
  return out;
}

function normNodeSize(v) {
  const out = normPoint(v, "size", ["w", "h"]);
  out.w = Math.max(80, Math.min(800, out.w));
  out.h = Math.max(40, Math.min(600, out.h));
  return out;
}

function normStringList(v, key) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      /* 逗号/换行分隔 */
    }
    return s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  }
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  throw core.sciErr("ERR_VALIDATION", `${key} 必须是数组或分隔字符串`);
}

// ── 完成进度 ────────────────────────────────────────────────────────────────
// 每个节点可记录执行进度：完成样本数 done / 总数 total（自动折算百分比），或直接给 percent。
// 优先级：显式 percent > done/total > 状态推导（done=100、dropped=0，其余"未知"=null）。
// 「未知」不参与总进度平均，避免把没记录进度的步骤当成 0% 拉低整体。

const clampPercent = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));

// 严格校验（写路径）：接受数字 / {percent} / {done,total} / {done}；null 表示清除
function normProgress(v, key = "progress") {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw core.sciErr("ERR_VALIDATION", `${key} 不能为负数`);
    return { percent: clampPercent(n) };
  }
  if (!isObj(v)) throw core.sciErr("ERR_VALIDATION", `${key} 必须是数字、对象或 null`);
  const out = {};
  if (v.percent !== undefined && v.percent !== null && v.percent !== "") {
    const n = Number(v.percent);
    if (!Number.isFinite(n) || n < 0) throw core.sciErr("ERR_VALIDATION", `${key}.percent 必须是非负数字`);
    out.percent = clampPercent(n);
  }
  if (v.done !== undefined && v.done !== null && v.done !== "") {
    const n = Number(v.done);
    if (!Number.isFinite(n) || n < 0) throw core.sciErr("ERR_VALIDATION", `${key}.done 必须是非负数字`);
    out.done = Math.round(n);
  }
  if (v.total !== undefined && v.total !== null && v.total !== "") {
    const n = Number(v.total);
    if (!Number.isFinite(n) || n <= 0) throw core.sciErr("ERR_VALIDATION", `${key}.total 必须是正数`);
    out.total = Math.round(n);
  }
  if (out.done !== undefined && out.total !== undefined) {
    if (out.done > out.total) throw core.sciErr("ERR_VALIDATION", `${key}.done（${out.done}）不能大于 total（${out.total}）`);
    if (out.percent === undefined) out.percent = clampPercent((out.done / out.total) * 100);
  }
  if (out.percent === undefined && out.done === undefined) {
    throw core.sciErr("ERR_VALIDATION", `${key} 需要 percent 或 done/total 至少一项`);
  }
  if (v.unit !== undefined && v.unit !== null && String(v.unit).trim()) out.unit = String(v.unit).trim().slice(0, 12);
  if (v.note !== undefined && v.note !== null && String(v.note).trim()) out.note = String(v.note).trim().slice(0, 200);
  out.updatedAt = core.nowISO();
  return out;
}

// 宽松归一（读路径/持久化数据可能有历史脏值）
function normProgressLoose(v) {
  try {
    return normProgress(v) ?? null;
  } catch {
    return null;
  }
}

// 节点百分比：显式 percent > done/total > 状态推导
function progressOf(node) {
  const p = node && node.progress;
  if (isObj(p)) {
    if (Number.isFinite(Number(p.percent))) return clampPercent(p.percent);
    if (Number.isFinite(Number(p.done)) && Number.isFinite(Number(p.total)) && Number(p.total) > 0) {
      return clampPercent((Number(p.done) / Number(p.total)) * 100);
    }
    if (Number.isFinite(Number(p.done)) && p.total === undefined) return null; // 只有绝对数、没有分母
  }
  if (node && node.status === "done") return 100;
  if (node && node.status === "dropped") return 0;
  return null;
}

function progressLabel(node) {
  const p = node && node.progress;
  const pct = progressOf(node);
  if (isObj(p) && Number.isFinite(Number(p.done)) && Number.isFinite(Number(p.total))) {
    return `${p.done}/${p.total}${p.unit ? " " + p.unit : ""}${pct !== null ? "（" + pct + "%）" : ""}`;
  }
  if (pct !== null) return pct + "%";
  return "";
}

// 进度汇总（总进度/分泳道/分类型/样本合计）
function progressSummary(nodes) {
  const known = [];
  const samples = { done: 0, total: 0 };
  const byTrack = {};
  const byKind = {};
  const byStatus = {};
  const bump = (bag, key, node) => {
    const k = key || "（未分类）";
    const slot = bag[k] || (bag[k] = { nodes: 0, known: 0, sum: 0, percent: null, done: 0, total: 0 });
    slot.nodes += 1;
    const pct = progressOf(node);
    if (pct !== null) { slot.known += 1; slot.sum += pct; }
    const p = node.progress;
    if (isObj(p) && Number.isFinite(Number(p.done))) slot.done += Number(p.done);
    if (isObj(p) && Number.isFinite(Number(p.total))) slot.total += Number(p.total);
    return slot;
  };
  for (const n of nodes) {
    const pct = progressOf(n);
    if (pct !== null) known.push(pct);
    const p = n.progress;
    if (isObj(p) && Number.isFinite(Number(p.done))) samples.done += Number(p.done);
    if (isObj(p) && Number.isFinite(Number(p.total))) samples.total += Number(p.total);
    bump(byTrack, n.track, n);
    bump(byKind, n.kind, n);
    bump(byStatus, n.status, n);
  }
  const finish = (bag) => {
    for (const slot of Object.values(bag)) slot.percent = slot.known ? Math.round(slot.sum / slot.known) : null;
    return bag;
  };
  finish(byTrack); finish(byKind); finish(byStatus);
  const doneNodes = nodes.filter((n) => n.status === "done").length;
  return {
    overall: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    known: known.length,
    unknown: nodes.length - known.length,
    nodes: nodes.length,
    doneNodes,
    // 无任何显式进度时的兜底口径：按状态"完成节点/总节点"
    doneRatio: nodes.length ? Math.round((doneNodes / nodes.length) * 100) : 0,
    samples: { done: samples.done, total: samples.total, percent: samples.total > 0 ? clampPercent((samples.done / samples.total) * 100) : null },
    byTrack,
    byKind,
    byStatus,
  };
}


// ── 文档读写 ────────────────────────────────────────────────────────────────

function roadmapPath(root) {
  return path.join(root, ROADMAP_RELPATH);
}

function emptyDoc(root, title) {
  return {
    schema: ROADMAP_SCHEMA,
    title: title || "技术路线图",
    description: "",
    rev: 0,
    viewport: { x: 0, y: 0, k: 1 },
    layoutStyle: "compact",
    nodes: [],
    edges: [],
    history: [],
    createdAt: core.nowISO(),
    updatedAt: core.nowISO(),
    root,
  };
}

// 读：不存在返回 null（由调用方决定是 ERR_NOT_INIT 还是「空路线图」）
async function loadRoadmap(root) {
  const file = roadmapPath(root);
  const data = await core.readJson(file, null);
  if (!data) return null;
  return normalizeDoc(data, root, file);
}

function normalizeDoc(data, root, file) {
  const doc = {
    schema: Number(data.schema) || ROADMAP_SCHEMA,
    title: typeof data.title === "string" && data.title.trim() ? data.title : "技术路线图",
    description: typeof data.description === "string" ? data.description : "",
    rev: Number.isFinite(Number(data.rev)) ? Number(data.rev) : 0,
    viewport: isObj(data.viewport) ? { x: Number(data.viewport.x) || 0, y: Number(data.viewport.y) || 0, k: Number(data.viewport.k) || 1 } : { x: 0, y: 0, k: 1 },
    layoutStyle: LAYOUT_STYLE_IDS.includes(data.layoutStyle) ? data.layoutStyle : "compact",
    nodes: Array.isArray(data.nodes) ? data.nodes.map(normalizeNode) : [],
    edges: Array.isArray(data.edges) ? data.edges.map(normalizeEdge).filter(Boolean) : [],
    history: Array.isArray(data.history) ? data.history : [],
    createdAt: data.createdAt || core.nowISO(),
    updatedAt: data.updatedAt || core.nowISO(),
    root,
    file,
  };
  // 丢弃悬空边（防御手工编辑坏数据）
  const ids = new Set(doc.nodes.map((n) => n.id));
  doc.edges = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return doc;
}

function normalizeNode(n) {
  const out = {
    id: String(n.id),
    kind: KINDS.includes(n.kind) ? n.kind : DEFAULT_KIND,
    title: typeof n.title === "string" ? n.title : String(n.id),
    summary: typeof n.summary === "string" ? n.summary : "",
    status: STATUSES.includes(n.status) ? n.status : DEFAULT_STATUS,
    track: typeof n.track === "string" && n.track.trim() ? n.track : DEFAULT_TRACK,
    color: typeof n.color === "string" ? n.color : "",
    shape: SHAPES.includes(n.shape) ? n.shape : DEFAULT_SHAPE,
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
    strategy: typeof n.strategy === "string" ? n.strategy : "",
    params: isObj(n.params) ? n.params : {},
    tests: Array.isArray(n.tests) ? n.tests.map(String) : [],
    refs: isObj(n.refs) ? n.refs : {},
    owner: typeof n.owner === "string" ? n.owner : "",
    inputs: Array.isArray(n.inputs) ? n.inputs.map(String) : [],
    outputs: Array.isArray(n.outputs) ? n.outputs.map(String) : [],
    tool: typeof n.tool === "string" ? n.tool : "",
    command: typeof n.command === "string" ? n.command : "",
    progress: normProgressLoose(n.progress),
    version: Number.isFinite(Number(n.version)) ? Number(n.version) : 1,
    versions: Array.isArray(n.versions) ? n.versions : [],
    createdAt: n.createdAt || core.nowISO(),
    updatedAt: n.updatedAt || core.nowISO(),
  };
  if (isObj(n.pos)) out.pos = { x: Number(n.pos.x) || 0, y: Number(n.pos.y) || 0 };
  if (isObj(n.size)) out.size = { w: Number(n.size.w) || DEFAULT_SIZE.w, h: Number(n.size.h) || DEFAULT_SIZE.h };
  if (!out.versions.length) {
    out.versions = [{
      version: out.version,
      at: out.updatedAt,
      author: "unknown",
      note: "（历史缺失，载入时补建基线）",
      change: "create",
      changed: SEMANTIC_FIELDS.slice(),
      snapshot: snapshotOf(out),
    }];
  }
  return out;
}

function normalizeEdge(e) {
  if (!e || !e.from || !e.to) return null;
  const type = EDGE_TYPES.includes(e.type) ? e.type : "serial";
  return {
    id: String(e.id || ""),
    from: String(e.from),
    to: String(e.to),
    type,
    label: typeof e.label === "string" ? e.label : "",
    color: typeof e.color === "string" ? e.color : "",
    style: typeof e.style === "string" ? e.style : "",
    createdAt: e.createdAt || core.nowISO(),
    updatedAt: e.updatedAt || core.nowISO(),
  };
}

// 原子写（写方在调用处持锁；rev 由 mutate 统一推进）
async function saveRoadmap(root, doc) {
  const out = { ...doc, updatedAt: core.nowISO() };
  delete out.root;
  delete out.file;
  if (out.history.length > MAX_HISTORY) out.history = out.history.slice(-MAX_HISTORY);
  await core.writeJsonAtomic(roadmapPath(root), out);
}

async function requireRoadmap(root) {
  const doc = await loadRoadmap(root);
  if (!doc) {
    throw core.sciErr("ERR_NOT_INIT", `路线图未初始化（缺 ${ROADMAP_RELPATH}）；先调用 roadmap_init`);
  }
  return doc;
}

// ── 版本 ────────────────────────────────────────────────────────────────────

function snapshotOf(node) {
  const snap = {};
  for (const f of SEMANTIC_FIELDS) {
    const v = node[f];
    // 缺失字段统一记 null：这样"回滚到没有 progress 的旧版本"能真正把 progress 清掉，
    // changedFields 的 JSON 比较也不会因 undefined/null 抖动。
    if (v === undefined) snap[f] = null;
    else snap[f] = Array.isArray(v) ? v.slice() : isObj(v) ? JSON.parse(JSON.stringify(v)) : v;
  }
  return snap;
}

// 比较快照与节点，返回变化字段名
function changedFields(node, snapshot) {
  const changed = [];
  for (const f of SEMANTIC_FIELDS) {
    const a = JSON.stringify(node[f] ?? null);
    const b = JSON.stringify(snapshot[f] ?? null);
    if (a !== b) changed.push(f);
  }
  return changed;
}

function pushVersion(node, { author, note, change }) {
  const next = (Number(node.version) || 0) + 1;
  node.version = next;
  node.updatedAt = core.nowISO();
  node.versions = Array.isArray(node.versions) ? node.versions : [];
  node.versions.push({
    version: next,
    at: node.updatedAt,
    author: author || "unknown",
    note: note || "",
    change,
    changed: change === "create" || change === "revert" ? SEMANTIC_FIELDS.slice() : changedFields(node, node.versions[node.versions.length - 1]?.snapshot || {}),
    snapshot: snapshotOf(node),
  });
  return node.versions[node.versions.length - 1];
}

function bumpRev(doc, entry) {
  doc.rev = (Number(doc.rev) || 0) + 1;
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  doc.history.push({ rev: doc.rev, at: core.nowISO(), ...entry });
  return doc.rev;
}

// ── 图算法（SCC / 拓扑 / 深度 / 关键路径 / 自动布局）──────────────────────────

function adjacency(nodes, edges, types) {
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const pred = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (types && !types.includes(e.type)) continue;
    if (!succ.has(e.from) || !succ.has(e.to)) continue;
    succ.get(e.from).push(e.to);
    pred.get(e.to).push(e.from);
  }
  return { succ, pred };
}

// 迭代版 Tarjan：返回强连通分量（每个分量是 id 数组）
function stronglyConnected(ids, succ) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let counter = 0;
  for (const start of ids) {
    if (index.has(start)) continue;
    const work = [{ v: start, i: 0, next: succ.get(start) || [] }];
    index.set(start, counter); low.set(start, counter); counter++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.next.length) {
        const w = frame.next[frame.i++];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0, next: succ.get(w) || [] });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1];
          low.set(parent.v, Math.min(low.get(parent.v), low.get(frame.v)));
        }
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp = [];
          for (;;) {
            const w = stack.pop();
            onStack.delete(w);
            comp.push(w);
            if (w === frame.v) break;
          }
          comps.push(comp);
        }
      }
    }
  }
  return comps;
}

// 图分析：环、根/叶、深度、关键路径
function analyze(doc, layoutCfg = DEFAULT_LAYOUT) {
  const nodes = doc.nodes;
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const edges = doc.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));

  const { succ, pred } = adjacency(nodes, edges);
  const comps = stronglyConnected(ids, succ);
  const compOf = new Map();
  comps.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));

  // 自环（loop/feedback 自反馈）也算一个环
  const selfLoops = edges.filter((e) => e.from === e.to).map((e) => e.from);
  const cycles = comps.filter((c) => c.length > 1).concat(selfLoops.map((id) => [id]));
  const nodesInCycle = new Set(cycles.flat());

  // 凝聚图（去环后的 DAG）上的拓扑 + 深度 + 关键路径
  const cSucc = comps.map(() => new Set());
  for (const e of edges) {
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) cSucc[a].add(b);
  }
  const order = topoOrder(comps.length, cSucc);
  // 关键路径：凝聚图上「节点数最多」的链（长链 = 项目最长依赖链）
  const score = comps.map((c) => c.length);
  const critPrev = new Array(comps.length).fill(-1);
  for (const c of order) {
    for (const d of cSucc[c]) {
      const cand = score[c] + comps[d].length;
      if (cand > score[d]) { score[d] = cand; critPrev[d] = c; }
    }
  }
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < comps.length; i++) {
    if (score[i] > bestScore) { bestScore = score[i]; best = i; }
  }
  const criticalPath = [];
  for (let c = best; c !== -1; c = critPrev[c]) {
    criticalPath.unshift(...comps[c]);
    if (critPrev[c] === -1) break;
  }

  // 深度：只用「串联/并联」子图（反馈/循环是回边，不应把列拉长）
  const depthOf = new Map();
  const flow = adjacency(nodes, edges, FLOW_EDGE_TYPES);
  const flowComps = stronglyConnected(ids, flow.succ);
  const flowCompOf = new Map();
  flowComps.forEach((c, i) => c.forEach((id) => flowCompOf.set(id, i)));
  const fSucc = flowComps.map(() => new Set());
  for (const e of edges) {
    if (!FLOW_EDGE_TYPES.includes(e.type)) continue;
    const a = flowCompOf.get(e.from);
    const b = flowCompOf.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) fSucc[a].add(b);
  }
  const fOrder = topoOrder(flowComps.length, fSucc);
  const fDepth = new Array(flowComps.length).fill(0);
  for (const c of fOrder) for (const d of fSucc[c]) fDepth[d] = Math.max(fDepth[d], fDepth[c] + 1);
  for (const id of ids) depthOf.set(id, fDepth[flowCompOf.get(id)] ?? 0);

  // 根/叶按「正向流」判定：反馈/循环是回边，不应让起点失去"根"的身份
  const roots = ids.filter((id) => (flow.pred.get(id) || []).length === 0);
  const leaves = ids.filter((id) => (flow.succ.get(id) || []).length === 0);

  return {
    ids, edges, succ, pred, comps, compOf, cycles, nodesInCycle,
    depth: depthOf, criticalPath, roots, leaves, layoutCfg,
  };
}

function topoOrder(n, succSets) {
  const indeg = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (const j of succSets[i]) indeg[j]++;
  const queue = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  const order = [];
  while (queue.length) {
    const c = queue.shift();
    order.push(c);
    for (const d of succSets[c]) if (--indeg[d] === 0) queue.push(d);
  }
  for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i); // 防御（理论不可达）
  return order;
}

// 自动布局：紧凑「蛇形」分层布局（确定性、可重复）。
//
//   · 列 = 正向深度（串联/并联推进的层）；深度过长时按 wrapAt 折到下一「带」（band），
//     奇数带左右反向（蛇形），于是带尾到下一带开头的边仍上下相邻，不会横穿画布；
//   · 同一带内按泳道（track）占用的深度区间做「区间装箱」：深度区间不重叠的泳道共享
//     同一行（顺序阶段天然不重叠），只有并行重叠时才另起一行，避免泳道把画布撑高；
//   · 同一格（带 × 列 × 泳道）内的多个节点再向下堆叠 rowGap。
//
// wrapAt 从候选值中选「在标称视口 1400×820 下最易读」的那个：先算整体包围盒的适配
// 比例，再按 1.7 的目标长宽比做小幅惩罚。于是长链不会摊成 4000px 宽的「扁平」长条，
// 而是在接近一屏的比例内展开（例如 17 节点 / 6 泳道 → 约 1320×710，而不是 4260×1060）。
// 自动布局样式表：不同图适合不同排版，面板上可切换（默认 compact）。
//   compact    紧凑蛇形：深度换行 + 泳道区间装箱，接近一屏（长链不会被摊成一条横带）
//   horizontal 横向泳道：每条泳道单独一行、按深度从左到右，层级最清晰但很长（旧版行为）
//   vertical   纵向阶段：阶段自上而下、泳道并排成列，适合窄高面板 / 纯流水线阅读
const LAYOUT_STYLES = [
  { id: "compact", label: "紧凑蛇形", hint: "深度过长自动换行成多带（奇数带反向），接近一屏，适合总览" },
  { id: "horizontal", label: "横向泳道", hint: "每条泳道一行、按深度从左到右，层级最清晰但图会很长" },
  { id: "vertical", label: "纵向阶段", hint: "阶段自上而下、泳道并排成列，适合窄高面板或按阶段通读" },
];
const LAYOUT_STYLE_IDS = LAYOUT_STYLES.map((x) => x.id);
const LAYOUT_VIEWPORT = { w: 1400, h: 820 };

/** 读文档上保存的布局样式（非法/缺失 → compact）。 */
function layoutStyleOf(doc) {
  const s = doc && doc.layoutStyle;
  return LAYOUT_STYLE_IDS.includes(s) ? s : "compact";
}

// 横向泳道：列 = 深度，行 = 泳道；同泳道同深度再向下堆叠。确定性、可重复。
function layoutHorizontal(doc, conf, info) {
  const tracks = trackList(doc);
  const trackIndex = new Map(tracks.map((t, i) => [t, i]));
  const used = new Map(); // `${track}|${depth}` → 已占行数
  const out = {};
  for (const n of doc.nodes) {
    const d = info.depth.get(n.id) ?? 0;
    const t = n.track || DEFAULT_TRACK;
    const key = `${t}|${d}`;
    const stack = used.get(key) || 0;
    used.set(key, stack + 1);
    out[n.id] = {
      x: conf.marginX + d * conf.colGap,
      y: conf.marginY + (trackIndex.get(t) ?? 0) * conf.trackGap + stack * conf.rowGap,
    };
  }
  return out;
}

// 纵向阶段：行 = 深度（自上而下），列 = 泳道；同泳道同深度向下让位。
function layoutVertical(doc, conf, info) {
  const tracks = trackList(doc);
  const trackIndex = new Map(tracks.map((t, i) => [t, i]));
  const pitchY = DEFAULT_SIZE.h + 44; // 68 + 44：阶段之间的行距
  const used = new Map();
  const out = {};
  for (const n of doc.nodes) {
    const d = info.depth.get(n.id) ?? 0;
    const t = n.track || DEFAULT_TRACK;
    const key = `${t}|${d}`;
    const stack = used.get(key) || 0;
    used.set(key, stack + 1);
    out[n.id] = {
      x: conf.marginX + (trackIndex.get(t) ?? 0) * conf.colGap,
      y: conf.marginY + d * pitchY + stack * (DEFAULT_SIZE.h + 24),
    };
  }
  return out;
}

function layoutBounds(doc, pos) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const size = isObj(n.size) ? n.size : DEFAULT_SIZE;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + size.w);
    maxY = Math.max(maxY, p.y + size.h);
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}

// 按给定换行宽度铺一版坐标：带内泳道区间装箱 + 蛇形折行 + 同格堆叠。
function layoutForWrap(doc, conf, info, perRow) {
  const depthOf = (n) => info.depth.get(n.id) ?? 0;
  const depthMax = doc.nodes.reduce((m, n) => Math.max(m, depthOf(n)), 0);
  const rows = Math.ceil((depthMax + 1) / perRow);
  const tracks = trackList(doc);
  const pos = {};
  const used = new Map(); // "row|col|lane" → 已堆叠数量
  let y = conf.marginY;
  for (let row = 0; row < rows; row++) {
    const rowNodes = doc.nodes.filter((n) => Math.floor(depthOf(n) / perRow) === row);
    if (!rowNodes.length) continue;
    // 本带内每条泳道占用的深度区间（列范围）
    const span = new Map();
    for (const n of rowNodes) {
      const t = n.track || DEFAULT_TRACK;
      const d = depthOf(n);
      const s = span.get(t) || { min: d, max: d };
      s.min = Math.min(s.min, d);
      s.max = Math.max(s.max, d);
      span.set(t, s);
    }
    // 区间装箱：深度区间互不重叠的泳道共用一个 lane 行
    const laneOf = new Map();
    const lanes = [];
    for (const t of tracks) {
      const s = span.get(t);
      if (!s) continue;
      let lane = lanes.findIndex((ranges) => ranges.every(([a, b]) => s.max < a || s.min > b));
      if (lane === -1) {
        lanes.push([]);
        lane = lanes.length - 1;
      }
      lanes[lane].push([s.min, s.max]);
      laneOf.set(t, lane);
    }
    const laneCount = Math.max(1, lanes.length);
    for (const n of rowNodes) {
      const d = depthOf(n);
      const col = d % perRow;
      const xCol = row % 2 === 1 ? perRow - 1 - col : col;
      const lane = laneOf.get(n.track || DEFAULT_TRACK) ?? 0;
      const key = row + "|" + col + "|" + lane;
      const stack = used.get(key) || 0;
      used.set(key, stack + 1);
      pos[n.id] = {
        x: conf.marginX + xCol * conf.colGap,
        y: y + lane * conf.trackGap + stack * conf.rowGap,
      };
    }
    y += laneCount * conf.trackGap + conf.bandGap;
  }
  return pos;
}

function layoutCompact(doc, conf, info) {
  const depthMax = doc.nodes.reduce((m, n) => Math.max(m, info.depth.get(n.id) ?? 0), 0);
  const D = depthMax + 1;
  const candidates = [];
  if (D > 5) for (let p = 3; p <= Math.min(D, 10); p++) candidates.push(p);
  if (!candidates.includes(D)) candidates.push(D);
  let best = null;
  for (const perRow of candidates) {
    const pos = layoutForWrap(doc, conf, info, perRow);
    const { w, h } = layoutBounds(doc, pos);
    const scale = Math.min(LAYOUT_VIEWPORT.w / Math.max(1, w), LAYOUT_VIEWPORT.h / Math.max(1, h));
    const aspectPenalty = Math.abs(w / Math.max(1, h) - LAYOUT_VIEWPORT.w / LAYOUT_VIEWPORT.h) * 0.015;
    const score = scale - aspectPenalty;
    if (best === null || score > best.score + 1e-9) best = { pos, score };
  }
  return best.pos;
}

/**
 * 自动布局入口：按样式分发。
 * @param doc 路线图文档
 * @param cfg 布局间距配置（config.layout）
 * @param opts.style 样式 id（compact / horizontal / vertical）；缺省读 doc.layoutStyle，再缺省 compact
 */
function autoLayoutPositions(doc, cfg = {}, opts = {}) {
  const conf = { ...DEFAULT_LAYOUT, ...(cfg || {}) };
  if (!doc.nodes.length) return {};
  const style = LAYOUT_STYLE_IDS.includes(opts.style) ? opts.style : layoutStyleOf(doc);
  const info = analyze(doc, conf);
  if (style === "horizontal") return layoutHorizontal(doc, conf, info);
  if (style === "vertical") return layoutVertical(doc, conf, info);
  return layoutCompact(doc, conf, info);
}

function trackList(doc) {
  const seen = [];
  for (const n of doc.nodes) {
    const t = n.track || DEFAULT_TRACK;
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

// 视口内的节点（供 UI 视图返回带 pos 的完整图）
function withPositions(doc, cfg) {
  const auto = autoLayoutPositions(doc, cfg, { style: layoutStyleOf(doc) });
  return doc.nodes.map((n) => ({
    ...n,
    pos: isObj(n.pos) ? n.pos : auto[n.id],
    size: isObj(n.size) ? n.size : { ...DEFAULT_SIZE },
    autoPos: !isObj(n.pos),
  }));
}

// ── 视图 ────────────────────────────────────────────────────────────────────

function edgeIndex(doc) {
  const byId = new Map();
  const outList = new Map();
  const inList = new Map();
  for (const e of doc.edges) {
    byId.set(e.id, e);
    if (!outList.has(e.from)) outList.set(e.from, []);
    if (!inList.has(e.to)) inList.set(e.to, []);
    outList.get(e.from).push(e);
    inList.get(e.to).push(e);
  }
  return { byId, outList, inList };
}

// I/O 传递关系：节点 outputs ∩ 下游 inputs = 沿这条边传递的产物；并汇总每个产物的
// 生产者/消费者，供面板「数据流」页与 Mermaid/Graphviz 导出使用。
function ioSummary(doc) {
  const produced = new Map();
  const consumed = new Map();
  const push = (map, key, id) => {
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.includes(id)) list.push(id);
  };
  for (const n of doc.nodes) {
    for (const a of n.outputs || []) push(produced, a, n.id);
    for (const a of n.inputs || []) push(consumed, a, n.id);
  }
  const names = [...new Set([...produced.keys(), ...consumed.keys()])].sort();
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const transfers = [];
  for (const e of doc.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const out = new Set(from.outputs || []);
    const artifacts = (to.inputs || []).filter((a) => out.has(a));
    if (artifacts.length) transfers.push({ edge: e.id, from: e.from, to: e.to, type: e.type, artifacts });
  }
  const artifacts = names.map((name) => ({
    name,
    producedBy: produced.get(name) || [],
    consumedBy: consumed.get(name) || [],
  }));
  return {
    artifacts,
    transfers,
    orphanOutputs: artifacts.filter((a) => a.consumedBy.length === 0).map((a) => a.name),
    missingInputs: artifacts.filter((a) => a.producedBy.length === 0).map((a) => a.name),
  };
}

function roadmapView(doc, cfg) {
  const info = analyze(doc, cfg);
  const io = ioSummary(doc);
  const { outList, inList } = edgeIndex(doc);
  const byKind = {};
  for (const k of KINDS) byKind[k] = 0;
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  const byType = {};
  for (const t of EDGE_TYPES) byType[t] = 0;
  for (const n of doc.nodes) { byKind[n.kind] = (byKind[n.kind] || 0) + 1; byStatus[n.status] = (byStatus[n.status] || 0) + 1; }
  for (const e of doc.edges) byType[e.type] = (byType[e.type] || 0) + 1;

  return {
    root: doc.root,
    file: doc.file,
    schema: doc.schema,
    title: doc.title,
    description: doc.description,
    rev: doc.rev,
    viewport: doc.viewport,
    updatedAt: doc.updatedAt,
    tracks: trackList(doc),
    layoutStyle: layoutStyleOf(doc),
    layoutStyles: LAYOUT_STYLES,
    nodes: withPositions(doc, cfg).map((n) => ({
      ...n,
      inCycle: info.nodesInCycle.has(n.id),
      depth: info.depth.get(n.id) ?? 0,
      // 画布直接用这个百分比画填充进度条；null = 未记录进度（不画填充）
      percent: progressOf(n),
      progressText: progressLabel(n),
      upstream: (inList.get(n.id) || []).map((e) => e.from),
      downstream: (outList.get(n.id) || []).map((e) => e.to),
    })),
    edges: doc.edges,
    io,
    progress: progressSummary(doc.nodes),
    stats: {
      nodes: doc.nodes.length,
      edges: doc.edges.length,
      byKind,
      byStatus,
      byType,
      tracks: trackList(doc).length,
      artifacts: io.artifacts.length,
      cycles: info.cycles.map((c) => c.slice()).sort((a, b) => b.length - a.length),
      cycleCount: info.cycles.length,
      nodesInCycle: [...info.nodesInCycle],
      roots: info.roots,
      leaves: info.leaves,
      criticalPath: info.criticalPath,
    },
    history: doc.history.slice(-20).reverse(),
    generatedAt: core.nowISO(),
  };
}

// 单节点详情：上下游传递闭包 + 版本概览
function nodeDetail(doc, nodeId, cfg) {
  const info = analyze(doc, cfg);
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw core.sciErr("ERR_NOT_FOUND", `节点不存在：${nodeId}`);
  const { outList, inList } = edgeIndex(doc);
  const walk = (start, list) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of list.get(cur) || []) {
        const nxt = list === outList ? e.to : e.from;
        if (nxt === start || seen.has(nxt)) continue;
        seen.add(nxt);
        queue.push(nxt);
      }
    }
    return [...seen];
  };
  return {
    node: {
      ...node,
      pos: isObj(node.pos) ? node.pos : autoLayoutPositions(doc, cfg, { style: layoutStyleOf(doc) })[node.id],
      inCycle: info.nodesInCycle.has(nodeId),
      depth: info.depth.get(nodeId) ?? 0,
      percent: progressOf(node),
      progressText: progressLabel(node),
    },
    upstream: walk(nodeId, inList).map((id) => ({ id, title: titleOf(doc, id), via: directEdges(doc, id, nodeId, "in") })),
    downstream: walk(nodeId, outList).map((id) => ({ id, title: titleOf(doc, id), via: directEdges(doc, nodeId, id, "out") })),
    io: {
      inputs: node.inputs || [],
      outputs: node.outputs || [],
      tool: node.tool || "",
      command: node.command || "",
      transfers: ioSummary(doc).transfers.filter((t) => t.from === nodeId || t.to === nodeId),
    },
    incoming: (inList.get(nodeId) || []).map((e) => ({ ...e })),
    outgoing: (outList.get(nodeId) || []).map((e) => ({ ...e })),
    versionCount: node.versions.length,
    versions: node.versions.map(summarizeVersion),
  };
}

function titleOf(doc, id) {
  return doc.nodes.find((n) => n.id === id)?.title || id;
}

function directEdges(doc, from, to, dir) {
  const edges = doc.edges.filter((e) => (dir === "out" ? e.from === from && e.to === to : e.to === to && e.from === from));
  return edges.map((e) => ({ id: e.id, type: e.type, label: e.label }));
}

function summarizeVersion(v) {
  return {
    version: v.version,
    at: v.at,
    author: v.author,
    note: v.note,
    change: v.change,
    changed: v.changed || [],
    title: v.snapshot?.title ?? "",
    status: v.snapshot?.status ?? "",
    kind: v.snapshot?.kind ?? "",
  };
}

function versionDiff(doc, nodeId, fromV, toV) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw core.sciErr("ERR_NOT_FOUND", `节点不存在：${nodeId}`);
  const pick = (v) => node.versions.find((x) => x.version === v);
  const a = pick(fromV);
  const b = pick(toV);
  if (!a) throw core.sciErr("ERR_NOT_FOUND", `版本不存在：v${fromV}`);
  if (!b) throw core.sciErr("ERR_NOT_FOUND", `版本不存在：v${toV}`);
  const fields = {};
  for (const f of SEMANTIC_FIELDS) {
    const x = a.snapshot?.[f];
    const y = b.snapshot?.[f];
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) fields[f] = { from: x ?? null, to: y ?? null };
  }
  return { node: nodeId, from: fromV, to: toV, changed: Object.keys(fields), fields };
}

// ── 渲染（mermaid / dot）────────────────────────────────────────────────────

const escMermaid = (s) => String(s ?? "").replace(/"/g, "'").replace(/\n+/g, " ");

function mermaidShape(shape, id, text) {
  const t = escMermaid(text);
  switch (shape) {
    case "round": return `${id}("${t}")`;
    case "pill": return `${id}(["${t}"])`;
    case "diamond": return `${id}{"${t}"}`;
    case "hexagon": return `${id}{{"${t}"}}`;
    case "circle": return `${id}(("${t}"))`;
    case "note": return `${id}>"${t}"]`;
    default: return `${id}["${t}"]`;
  }
}

function renderMermaid(doc, opts = {}) {
  const dir = opts.direction || "LR";
  const lines = [`flowchart ${dir}`];
  const usedColors = new Map();
  const io = ioSummary(doc);
  const transferOf = new Map(io.transfers.map((t) => [t.edge, t.artifacts]));
  for (const n of doc.nodes) {
    const label = [`${n.id}. ${n.title}`, `${KIND_LABEL[n.kind] || n.kind} · ${STATUS_LABEL[n.status] || n.status}${n.track ? " · " + n.track : ""}`];
    const pct = progressOf(n);
    if (pct !== null) label.push(`进度 ${progressLabel(n) || pct + "%"}`);
    if (n.summary) label.push(escMermaid(n.summary).slice(0, 80));
    if (n.tool) label.push("⚙ " + escMermaid(n.tool).slice(0, 80));
    const html = label.join("<br/>");
    lines.push(`  ${mermaidShape(n.shape, n.id, html)}`);
    if (n.color) {
      const cls = usedColors.get(n.color) || `rmc${usedColors.size + 1}`;
      usedColors.set(n.color, cls);
    }
  }
  for (const e of doc.edges) {
    const ioArtifacts = transferOf.get(e.id);
    const lbl = e.label || (ioArtifacts && ioArtifacts.length ? ioArtifacts.join(" / ") : (EDGE_LABEL[e.type] || e.type));
    if (e.type === "serial") lines.push(`  ${e.from} -->|${escMermaid(lbl)}| ${e.to}`);
    else if (e.type === "parallel") lines.push(`  ${e.from} ---|${escMermaid(lbl)}| ${e.to}`);
    else lines.push(`  ${e.from} -.->|${escMermaid(lbl)}| ${e.to}`);
  }
  for (const [color, cls] of usedColors) lines.push(`  classDef ${cls} fill:${color},color:#fff,stroke:${color}`);
  for (const n of doc.nodes) {
    if (n.color && usedColors.has(n.color)) lines.push(`  class ${n.id} ${usedColors.get(n.color)}`);
  }
  return lines.join("\n");
}

const DOT_SHAPES = { box: "box", round: "box", pill: "box", diamond: "diamond", hexagon: "hexagon", circle: "circle", note: "note" };
const escDot = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n+/g, "\\n");

function renderDot(doc, opts = {}) {
  const dir = opts.direction || "LR";
  const lines = ["digraph roadmap {", `  rankdir=${dir};`, '  node [style="rounded,filled", fontname="Helvetica"];'];
  const io = ioSummary(doc);
  const transferOf = new Map(io.transfers.map((t) => [t.edge, t.artifacts]));
  for (const n of doc.nodes) {
    let text = `${escDot(n.id + ". " + n.title)}\\n${escDot(KIND_LABEL[n.kind] || n.kind)} · ${escDot(STATUS_LABEL[n.status] || n.status)}`;
    if (n.tool) text += "\\n⚙ " + escDot(n.tool);
    const attrs = [`label="${text}"`, `shape=${DOT_SHAPES[n.shape] || "box"}`];
    if (n.color && /^#/.test(n.color)) attrs.push(`fillcolor="${n.color}"`, 'fontcolor="#ffffff"');
    else attrs.push('fillcolor="#f5f6f8"');
    lines.push(`  "${escDot(n.id)}" [${attrs.join(", ")}];`);
  }
  for (const e of doc.edges) {
    const ioArtifacts = transferOf.get(e.id);
    const lbl = e.label || (ioArtifacts && ioArtifacts.length ? ioArtifacts.join(" / ") : (EDGE_LABEL[e.type] || e.type));
    const attrs = [`label="${escDot(lbl)}"`];
    if (e.type !== "serial") attrs.push("style=dashed");
    if (e.type === "parallel") attrs.push("dir=none");
    lines.push(`  "${escDot(e.from)}" -> "${escDot(e.to)}" [${attrs.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

// ── 变更操作（写路径：调用处统一持锁）───────────────────────────────────────

function findNode(doc, id) {
  const n = doc.nodes.find((x) => x.id === id);
  if (!n) throw core.sciErr("ERR_NOT_FOUND", `节点不存在：${id}`);
  return n;
}

function assertNoDuplicateEdge(doc, from, to, type, ignoreId) {
  const dup = doc.edges.find((e) => e.id !== ignoreId && e.from === from && e.to === to && e.type === type);
  if (dup) throw core.sciErr("ERR_VALIDATION", `重复的${EDGE_LABEL[type] || type}关系已存在：${from} → ${to}（${dup.id}）`);
}

function createNode(doc, input, meta = {}) {
  const id = input.id ? String(input.id) : core.nextSeqId(doc.nodes, "n");
  if (doc.nodes.some((n) => n.id === id)) throw core.sciErr("ERR_VALIDATION", `节点 id 已存在：${id}`);
  const title = core.requireStr(input, "title");
  const kind = input.kind === undefined || input.kind === null || input.kind === ""
    ? DEFAULT_KIND : enumParam(input, "kind", KINDS, DEFAULT_KIND);
  const status = input.status === undefined || input.status === null || input.status === ""
    ? (meta.defaultStatus || DEFAULT_STATUS) : enumParam(input, "status", STATUSES, DEFAULT_STATUS);
  const shape = input.shape === undefined || input.shape === null || input.shape === ""
    ? DEFAULT_SHAPE : enumParam(input, "shape", SHAPES, DEFAULT_SHAPE);
  const node = {
    id,
    kind,
    title,
    summary: optStrWithDefault(input, "summary", ""),
    status,
    track: optStrWithDefault(input, "track", DEFAULT_TRACK) || DEFAULT_TRACK,
    color: input.color ? normColor(input.color) : DEFAULT_COLOR,
    shape,
    tags: normStringList(input.tags, "tags") || [],
    strategy: optStrWithDefault(input, "strategy", ""),
    params: normJsonObject(input.params, "params") || {},
    tests: normStringList(input.tests, "tests") || [],
    refs: normJsonObject(input.refs, "refs") || {},
    owner: optStrWithDefault(input, "owner", ""),
    inputs: normStringList(input.inputs, "inputs") || [],
    outputs: normStringList(input.outputs, "outputs") || [],
    tool: optStrWithDefault(input, "tool", ""),
    command: optStrWithDefault(input, "command", ""),
    progress: normProgress(input.progress) ?? null,
    version: 0,
    versions: [],
    createdAt: core.nowISO(),
    updatedAt: core.nowISO(),
  };
  node.version = 1;
  node.versions.push({
    version: 1,
    at: node.updatedAt,
    author: meta.author || "human",
    note: meta.note || "",
    change: "create",
    changed: SEMANTIC_FIELDS.slice(),
    snapshot: snapshotOf(node),
  });
  doc.nodes.push(node);
  bumpRev(doc, { author: meta.author || "human", op: "node_add", target: id, note: `新建「${title}」` });
  return node;
}

function patchNode(doc, id, patch, meta = {}) {
  const node = findNode(doc, id);
  const applied = [];
  const assign = (f, v, fn) => {
    const nv = fn ? fn(v) : v;
    if (nv === undefined) return;
    node[f] = nv;
    applied.push(f);
  };
  if (patch.kind !== undefined) assign("kind", patch.kind, (v) => enumParam({ kind: v }, "kind", KINDS, node.kind));
  if (patch.title !== undefined) assign("title", patch.title, (v) => { const s = String(v).trim(); if (!s) throw core.sciErr("ERR_VALIDATION", "title 不能为空"); return s; });
  if (patch.summary !== undefined) assign("summary", patch.summary, (v) => String(v));
  if (patch.status !== undefined) assign("status", patch.status, (v) => enumParam({ status: v }, "status", STATUSES, node.status));
  if (patch.track !== undefined) assign("track", patch.track, (v) => String(v).trim() || DEFAULT_TRACK);
  if (patch.color !== undefined) assign("color", patch.color, (v) => normColor(v));
  if (patch.shape !== undefined) assign("shape", patch.shape, (v) => enumParam({ shape: v }, "shape", SHAPES, node.shape));
  if (patch.tags !== undefined) assign("tags", patch.tags, (v) => normStringList(v, "tags") || []);
  if (patch.strategy !== undefined) assign("strategy", patch.strategy, (v) => String(v));
  if (patch.params !== undefined) assign("params", patch.params, (v) => normJsonObject(v, "params") || {});
  if (patch.tests !== undefined) assign("tests", patch.tests, (v) => normStringList(v, "tests") || []);
  if (patch.refs !== undefined) assign("refs", patch.refs, (v) => normJsonObject(v, "refs") || {});
  if (patch.owner !== undefined) assign("owner", patch.owner, (v) => String(v));
  if (patch.inputs !== undefined) assign("inputs", patch.inputs, (v) => normStringList(v, "inputs") || []);
  if (patch.outputs !== undefined) assign("outputs", patch.outputs, (v) => normStringList(v, "outputs") || []);
  if (patch.tool !== undefined) assign("tool", patch.tool, (v) => String(v));
  if (patch.command !== undefined) assign("command", patch.command, (v) => String(v));
  // 进度：null 表示清除；数字/对象走严格校验（done 不能大于 total）
  if (patch.progress !== undefined) {
    const p = normProgress(patch.progress);
    node.progress = p ?? null;
    applied.push("progress");
  }

  // 布局字段：不进版本
  let layoutChanged = false;
  if (patch.pos !== undefined && patch.pos !== null) { node.pos = normPoint(patch.pos, "pos", ["x", "y"]); layoutChanged = true; }
  if (patch.size !== undefined && patch.size !== null) { node.size = normNodeSize(patch.size); layoutChanged = true; }

  if (!applied.length) {
    if (layoutChanged) return { node, version: null, changed: [] };
    throw core.sciErr("ERR_VALIDATION", "没有任何可更新的字段");
  }
  const version = pushVersion(node, { author: meta.author, note: meta.note, change: "update" });
  bumpRev(doc, { author: meta.author || "unknown", op: "node_update", target: id, note: `${meta.note || "更新"}（v${version.version}：${version.changed.join(",") || "无变化"}）` });
  return { node, version, changed: version.changed };
}

function removeNode(doc, id, meta = {}) {
  const node = findNode(doc, id);
  const removedEdges = doc.edges.filter((e) => e.from === id || e.to === id).map((e) => e.id);
  doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id);
  doc.nodes = doc.nodes.filter((n) => n.id !== id);
  bumpRev(doc, { author: meta.author || "unknown", op: "node_remove", target: id, note: `删除「${node.title}」及其 ${removedEdges.length} 条关系` });
  return { removed: true, id, title: node.title, removedEdges, versions: node.versions.length };
}

function addLink(doc, input, meta = {}) {
  const from = core.requireStr(input, "from");
  const to = input.to === undefined || input.to === null || input.to === "" ? from : String(input.to).trim();
  findNode(doc, from);
  findNode(doc, to);
  const type = input.type === undefined || input.type === null || input.type === "" ? "serial" : enumParam(input, "type", EDGE_TYPES, "serial");
  if (from === to && type !== "loop" && type !== "feedback") {
    throw core.sciErr("ERR_VALIDATION", `自环只允许 loop/feedback（自反馈），当前为 ${type}`);
  }
  assertNoDuplicateEdge(doc, from, to, type);
  const edge = {
    id: input.id ? String(input.id) : core.nextSeqId(doc.edges, "e"),
    from,
    to,
    type,
    label: optStrWithDefault(input, "label", ""),
    color: input.color ? normColor(input.color) : "",
    style: optStrWithDefault(input, "style", ""),
    createdAt: core.nowISO(),
    updatedAt: core.nowISO(),
  };
  doc.edges.push(edge);
  bumpRev(doc, { author: meta.author || "human", op: "link_add", target: edge.id, note: `${from} —[${EDGE_LABEL[type]}]→ ${to}` });
  return edge;
}

function updateLink(doc, input, meta = {}) {
  const id = core.requireStr(input, "id");
  const edge = doc.edges.find((e) => e.id === id);
  if (!edge) throw core.sciErr("ERR_NOT_FOUND", `关系不存在：${id}`);
  const next = { ...edge };
  if (input.from !== undefined) { next.from = String(input.from).trim(); findNode(doc, next.from); }
  if (input.to !== undefined) { next.to = String(input.to).trim(); findNode(doc, next.to); }
  if (input.type !== undefined) next.type = enumParam(input, "type", EDGE_TYPES, edge.type);
  if (input.label !== undefined) next.label = String(input.label);
  if (input.color !== undefined) next.color = normColor(input.color);
  if (input.style !== undefined) next.style = String(input.style);
  if (next.from === next.to && next.type !== "loop" && next.type !== "feedback") {
    throw core.sciErr("ERR_VALIDATION", `自环只允许 loop/feedback（自反馈），当前为 ${next.type}`);
  }
  assertNoDuplicateEdge(doc, next.from, next.to, next.type, id);
  Object.assign(edge, next, { updatedAt: core.nowISO() });
  bumpRev(doc, { author: meta.author || "unknown", op: "link_update", target: id, note: `${edge.from} —[${EDGE_LABEL[edge.type]}]→ ${edge.to}` });
  return edge;
}

function removeLink(doc, id, meta = {}) {
  const edge = doc.edges.find((e) => e.id === id);
  if (!edge) throw core.sciErr("ERR_NOT_FOUND", `关系不存在：${id}`);
  doc.edges = doc.edges.filter((e) => e.id !== id);
  bumpRev(doc, { author: meta.author || "unknown", op: "link_remove", target: id, note: `删除关系 ${edge.from} → ${edge.to}` });
  return { removed: true, id, from: edge.from, to: edge.to };
}

function revertNode(doc, id, version, meta = {}) {
  const node = findNode(doc, id);
  const target = node.versions.find((v) => v.version === Number(version));
  if (!target) throw core.sciErr("ERR_NOT_FOUND", `版本不存在：v${version}（节点 ${id} 共 ${node.versions.length} 版）`);
  for (const f of SEMANTIC_FIELDS) {
    const v = target.snapshot?.[f];
    node[f] = Array.isArray(v) ? v.slice() : isObj(v) ? JSON.parse(JSON.stringify(v)) : (v ?? node[f]);
  }
  const entry = pushVersion(node, { author: meta.author, note: meta.note || `回滚到 v${target.version}`, change: "revert" });
  bumpRev(doc, { author: meta.author || "unknown", op: "node_revert", target: id, note: `回滚到 v${target.version}（新版本 v${entry.version}，历史保留）` });
  return { node, version: entry, revertedTo: target.version };
}

// AI 辅助生成 / 批量导入：一次事务内建节点 + 连边（原子）
function applySpec(doc, spec, opts = {}) {
  const mode = opts.mode === "replace" ? "replace" : "merge";
  const author = opts.author || "ai";
  const note = opts.note || "";
  const matchTitle = opts.matchTitle !== false;
  const created = [];
  const updated = [];
  const edgesAdded = [];
  const edgesSkipped = [];
  const nodeMap = {}; // spec ref → node id

  if (mode === "replace") {
    const removedNodes = doc.nodes.map((n) => n.id);
    doc.nodes = [];
    doc.edges = [];
    bumpRev(doc, { author, op: "apply_replace", target: "-", note: `重建路线图：清空 ${removedNodes.length} 节点（历史保留）` });
  }

  const findExisting = (input) => {
    if (input.id) {
      const byId = doc.nodes.find((n) => n.id === String(input.id));
      if (byId) return byId;
    }
    if (input.ref) {
      const mapped = nodeMap[input.ref];
      if (mapped) return doc.nodes.find((n) => n.id === mapped);
      const byRefId = doc.nodes.find((n) => n.id === String(input.ref));
      if (byRefId) return byRefId;
    }
    if (matchTitle && input.title) {
      const t = String(input.title).trim();
      const hits = doc.nodes.filter((n) => n.title === t);
      if (hits.length === 1) return hits[0];
    }
    return null;
  };

  for (const raw of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (!isObj(raw)) throw core.sciErr("ERR_VALIDATION", "spec.nodes 的每一项必须是对象");
    const input = { ...raw };
    const ref = input.ref ? String(input.ref) : (input.id ? String(input.id) : "");
    const existing = mode === "merge" ? findExisting(input) : null;
    delete input.ref;
    if (existing) {
      const patch = {};
      for (const f of [...SEMANTIC_FIELDS, ...LAYOUT_FIELDS]) if (input[f] !== undefined) patch[f] = input[f];
      if (input.id !== undefined) delete patch.id;
      const res = Object.keys(patch).length ? patchNode(doc, existing.id, patch, { author, note: note || "AI 批量更新" }) : { node: existing, changed: [] };
      if (ref) nodeMap[ref] = existing.id;
      nodeMap[existing.id] = existing.id;
      updated.push({ id: existing.id, ref: ref || null, changed: res.changed || [] });
    } else {
      const node = createNode(doc, input, { author, note: note || "AI 生成", defaultStatus: opts.defaultStatus });
      if (ref) nodeMap[ref] = node.id;
      created.push({ id: node.id, ref: ref || null, title: node.title });
    }
  }

  const resolve = (key) => {
    const k = String(key);
    if (nodeMap[k]) return nodeMap[k];
    if (doc.nodes.some((n) => n.id === k)) return k;
    throw core.sciErr("ERR_NOT_FOUND", `spec.edges 引用了未知节点：${k}（可用 ref 或已有节点 id）`);
  };

  for (const raw of Array.isArray(spec.edges) ? spec.edges : []) {
    if (!isObj(raw)) throw core.sciErr("ERR_VALIDATION", "spec.edges 的每一项必须是对象");
    const from = resolve(raw.from);
    const to = raw.to === undefined || raw.to === null || raw.to === "" ? from : resolve(raw.to);
    const type = raw.type && EDGE_TYPES.includes(raw.type) ? raw.type : "serial";
    if (from === to && type !== "loop" && type !== "feedback") {
      throw core.sciErr("ERR_VALIDATION", `自环只允许 loop/feedback（自反馈）：${from}`);
    }
    if (doc.edges.some((e) => e.from === from && e.to === to && e.type === type)) {
      edgesSkipped.push({ from, to, type });
      continue;
    }
    const edge = addLink(doc, { from, to, type, label: raw.label, color: raw.color }, { author });
    edgesAdded.push({ id: edge.id, from, to, type });
  }

  // spec.doc：整体元信息（标题/说明）
  if (isObj(spec.doc)) {
    if (typeof spec.doc.title === "string" && spec.doc.title.trim()) doc.title = spec.doc.title.trim();
    if (typeof spec.doc.description === "string") doc.description = spec.doc.description;
  }

  bumpRev(doc, {
    author,
    op: "apply",
    target: "-",
    note: `${mode === "replace" ? "重建" : "合并"}：新建 ${created.length} / 更新 ${updated.length} 节点，新增 ${edgesAdded.length} 关系${note ? "｜" + note : ""}`,
  });
  return { mode, created, updated, edgesAdded, edgesSkipped, nodeMap };
}

// ── 根探测 ──────────────────────────────────────────────────────────────────

async function roadmapRoot(args, exec, markers) {
  return core.resolveRoot(args, exec, markers);
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const layoutCfg = { ...DEFAULT_LAYOUT, ...(config.layout || {}) };
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

  // 所有写操作统一：持锁 → 读 → 变更 → 原子写
  const mutate = async (root, fn) => {
    const file = roadmapPath(root);
    return core.withFileLock(file, async () => {
      const doc = await requireRoadmap(root);
      const out = await fn(doc);
      await saveRoadmap(root, doc);
      return { root, file, rev: doc.rev, ...out };
    }, lockOpts);
  };

  const ROOT_PARAM = { type: "string", description: "项目根（默认自动探测：从工作目录向上找含 .dsh/.git 的目录）" };

  // ── roadmap_init ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_init",
    description:
      "初始化技术路线图（<项目根>/.dsh/roadmap.json）。路线图把每个 步骤/issue/step/milestone 记为节点，用带类型的边表达上下游关系：串联 serial / 并联 parallel / 反馈 feedback / 循环 loop。已存在时幂等返回现状（不覆盖）。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        title: { type: "string", description: "路线图标题（可选）" },
        description: { type: "string", description: "一句话说明（可选）" },
        reset: { type: "boolean", description: "true=清空重建（历史保留在 history，慎用）" },
      },
    },
    presentTitle: "初始化技术路线图",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, created: { type: "boolean" },
        roadmap: { type: "object" }, generatedAt: { type: "string" },
      },
      required: ["root", "file", "created", "roadmap", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const file = roadmapPath(root);
      const created = await core.withFileLock(file, async () => {
        const existing = await loadRoadmap(root);
        if (existing && args.reset !== true) return false;
        const doc = emptyDoc(root, args.title);
        if (typeof args.description === "string") doc.description = args.description;
        if (existing && args.reset === true) {
          doc.history = existing.history;
          doc.rev = existing.rev;
          bumpRev(doc, { author: "human", op: "init_reset", target: "-", note: `重置路线图（原 ${existing.nodes.length} 节点）` });
        } else {
          bumpRev(doc, { author: "human", op: "init", target: "-", note: "初始化技术路线图" });
        }
        await saveRoadmap(root, doc);
        return true;
      }, lockOpts);
      const doc = await requireRoadmap(root);
      core.appendAudit(root, { tool: "roadmap_init", ok: true, created });
      return { root, file, created, roadmap: roadmapView(doc, layoutCfg), generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_show ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_show",
    description:
      "读取技术路线图全图（节点 + 带类型的关系边 + 画布位置）+ 图分析统计（环/关键路径/根叶/深度/上下游邻居）。传 node 时额外给出该节点的上下游传递闭包与版本概览。未初始化时温和返回提示。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        node: { type: "string", description: "（可选）节点 id：附加该节点的上下游闭包与版本概览" },
      },
    },
    presentTitle: "技术路线图",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, initialized: { type: "boolean" }, roadmap: { type: "object" },
        node: { type: "object" }, generatedAt: { type: "string" },
      },
      required: ["root", "initialized", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const doc = await loadRoadmap(root);
      if (!doc) {
        return { root, initialized: false, hint: "路线图未初始化：先调用 roadmap_init（或 roadmap_apply 携带 doc.title 直接生成）", generatedAt: core.nowISO() };
      }
      const out = { root, initialized: true, roadmap: roadmapView(doc, layoutCfg), generatedAt: core.nowISO() };
      if (args.node) out.node = nodeDetail(doc, String(args.node).trim(), layoutCfg);
      return out;
    },
  }));

  // ── roadmap_node_add ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_node_add",
    description:
      "新增路线图节点（步骤/issue/里程碑）。可指定 kind/status/track（泳道）/color/shape/tags/strategy（分析策略）/params（超参）/tests/refs/pos·size 以及 IO 契约：inputs（输入产物，数组）、outputs（输出产物，数组）、tool（软件/工具名）、command（命令或程序调用）。progress 记录执行进度（{done,total,unit} 或 {percent}），画布上以进度条填充该节点图形块。当下游节点的 inputs 与上游 outputs 同名时，两者的边会自动成为该产物的 IO 传递关系（画布/Mermaid/数据流面板可见）。新节点自动获得 v1 版本。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        title: { type: "string", description: "标题（必填）" },
        kind: { type: "string", enum: KINDS, description: "节点类型（默认 step）" },
        summary: { type: "string", description: "摘要" },
        status: { type: "string", enum: STATUSES, description: "状态（默认 planned）" },
        track: { type: "string", description: "泳道 / 阶段（默认「主线」）" },
        color: { type: "string", description: "颜色：#rrggbb 或调色板名（如 blue / amber-6）" },
        shape: { type: "string", enum: SHAPES, description: "形状（默认 box）" },
        tags: { type: "array", items: { type: "string" }, description: "标签" },
        strategy: { type: "string", description: "分析策略说明" },
        params: { type: "object", additionalProperties: true, description: "超参（自由 JSON）" },
        tests: { type: "array", items: { type: "string" }, description: "测试清单" },
        refs: { type: "object", additionalProperties: true, description: "关联对象，如 {experiment:'E01',artifact:'tab@2',hypothesis:'H1'}" },
        owner: { type: "string", description: "负责人" },
        inputs: { type: "array", items: { type: "string" }, description: "输入产物/数据（如 raw_reads.fastq）" },
        outputs: { type: "array", items: { type: "string" }, description: "输出产物/数据（如 clean_reads.fastq）" },
        tool: { type: "string", description: "软件/工具（如 Phrap、GLIMMER、bwa+bcftools）" },
        command: { type: "string", description: "命令或程序调用（可含占位符，便于复现）" },
        progress: {
          oneOf: [
            { type: "number", description: "百分比 0-100" },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                percent: { type: "number", description: "百分比 0-100（与 done/total 二选一）" },
                done: { type: "number", description: "已完成数量（样本数等）" },
                total: { type: "number", description: "总量（与 done 同时给出时自动折算百分比）" },
                unit: { type: "string", description: "单位，如 样本 / 文件 / reads" },
                note: { type: "string", description: "进度备注" },
              },
            },
            { type: "null" },
          ],
          description: "执行进度：{done: 已完成样本数, total: 总样本数, unit?: '样本', note?} 或 {percent: 0-100}；画布上以进度条填充该节点图形块",
        },
        pos: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, description: "画布坐标（可选）" },
        size: { type: "object", properties: { w: { type: "number" }, h: { type: "number" } }, description: "节点尺寸（可选）" },
        note: { type: "string", description: "版本备注" },
        author: { type: "string", description: "变更者（默认 human）" },
      },
    },
    presentTitle: "新增路线图节点",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: { root: { type: "string" }, file: { type: "string" }, rev: { type: "number" }, node: { type: "object" }, generatedAt: { type: "string" } },
      required: ["root", "node", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const out = await mutate(root, async (doc) => {
        const node = createNode(doc, args, { author: optStrWithDefault(args, "author", "human"), note: optStrWithDefault(args, "note", "") });
        if (args.pos !== undefined && args.pos !== null) node.pos = normPoint(args.pos, "pos", ["x", "y"]);
        if (args.size !== undefined && args.size !== null) node.size = normNodeSize(args.size);
        return { node: { ...node } };
      });
      core.appendAudit(root, { tool: "roadmap_node_add", ok: true, node: out.node.id });
      return { ...out, generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_node_update ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_node_update",
    description:
      "更新路线图节点（只传要改的字段）。语义字段（标题/状态/进度/泳道/颜色/形状/标签/策略/超参/测试/关联/输入输出/工具/命令）变更会追加一个新版本（v2、v3…，历史 append-only）；pos/size 只改画布布局、不产生版本。progress 用 {done,total,unit} 或 {percent} 更新完成进度（null 清除），画布上以进度条填充节点图形块。action=remove 删除节点及其关系。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        node: { type: "string", description: "节点 id（必填）" },
        action: { type: "string", enum: ["patch", "remove"], description: "patch（默认）或 remove" },
        title: { type: "string" }, kind: { type: "string", enum: KINDS },
        summary: { type: "string" }, status: { type: "string", enum: STATUSES },
        track: { type: "string" }, color: { type: "string" }, shape: { type: "string", enum: SHAPES },
        tags: { type: "array", items: { type: "string" } },
        strategy: { type: "string" },
        params: { type: "object", additionalProperties: true },
        tests: { type: "array", items: { type: "string" } },
        refs: { type: "object", additionalProperties: true },
        owner: { type: "string" },
        inputs: { type: "array", items: { type: "string" }, description: "输入产物/数据" },
        outputs: { type: "array", items: { type: "string" }, description: "输出产物/数据" },
        tool: { type: "string", description: "软件/工具" },
        command: { type: "string", description: "命令或程序调用" },
        progress: {
          oneOf: [
            { type: "number", description: "百分比 0-100" },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                percent: { type: "number", description: "百分比 0-100" },
                done: { type: "number", description: "已完成数量" },
                total: { type: "number", description: "总量" },
                unit: { type: "string", description: "单位" },
                note: { type: "string", description: "进度备注" },
              },
            },
            { type: "null" },
          ],
          description: "执行进度 patch：{done,total,unit} 或 {percent}；null 清除进度。每次变更追加一个新版本",
        },
        pos: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        size: { type: "object", properties: { w: { type: "number" }, h: { type: "number" } } },
        note: { type: "string", description: "版本备注（写进历史，便于回溯「为什么改」）" },
        author: { type: "string", description: "变更者（默认 human；AI 生成请写 ai）" },
      },
    },
    presentTitle: "更新路线图节点",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, rev: { type: "number" },
        node: { type: "object" }, version: { type: "object" }, removed: { type: "boolean" }, generatedAt: { type: "string" },
      },
      required: ["root", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const id = core.requireStr(args, "node");
      const author = optStrWithDefault(args, "author", "human");
      const note = optStrWithDefault(args, "note", "");
      if (args.action === "remove") {
        const out = await mutate(root, async (doc) => ({ ...removeNode(doc, id, { author, note }) }));
        core.appendAudit(root, { tool: "roadmap_node_update", ok: true, node: id, action: "remove" });
        return { ...out, generatedAt: core.nowISO() };
      }
      const out = await mutate(root, async (doc) => {
        const res = patchNode(doc, id, args, { author, note });
        return { node: { ...res.node }, version: res.version };
      });
      core.appendAudit(root, { tool: "roadmap_node_update", ok: true, node: id });
      return { ...out, generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_node_history ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_node_history",
    description:
      "查看节点版本历史（append-only）：每版的作者、备注、变更类型（create/update/revert）与变更字段，可选快照。传 from/to 给出两版之间的字段级差异。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        node: { type: "string", description: "节点 id（必填）" },
        from: { type: "number", description: "（可选）起始版本号，用于版本差异" },
        to: { type: "number", description: "（可选）目标版本号，用于版本差异" },
        snapshot: { type: "boolean", description: "true=附每版完整快照" },
      },
    },
    presentTitle: "节点版本历史",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, node: { type: "string" }, current: { type: "number" },
        versions: { type: "array" }, diff: { type: "object" }, generatedAt: { type: "string" },
      },
      required: ["root", "node", "current", "versions", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const doc = await requireRoadmap(root);
      const id = core.requireStr(args, "node");
      const node = findNode(doc, id);
      const versions = node.versions.map((v) => (args.snapshot === true ? { ...v } : summarizeVersion(v)));
      const out = { root, file: doc.file, node: id, title: node.title, current: node.version, versions, generatedAt: core.nowISO() };
      if (args.from !== undefined && args.to !== undefined) out.diff = versionDiff(doc, id, Number(args.from), Number(args.to));
      return out;
    },
  }));

  // ── roadmap_node_revert ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_node_revert",
    description:
      "把节点回滚到历史版本：语义字段恢复为该版快照，并以「新增一个版本」的方式记录（append-only，旧版本永不删除，可再回滚回来）。用于项目迭代中换回旧的分析策略/超参/测试。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        node: { type: "string", description: "节点 id（必填）" },
        version: { type: "number", description: "目标版本号（必填）" },
        note: { type: "string", description: "回滚原因" },
        author: { type: "string", description: "变更者（默认 human）" },
      },
    },
    presentTitle: "回滚节点版本",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, rev: { type: "number" },
        node: { type: "object" }, revertedTo: { type: "number" }, version: { type: "object" }, generatedAt: { type: "string" },
      },
      required: ["root", "node", "revertedTo", "version", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const id = core.requireStr(args, "node");
      const version = Number(args.version);
      if (!Number.isFinite(version)) throw core.sciErr("ERR_VALIDATION", "version 必填且为数字");
      const out = await mutate(root, async (doc) => {
        const res = revertNode(doc, id, version, { author: optStrWithDefault(args, "author", "human"), note: optStrWithDefault(args, "note", "") });
        return { node: { ...res.node }, revertedTo: res.revertedTo, version: res.version };
      });
      core.appendAudit(root, { tool: "roadmap_node_revert", ok: true, node: id, to: version });
      return { ...out, generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_link ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_link",
    description:
      "维护节点间的上下游关系边：action=add/update/remove。type ∈ serial（串联，A 完成后 B）/ parallel（并联，可并行推进）/ feedback（反馈，下游回灌上游）/ loop（循环，迭代回环）。from/to 用节点 id；自环仅允许 loop/feedback（自反馈）。重复同类关系会被拒。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        action: { type: "string", enum: ["add", "update", "remove"], description: "默认 add" },
        id: { type: "string", description: "关系 id（update/remove 必填；add 可省略自动分配）" },
        from: { type: "string", description: "起点节点 id" },
        to: { type: "string", description: "终点节点 id（省略=自环，仅 loop/feedback）" },
        type: { type: "string", enum: EDGE_TYPES, description: "关系类型（默认 serial）" },
        label: { type: "string", description: "边标签（如「质控通过」「超参 grid」）" },
        color: { type: "string", description: "边颜色（可选）" },
        style: { type: "string", description: "边样式（可选，如 dashed）" },
        author: { type: "string", description: "变更者（默认 human）" },
      },
    },
    presentTitle: "维护路线图关系",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, rev: { type: "number" },
        edge: { type: "object" }, removed: { type: "boolean" }, generatedAt: { type: "string" },
      },
      required: ["root", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const author = optStrWithDefault(args, "author", "human");
      const action = optStrWithDefault(args, "action", "add");
      const out = await mutate(root, async (doc) => {
        if (action === "remove") return { ...removeLink(doc, core.requireStr(args, "id"), { author }) };
        if (action === "update") return { edge: updateLink(doc, args, { author }) };
        return { edge: addLink(doc, args, { author }) };
      });
      core.appendAudit(root, { tool: "roadmap_link", ok: true, action });
      return { ...out, generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_apply ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_apply",
    description:
      "AI 辅助生成 / 批量导入路线图：一次原子事务里按 spec 批量建节点并连边。spec.nodes[].ref 是本地别名，spec.edges 用 ref（或已有节点 id）引用。mode=merge（默认，按 id/ref/同名 title 匹配已有节点则更新、否则新建，适合增量迭代）| replace（先清空再重建，历史保留）。未初始化时会自动创建。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        spec: { type: "object", additionalProperties: true, description: "路线图规格 {doc?, nodes:[{ref,kind,title,...}], edges:[{from,to,type,label}]}；也可用 specJson 传字符串" },
        specJson: { type: "string", description: "spec 的 JSON 字符串（与 spec 二选一）" },
        mode: { type: "string", enum: ["merge", "replace"], description: "默认 merge" },
        matchTitle: { type: "boolean", description: "merge 时是否按同名 title 认领已有节点（默认 true，让 AI 重复生成幂等）" },
        note: { type: "string", description: "本次生成/导入的说明" },
        author: { type: "string", description: "变更者（默认 ai）" },
      },
    },
    presentTitle: "生成/导入技术路线图",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, rev: { type: "number" },
        result: { type: "object" }, roadmap: { type: "object" }, generatedAt: { type: "string" },
      },
      required: ["root", "result", "roadmap", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      let spec = args.spec;
      if ((!spec || !isObj(spec)) && typeof args.specJson === "string" && args.specJson.trim()) {
        try {
          spec = JSON.parse(args.specJson);
        } catch (err) {
          throw core.sciErr("ERR_VALIDATION", `specJson 解析失败：${err.message}`);
        }
      }
      if (!isObj(spec)) throw core.sciErr("ERR_VALIDATION", "spec 必填（对象，或传 specJson 字符串）");
      const file = roadmapPath(root);
      const result = await core.withFileLock(file, async () => {
        let doc = await loadRoadmap(root);
        if (!doc) {
          doc = emptyDoc(root, isObj(spec.doc) ? spec.doc.title : undefined);
          bumpRev(doc, { author: optStrWithDefault(args, "author", "ai"), op: "init", target: "-", note: "roadmap_apply 自动初始化" });
        }
        const res = applySpec(doc, spec, {
          mode: optStrWithDefault(args, "mode", "merge"),
          author: optStrWithDefault(args, "author", "ai"),
          note: optStrWithDefault(args, "note", ""),
          matchTitle: args.matchTitle !== false,
        });
        await saveRoadmap(root, doc);
        return { res, doc };
      }, lockOpts);
      core.appendAudit(root, { tool: "roadmap_apply", ok: true, created: result.res.created.length, updated: result.res.updated.length });
      return {
        root,
        file,
        rev: result.doc.rev,
        result: result.res,
        roadmap: roadmapView(result.doc, layoutCfg),
        generatedAt: core.nowISO(),
      };
    },
  }));

  // ── roadmap_layout ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_layout",
    description:
      "调整/持久化画布布局：mode=manual 写入指定节点的 {x,y} 坐标（拖拽后用）；mode=auto 自动排布，style 可选 compact（默认：紧凑蛇形，深度过长自动换行成接近一屏的比例，如 17 节点/6 泳道约 1200×590）/ horizontal（横向泳道：每条泳道一行、层级最清晰但图很长）/ vertical（纵向阶段：阶段自上而下、泳道并排）。overwrite=true 覆盖已有坐标（默认只排没有坐标的节点）。布局不进版本历史（拖拽不产生版本）。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        mode: { type: "string", enum: ["auto", "manual"], description: "默认 auto" },
        positions: { type: "object", additionalProperties: true, description: "manual：{节点id: {x,y}}" },
        overwrite: { type: "boolean", description: "auto：是否覆盖已有坐标（默认 false，只排未定位节点）" },
        style: { type: "string", enum: LAYOUT_STYLE_IDS, description: "auto 布局样式：compact 紧凑蛇形（默认）/ horizontal 横向泳道 / vertical 纵向阶段" },
        viewport: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, description: "画布视口（可选，随手势持久化）" },
        author: { type: "string", description: "变更者（默认 human）" },
      },
    },
    presentTitle: "调整路线图布局",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, file: { type: "string" }, mode: { type: "string" },
        moved: { type: "number" }, positions: { type: "object" }, style: { type: "string" }, generatedAt: { type: "string" },
      },
      required: ["root", "mode", "moved", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const mode = optStrWithDefault(args, "mode", "auto");
      const styleArg = optStrWithDefault(args, "style", "");
      if (styleArg && !LAYOUT_STYLE_IDS.includes(styleArg)) throw core.sciErr("ERR_VALIDATION", `style 必须是 ${LAYOUT_STYLE_IDS.join(" / ")} 之一`);
      const out = await mutate(root, async (doc) => {
        const style = LAYOUT_STYLE_IDS.includes(styleArg) ? styleArg : layoutStyleOf(doc);
        const positions = {};
        if (mode === "manual") {
          const input = normJsonObject(args.positions, "positions") || {};
          for (const [id, p] of Object.entries(input)) {
            const node = findNode(doc, id);
            node.pos = normPoint(p, `positions.${id}`, ["x", "y"]);
            positions[id] = node.pos;
          }
        } else {
          const auto = autoLayoutPositions(doc, layoutCfg, { style });
          for (const node of doc.nodes) {
            if (!args.overwrite && isObj(node.pos)) { positions[node.id] = node.pos; continue; }
            node.pos = auto[node.id];
            positions[node.id] = node.pos;
          }
          doc.layoutStyle = style;
        }
        if (args.viewport !== undefined) {
          const v = normJsonObject(args.viewport, "viewport") || {};
          doc.viewport = { x: Number(v.x) || 0, y: Number(v.y) || 0, k: Number(v.k) || 1 };
        }
        // 布局变更也记一条 history（不进节点版本），便于回溯"谁动了画布"
        bumpRev(doc, { author: optStrWithDefault(args, "author", "human"), op: "layout", target: "-", note: `布局：${mode}${mode === "auto" ? `·${style}` : ""}（${Object.keys(positions).length} 节点）` });
        return { mode, style, moved: Object.keys(positions).length, positions, viewport: doc.viewport };
      });
      return { ...out, generatedAt: core.nowISO() };
    },
  }));

  // ── roadmap_render ──
  ctx.tools.register(core.makeTool({
    name: "roadmap_render",
    description:
      "把技术路线图渲染为可粘贴的文本：format=mermaid（flowchart，串联=实线箭头 / 并联=无箭头连线 / 反馈·循环=虚线箭头，形状与颜色随节点）或 dot（Graphviz）。用于写进 README/文档/论文方法学附图。返回结构化 JSON。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: ROOT_PARAM,
        format: { type: "string", enum: ["mermaid", "dot"], description: "默认 mermaid" },
        direction: { type: "string", enum: ["LR", "TB", "RL", "BT"], description: "方向（默认 LR）" },
      },
    },
    presentTitle: "渲染技术路线图",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        root: { type: "string" }, format: { type: "string" }, text: { type: "string" },
        nodes: { type: "number" }, edges: { type: "number" }, generatedAt: { type: "string" },
      },
      required: ["root", "format", "text", "generatedAt"],
    },
    async execute(args, exec) {
      const root = await roadmapRoot(args, exec, markers);
      const doc = await requireRoadmap(root);
      const format = optStrWithDefault(args, "format", "mermaid") === "dot" ? "dot" : "mermaid";
      const direction = optStrWithDefault(args, "direction", "LR");
      const text = format === "dot" ? renderDot(doc, { direction }) : renderMermaid(doc, { direction });
      return { root, format, direction, text, nodes: doc.nodes.length, edges: doc.edges.length, generatedAt: core.nowISO() };
    },
  }));

  return {
    roadmapPath,
    loadRoadmap,
    saveRoadmap,
    requireRoadmap,
    roadmapView,
    nodeDetail,
    analyze,
    ioSummary,
    autoLayoutPositions,
    applySpec,
    createNode,
    patchNode,
    removeNode,
    revertNode,
    addLink,
    updateLink,
    removeLink,
    versionDiff,
    renderMermaid,
    renderDot,
    withPositions,
    trackList,
    DEFAULT_LAYOUT,
    LAYOUT_STYLES,
    LAYOUT_STYLE_IDS,
    layoutStyleOf,
    KINDS,
    STATUSES,
    SHAPES,
    EDGE_TYPES,
    SEMANTIC_FIELDS,
    bumpRev,
    emptyDoc,
  };
}

export {
  apply,
  roadmapPath,
  loadRoadmap,
  saveRoadmap,
  requireRoadmap,
  roadmapView,
  nodeDetail,
  analyze,
  ioSummary,
  autoLayoutPositions,
  applySpec,
  createNode,
  patchNode,
  removeNode,
  revertNode,
  addLink,
  updateLink,
  removeLink,
  versionDiff,
  renderMermaid,
  renderDot,
  withPositions,
  trackList,
  emptyDoc,
  bumpRev,
  DEFAULT_LAYOUT,
  LAYOUT_STYLES,
  LAYOUT_STYLE_IDS,
  layoutStyleOf,
  DEFAULT_SIZE,
  KINDS,
  STATUSES,
  SHAPES,
  EDGE_TYPES,
  SEMANTIC_FIELDS,
  KIND_LABEL,
  STATUS_LABEL,
  EDGE_LABEL,
  progressOf,
  progressLabel,
  progressSummary,
  normProgress,
};
