// science-scientific-reviewer 单元测试 —— 独立自动评审引擎：
//   1. 插件契约 + 配置归一化
//   2. 触发判定 detectTriggers（三类触发 + 防抖 + 首次基线不触发）
//   3. 评审输出解析 parseVerdicts（合法/乱答/非法 verdict）
//   4. 端到端：agent/request 钩子 → 快照 diff → llm.stream 评审 → recordReview 落盘
//      （评审模型透传断言 / testing 假设终结 / 子代理会话跳过 / 防抖）
//   5. 评审门禁：gate 标记 + 最新评审 needs-work → research_findings 抛 ERR_REVIEW_GATE
// 全部 headless、零依赖。用法：node test/scientific-reviewer.test.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const reviewer = await import(path.join(pkg, "engines", "scientific-reviewer.mjs"));
const loop = await import(path.join(pkg, "engines", "research-loop.mjs"));

let passed = 0;
let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

async function waitFor(cond, ms = 5000, step = 25) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

// ── 1. 插件契约与配置归一化 ─────────────────────────────────────────
console.log("== 1. 插件契约与配置归一化 ==");
ok("契约 name/inject/apply", reviewer.name === "science-scientific-reviewer" && reviewer.inject?.includes("llm") && typeof reviewer.apply === "function");
ok("导出可单测纯函数", ["normalizeConfig", "takeSnapshot", "detectTriggers", "collectClaims", "buildReviewPrompt", "parseVerdicts"].every((k) => typeof reviewer[k] === "function"));

{
  const c = reviewer.normalizeConfig({});
  ok("默认配置：enabled + 三类触发 + 默认防抖 180s", c.enabled && c.triggers.onArtifact && c.triggers.onHypothesis && c.triggers.onManuscript && c.triggers.minIntervalSec === 180 && c.gate === false);
  const c2 = reviewer.normalizeConfig({ enabled: false, model: { provider: "p", model: "m", reasoningEffort: "high" }, triggers: { minIntervalSec: 5, onManuscript: false }, gate: true });
  ok("显式配置透传", c2.enabled === false && c2.model.provider === "p" && c2.model.reasoningEffort === "high" && c2.triggers.minIntervalSec === 5 && c2.triggers.onManuscript === false && c2.gate === true);
}

// ── 2. 触发判定 ─────────────────────────────────────────────────────
console.log("\n== 2. detectTriggers 触发判定 ==");
const CFG = reviewer.normalizeConfig({ triggers: { minIntervalSec: 0 } });
const SNAP_A = {
  manifestMtime: 1,
  hypotheses: [{ id: "H1", status: "testing", updatedAt: "t1" }],
  artifacts: [{ name: "tab", latestVersion: 1, deprecated: false }],
  manuscriptMtime: 0,
};
{
  ok("首次建基线不触发", reviewer.detectTriggers(null, SNAP_A, 0, CFG).fire === false);
  const noChange = reviewer.detectTriggers(SNAP_A, SNAP_A, 0, CFG);
  ok("无变化不触发", noChange.fire === false && noChange.reasons.length === 0);
  const hyp = reviewer.detectTriggers(SNAP_A, { ...SNAP_A, hypotheses: [{ id: "H1", status: "testing", updatedAt: "t2" }] }, 0, CFG);
  ok("假设 updatedAt 变化触发", hyp.fire && hyp.changedHypotheses.includes("H1"), hyp.reasons.join(";"));
  const art = reviewer.detectTriggers(SNAP_A, { ...SNAP_A, artifacts: [{ name: "tab", latestVersion: 2, deprecated: false }] }, 0, CFG);
  ok("工件新版本触发", art.fire && art.changedArtifacts[0].name === "tab");
  const ms = reviewer.detectTriggers(SNAP_A, { ...SNAP_A, manuscriptMtime: 99 }, 0, CFG);
  ok("manuscript 变更触发", ms.fire && ms.manuscriptChanged);
  const deb = reviewer.detectTriggers(SNAP_A, { ...SNAP_A, manuscriptMtime: 99 }, Date.now(), reviewer.normalizeConfig({}));
  ok("minIntervalSec 防抖", deb.fire === false && deb.reasons.length > 0);
  const off = reviewer.detectTriggers(SNAP_A, { ...SNAP_A, manuscriptMtime: 99 }, 0, reviewer.normalizeConfig({ triggers: { onManuscript: false, minIntervalSec: 0 } }));
  ok("触发器可单独关闭", off.fire === false);
}

// ── 3. 评审输出解析 ─────────────────────────────────────────────────
console.log("\n== 3. parseVerdicts 解析 ==");
{
  const good = '分析略。\n```json\n{"reviews":[{"target":"假设 H1","verdict":"supported","summary":"数字一致","issues":[],"hypothesis":"H1","experiment":"E01"}]}\n```';
  const v = reviewer.parseVerdicts(good);
  ok(" fenced JSON 解析", v?.length === 1 && v[0].verdict === "supported" && v[0].hypothesis === "H1" && v[0].experiment === "E01");
  const raw = reviewer.parseVerdicts('前缀 {"reviews":[{"target":"工件 tab v2","verdict":"needs-work","issues":["缺多重检验校正"]}]} 后缀');
  ok("裸 JSON 解析 + issues", raw?.length === 1 && raw[0].verdict === "needs-work" && raw[0].issues.length === 1);
  ok("乱答 → null", reviewer.parseVerdicts("我觉得没问题，但没有按格式输出") === null);
  const bad = reviewer.parseVerdicts('{"reviews":[{"target":"x","verdict":"perfect"},{"verdict":"supported"}]}');
  ok("非法 verdict → unverifiable；缺 target 丢弃", bad?.length === 1 && bad[0].verdict === "unverifiable");
  const badIds = reviewer.parseVerdicts('{"reviews":[{"target":"x","verdict":"supported","hypothesis":"rm -rf","experiment":"E1"}]}');
  ok("hypothesis/experiment id 合法性校验", badIds[0].hypothesis === undefined && badIds[0].experiment === "E1");
}

// ── 4. 端到端：agent/request → 评审 → 落盘 ──────────────────────────
console.log("\n== 4. 端到端自动评审（mock ctx）==");
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-reviewer-e2e-"));
  await fsp.mkdir(path.join(root, ".git"), { recursive: true });
  await fsp.mkdir(path.join(root, "experiments", "E01"), { recursive: true });
  await fsp.writeFile(path.join(root, "experiments", "E01", "design.md"), "# 实验 E01\n检验 H1\n", "utf8");
  await fsp.writeFile(path.join(root, "experiments", "E01", "log.md"), "# 日志\np=0.003\n", "utf8");
  const manifest = {
    schema: 2,
    project: { id: "t", title: "t", domain: "d", created: "t", status: "active" },
    question: { text: "q", updatedAt: "t" },
    hypotheses: [{ id: "H1", text: "组间差异显著", status: "testing", experiments: ["E01"], reviews: [], updatedAt: "t1" }],
    loop: { phase: "analysis", iteration: 1, history: [] },
    experiments: [{ id: "E01", title: "差异检验", hypothesis: "H1", status: "running", created: "t", updatedAt: "t", reviews: [] }],
    artifacts: [],
    reviews: [],
    updatedAt: "t1",
  };
  await fsp.writeFile(path.join(root, "research-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const REPLY = '{"reviews":[{"target":"假设 H1：组间差异显著","verdict":"supported","summary":"log 中 p=0.003 与论断一致","issues":[],"hypothesis":"H1","experiment":"E01"}]}';
  const streamCalls = [];
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      stream: (options) => {
        streamCalls.push(options);
        return (async function* () {
          yield { type: "text-delta", index: 0, text: "逐条分析略。\n```json\n" + REPLY + "\n```" };
          yield { type: "finish", reason: { kind: "success" } };
        })();
      },
    },
    agents: { get: (id) => (id === "main" ? { session: { meta: {}, header: { cwd: root } } } : { session: { meta: { origin: "subagent" }, header: { cwd: root } } }) },
    get: () => undefined,
    on: (name, fn) => (listeners.has(name) ? listeners.get(name) : listeners.set(name, []).get(name)).push(fn),
  };
  reviewer.apply(ctx, {
    model: { provider: "p-strong", model: "m-strong", reasoningEffort: "high" },
    triggers: { minIntervalSec: 0 },
    gate: true,
  });
  const handlers = listeners.get("agent/request") ?? [];
  ok("注册 agent/request 监听", handlers.length === 1);
  const fire = (sessionId) => handlers[0]({ sessionId }, async () => "resolved");

  // 首次：只建基线
  await fire("main");
  await waitFor(async () => (await fsp.readFile(path.join(root, ".reviewer", "state.json"), "utf8").catch(() => "")).includes("snapshot"));
  ok("首次 turn 只建基线（不调用评审模型）", streamCalls.length === 0);

  // 子代理会话：不评审
  await fsp.writeFile(path.join(root, "manuscript.md"), "x", "utf8").catch(() => {});
  manifest.hypotheses[0].updatedAt = "t2";
  await fsp.writeFile(path.join(root, "research-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await fire("sub");
  await new Promise((r) => setTimeout(r, 150));
  ok("子代理会话跳过评审", streamCalls.length === 0);

  // 主会话：假设更新 → 自动评审
  await fire("main");
  const done = await waitFor(async () => (await fsp.readFile(path.join(root, "research-manifest.json"), "utf8")).includes('"R01"'));
  ok("评审完成并落盘", done);
  ok("评审模型透传 config.model", streamCalls.length === 1 && streamCalls[0].provider === "p-strong" && streamCalls[0].model === "m-strong" && streamCalls[0].reasoningEffort === "high", `${streamCalls[0]?.provider}/${streamCalls[0]?.model}`);
  const m2 = JSON.parse(await fsp.readFile(path.join(root, "research-manifest.json"), "utf8"));
  ok("manifest.reviews 登记 + testing 假设被终结", m2.reviews.length === 1 && m2.reviews[0].verdict === "supported" && m2.hypotheses[0].status === "supported");
  ok("reviews/R01/report.md 生成", (await fsp.readFile(path.join(root, "reviews", "R01", "report.md"), "utf8")).includes("结论：supported"));
  ok("gate=true 写入门禁标记", await fsp.stat(path.join(root, ".reviewer", "gate")).then(() => true, () => false));

  // 防抖：minIntervalSec 大时，新事件不触发第二次评审
  const ctx2 = { ...ctx, llm: { ...ctx.llm }, on: ctx.on };
  const streamCalls2 = [];
  ctx2.llm.stream = (o) => { streamCalls2.push(o); return (async function* () { yield { type: "finish", reason: { kind: "success" } }; })(); };
  const listeners2 = new Map();
  ctx2.on = (n, fn) => (listeners2.has(n) ? listeners2.get(n) : listeners2.set(n, []).get(n)).push(fn);
  reviewer.apply(ctx2, { model: { provider: "p", model: "m" }, triggers: { minIntervalSec: 3600 } });
  manifest.hypotheses[0].updatedAt = "t3";
  await fsp.writeFile(path.join(root, "research-manifest.json"), JSON.stringify({ ...m2, hypotheses: [{ ...m2.hypotheses[0], updatedAt: "t3" }] }, null, 2), "utf8");
  await listeners2.get("agent/request")[0]({ sessionId: "main" }, async () => "ok");
  await new Promise((r) => setTimeout(r, 200));
  ok("minIntervalSec 内不重复评审", streamCalls2.length === 0);
}

// ── 5. 评审门禁（gate）──────────────────────────────────────────────
console.log("\n== 5. 评审门禁 ERR_REVIEW_GATE ==");
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-reviewer-gate-"));
  await fsp.mkdir(path.join(root, ".git"), { recursive: true });
  await fsp.mkdir(path.join(root, "experiments", "E01"), { recursive: true });
  await fsp.mkdir(path.join(root, ".reviewer"), { recursive: true });
  await fsp.writeFile(path.join(root, ".reviewer", "gate"), "on\n", "utf8");
  const manifest = {
    schema: 2,
    project: { id: "t", title: "t", domain: "d", created: "t", status: "active" },
    question: { text: "q", updatedAt: "t" },
    hypotheses: [{ id: "H1", text: "h", status: "testing", experiments: ["E01"], reviews: ["R01"], updatedAt: "t" }],
    loop: { phase: "analysis", iteration: 0, history: [] },
    experiments: [{ id: "E01", title: "e", hypothesis: "H1", status: "running", created: "t", updatedAt: "t", reviews: ["R01"] }],
    artifacts: [],
    reviews: [{ id: "R01", target: "假设 H1", verdict: "needs-work", created: "t" }],
    updatedAt: "t",
  };
  await fsp.writeFile(path.join(root, "research-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const tools = {};
  loop.apply({ tools: { register: (d) => (tools[d.name] = d) } }, {});
  const exec = { agent: { session: { id: "s", header: { cwd: root } } } };

  // gate 拦截：最新评审 needs-work 的假设不得下结论
  let code = null;
  try {
    await tools.research_findings.execute({ experiment: "E01", finding: "新观察", conclusion: "supported" }, exec);
  } catch (err) {
    code = err.code;
  }
  ok("最新评审 needs-work → research_findings 抛 ERR_REVIEW_GATE", code === "ERR_REVIEW_GATE");

  // 复审覆盖（supported 不在终结校验前再检查 gate：最新评审已非待处理）
  await tools.research_review.execute({ target: "假设 H1 复审", verdict: "supported", hypothesis: "H1", experiment: "E01", summary: "已修复" }, exec);
  const m = JSON.parse(await fsp.readFile(path.join(root, "research-manifest.json"), "utf8"));
  ok("复审 supported 终结假设并清除待处理", m.hypotheses[0].status === "supported" && m.reviews.length === 2);

  // research_review 仍校验 verdict 枚举（含 unverifiable）
  let vcode = null;
  try {
    await tools.research_review.execute({ target: "x", verdict: "perfect" }, exec);
  } catch (err) {
    vcode = err.code;
  }
  ok("非法 verdict 仍抛 ERR_VALIDATION", vcode === "ERR_VALIDATION");
  await tools.research_review.execute({ target: "不可核实论断", verdict: "unverifiable" }, exec);
  const m3 = JSON.parse(await fsp.readFile(path.join(root, "research-manifest.json"), "utf8"));
  ok("unverifiable verdict 可登记", m3.reviews.some((r) => r.verdict === "unverifiable"));

  // 无 gate 标记的项目不受门禁影响
  const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-reviewer-nogate-"));
  await fsp.mkdir(path.join(root2, ".git"), { recursive: true });
  await fsp.mkdir(path.join(root2, "experiments", "E01"), { recursive: true });
  await fsp.writeFile(path.join(root2, "research-manifest.json"), JSON.stringify({ ...manifest, reviews: [{ id: "R01", target: "t", verdict: "needs-work", created: "t" }] }, null, 2), "utf8");
  const exec2 = { agent: { session: { id: "s", header: { cwd: root2 } } } };
  await tools.research_findings.execute({ experiment: "E01", finding: "x", conclusion: "supported" }, exec2);
  const m4 = JSON.parse(await fsp.readFile(path.join(root2, "research-manifest.json"), "utf8"));
  ok("无 gate 标记 → 正常下结论", m4.hypotheses[0].status === "supported");
}

// ── 6. recordReview 导出直调 ────────────────────────────────────────
console.log("\n== 6. recordReview 导出 ==");
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-reviewer-rr-"));
  await fsp.mkdir(path.join(root, ".git"), { recursive: true });
  await fsp.writeFile(path.join(root, "research-manifest.json"), JSON.stringify({
    schema: 2,
    project: { id: "t", title: "t", domain: "d", created: "t", status: "active" },
    question: { text: "", updatedAt: "" },
    hypotheses: [], loop: { phase: "literature", iteration: 0, history: [] },
    experiments: [], artifacts: [], reviews: [], updatedAt: "t",
  }, null, 2), "utf8");
  const r = await loop.recordReview(root, { target: "工件 tab v1", verdict: "needs-work", issues: ["缺效应量"], summary: "s" });
  ok("recordReview 返回 id 与报告路径", r.id === "R01" && r.reportPath.endsWith(path.join("reviews", "R01", "report.md")));
  const m = JSON.parse(await fsp.readFile(path.join(root, "research-manifest.json"), "utf8"));
  ok("落盘 + history 事件", m.reviews.length === 1 && m.loop.history.some((h) => h.action === "review"));
}

console.log(`\n${failures === 0 ? "✔ 全部通过" : "✗ 有失败"}：${passed} 通过，${failures} 失败`);
process.exit(failures === 0 ? 0 : 1);
