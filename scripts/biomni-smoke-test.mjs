// dsh-science Biomni-mode smoke test —— 验证 4 个 biomni 引擎（registry/retriever/plan/reflect）
// 的工具逻辑、错误码体系、默认目录播种、检索打分（领域启发式 + 关键词）、计划清单状态机、
// 反思日志追加，并对 preset-biomni 做过静态校验（引擎 yaml 存在、镜像 SHA-256 一致）。
// 用法：node scripts/biomni-smoke-test.mjs [工作目录]
// 默认工作目录 = os.tmpdir() 下的临时目录（发布包本身保持只读，适合 CI）。

import { promises as fsp, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");

// 尽力解析真实 @deepseek-ai/dsh-tools（本包零依赖，只有装了 dsh 的环境才能解析到）：
// 先按本包解析，再退回全局 npm root。解析不到返回 {}，调用方降级跳过。
async function importDshTools() {
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tools"));
  } catch { /* 本包不依赖 dsh */ }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(globalRoot, "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js"));
  } catch { /* npm root 不可用 */ }
  for (const c of candidates) {
    if (!c || !existsSync(c)) continue;
    try {
      return await import(c);
    } catch { /* 继续尝试下一个候选 */ }
  }
  return {};
}

const work = process.argv[2]
  ? path.resolve(process.argv[2])
  : await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-science-biomni-"));
// 锚定项目根：探测标记 .git 让 resolveRoot 直接返回 work，不向上爬
await fsp.mkdir(path.join(work, ".git"), { recursive: true });
console.log(`工作区：${work}\n`);

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

// 与 dsh 实际传入的形状一致：cwd 在 SessionHeader（agent.session.header.cwd）上
const exec = { agent: { session: { id: "biomni-smoke", header: { cwd: work } } } };

async function registerBiomni() {
  const tools = {};
  const mods = {};
  for (const name of ["biomni-registry", "biomni-retriever", "biomni-plan", "biomni-reflect"]) {
    const m = await import(path.join(pkg, "engines", `${name}.mjs`));
    mods[name] = m;
    await m.apply({ tools: { register: (d) => (tools[d.name] = d) } }, {});
  }
  return { tools, mods };
}

const { tools, mods } = await registerBiomni();

// ── 1. 引擎元数据 ────────────────────────────────────────────────────────────
ok("biomni-registry: name/inject/apply", mods["biomni-registry"].name === "biomni-registry" && mods["biomni-registry"].inject?.includes("tools") && typeof mods["biomni-registry"].apply === "function");
ok("biomni-retriever: name/inject/apply", mods["biomni-retriever"].name === "biomni-retriever" && mods["biomni-retriever"].inject?.includes("tools") && typeof mods["biomni-retriever"].apply === "function");
ok("biomni-plan: name/inject/apply", mods["biomni-plan"].name === "biomni-plan" && mods["biomni-plan"].inject?.includes("tools") && typeof mods["biomni-plan"].apply === "function");
ok("biomni-reflect: name/inject/apply", mods["biomni-reflect"].name === "biomni-reflect" && mods["biomni-reflect"].inject?.includes("tools") && typeof mods["biomni-reflect"].apply === "function");

const EXPECT_TOOLS = ["biomni_resources_list", "biomni_registry_add", "biomni_registry_remove", "biomni_registry_show", "biomni_retrieve", "biomni_plan_init", "biomni_plan_update", "biomni_plan_status", "biomni_reflect", "biomni_reflect_list"];
ok(`biomni tools 齐全（${EXPECT_TOOLS.length} 个）`, EXPECT_TOOLS.every((n) => typeof tools[n]?.execute === "function"));

// 回归护栏：每个工具的 parameters 必须是 object-rooted JSON Schema（type:"object" + properties）。
// dsh 的 defineTool 会把扁平参数表编译成 {type:"object",properties,required}，LLM provider
// 要求顶层 type:"object"；否则报 "Invalid schema for function ... got type: null"。
{
  const bad = [];
  for (const n of EXPECT_TOOLS) {
    const p = tools[n]?.parameters;
    if (!(p && p.type === "object" && p.properties && typeof p.properties === "object")) bad.push(n);
  }
  ok("biomni 工具 parameters 均为 object-rooted schema", bad.length === 0, bad.length ? "bad=" + bad.join(",") : "");
}

// 回归护栏：工具返回值必须是 lossless JSON（dsh 会对工具返回值做 snapshotJsonValue；
// 含 undefined/NaN/Date 等的值会抛 "value is not lossless JSON"）。
function isLosslessJson(v, seen = new Set()) {
  if (v === undefined) return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "object" && v !== null) {
    if (v instanceof Date) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.every((x) => isLosslessJson(x, seen));
    return Object.values(v).every((x) => isLosslessJson(x, seen));
  }
  return true;
}
{
  const probeWork = await fsp.mkdtemp(path.join(os.tmpdir(), "biomni-lossless-probe-"));
  await fsp.mkdir(path.join(probeWork, ".git"), { recursive: true });
  const rootExec = { agent: { session: { header: { cwd: probeWork } } } };
  const probes = [
    ["biomni_reflect", { root: probeWork, observation: "obs", reflection: "refl", verdict: "revise" }], // 未传 step → 曾触发 lossless 失败
    ["biomni_plan_status", { root: probeWork }],
    ["biomni_registry_show", { root: probeWork, type: "data_lake", name: "gtex_tissue_gene_tpm" }],
  ];
  const bad = [];
  const probed = [];
  for (const [n, args] of probes) {
    try {
      const v = await tools[n].execute(args, rootExec);
      if (!isLosslessJson(v)) bad.push(n);
      probed.push([n, v]);
    } catch (e) {
      if (e?.code === "ERR_NOT_INIT" || e?.code === "ERR_NOT_FOUND") continue;
      bad.push(`${n}(throw ${e?.code ?? e.message})`);
    }
  }
  ok("biomni 工具返回值为 lossless JSON", bad.length === 0, bad.length ? "bad=" + bad.join(",") : "");

  // 回归护栏：工具输出契约。dsh 会按 `output.schema` 校验 execute 的返回值
  // （dsh-tools createSuccessResult → validateJsonSchemaValue）。这些工具返回对象，
  // 若默认 schema 仍是 `{type:"string"}`，真实会话里每个 biomni 工具都会报
  // `tool "…" returned invalid output: "value" must be a string`——mock ctx 直接调
  // execute，绕过框架校验，因此只有这条护栏能拦住该回归。
  {
    const noConstraint = EXPECT_TOOLS.every((n) => {
      const s = tools[n]?.output?.schema;
      return s && typeof s === "object" && Object.keys(s).length === 0;
    });
    ok("biomni 工具 output.schema 不施加类型约束（{}）", noConstraint);

    const rendered = tools.biomni_plan_status.output.render({}, { root: "/x", initialized: true });
    ok("biomni 工具对象返回值渲染为 JSON（非 [object Object]）", Boolean(rendered?.[0]?.text?.includes('"initialized": true')));

    const { validateJsonSchemaValue } = await importDshTools();
    if (typeof validateJsonSchemaValue !== "function") {
      console.log("  ⚠ 跳过 output.schema 真实校验（未找到 @deepseek-ai/dsh-tools；装了 dsh 的环境会跑）");
    } else {
      const viol = [];
      for (const [n, v] of probed) {
        const vs = validateJsonSchemaValue(tools[n].output.schema, v, "value");
        if (vs.length) viol.push(`${n}: ${vs.join("; ")}`);
      }
      ok("output.schema 接受实际返回值（真实 dsh 校验器）", viol.length === 0, viol.join(" | "));
    }
  }
}

// ── 2. 注册表：默认目录播种 ──────────────────────────────────────────────────
{
  const list = await tools.biomni_resources_list.execute({ root: work }, exec);
  ok("registry: 播种默认目录", list.overview.tools > 0 && list.overview.data_lake > 0 && list.overview.libraries > 0 && list.overview.know_how > 0, `tools=${list.overview.tools} data=${list.overview.data_lake} libs=${list.overview.libraries} kh=${list.overview.know_how}`);
  ok("registry: 播种目录含 scanpy + GTEx", list.universe.libraries.some((r) => r.name === "scanpy") && list.universe.data_lake.some((r) => r.name === "gtex_tissue_gene_tpm"));
  // 过滤
  const kh = await tools.biomni_resources_list.execute({ root: work, type: "know_how" }, exec);
  ok("registry: type 过滤", kh.universe.know_how.length > 0 && !kh.universe.tools);
  // keyword
  const kw = await tools.biomni_resources_list.execute({ root: work, keyword: "单细胞" }, exec);
  ok("registry: keyword 搜索", kw.universe.libraries.some((r) => r.name === "scanpy"));
}

// ── 3. 注册表：运行时注入 / 查看 / 移除 ──────────────────────────────────────
{
  const added = await tools.biomni_registry_add.execute({ root: work, type: "data_lake", item: { name: "my_custom_dataset", description: "我的自定义数据集" } }, exec);
  ok("registry_add: 注入数据湖", added.added.name === "my_custom_dataset");
  const show = await tools.biomni_registry_show.execute({ root: work, type: "data_lake", name: "my_custom_dataset" }, exec);
  ok("registry_show: 查看注入项", show.resource.description === "我的自定义数据集");
  // 重复注入被拒
  await expectThrow(() => tools.biomni_registry_add.execute({ root: work, type: "data_lake", item: { name: "my_custom_dataset", description: "dup" } }, exec), "ERR_CONFLICT", "registry_add: 重复注入被拒");
  // 注入 know_how（带 content）
  await tools.biomni_registry_add.execute({ root: work, type: "know_how", item: { name: "my_protocol", description: "我的协议", content: "步骤 1/2/3" } }, exec);
  const kh = await tools.biomni_registry_show.execute({ root: work, type: "know_how", name: "my_protocol" }, exec);
  ok("registry_add: know_how 注入含 content", kh.resource.content === "步骤 1/2/3");
  // 移除
  const removed = await tools.biomni_registry_remove.execute({ root: work, type: "data_lake", name: "my_custom_dataset" }, exec);
  ok("registry_remove: 移除注入项", removed.removed.name === "my_custom_dataset");
  await expectThrow(() => tools.biomni_registry_remove.execute({ root: work, type: "data_lake", name: "my_custom_dataset" }, exec), "ERR_NOT_FOUND", "registry_remove: 移除不存在被拒");
  await expectThrow(() => tools.biomni_registry_add.execute({ root: work, type: "bogus", item: { name: "x" } }, exec), "ERR_VALIDATION", "registry_add: 非法 type 被拒");
}

// ── 4. 检索器：检索增强规划 ──────────────────────────────────────────────────
{
  const r = await tools.biomni_retrieve.execute({ root: work, query: "对该单细胞数据做注释并生成假说" }, exec);
  ok("retrieve: 返回聚焦子集", Array.isArray(r.focus.data_lake) && Array.isArray(r.focus.libraries) && r.focus.libraries.length > 0);
  ok("retrieve: 检测到 single_cell 主题", r.detected_topics.includes("single_cell"), r.detected_topics.join(","));
  ok("retrieve: 相关库被聚焦（scanpy 在 libraries）", r.focus.libraries.some((x) => x.name === "scanpy"));
  ok("retrieve: 相关工具被聚焦（omics 在 tools）", r.focus.tools.some((x) => x.name === "omics"));
  ok("retrieve: 给出计划骨架", Array.isArray(r.plan_hint.steps) && r.plan_hint.steps.length > 0);
  // 变异主题
  const rv = await tools.biomni_retrieve.execute({ root: work, query: "解释这个 VCF 里的致病变异" }, exec);
  ok("retrieve: 检测到 variants 主题", rv.detected_topics.includes("variants"));
  ok("retrieve: 变异查询聚焦 gnomad 数据", rv.focus.data_lake.some((x) => x.name === "gnomad"));
  // query 必填
  await expectThrow(() => tools.biomni_retrieve.execute({ root: work, query: "" }, exec), "ERR_VALIDATION", "retrieve: 空 query 被拒");
}

// ── 5. 计划：清单状态机 ──────────────────────────────────────────────────────
{
  const init = await tools.biomni_plan_init.execute({ root: work, task: "单细胞注释", goal: "标识细胞类型", steps: ["读数据", "聚类", "标注"] }, exec);
  ok("plan_init: 建立清单", init.plan.status === "active" && init.plan.steps.length === 3);
  const upd = await tools.biomni_plan_update.execute({ root: work, step: 0, stepStatus: "done", addResult: "已读入 3w×2k 矩阵，QC 通过" }, exec);
  ok("plan_update: 步骤置 done", upd.plan.steps[0].status === "done");
  ok("plan_update: 追加结果（含观察）", upd.plan.results.length === 1 && upd.plan.results[0].result.includes("矩阵"));
  const updFail = await tools.biomni_plan_update.execute({ root: work, step: 1, stepStatus: "failed", note: "内存不足" }, exec);
  ok("plan_update: 步骤置 failed + note", updFail.plan.steps[1].status === "failed" && updFail.plan.steps[1].note === "内存不足");
  const updAddStep = await tools.biomni_plan_update.execute({ root: work, addStep: "可视化" }, exec);
  ok("plan_update: 追加步骤", updAddStep.plan.steps.length === 4 && updAddStep.plan.steps[3].text === "可视化");
  const status = await tools.biomni_plan_status.execute({ root: work }, exec);
  ok("plan_status: 渲染清单", status.initialized && status.text.includes("研究计划") && status.text.includes("[✓]"));
  await expectThrow(() => tools.biomni_plan_update.execute({ root: work, step: 99, stepStatus: "done" }, exec), "ERR_NOT_FOUND", "plan_update: 步骤越界被拒");
  await expectThrow(() => tools.biomni_plan_init.execute({ root: work, task: "" }, exec), "ERR_VALIDATION", "plan_init: 空 task 被拒");
}

// ── 6. 反思：自批判日志 ──────────────────────────────────────────────────────
{
  const rec = await tools.biomni_reflect.execute({ root: work, observation: "聚类出 12 类", reflection: "12 类偏多，可能需合并", diagnosis: "分辨率可能过高", nextAction: "降低分辨率重聚类", verdict: "revise", step: 2 }, exec);
  ok("reflect: 记录反思", rec.recorded.verdict === "revise" && rec.recorded.observation === "聚类出 12 类");
  await tools.biomni_reflect.execute({ root: work, observation: "QC 通过", reflection: "可继续", verdict: "ok" }, exec);
  const list = await tools.biomni_reflect_list.execute({ root: work }, exec);
  ok("reflect_list: 返回最近反思", list.count === 2 && list.reflections[0].observation === "QC 通过");
  await expectThrow(() => tools.biomni_reflect.execute({ root: work }, exec), "ERR_VALIDATION", "reflect: 空观察+空反思被拒");
}

// ── 7. preset-biomni 静态校验 ────────────────────────────────────────────────
{
  const presetDir = path.join(pkg, "preset-biomni");
  ok("preset-biomni: preset.yml 存在", existsSync(path.join(presetDir, "preset.yml")));
  ok("preset-biomni: agent.cordis.yml 存在", existsSync(path.join(presetDir, "agent.cordis.yml")));
  // 引擎镜像与源一致
  for (const f of ["core.mjs", "biomni-registry.mjs", "biomni-retriever.mjs", "biomni-plan.mjs", "biomni-reflect.mjs"]) {
    const a = createHash("sha256").update(await fsp.readFile(path.join(pkg, "engines", f))).digest("hex");
    const b = createHash("sha256").update(await fsp.readFile(path.join(presetDir, "engines", f))).digest("hex");
    ok(`preset-biomni: engines/${f} 与源一致`, a === b);
  }
  // agent.cordis.yml 引用 4 个 biomni 引擎（相对路径）
  const cordis = await fsp.readFile(path.join(presetDir, "agent.cordis.yml"), "utf8");
  for (const eng of ["biomni-registry.mjs", "biomni-retriever.mjs", "biomni-plan.mjs", "biomni-reflect.mjs"]) {
    ok(`preset-biomni: agent.cordis.yml 引用 ${eng}`, cordis.includes(`./engines/${eng}`));
  }
}

// ── 8. 技能存在 ──────────────────────────────────────────────────────────────
ok("skill: biomni-agent/SKILL.md 存在", existsSync(path.join(pkg, "skills", "biomni-agent", "SKILL.md")));

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} 通过，${failures} 失败`);
process.exit(failures ? 1 : 0);
