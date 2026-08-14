// dsh-science smoke test —— 在临时工作区上验证两个引擎插件的全部工具逻辑，
// 并对发布包做静态校验（dsh.bundle manifest、cordis.patch.yml 子路径、引擎镜像一致性）。
// 用法：node scripts/smoke-test.mjs [工作目录]
// 默认工作目录 = os.tmpdir() 下的临时目录（发布包本身保持只读，适合 CI）。

import { promises as fsp, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");

// ── 临时工作区 ──────────────────────────────────────────────────────
const work = process.argv[2]
  ? path.resolve(process.argv[2])
  : await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-science-smoke-"));
await fsp.mkdir(work, { recursive: true });
console.log(`工作区：${work}\n`);

const plugins = [
  { name: "science-research-loop", file: path.join(pkg, "engines", "research-loop.mjs") },
  { name: "science-artifact-registry", file: path.join(pkg, "engines", "artifact-registry.mjs") },
];
const exec = { agent: { session: { id: "smoke-test-session", cwd: work } } };

let failures = 0;
let passed = 0;

async function runTool(tool, args) {
  return String(await tool.execute(args, exec));
}

// ── 静态包校验 ──────────────────────────────────────────────────────
console.log("== 静态包校验 ==");
const pkgJson = JSON.parse(await fsp.readFile(path.join(pkg, "package.json"), "utf8"));
if (pkgJson?.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("package.json 缺少 dsh.bundle.patch");
console.log("  package.json: dsh.bundle.patch ✓");
passed++;

const patchText = await fsp.readFile(path.join(pkg, "cordis.patch.yml"), "utf8");
const engineNames = ["research-loop.mjs", "artifact-registry.mjs"];
for (const e of engineNames) {
  const want = `dsh-science/engines/${e}`;
  if (!patchText.includes(want)) throw new Error(`cordis.patch.yml 缺少子路径引用 ${want}`);
  if (!pkgJson.exports?.["./engines/*"]) throw new Error(`package.json exports 缺少 ./engines/*`);
}
console.log("  cordis.patch.yml: 子路径导出引用 ✓");
passed++;

for (const e of engineNames) {
  const a = await sha256(path.join(pkg, "engines", e));
  const b = await sha256(path.join(pkg, "preset", "engines", e));
  if (a !== b) throw new Error(`engines/${e} 与 preset/engines/${e} 不一致（先跑 bash scripts/sync-engines.sh）`);
}
console.log("  engines/ ↔ preset/engines/ 镜像一致 ✓");
passed++;

// ── 插件工具注册 ────────────────────────────────────────────────────
for (const p of plugins) {
  const mod = await import(p.file);
  if (mod.name !== p.name) throw new Error(`${p.file}: name export mismatch`);
  if (typeof mod.apply !== "function") throw new Error(`${p.file}: missing apply`);
  const definitions = [];
  await mod.apply({ tools: { register: (def) => definitions.push(def) } }, {});
  console.log(`\n== ${p.name}: ${definitions.length} tools registered ==`);
  for (const d of definitions) console.log(`   - ${d.name}`);
  for (const d of definitions) {
    try {
      const out = await runTool(d, {});
      passed++;
      console.log(`   ${d.name}: OK (${out.split("\n")[0].slice(0, 80)})`);
    } catch (err) {
      failures++;
      console.error(`   ${d.name}: THREW ${err.message}`);
    }
  }
}

// ── 端到端研究循环演练 ─────────────────────────────────────────────
console.log("\n== 端到端演练：研究循环 + 工件 ==");
const loopMod = await import(path.join(pkg, "engines", "research-loop.mjs"));
const artMod = await import(path.join(pkg, "engines", "artifact-registry.mjs"));
const loopTools = {};
const artTools = {};
for (const mod of [loopMod, artMod]) {
  const defs = [];
  await mod.apply({ tools: { register: (d) => defs.push(d) } }, {});
  for (const d of defs) (mod === loopMod ? loopTools : artTools)[d.name] = d;
}

const steps = [
  ["research_init", { title: "AMR 病原体基因组监测（演示）", domain: "bioinformatics", question: "本地暴发菌株是否携带已知耐药基因？" }],
  ["research_hypothesis", { text: "暴发菌株共享同一获得性耐药基因盒（如 blaNDM）", question: "暴发菌株是否共享耐药基因盒？" }],
  ["research_experiment", { title: "耐药基因筛查", hypothesis: "H1", objective: "对 3 株暴发分离株做 WGS 耐药基因筛查", plan: ["fastp 修剪", "kraken2 污染检查", "ResFinder/AMRFinder 耐药基因注释"] }],
  ["research_findings", { experiment: "E01", finding: "3 株均检出 blaNDM-5（覆盖度>30x，identity>99%）", conclusion: "supported", nextQuestion: "耐药基因是否位于可转移质粒？" }],
  ["research_phase", { phase: "analysis" }],
];

for (const [name, args] of steps) {
  const out = await loopTools[name].execute(args, exec);
  console.log(`research_${name} -> ${String(out).split("\n").slice(0, 3).join(" | ")}`);
  passed++;
}

const artifactFile = path.join(work, "experiments", "E01", "results", "amr-summary.tsv");
await fsp.mkdir(path.dirname(artifactFile), { recursive: true });
await fsp.writeFile(artifactFile, "sample\tgene\tidentity\tcoverage\nS1\tblaNDM-5\t99.4\t42x\nS2\tblaNDM-5\t99.1\t38x\nS3\tblaNDM-5\t99.6\t51x\n", "utf8");

const saveOut = await artTools.artifact_save.execute(
  {
    name: "amr-screening",
    description: "3 株暴发分离株耐药基因筛查结果",
    sources: ["experiments/E01/results/amr-summary.tsv"],
    command: "amrfinder --organism bacterium -p <assemblies>",
    inputs: ["data/raw/assemblies/"],
    notes: "AMRFinderPlus v4.0.3, identity>=99%, coverage>=30x",
  },
  exec
);
console.log(`artifact_save -> ${String(saveOut).split("\n").slice(0, 4).join(" | ")}`);
passed++;

const listOut = await artTools.artifact_list.execute({}, exec);
console.log(`artifact_list -> ${String(listOut).split("\n")[0]}`);
passed++;

const reviewOut = await loopTools.research_review.execute(
  { target: "claim: 3 株均携带 blaNDM-5", verdict: "supported", issues: ["需补质粒定位实验"], summary: "命令与结果文件一致，注释参数合理" },
  exec
);
console.log(`research_review -> ${String(reviewOut).split("\n")[0]}`);
passed++;

// ── 校验产物 ────────────────────────────────────────────────────────
const manifest = JSON.parse(await fsp.readFile(path.join(work, "research-manifest.json"), "utf8"));
console.log(`\nmanifest: 假设 ${manifest.hypotheses.length} 条、实验 ${manifest.experiments.length} 个、评审 ${manifest.reviews.length} 条、阶段 ${manifest.loop.phase}、迭代 ${manifest.loop.iteration}`);
const provPath = path.join(work, "artifacts", "amr-screening", "provenance.md");
console.log(`provenance.md 存在: ${existsSync(provPath)}，长度 ${(await fsp.readFile(provPath, "utf8")).length} 字符`);
passed++;

console.log(`\n结果: ${passed} 通过, ${failures} 失败`);
if (!process.argv[2]) await fsp.rm(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);

async function sha256(p) {
  const data = await fsp.readFile(p);
  return createHash("sha256").update(data).digest("hex");
}
