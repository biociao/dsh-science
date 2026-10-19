// science-roadmap 单元测试 —— 技术路线图引擎：
//   1. 插件契约 / 工具清单 / object-rooted schema / 结构化输出
//   2. init（幂等 / reset）
//   3. 节点：字段校验、v1 版本、自定义颜色与形状
//   4. 版本管理：update→新版本、pos 不进版本、history/diff、revert 追加式回滚
//   5. 关系边：serial/parallel/feedback/loop、重复拒绝、自环约束、悬空引用拒绝
//   6. 图分析：环检测（SCC）、关键路径、根/叶、上下游闭包
//   7. AI 辅助生成：roadmap_apply 的 merge 幂等 / replace / ref 解析
//   8. 画布布局：auto/manual/viewport，且不污染节点版本
//   9. 渲染：mermaid / dot
//  10. 并发写：文件锁保证不丢更新
// 全部 headless、零依赖。用法：node test/roadmap.test.mjs

import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { EventEmitter } from "node:events";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const rm = await import(path.join(pkg, "engines", "roadmap.mjs"));

let passed = 0;
let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

async function expectThrow(fn, code, name) {
  try {
    await fn();
    failures++;
    console.error(`  ✗ ${name}：期望抛错 ${code}，但未抛`);
    return false;
  } catch (err) {
    if (code && err?.code !== code) {
      failures++;
      console.error(`  ✗ ${name}：错误码不符，期望 ${code}，实际 ${err?.code ?? err?.message}`);
      return false;
    }
    passed++;
    console.log(`  ✔ ${name} → 抛错 ${err?.code ?? err?.message}`);
    return true;
  }
}

const work = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-roadmap-test-"));
const root = path.join(work, "proj");
await fsp.mkdir(root, { recursive: true });
const exec = { agent: { session: { id: "roadmap-test", header: { cwd: root } } } };

// 注册工具（与 dsh 的 ctx.tools.register 形状一致）
const tools = {};
await rm.apply({ tools: { register: (d) => (tools[d.name] = d) } }, {});

// ── 1. 插件契约 ─────────────────────────────────────────────────────
console.log("== 1. 插件契约与工具注册 ==");
ok("契约 name/inject/apply", rm.name === "science-roadmap" && rm.inject?.includes("tools") && typeof rm.apply === "function");
const EXPECT = [
  "roadmap_init", "roadmap_show", "roadmap_node_add", "roadmap_node_update",
  "roadmap_node_history", "roadmap_node_revert", "roadmap_link", "roadmap_apply",
  "roadmap_layout", "roadmap_render",
];
const missing = EXPECT.filter((n) => !tools[n]);
ok("注册 10 个工具", missing.length === 0, missing.length ? `缺：${missing}` : "");
{
  const bad = Object.entries(tools)
    .filter(([, t]) => !(t.parameters?.type === "object" && t.parameters?.properties && typeof t.parameters.properties === "object"))
    .map(([n]) => n);
  ok("工具 parameters 均为 object-rooted schema", bad.length === 0, bad.length ? "bad=" + bad.join(",") : "");
}
ok("工具全部结构化 JSON 输出", EXPECT.every((n) => tools[n]?.output?.schema?.type === "object"));
ok("枚举常量导出完整", JSON.stringify(rm.EDGE_TYPES) === JSON.stringify(["serial", "parallel", "feedback", "loop"]) && rm.SHAPES.length === 7 && rm.STATUSES.length === 5);

// ── 2. init ─────────────────────────────────────────────────────────
console.log("\n== 2. roadmap_init ==");
{
  const before = await tools.roadmap_show.execute({ root }, exec);
  ok("未初始化时温和返回提示", before.initialized === false && /roadmap_init/.test(before.hint));
  const init = await tools.roadmap_init.execute({ root, title: "AMR 分析路线图" }, exec);
  ok("初始化创建 .dsh/roadmap.json", init.created === true && init.file.endsWith(path.join(".dsh", "roadmap.json")));
  ok("初始化落盘 + 标题", init.roadmap.title === "AMR 分析路线图" && (await fsp.stat(init.file).then(() => true, () => false)));
  const again = await tools.roadmap_init.execute({ root }, exec);
  ok("重复初始化幂等（不覆盖）", again.created === false && again.roadmap.title === "AMR 分析路线图");
}

// ── 3. 节点与校验 ───────────────────────────────────────────────────
console.log("\n== 3. 节点：字段校验 / v1 版本 / 颜色形状 ==");
{
  const n1 = await tools.roadmap_node_add.execute({
    root, title: "数据质控", kind: "step", status: "done", track: "数据",
    color: "#4f8ef7", shape: "round", tags: ["qc", "fastp"],
    strategy: "fastp + sourmash 去污染", params: { q20: 0.9, minLen: 50 },
    tests: ["per-base quality", "adapter 残留"], refs: { experiment: "E01" },
  }, exec);
  ok("新增节点：v1 + 字段落库", n1.node.id === "n1" && n1.node.version === 1 && n1.node.versions.length === 1 && n1.node.versions[0].change === "create");
  ok("自定义颜色/形状/泳道持久化", n1.node.color === "#4f8ef7" && n1.node.shape === "round" && n1.node.track === "数据");
  ok("策略/超参/测试/关联落库", n1.node.strategy.includes("fastp") && n1.node.params.minLen === 50 && n1.node.tests.length === 2 && n1.node.refs.experiment === "E01");

  const n2 = await tools.roadmap_node_add.execute({ root, title: "去宿主污染", kind: "step", track: "数据", status: "running" }, exec);
  const n3 = await tools.roadmap_node_add.execute({ root, title: "组装", kind: "milestone", track: "组装", color: "amber-6", shape: "hexagon" }, exec);
  ok("id 递增分配", n2.node.id === "n2" && n3.node.id === "n3");
  ok("调色板名颜色被接受", n3.node.color === "amber-6");

  await expectThrow(() => tools.roadmap_node_add.execute({ root, title: "" }, exec), "ERR_VALIDATION", "空标题被拒");
  await expectThrow(() => tools.roadmap_node_add.execute({ root, title: "x", color: "not a color!" }, exec), "ERR_VALIDATION", "非法颜色被拒");
  await expectThrow(() => tools.roadmap_node_add.execute({ root, title: "x", shape: "star" }, exec), "ERR_VALIDATION", "非法形状被拒");
  await expectThrow(() => tools.roadmap_node_add.execute({ root, title: "x", status: "bogus" }, exec), "ERR_VALIDATION", "非法状态被拒");
  await expectThrow(() => tools.roadmap_node_add.execute({ root, title: "x", params: "nojson" }, exec), "ERR_VALIDATION", "非法 params 被拒");
}

// ── 4. 版本管理 ─────────────────────────────────────────────────────
console.log("\n== 4. 版本管理：update / history / revert ==");
{
  const up1 = await tools.roadmap_node_update.execute({ root, node: "n1", params: { q20: 0.95, minLen: 80 }, note: "放宽 q20 阈值" }, exec);
  ok("更新产生 v2", up1.node.version === 2 && up1.version.change === "update" && up1.version.changed.includes("params"));
  ok("版本备注写入", up1.version.note === "放宽 q20 阈值" && up1.version.author === "human");

  const up2 = await tools.roadmap_node_update.execute({ root, node: "n1", pos: { x: 320, y: 210 }, size: { w: 240, h: 80 } }, exec);
  ok("仅改布局不产生新版本", up2.version === null && up2.node.version === 2);
  const graph1 = await tools.roadmap_show.execute({ root, node: "n1" }, exec);
  const n1View = graph1.roadmap.nodes.find((n) => n.id === "n1");
  ok("布局坐标已持久化", n1View.pos.x === 320 && n1View.size.w === 240 && n1View.autoPos === false);
  ok("节点详情返回版本数", graph1.node.versionCount === 2 && graph1.node.versions.length === 2);

  const hist = await tools.roadmap_node_history.execute({ root, node: "n1", from: 1, to: 2 }, exec);
  ok("版本历史：两版 + 字段级 diff", hist.current === 2 && hist.versions.length === 2 && hist.diff.changed.includes("params"));
  ok("diff 给出前后取值", JSON.stringify(hist.diff.fields.params.from) === JSON.stringify({ q20: 0.9, minLen: 50 }));

  const rev = await tools.roadmap_node_revert.execute({ root, node: "n1", version: 1, note: "阈值过松，回滚" }, exec);
  ok("回滚 = 追加 v3（append-only）", rev.node.version === 3 && rev.revertedTo === 1 && rev.version.change === "revert");
  ok("回滚后语义字段恢复为 v1 快照", rev.node.params.q20 === 0.9 && rev.node.params.minLen === 50);
  ok("旧版本仍在（未删除）", rev.node.versions.map((v) => v.version).join(",") === "1,2,3");
  ok("回滚不影响布局字段", rev.node.pos.x === 320);

  await expectThrow(() => tools.roadmap_node_update.execute({ root, node: "n9", status: "done" }, exec), "ERR_NOT_FOUND", "未知节点被拒");
  await expectThrow(() => tools.roadmap_node_revert.execute({ root, node: "n1", version: 99 }, exec), "ERR_NOT_FOUND", "未知版本被拒");
  await expectThrow(() => tools.roadmap_node_update.execute({ root, node: "n1" }, exec), "ERR_VALIDATION", "空 patch 被拒");
}

// ── 5. 关系边 ───────────────────────────────────────────────────────
console.log("\n== 5. 关系边：串联/并联/反馈/循环 ==");
{
  const e1 = await tools.roadmap_link.execute({ root, from: "n1", to: "n2", type: "serial", label: "质控通过" }, exec);
  ok("串联边创建", e1.edge.type === "serial" && e1.edge.id === "e1" && e1.edge.label === "质控通过");
  const e2 = await tools.roadmap_link.execute({ root, from: "n2", to: "n3", type: "serial" }, exec);
  const par = await tools.roadmap_link.execute({ root, from: "n1", to: "n3", type: "parallel", label: "并行探索" }, exec);
  const fb = await tools.roadmap_link.execute({ root, from: "n3", to: "n1", type: "feedback", label: "组装失败回灌" }, exec);
  ok("并联/反馈边创建", par.edge.type === "parallel" && fb.edge.type === "feedback");

  const self = await tools.roadmap_link.execute({ root, from: "n3", type: "loop", label: "迭代打磨" }, exec);
  ok("自环（loop）允许", self.edge.from === "n3" && self.edge.to === "n3");

  await expectThrow(() => tools.roadmap_link.execute({ root, from: "n1", to: "n2", type: "serial" }, exec), "ERR_VALIDATION", "重复同类关系被拒");
  await expectThrow(() => tools.roadmap_link.execute({ root, from: "n1", to: "n1", type: "serial" }, exec), "ERR_VALIDATION", "serial 自环被拒");
  await expectThrow(() => tools.roadmap_link.execute({ root, from: "n1", to: "n99" }, exec), "ERR_NOT_FOUND", "悬空目标被拒");
  await expectThrow(() => tools.roadmap_link.execute({ root, from: "n1", to: "n2", type: "weird" }, exec), "ERR_VALIDATION", "非法关系类型被拒");

  const upd = await tools.roadmap_link.execute({ root, action: "update", id: "e2", label: "组装完成", type: "parallel" }, exec);
  ok("关系可改类型/标签", upd.edge.type === "parallel" && upd.edge.label === "组装完成");
  const del = await tools.roadmap_link.execute({ root, action: "remove", id: e2.edge.id }, exec);
  ok("关系可删除", del.removed === true);

  // 恢复成一条串联链，便于后续图分析
  await tools.roadmap_link.execute({ root, from: "n2", to: "n3", type: "serial" }, exec);
}

// ── 6. 图分析 ───────────────────────────────────────────────────────
console.log("\n== 6. 图分析：环 / 关键路径 / 根叶 / 上下游闭包 ==");
{
  const g = await tools.roadmap_show.execute({ root, node: "n3" }, exec);
  const s = g.roadmap.stats;
  ok("统计计数（节点 3 / 边 5）", s.nodes === 3 && s.edges === 5, `nodes=${s.nodes} edges=${s.edges}`);
  ok("按类型统计关系", s.byType.serial === 2 && s.byType.parallel === 1 && s.byType.feedback === 1 && s.byType.loop === 1);
  ok("环检测抓到反馈回路", s.cycleCount >= 1 && s.nodesInCycle.includes("n1") && s.nodesInCycle.includes("n3"));
  ok("根/叶识别", s.roots.includes("n1") && s.leaves.includes("n3"));
  ok("关键路径覆盖主链", s.criticalPath.length >= 2 && s.criticalPath.includes("n3"));
  ok("深度：反馈边不推列（n1=0）", g.roadmap.nodes.find((n) => n.id === "n1").depth === 0);
  ok("上下游传递闭包", g.node.downstream.some((d) => d.id === "n2") && g.node.upstream.some((u) => u.id === "n1"));
  ok("节点在环内被标记", g.node.node.inCycle === true);
}

// ── 7. AI 辅助生成 ──────────────────────────────────────────────────
console.log("\n== 7. roadmap_apply：AI 批量生成 / 幂等 / replace ==");
{
  const spec = {
    doc: { title: "AMR 分析路线图", description: "从质控到耐药基因分型" },
    nodes: [
      { ref: "qc", kind: "step", title: "数据质控", track: "数据", status: "done" },
      { ref: "asm", kind: "step", title: "组装与注释", track: "组装", strategy: "flye + prokka" },
      { ref: "amr", kind: "milestone", title: "耐药基因分型", track: "分析", params: { db: "CARD", identity: 0.9 } },
    ],
    edges: [
      { from: "qc", to: "asm", type: "serial", label: "clean reads" },
      { from: "asm", to: "amr", type: "serial" },
      { from: "amr", to: "qc", type: "feedback", label: "分型异常回到质控" },
    ],
  };
  const a1 = await tools.roadmap_apply.execute({ root, spec, note: "AI 生成初版" }, exec);
  ok("apply 新建 2 节点 + 3 关系，同名节点认领为更新", a1.result.created.length === 2 && a1.result.updated.length === 1 && a1.result.edgesAdded.length === 3);
  ok("同名 title 被认领（AI 重复生成幂等的基础）", a1.result.updated[0].id === "n1" && a1.result.created.map((c) => c.ref).sort().join(",") === "amr,asm");
  ok("ref → 真实 id 映射返回", a1.result.nodeMap.qc === "n1" && typeof a1.result.nodeMap.amr === "string");
  ok("doc 元信息写入", a1.roadmap.title === "AMR 分析路线图" && a1.roadmap.description.includes("耐药基因"));

  const a2 = await tools.roadmap_apply.execute({ root, spec, note: "AI 复跑" }, exec);
  ok("重复 apply 幂等：0 新建", a2.result.created.length === 0 && a2.result.updated.length === 3);
  ok("重复 apply 不重复连边", a2.result.edgesAdded.length === 0 && a2.result.edgesSkipped.length === 3);

  const inj = await tools.roadmap_apply.execute({
    root,
    specJson: JSON.stringify({ nodes: [{ ref: "asm", title: "组装与注释", params: { assembler: "flye" } }] }),
    note: "补超参",
  }, exec);
  ok("specJson 字符串可用 + 同名节点更新", inj.result.created.length === 0 && inj.result.updated.length === 1);

  await expectThrow(
    () => tools.roadmap_apply.execute({ root, spec: { edges: [{ from: "qc", to: "ghost" }] } }, exec),
    "ERR_NOT_FOUND", "spec 引用未知 ref 被拒",
  );
  await expectThrow(() => tools.roadmap_apply.execute({ root, specJson: "{bad json" }, exec), "ERR_VALIDATION", "非法 specJson 被拒");
  await expectThrow(() => tools.roadmap_apply.execute({ root }, exec), "ERR_VALIDATION", "缺 spec 被拒");

  const before = (await tools.roadmap_show.execute({ root }, exec)).roadmap;
  const a3 = await tools.roadmap_apply.execute({
    root,
    mode: "replace",
    spec: { nodes: [{ ref: "v1", title: "重测序", track: "数据" }, { ref: "v2", title: "变异检测", track: "分析" }], edges: [{ from: "v1", to: "v2", type: "serial" }] },
    note: "换方案",
  }, exec);
  ok("replace 清空重建（只留新 2 节点）", a3.roadmap.nodes.length === 2 && a3.roadmap.edges.length === 1);
  ok("replace 前历史保留在 history", a3.roadmap.history.some((h) => h.op === "apply_replace"));
  ok("replace 后 rev 单调递增", a3.roadmap.rev > before.rev);
}

// ── 8. 画布布局 ─────────────────────────────────────────────────────
console.log("\n== 8. roadmap_layout：auto / manual / viewport ==");
{
  const ids = (await tools.roadmap_show.execute({ root }, exec)).roadmap.nodes.map((n) => n.id);
  const auto = await tools.roadmap_layout.execute({ root, mode: "auto", overwrite: true }, exec);
  ok("auto 布局覆盖全部节点", auto.moved === ids.length && Object.keys(auto.positions).length === ids.length);
  const g = (await tools.roadmap_show.execute({ root }, exec)).roadmap;
  const v1 = g.nodes.find((n) => n.id === ids[0]).pos;
  const v2 = g.nodes.find((n) => n.id === ids[1]).pos;
  ok("auto 布局按深度分列（下游 x 更大）", v2.x > v1.x, `x1=${v1.x} x2=${v2.x}`);

  const manual = await tools.roadmap_layout.execute({ root, mode: "manual", positions: { [ids[0]]: { x: -120, y: 55 } }, viewport: { x: 10, y: 20, k: 1.5 } }, exec);
  ok("manual 写入坐标", manual.positions[ids[0]].x === -120);
  const g2 = (await tools.roadmap_show.execute({ root }, exec)).roadmap;
  ok("viewport 持久化", g2.viewport.k === 1.5 && g2.viewport.y === 20);
  await expectThrow(() => tools.roadmap_layout.execute({ root, mode: "manual", positions: { nope: { x: 1, y: 2 } } }, exec), "ERR_NOT_FOUND", "未知节点坐标被拒");
  const versions = g2.nodes.map((n) => n.version);
  const g3 = (await tools.roadmap_show.execute({ root }, exec)).roadmap;
  ok("布局操作不产生节点版本", JSON.stringify(g3.nodes.map((n) => n.version)) === JSON.stringify(versions));

  // 紧凑布局：长链自动换行（蛇形），整体长宽比接近一屏，而不是 4000px 宽的一条横带
  const longRoot = path.join(work, "long-layout");
  await tools.roadmap_init.execute({ root: longRoot, title: "长链" }, exec);
  const longIds = [];
  for (let i = 0; i < 18; i++) {
    const r = await tools.roadmap_node_add.execute({ root: longRoot, title: "步骤 " + i, track: i < 6 ? "A" : i < 12 ? "B" : "C" }, exec);
    longIds.push(r.node.id);
  }
  for (let i = 1; i < longIds.length; i++) await tools.roadmap_link.execute({ root: longRoot, from: longIds[i - 1], to: longIds[i], type: "serial" }, exec);
  const longLay = await tools.roadmap_layout.execute({ root: longRoot, mode: "auto", overwrite: true }, exec);
  const lpos = longLay.positions;
  const lxs = longIds.map((id) => lpos[id].x);
  const lys = longIds.map((id) => lpos[id].y);
  const lbw = Math.max(...lxs) - Math.min(...lxs) + 200;
  const lbh = Math.max(...lys) - Math.min(...lys) + 68;
  ok("紧凑布局：长链换行成多带（不再是一整行）", new Set(lys).size >= 3, `bands=${new Set(lys).size}`);
  ok("紧凑布局：整体长宽比接近一屏（≤ 2.6）", lbw / lbh <= 2.6, `bbox=${lbw}x${lbh}`);
  ok("紧凑布局：宽度受控（< 单行的一半）", lbw < 18 * 250 * 0.6, `w=${lbw}`);
  const longLay2 = await tools.roadmap_layout.execute({ root: longRoot, mode: "auto", overwrite: true }, exec);
  ok("紧凑布局：确定性（重复布局坐标一致）", JSON.stringify(longLay2.positions) === JSON.stringify(lpos));
  // 蛇形：带末节点与下一带首节点同列（上下相邻），边不会横穿整行
  const bandBreaks = [];
  for (let i = 1; i < longIds.length; i++) if (lys[i] !== lys[i - 1]) bandBreaks.push(i);
  ok("紧凑布局：蛇形换行（带边界处上下相邻、列对齐）", bandBreaks.length >= 2 && bandBreaks.every((i) => Math.abs(lxs[i] - lxs[i - 1]) <= 1), `breaks=${bandBreaks.join(",")}`);

  // 自动布局样式切换：compact / horizontal / vertical，样式随文档保存
  const styleRoot = path.join(work, "style-layout");
  await tools.roadmap_init.execute({ root: styleRoot, title: "样式" }, exec);
  const sIds = [];
  for (let i = 0; i < 6; i++) {
    const r = await tools.roadmap_node_add.execute({ root: styleRoot, title: "阶段 " + i, track: i < 3 ? "T1" : "T2" }, exec);
    sIds.push(r.node.id);
  }
  for (let i = 1; i < sIds.length; i++) await tools.roadmap_link.execute({ root: styleRoot, from: sIds[i - 1], to: sIds[i], type: "serial" }, exec);
  const defaultView = (await tools.roadmap_show.execute({ root: styleRoot }, exec)).roadmap;
  ok("布局样式：默认 compact 随视图返回", defaultView.layoutStyle === "compact" && Array.isArray(defaultView.layoutStyles) && defaultView.layoutStyles.length === 3);
  const hLay = await tools.roadmap_layout.execute({ root: styleRoot, mode: "auto", overwrite: true, style: "horizontal" }, exec);
  const hView = (await tools.roadmap_show.execute({ root: styleRoot }, exec)).roadmap;
  const hx = sIds.map((id) => hLay.positions[id].x);
  ok("横向泳道：列=深度、下游 x 递增", hLay.style === "horizontal" && hx.every((x, i) => i === 0 || x > hx[i - 1]) && hView.layoutStyle === "horizontal");
  ok("横向泳道：泳道分行（T1/T2 的 y 不同）", hLay.positions[sIds[0]].y !== hLay.positions[sIds[3]].y);
  const vLay = await tools.roadmap_layout.execute({ root: styleRoot, mode: "auto", overwrite: true, style: "vertical" }, exec);
  const vView = (await tools.roadmap_show.execute({ root: styleRoot }, exec)).roadmap;
  const vy = sIds.map((id) => vLay.positions[id].y);
  ok("纵向阶段：行=深度、下游 y 递增", vLay.style === "vertical" && vy.every((y, i) => i === 0 || y > vy[i - 1]) && vView.layoutStyle === "vertical");
  ok("纵向阶段：泳道并排成列（T1/T2 的 x 不同）", vLay.positions[sIds[0]].x !== vLay.positions[sIds[3]].x);
  const cLay = await tools.roadmap_layout.execute({ root: styleRoot, mode: "auto", overwrite: true, style: "compact" }, exec);
  ok("切回紧凑蛇形：样式保存", cLay.style === "compact" && (await tools.roadmap_show.execute({ root: styleRoot }, exec)).roadmap.layoutStyle === "compact");
  await expectThrow(() => tools.roadmap_layout.execute({ root: styleRoot, mode: "auto", style: "spiral" }, exec), "ERR_VALIDATION", "布局样式：非法值被拒");
}

// ── 9. 渲染 ─────────────────────────────────────────────────────────
console.log("\n== 9. roadmap_render：mermaid / dot ==");
{
  const mm = await tools.roadmap_render.execute({ root, format: "mermaid" }, exec);
  ok("mermaid：flowchart + 节点形状 + 串联箭头", mm.text.startsWith("flowchart LR") && /\[\"/.test(mm.text) && mm.text.includes("-->|"));
  const doc = await rm.loadRoadmap(root);
  await rm.addLink(doc, { from: doc.nodes[0].id, to: doc.nodes[1].id, type: "parallel" });
  await rm.saveRoadmap(root, doc);
  const mm2 = await tools.roadmap_render.execute({ root, format: "mermaid" }, exec);
  ok("mermaid：并联用无箭头连线", /---\|/.test(mm2.text));
  const mm3 = await tools.roadmap_render.execute({ root, format: "mermaid", direction: "TB" }, exec);
  ok("mermaid：方向可配", mm3.text.startsWith("flowchart TB"));
  const dot = await tools.roadmap_render.execute({ root, format: "dot" }, exec);
  ok("dot：digraph + 形状 + 虚线", dot.text.startsWith("digraph roadmap {") && dot.text.includes("shape=") && dot.text.includes("style=dashed"));
  const r = await tools.roadmap_render.execute({ root, format: "mermaid" }, exec);
  ok("渲染返回节点/边计数", r.nodes >= 2 && r.edges >= 1);
  const emptyRoot = path.join(work, "empty-proj");
  await fsp.mkdir(emptyRoot, { recursive: true });
  await expectThrow(() => tools.roadmap_render.execute({ root: emptyRoot }, exec), "ERR_NOT_INIT", "未初始化时渲染被拒");
  await expectThrow(() => tools.roadmap_node_update.execute({ root: emptyRoot, node: "n1", status: "done" }, exec), "ERR_NOT_INIT", "未初始化时更新被拒");
}

// ── 9.5 节点 IO 契约 / 工具 / 数据流 ─────────────────────────────────
console.log("\n== 9.5 节点 IO 契约（inputs/outputs/tool/command）与数据流 ==");
{
  const ioRoot = path.join(work, "io-proj");
  await tools.roadmap_init.execute({ root: ioRoot, title: "IO" }, exec);
  const a = await tools.roadmap_node_add.execute({
    root: ioRoot, title: "清洗", tool: "fastp", command: "fastp -i raw.fq -o clean.fq -q 20",
    inputs: ["raw_reads.fastq"], outputs: ["clean_reads.fastq", "qc_report.html"],
  }, exec);
  const b = await tools.roadmap_node_add.execute({
    root: ioRoot, title: "组装", tool: "Phrap", command: "phrap clean_reads.fasta -minmatch 30",
    inputs: ["clean_reads.fastq"], outputs: ["contigs.fasta"],
  }, exec);
  await tools.roadmap_link.execute({ root: ioRoot, from: a.node.id, to: b.node.id, type: "serial" }, exec);
  const view = (await tools.roadmap_show.execute({ root: ioRoot }, exec)).roadmap;
  const na = view.nodes.find((n) => n.id === a.node.id);
  ok("节点 IO/工具/命令落库并随视图返回", JSON.stringify(na.inputs) === JSON.stringify(["raw_reads.fastq"]) && na.outputs.length === 2 && na.tool === "fastp" && na.command.includes("-q 20"));
  ok("视图 io：同名 outputs/inputs → 边传递产物", view.io.transfers.length === 1 && view.io.transfers[0].artifacts[0] === "clean_reads.fastq");
  ok("视图 io：产物清单含生产者/消费者", (() => {
    const art = view.io.artifacts.find((x) => x.name === "clean_reads.fastq");
    return Boolean(art && art.producedBy[0] === a.node.id && art.consumedBy[0] === b.node.id);
  })());
  ok("stats 记录产物数", view.stats.artifacts === view.io.artifacts.length && view.stats.artifacts >= 3);
  const patched = await tools.roadmap_node_update.execute({ root: ioRoot, node: a.node.id, tool: "fastp v0.23", note: "锁定工具版本" }, exec);
  ok("改工具 → 追加版本且 changed 含 tool", patched.version.changed.includes("tool") && patched.node.version === 2);
  await expectThrow(() => tools.roadmap_node_update.execute({ root: ioRoot, node: a.node.id, inputs: { bad: true } }, exec), "ERR_VALIDATION", "inputs 非数组/分隔字符串被拒");
  const det = await tools.roadmap_show.execute({ root: ioRoot, node: b.node.id }, exec);
  ok("节点详情含 io（输入/工具/传递边）", Boolean(det.node.io) && det.node.io.transfers.length === 1 && det.node.io.inputs.includes("clean_reads.fastq") && det.node.io.tool === "Phrap");
  const mm = await tools.roadmap_render.execute({ root: ioRoot, format: "mermaid" }, exec);
  ok("Mermaid：节点带工具、边带传递产物", mm.text.includes("⚙ fastp") && mm.text.includes("clean_reads.fastq"));
  const dot = await tools.roadmap_render.execute({ root: ioRoot, format: "dot" }, exec);
  ok("Graphviz：节点带工具、边带传递产物", dot.text.includes("⚙ Phrap") && dot.text.includes("clean_reads.fastq"));
}

// ── 10. 并发写（文件锁）─────────────────────────────────────────────
console.log("\n== 10. 并发写：文件锁不丢更新 ==");
{
  const cRoot = path.join(work, "concurrent");
  await fsp.mkdir(cRoot, { recursive: true });
  await tools.roadmap_init.execute({ root: cRoot, title: "并发" }, exec);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      tools.roadmap_node_add.execute({ root: cRoot, title: `并发节点 ${i}`, track: "T" }, exec)),
  );
  const g = (await tools.roadmap_show.execute({ root: cRoot }, exec)).roadmap;
  const ids = g.nodes.map((n) => n.id);
  ok("8 个并发新增全部落库（无丢更新）", g.nodes.length === 8 && new Set(ids).size === 8, `ids=${ids.join(",")}`);
  ok("rev 与操作数一致（init + 8）", g.rev === 9, `rev=${g.rev}`);
}

// ── 11. 宿主侧 REST 层 + AI 辅助生成 ─────────────────────────────────
console.log("\n== 11. roadmap-ui：REST 路由 / 处理器 / AI 生成 ==");
{
  const ui = await import(path.join(pkg, "engines", "roadmap-ui.mjs"));
  ok("UI 契约 name/inject/apply", ui.name === "science-roadmap-ui" && ui.inject?.includes("webServer") && typeof ui.apply === "function");

  // mock ctx：捕获 webServer 路由与 llm.stream
  let route = null;
  let llmCalls = 0;
  let llmReply = "";
  const uRoot = path.join(work, "ui-proj");
  await fsp.mkdir(uRoot, { recursive: true });
  const mockCtx = {
    get: (k) => {
      if (k === "webServer") return { register: (r) => { route = r; return () => {}; } };
      if (k === "llm") {
        return {
          stream: (opts) => {
            llmCalls++;
            assertOpts = opts;
            return (async function* () {
              yield { type: "text-delta", text: llmReply.slice(0, 20) };
              yield { type: "text-delta", text: llmReply.slice(20) };
            })();
          },
        };
      }
      if (k === "agentDefaultModel") return { currentSelection: () => ({ provider: "p-default", model: "m-default" }) };
      return undefined;
    },
    on: () => () => {},
    logger: { info() {}, warn() {} },
  };
  let assertOpts = null;
  ui.apply(mockCtx, { roadmapRoot: uRoot, ai: { model: { provider: "p-ai", model: "m-ai" } } });
  ok("注册前缀路由 /dsh-science/roadmap", route?.kind === "prefix" && route?.path === "/dsh-science/roadmap");

  // 直接驱动 handler，覆盖 HTTP 语义
  const call = (method, url, body, headers = {}) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { origin: "http://127.0.0.1:19387", host: "127.0.0.1:19387", ...headers };
    req.destroy = () => {};
    const res = {
      status: 0, body: "",
      writeHead(s) { this.status = s; },
      end(b) { this.body = b; resolve(this); },
    };
    route.handler(req, res);
    setImmediate(() => { req.emit("data", JSON.stringify(body || {})); req.emit("end"); });
  });

  const get = await call("GET", "/dsh-science/roadmap/config");
  ok("非 POST 被拒（405）", get.status === 405);
  const cross = await call("POST", "/dsh-science/roadmap/config", {}, { origin: "http://evil.example" });
  ok("跨源被拒（403）", cross.status === 403);
  const crossSite = await call("POST", "/dsh-science/roadmap/config", {}, { "sec-fetch-site": "cross-site" });
  ok("Sec-Fetch-Site: cross-site 被拒（403）", crossSite.status === 403);
  // 桌面端（Electron）：页面 origin 为 dsh-app://app，主进程 forwardWebRequest 转发时
  // 删除 origin/sec-fetch-site，只留 Host 头 —— 必须放行，否则整套面板 403。
  const desktop = await call("POST", "/dsh-science/roadmap/config", {}, { origin: undefined });
  ok("桌面壳转发：缺 Origin + 回环 Host → 200", desktop.status === 200);
  const unknown = await call("POST", "/dsh-science/roadmap/nope", {});
  ok("未知方法 404", unknown.status === 404 && JSON.parse(unknown.body).ok === false);

  const cfg = JSON.parse((await call("POST", "/dsh-science/roadmap/config", {})).body);
  ok("config：默认根 + 枚举 + AI 模型", cfg.ok && cfg.defaultRoot === uRoot && cfg.shapes.length === 7 && cfg.ai.provider === "p-ai");
  ok("config：布局样式表（3 种）", Array.isArray(cfg.layoutStyles) && cfg.layoutStyles.length === 3 && cfg.layoutStyles[0].id === "compact");
  const preShow = JSON.parse((await call("POST", "/dsh-science/roadmap/show", {})).body);
  ok("show：未初始化时 initialized=false", preShow.ok && preShow.initialized === false);

  const prompt = JSON.parse((await call("POST", "/dsh-science/roadmap/prompt", { goal: "从原始 reads 到耐药分型" })).body);
  ok("prompt：生成可粘贴提示词（含目标与关系语义）", prompt.ok && prompt.prompt.includes("从原始 reads 到耐药分型") && prompt.prompt.includes("feedback"));

  // AI 生成：mock LLM 返回规格 → applySpec 落盘
  llmReply = "好的，这是路线图：\n```json\n" + JSON.stringify({
    doc: { title: "耐药分析路线图" },
    nodes: [
      { ref: "qc", title: "数据质控", kind: "step", track: "数据" },
      { ref: "asm", title: "组装", kind: "step", track: "组装", params: { assembler: "flye" } },
      { ref: "amr", title: "耐药分型", kind: "milestone", track: "分析" },
    ],
    edges: [
      { from: "qc", to: "asm", type: "serial" },
      { from: "asm", to: "amr", type: "serial" },
      { from: "amr", to: "qc", type: "feedback", label: "分型异常回灌" },
    ],
  }) + "\n```";
  const gen = JSON.parse((await call("POST", "/dsh-science/roadmap/generate", { goal: "耐药分析" })).body);
  ok("AI 生成：调用模型 + 解析围栏 JSON + 落盘 3 节点", gen.ok && llmCalls === 1 && gen.result.created.length === 3 && gen.roadmap.nodes.length === 3);
  ok("AI 生成：模型透传 config.ai.model", assertOpts?.provider === "p-ai" && assertOpts?.model === "m-ai" && Array.isArray(assertOpts?.messages?.[0]?.content));
  ok("AI 生成：反馈边被识别", gen.roadmap.stats.byType.feedback === 1 && gen.roadmap.stats.cycleCount === 1);
  ok("AI 生成走了 applySpec 的作者归因", gen.roadmap.nodes.every((n) => n.versions[0].author === "ai"));

  // 再由 REST 改画布：改颜色/形状、拖拽坐标、连线、版本回滚
  const upd = JSON.parse((await call("POST", "/dsh-science/roadmap/node-update", { node: "n1", patch: { color: "#22c55e", shape: "diamond" } })).body);
  ok("REST：改颜色/形状 → 新版本", upd.ok && upd.node.color === "#22c55e" && upd.node.shape === "diamond" && upd.node.version === 2);
  const drag = JSON.parse((await call("POST", "/dsh-science/roadmap/node-update", { node: "n1", patch: { pos: { x: 42, y: 84 } } })).body);
  ok("REST：拖拽坐标不产生版本", drag.ok && drag.node.pos.x === 42 && drag.node.version === 2);
  const hist = JSON.parse((await call("POST", "/dsh-science/roadmap/node-history", { node: "n1" })).body);
  ok("REST：版本历史", hist.ok && hist.versions.length === 2);
  const rev = JSON.parse((await call("POST", "/dsh-science/roadmap/node-revert", { node: "n1", version: 1, note: "颜色回退" })).body);
  ok("REST：回滚追加 v3 且历史保留", rev.ok && rev.node.version === 3 && rev.node.versions.length === 3 && rev.node.color === "");
  const lay = JSON.parse((await call("POST", "/dsh-science/roadmap/layout", { mode: "auto", overwrite: true, viewport: { x: 5, y: 6, k: 2 } })).body);
  ok("REST：auto 布局 + 视口", lay.ok && lay.moved === 3 && lay.viewport.k === 2);
  const rm1 = JSON.parse((await call("POST", "/dsh-science/roadmap/node-remove", { node: "n3" })).body);
  ok("REST：删除节点连带关系", rm1.ok && rm1.removed === true && rm1.removedEdges.length === 2);

  // 纯函数：模型输出解析与体检
  ok("extractSpec：容忍围栏/前后废话", ui.extractSpec('说明\n```json\n{"nodes":[{"title":"a"}]}\n```\n完毕')?.nodes?.length === 1);
  ok("extractSpec：非 JSON 返回 null", ui.extractSpec("没有 JSON") === null);
  ok("sanitizeSpec：无 title 节点被拒", (() => { try { ui.sanitizeSpec({ nodes: [{ kind: "step" }] }, 40); return false; } catch { return true; } })());
  ok("sanitizeSpec：超规模被拒", (() => { try { ui.sanitizeSpec({ nodes: Array.from({ length: 41 }, (_, i) => ({ title: "n" + i })) }, 40); return false; } catch { return true; } })());
  const noAi = makeNoAiCtx();
  const noAiHandlers = ui.makeHandlers({ roadmapRoot: uRoot }, noAi);
  const g2 = await noAiHandlers.generate({ goal: "x" });
  ok("无可用模型时给出可操作错误", g2.ok === false && /无可用模型|LLM 服务不可用/.test(g2.error));

  function makeNoAiCtx() {
    return { get: () => undefined, on: () => () => {}, logger: { info() {}, warn() {} } };
  }
}

// ── 12. client bundle 契约（手写打包脚本的集成护栏）────────────────────
console.log("\n== 12. client bundle：加载 / 插件契约 / slot 注册 / 方法与 REST 对齐 ==");
{
  const ui = await import(path.join(pkg, "engines", "roadmap-ui.mjs"));
  const bundlePath = path.join(pkg, "client", "remote-hosts-ui", "lib", "client.js");
  const bundleSrc = await fsp.readFile(bundlePath, "utf8");
  let loaded = null;
  const fakeReact = { createElement: () => null };
  const req = (n) => { if (n === "react") return fakeReact; throw new Error("意外的 require：" + n); };
  new Function("window", "require", bundleSrc)({ __ModuleLoader__: { load: (def) => { loaded = def; } } }, req);
  ok("bundle 经 __ModuleLoader__.load 注册且 id=dsh-science", loaded?.id === "dsh-science" && typeof loaded.factory === "function");

  const mod = loaded.factory(req);
  ok("bundle 导出插件契约（name/inject/apply）", mod?.name === "remote-hosts-ui" && mod.inject?.includes("slots") && typeof mod.apply === "function");

  const sections = [];
  const views = [];
  const slots = {
    inject: (name, fn) => { slots._injected = name; fn(); },
    register: (meta, render) => { (meta.name === "conversation.view" ? views : sections).push({ meta, render }); },
  };
  mod.apply({ get: (k) => (k === "slots" ? slots : undefined), on: () => () => {} });
  const ids = sections.map((s) => s.meta.id).sort();
  ok("设置页只剩 2 个：远程主机 / 科研工作台", sections.length === 2 && JSON.stringify(ids) === JSON.stringify(["remote-hosts", "workbench"]));
  ok("技术路线图注册为顶层会话视图（conversation.view，与「会话」「轨迹」并列）", views.length === 1 && views[0].meta.id === "roadmap" && views[0].meta.name === "conversation.view");
  const rdView = views[0];
  ok("技术路线图排「轨迹」之后（order=20）+ 中文标签 + 可直接渲染", rdView.meta.order === 20 && rdView.meta.label === "技术路线图" && typeof rdView.render === "function");
  ok("技术路线图不再出现在设置页", !ids.includes("roadmap"));

  // 客户端调用的每个 REST 方法都必须真实存在（防止改名后静默 404）
  const called = new Set([...bundleSrc.matchAll(/rdApi\(\s*"([a-z-]+)"/g)].map((m) => m[1]));
  const unknownCalls = [...called].filter((m) => !ui.METHODS.includes(m));
  ok("客户端调用的 REST 方法都在服务端注册（" + called.size + " 个）", unknownCalls.length === 0, unknownCalls.length ? "未注册：" + unknownCalls.join(",") : "");
  ok("服务端方法覆盖画布全部能力", ["show", "init", "node-add", "node-update", "node-remove", "node-history", "node-revert", "link", "apply", "layout", "viewport", "render", "prompt", "generate"].every((m) => ui.METHODS.includes(m)));
}

// ── 13. 画布渲染（无浏览器环境下用最小 hooks 模拟器执行真实 render）────────
console.log("\n== 13. 画布组件渲染（hooks 模拟器）==");
{
  const src = await fsp.readFile(path.join(pkg, "client", "remote-hosts-ui", "src", "roadmap.js"), "utf8");
  const states = [];
  const refs = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof init === "function" ? init() : init;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v }];
    },
    useRef: (init) => { const i = cursor++; if (!(i in refs)) refs[i] = { current: init }; return refs[i] },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  const h = React.createElement;
  const mod = new Function("React", "h", "fetch", "window", "navigator", "document",
    src + "\nreturn { RdPage, rdProjectOf, rdLayoutPositions };")(React, h, () => Promise.resolve({ ok: false }), { localStorage: { getItem: () => null, setItem: () => {} } }, {}, undefined);
  const RdPage = mod.RdPage;

  // 客户端布局实现与宿主引擎必须逐样式一致（防止两处几何漂移）
  {
    const cmpDoc = rm.emptyDoc(path.join(work, "cmp-ui-layout"), "cmp");
    for (let i = 0; i < 7; i++) rm.createNode(cmpDoc, { title: "c" + i, track: i < 4 ? "T1" : "T2" });
    for (let i = 1; i < cmpDoc.nodes.length; i++) rm.addLink(cmpDoc, { from: cmpDoc.nodes[i - 1].id, to: cmpDoc.nodes[i].id, type: "serial" });
    rm.createNode(cmpDoc, { title: "side", track: "T2" });
    rm.addLink(cmpDoc, { from: cmpDoc.nodes[1].id, to: cmpDoc.nodes[cmpDoc.nodes.length - 1].id, type: "parallel" });
    const cmpView = rm.roadmapView(cmpDoc, {});
    for (const style of ["compact", "horizontal", "vertical"]) {
      const enginePos = rm.autoLayoutPositions(cmpDoc, {}, { style });
      const uiPos = mod.rdLayoutPositions(cmpView, style);
      ok("客户端布局与引擎一致：" + style, JSON.stringify(uiPos) === JSON.stringify(enginePos), Object.keys(uiPos).length + " 节点");
    }
  }

  const shapes = ["box", "round", "pill", "diamond", "hexagon", "circle", "note"];
  const nodes = shapes.map((shape, i) => ({
    id: "n" + (i + 1), title: "步骤 " + (i + 1), kind: i === 0 ? "milestone" : "step",
    status: ["planned", "running", "blocked", "done", "dropped", "planned", "done"][i],
    track: i < 3 ? "数据" : "分析", color: i === 1 ? "" : "#4f8ef7", shape,
    size: { w: 200, h: 68 }, pos: { x: i * 300, y: (i % 3) * 140 },
    version: i + 1, inCycle: i === 0, depth: i, upstream: [], downstream: [], tags: [], tests: [], params: {}, refs: {},
  }));
  nodes[0].outputs = ["a.fastq"];
  nodes[0].tool = "fastp";
  nodes[0].command = "fastp -i raw.fq -o a.fastq -q 20";
  nodes[1].inputs = ["a.fastq"];
  nodes[1].outputs = ["b.bam"];
  nodes[1].tool = "bwa";
  nodes[2].inputs = ["b.bam"];
  nodes[2].tool = "samtools";
  const edges = [
    { id: "e1", from: "n1", to: "n2", type: "serial", label: "质控通过" },
    { id: "e2", from: "n2", to: "n3", type: "parallel", label: "" },
    { id: "e3", from: "n3", to: "n1", type: "feedback", label: "回灌" },
    { id: "e4", from: "n4", to: "n4", type: "loop", label: "迭代" },
    { id: "e5", from: "n1", to: "ghost", type: "serial", label: "" }, // 防御：悬空边不应崩
  ];
  const roadmap = {
    title: "路线图", rev: 7, tracks: ["数据", "分析"], viewport: { x: 0, y: 0, k: 1 },
    nodes, edges,
    io: {
      transfers: [
        { edge: "e1", from: "n1", to: "n2", type: "serial", artifacts: ["a.fastq"] },
        { edge: "e2", from: "n2", to: "n3", type: "parallel", artifacts: ["b.bam"] },
      ],
      artifacts: [
        { name: "a.fastq", producedBy: ["n1"], consumedBy: ["n2"] },
        { name: "b.bam", producedBy: ["n2"], consumedBy: ["n3"] },
      ],
      orphanOutputs: [], missingInputs: [],
    },
    stats: {
      nodes: nodes.length, edges: edges.length,
      byKind: { step: 6, issue: 0, milestone: 1 }, byStatus: { planned: 2, running: 1, blocked: 1, done: 2, dropped: 1 },
      byType: { serial: 2, parallel: 1, feedback: 1, loop: 1 }, tracks: 2,
      cycles: [["n1", "n3"]], cycleCount: 1, nodesInCycle: ["n1"], roots: ["n1"], leaves: ["n7"], criticalPath: ["n1", "n2", "n3"],
    },
    history: [{ rev: 7, op: "node_add", target: "n1", note: "AI 生成" }, { rev: 6, op: "layout", target: "-", note: "auto" }],
    file: "/proj/.dsh/roadmap.json", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const draft = { title: "步骤 1", kind: "step", status: "done", track: "数据", summary: "s", strategy: "st", params: "{}", tests: "t1", tags: "a", refs: "{}", owner: "", note: "" };

  const render = (patch, props) => {
    cursor = 0;
    // 文档化的 hook 顺序：[cfg, root, rm, err, okMsg, busy, tab, sel, selEdge, linkFrom, linkType, view, positions, draft, versions, aiGoal, aiSpec, aiPrompt, aiMode, panning, sizes, fitTick]
    Object.assign(states, { 0: { ok: true, ai: {}, layoutStyles: [{ id: "compact", label: "紧凑蛇形" }, { id: "horizontal", label: "横向泳道" }, { id: "vertical", label: "纵向阶段" }] }, 1: "/proj", 2: roadmap, 3: "", 4: "", 5: "", 6: "props", 7: [], 8: "", 9: "", 10: "serial", 11: { x: 0, y: 0, k: 1 }, 12: Object.fromEntries(nodes.map((n) => [n.id, n.pos])), 13: draft, 14: null, 15: "耐药分型", 16: "", 17: "", 18: "merge", 19: false, 20: {}, 21: 0 }, patch);
    return RdPage(props);
  };
  const walk = (el, fn) => {
    if (!el || typeof el !== "object") return;
    fn(el);
    for (const c of el.children || []) Array.isArray(c) ? c.forEach((x) => walk(x, fn)) : walk(c, fn);
  };
  const count = (tree, type) => { let n = 0; walk(tree, (el) => { if (el.type === type) n++ }); return n };

  const cases = [
    ["未初始化（rm=null）", { 2: null }, (t) => count(t, "svg") === 0],
    ["属性面板（选中单节点）", { 7: ["n1"] }, (t) => count(t, "svg") === 1 && count(t, "polygon") + count(t, "rect") + count(t, "ellipse") >= shapes.length],
    ["版本面板（含历史）", { 7: ["n1"], 6: "ver", 14: [{ version: 1, at: "t", author: "ai", note: "n", change: "create", changed: ["params"] }, { version: 2, at: "t", author: "human", note: "n2", change: "update", changed: ["status"] }] },
      (t) => { let hit = 0; walk(t, (el) => { if (typeof el.children?.[0] === "string" && el.children[0].includes("回滚到此版")) hit++ }); return hit === 1 }],
    ["AI 面板（含提示词与历史）", { 6: "ai", 17: "PROMPT" }, (t) => { let n = 0; walk(t, (el) => { if (el.type === "textarea" && el.props.value === "PROMPT") n++ }); return n === 1 }],
    ["多选（无单节点草稿）", { 7: ["n1", "n2"], 13: null }, (t) => count(t, "svg") === 1],
    ["选中关系边", { 7: [], 8: "e1" }, (t) => { let n = 0; walk(t, (el) => { if (typeof el.children?.[0] === "string" && el.children[0] === "删除关系") n++ }); return n === 1 }],
    ["数据流页（IO 传递与工具）", { 6: "io" }, (t) => {
      let artifacts = 0, tools = 0;
      walk(t, (el) => {
        const s = typeof el.children?.[0] === "string" ? el.children[0] : "";
        if (s.includes("a.fastq") || s.includes("b.bam")) artifacts++;
        if (s.includes("⚙ fastp") || s.includes("⚙ bwa")) tools++;
      });
      return artifacts >= 1 && tools >= 1;
    }],
    ["属性页 IO/工具/命令字段", { 7: ["n1"] }, (t) => {
      let fields = 0;
      walk(t, (el) => {
        const ph = typeof el.props.placeholder === "string" ? el.props.placeholder : "";
        if (el.type === "input" && ph.startsWith("如：Phrap")) fields++;
        if (el.type === "textarea" && ph.startsWith("如：raw_reads")) fields++;
        if (el.type === "textarea" && ph.startsWith("如：clean_reads")) fields++;
        if (el.type === "textarea" && ph.startsWith("如：phrap reads")) fields++;
      });
      return fields >= 3;
    }],
    ["连线模式提示", { 7: ["n1"], 9: "n1" }, (t) => { let n = 0; walk(t, (el) => { if (typeof el.children?.[0] === "string" && el.children[0].includes("连线模式：n1")) n++ }); return n === 1 }],
  ];
  for (const [name, patch, check] of cases) {
    let tree = null;
    let error = null;
    try { tree = render(patch); } catch (e) { error = e }
    ok("渲染不崩：" + name, !error, error ? error.message : "");
    if (!error) {
      let cond = false;
      try { cond = check(tree) } catch (e) { error = e }
      ok("渲染结构符合预期：" + name, cond && !error, error ? error.message : "");
    }
  }
  // 7 种形状都要真的渲染出对应 SVG 元素
  const tree = render({ 7: [] });
  ok("7 种形状各渲染出对应图元", count(tree, "polygon") >= 2 && count(tree, "ellipse") >= 1 && count(tree, "rect") >= 5, `rect=${count(tree, "rect")} polygon=${count(tree, "polygon")} ellipse=${count(tree, "ellipse")}`);
  ok("4 类关系边都渲染（含自环与悬空边防御）", count(tree, "path") >= 5, "path=" + count(tree, "path"));
  const styleSel = (() => { let hit = null; walk(tree, (el) => { if (!hit && el.type === "select" && String(el.props.title || "").startsWith("自动布局样式")) hit = el }); return hit })();
  const styleOpts = styleSel ? styleSel.children.flat(Infinity).filter((el) => el && el.type === "option") : [];
  ok("布局样式下拉：三种格式可切换", styleOpts.length === 3 && styleOpts.map((o) => o.props.value).join(",") === "compact,horizontal,vertical");
  const textOfTree = (t) => {
    const buf = [];
    walk(t, (el) => {
      const text = (el.children || []).flat(Infinity).filter((x) => typeof x === "string").join(" ");
      if (text) buf.push(text);
    });
    return buf.join(" ");
  };
  ok("边标签：无自定义文字时显示传递产物", textOfTree(tree).includes("b.bam · 并联"));
  ok("边标签：IO 产物优先、自定义 label 降为第二行", textOfTree(tree).includes("a.fastq") && textOfTree(tree).includes("质控通过"));

  // 交互处理器冒烟：直接调用渲染出的 handler（模拟器里 setState 只改状态数据）
  const tree2 = render({ 7: [], 8: "e1" });
  const find = (pred) => { let hit = null; walk(tree2, (el) => { if (!hit && pred(el)) hit = el }); return hit };
  const svgEl = find((el) => el.type === "svg");
  const nodeG = find((el) => el.type === "g" && typeof el.props.className === "string" && el.props.className.startsWith("rd-node"));
  const edgeHit = find((el) => el.props.className === "rd-edge-hit");
  const fitBtn = find((el) => el.type === "button" && el.props.title === "适应窗口");
  const ev = (extra) => ({ stopPropagation() {}, preventDefault() {}, target: { getAttribute: () => "1" }, currentTarget: {}, ...extra });
  const handlers = [
    ["画布空白点击（清空选择）", () => svgEl.props.onClick(ev())],
    ["节点按下 + 点击", () => { nodeG.props.onPointerDown(ev({ shiftKey: true, clientX: 10, clientY: 10 })); nodeG.props.onClick(ev()) }],
    ["连线点击（选中关系）", () => edgeHit.props.onClick(ev())],
    ["适应窗口按钮", () => fitBtn.props.onClick(ev())],
  ];
  for (const [name, fn] of handlers) {
    let error = null;
    try { fn() } catch (e) { error = e }
    ok("交互处理器不崩：" + name, !error, error ? error.message : "");
  }

  // ── 跟随项目：根目录来自会话所属 Workspace，而不是手填/上次路径 ──
  const items = [{ workspaceId: "w1", path: "/proj", title: "项目A", sessionIds: ["s1", "s2"] }];
  ok("rdProjectOf：按会话 id 找到所属项目", mod.rdProjectOf(items, "s2")?.path === "/proj");
  ok("rdProjectOf：项目外的会话 / 空列表返回 null", mod.rdProjectOf(items, "s9") === null && mod.rdProjectOf(null, "s1") === null);
  const wsRender = (sessionId) => render({}, { sessionId, useWorkspaces: (sel) => sel({ items }) });
  const rootInput = (t) => { let hit = null; walk(t, (el) => { if (!hit && el.type === "input" && el.props.className === "rd-input") hit = el }); return hit };
  const wsTree = wsRender("s1");
  ok("跟随项目：根目录输入框只读且带项目标记", rootInput(wsTree)?.props.readOnly === true && (() => {
    let badge = false;
    walk(wsTree, (el) => { if (typeof el.children?.[0] === "string" && el.children[0].startsWith("跟随项目：")) badge = true });
    return badge;
  })());
  ok("无项目归属时回落到手动输入（可编辑）", rootInput(wsRender("s9"))?.props.readOnly === false);
}

// ── 14. 画布交互：多选 / 整体拖动 / 框选 / 全选（增强 hooks 模拟器）──────
console.log("\n== 14. 画布交互：多选与整体拖动 ==");
{
  const src = await fsp.readFile(path.join(pkg, "client", "remote-hosts-ui", "src", "roadmap.js"), "utf8");
  const states = [];
  const refs = [];
  const winListeners = {};
  const fetchCalls = [];
  let cursor = 0;
  let mounted = false;
  const pendingEffects = [];
  const fakeWindow = {
    addEventListener: (t, fn) => { (winListeners[t] || (winListeners[t] = [])).push(fn) },
    removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== fn) },
    localStorage: { getItem: () => null, setItem: () => {} },
    confirm: () => true,
  };
  const fetchStub = (url, opts) => {
    fetchCalls.push({ url: String(url), body: opts && opts.body });
    return Promise.resolve({ json: async () => ({ ok: true }) });
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof init === "function" ? init() : init;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v }];
    },
    useRef: (init) => { const i = cursor++; if (!(i in refs)) refs[i] = { current: init }; return refs[i] },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: (fn) => { if (!mounted) pendingEffects.push(fn) },
  };
  const h = React.createElement;
  const mod = new Function("React", "h", "fetch", "window", "navigator", "document",
    src + "\nreturn { RdPage };\n")(React, h, fetchStub, fakeWindow, {}, undefined);

  const mkNode = (id, x, y, depth) => ({
    id, title: id, kind: "step", status: "planned", track: "数据", color: "", shape: "box",
    size: { w: 200, h: 68 }, pos: { x, y }, version: 1, inCycle: false, depth,
    upstream: [], downstream: [], tags: [], tests: [], params: {}, refs: {},
  });
  const nodes = [mkNode("n1", 0, 0, 0), mkNode("n2", 300, 0, 1), mkNode("n3", 600, 0, 2)];
  const roadmap = {
    title: "t", rev: 1, tracks: ["数据"], viewport: { x: 0, y: 0, k: 1 }, nodes, edges: [],
    stats: {
      nodes: 3, edges: 0, byKind: { step: 3, issue: 0, milestone: 0 },
      byStatus: { planned: 3, running: 0, blocked: 0, done: 0, dropped: 0 },
      byType: { serial: 0, parallel: 0, feedback: 0, loop: 0 }, tracks: 1,
      cycles: [], cycleCount: 0, nodesInCycle: [], roots: [], leaves: [], criticalPath: [],
    },
    history: [], file: "/proj/.dsh/roadmap.json", updatedAt: "",
  };
  const seed = {
    0: { ok: true, ai: {}, layoutStyles: [{ id: "compact", label: "紧凑蛇形" }, { id: "horizontal", label: "横向泳道" }, { id: "vertical", label: "纵向阶段" }] }, 1: "/proj", 2: roadmap, 3: "", 4: "", 5: "", 6: "props",
    7: [], 8: "", 9: "", 10: "serial", 11: { x: 0, y: 0, k: 1 },
    12: { n1: { x: 0, y: 0 }, n2: { x: 300, y: 0 }, n3: { x: 600, y: 0 } },
    13: null, 14: null, 15: "", 16: "", 17: "", 18: "merge", 19: false, 20: {}, 21: 0,
    22: null, 23: false,
  };
  const render = (patch = {}) => { cursor = 0; Object.assign(states, seed, patch); return mod.RdPage({}); };
  const rerender = () => { cursor = 0; return mod.RdPage({}); };
  const walk = (el, fn) => {
    if (!el || typeof el !== "object") return;
    fn(el);
    for (const c of el.children || []) Array.isArray(c) ? c.forEach((x) => walk(x, fn)) : walk(c, fn);
  };
  const find = (pred) => { let hit = null; walk(tree, (el) => { if (!hit && pred(el)) hit = el }); return hit };
  const nodeG = (id) => find((el) => el.type === "g" && el.props.key === id);
  const ev = (extra = {}) => ({
    stopPropagation() {}, preventDefault() {}, shiftKey: false, button: 0,
    target: { getAttribute: () => "1" }, currentTarget: {}, ...extra,
  });

  let tree = render();
  // 挂载：只执行一次 effect（注册 window pointermove/pointerup 监听；React 语义近似）
  mounted = true;
  for (const fn of pendingEffects) fn();

  // 1) Shift+点击多选
  nodeG("n1").props.onPointerDown(ev({ shiftKey: true }));
  tree = rerender();
  nodeG("n2").props.onPointerDown(ev({ shiftKey: true }));
  ok("Shift+点击多选：选中 2 个节点", Array.isArray(states[7]) && states[7].length === 2 && states[7].includes("n1") && states[7].includes("n2"));

  // 2) 拖动任一选中节点 → 整体同步位移
  tree = rerender();
  nodeG("n1").props.onPointerDown(ev({ clientX: 100, clientY: 100 }));
  for (const fn of winListeners.pointermove || []) fn({ clientX: 160, clientY: 140 });
  const p = states[12];
  ok("整体拖动：两个节点同步位移（各 +60/+40）", p.n1.x === 60 && p.n1.y === 40 && p.n2.x === 360 && p.n2.y === 40 && p.n3.x === 600);
  for (const fn of winListeners.pointerup || []) fn({});
  await new Promise((r) => setTimeout(r, 0));
  const layoutCall = fetchCalls.filter((c) => c.url.includes("/layout")).pop();
  const savedBody = layoutCall ? JSON.parse(layoutCall.body) : null;
  ok("整体拖动落盘：layout 手动坐标含两个节点", Boolean(savedBody && savedBody.positions && savedBody.positions.n1 && savedBody.positions.n2));

  // 3) Shift+拖动框选
  tree = rerender();
  const svg = find((el) => el.type === "svg");
  svg.props.onPointerDown(ev({ shiftKey: true, clientX: 990, clientY: 5 }));
  for (const fn of winListeners.pointermove || []) fn({ clientX: 10, clientY: 120 });
  ok("框选过程：出现选择框（反向拖动也归一化）", Boolean(states[22] && states[22].x0 === 990 && states[22].x1 === 10));
  for (const fn of winListeners.pointerup || []) fn({});
  ok("Shift+拖动框选：命中 3 个节点", Array.isArray(states[7]) && states[7].length === 3);
  ok("框选结束：选择框消失", states[22] === null);

  // 4) 全选按钮
  tree = rerender();
  const allBtn = find((el) => el.type === "button" && el.children && el.children[0] === "全选");
  allBtn.props.onClick(ev());
  ok("全选按钮：选中全部节点", states[7].length === 3);

  // 5) 框选模式开关（无需按住 Shift）
  tree = rerender();
  const boxBtn = find((el) => el.type === "button" && el.children && el.children[0] === "框选");
  boxBtn.props.onClick(ev());
  ok("框选按钮：开启框选模式", states[23] === true);
  ok("框选按钮：工具栏按钮进入选中态", (() => { tree = rerender(); const b = find((el) => el.type === "button" && el.children && el.children[0] === "框选"); return Boolean(b && String(b.props.className).includes("rd-btn-on")) })());

  // 6) 切换布局样式：立即用客户端算法重排（不依赖宿主引擎重启）
  tree = rerender();
  const styleSelect = find((el) => el.type === "select" && String(el.props.title || "").startsWith("自动布局样式"));
  styleSelect.props.onChange({ target: { value: "horizontal" } });
  ok("切换样式立即重排：样式状态 + 坐标同步变化", states[25] === "horizontal" && states[12].n2.x === 310 && states[12].n2.y === 60 && states[12].n3.x === 560);
  ok("切换样式：无报错", states[3] === "");
}

// ── 收尾 ────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? "✔" : "✗"} roadmap 测试：${passed} 通过，${failures} 失败`);
await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
if (failures > 0) process.exit(1);
