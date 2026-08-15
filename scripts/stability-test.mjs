// dsh-science stability test —— 针对 v0.1.1 并发/原子性修复的稳定性与压力测试。
//
// 覆盖：
//   1. 并行 artifact_save（不同工件）—— 索引不丢条目
//   2. 并行 artifact_save（同一工件）—— 版本 1..N 不丢失更新（回归：旧版无锁会丢）
//   3. 并行 research_*（假设/实验/发现）—— ID 不重复、状态机正确
//   4. 锁超时 —— 持锁时并发操作抛 ERR_LOCK_TIMEOUT，不挂死
//   5. 写读原子性 —— 频繁写时任意时刻读取 manifest 都是合法 JSON（无半截）
//   6. 死锁 soak —— 随机混合 research_* / artifact_* 并发，全部完成、无残留锁
//   7. 循环压力 —— 连续多轮完整循环后状态一致
//   8. 结构化输出契约 —— research_report / artifact_diff / artifact_verify 关键字段
//
// 用法：node scripts/stability-test.mjs [工作目录]
// 默认在 os.tmpdir() 下建临时工作区；全部通过退出码 0，否则 1。

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");

const work = process.argv[2]
  ? path.resolve(process.argv[2])
  : await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-science-stab-"));
await fsp.mkdir(work, { recursive: true });
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

const exec = { agent: { session: { id: "stability-test-session", cwd: work } } };

async function registerEngines(config = {}) {
  const loopMod = await import(path.join(pkg, "engines", "research-loop.mjs"));
  const artMod = await import(path.join(pkg, "engines", "artifact-registry.mjs"));
  const loopTools = {};
  const artTools = {};
  await loopMod.apply({ tools: { register: (d) => (loopTools[d.name] = d) } }, config);
  await artMod.apply({ tools: { register: (d) => (artTools[d.name] = d) } }, config);
  return { loopTools, artTools };
}

const { loopTools, artTools } = await registerEngines();
const sub = (name) => path.join(work, name);

// ── 1. 并行 artifact_save（不同工件）────────────────────────────────
console.log("== 1. 并行 artifact_save：不同工件 ==");
const tP = sub("t-parallel");
await fsp.mkdir(path.join(tP, "results"), { recursive: true });
for (let i = 1; i <= 6; i++) {
  await fsp.writeFile(path.join(tP, "results", `r${i}.txt`), `result-${i}\n`, "utf8");
}
const saveAll = await Promise.allSettled(
  Array.from({ length: 6 }, (_, i) =>
    artTools.artifact_save.execute({ root: tP, name: `job-${i + 1}`, sources: [`results/r${i + 1}.txt`] }, exec)
  )
);
ok("6 个并行保存全部成功", saveAll.every((s) => s.status === "fulfilled"), saveAll.filter((s) => s.status === "rejected").map((s) => s.reason?.code).join(","));
const index1 = JSON.parse(await fsp.readFile(path.join(tP, "artifacts", "artifacts.json"), "utf8"));
ok("索引含全部 6 个工件", index1.artifacts.length === 6);

// ── 2. 并行 artifact_save（同一工件：丢失更新回归）──────────────────
console.log("\n== 2. 并行 artifact_save：同一工件（丢失更新回归）==");
const tSame = sub("t-same");
await fsp.mkdir(path.join(tSame, "res"), { recursive: true });
await fsp.writeFile(path.join(tSame, "res", "same.txt"), "content-A\n", "utf8");
const sameSaves = await Promise.allSettled(
  Array.from({ length: 4 }, (_, i) =>
    artTools.artifact_save.execute({ root: tSame, name: "shared-art", sources: ["res/same.txt"], notes: `save-${i}` }, exec)
  )
);
ok("4 个同工件并行保存全部成功", sameSaves.every((s) => s.status === "fulfilled"), sameSaves.filter((s) => s.status === "rejected").map((s) => s.reason?.code).join(","));
const sharedMeta = JSON.parse(await fsp.readFile(path.join(tSame, "artifacts", "shared-art", "artifact.json"), "utf8"));
const versions = sharedMeta.versions.map((v) => v.version).sort((a, b) => a - b);
ok("版本 1..4 无丢失更新", JSON.stringify(versions) === "[1,2,3,4]", `实际 ${JSON.stringify(versions)}`);
const index2 = JSON.parse(await fsp.readFile(path.join(tSame, "artifacts", "artifacts.json"), "utf8"));
ok("索引 latestVersion=4", index2.artifacts.find((a) => a.name === "shared-art")?.latestVersion === 4);
ok("相同内容去重：v2+ 均链接自 v1", sharedMeta.versions.slice(1).every((v) => v.files[0]?.linkedFrom === "v1"));

// ── 3. 并行 research_* ──────────────────────────────────────────────
console.log("\n== 3. 并行 research_*：假设/实验/发现 ==");
const tR = sub("t-research");
await loopTools.research_init.execute({ root: tR, title: "并行循环", question: "并行是否一致？" }, exec);
const hypRes = await Promise.allSettled(
  Array.from({ length: 5 }, (_, i) =>
    loopTools.research_hypothesis.execute({ root: tR, text: `并行假设 ${i + 1}` }, exec)
  )
);
ok("5 个并行假设全部成功", hypRes.every((s) => s.status === "fulfilled"));
let m = JSON.parse(await fsp.readFile(path.join(tR, "research-manifest.json"), "utf8"));
const hIds = m.hypotheses.map((h) => h.id).sort();
ok("假设 ID 唯一且连续 H1..H5", JSON.stringify(hIds) === JSON.stringify(["H1", "H2", "H3", "H4", "H5"]), `实际 ${hIds.join(",")}`);

const expRes = await Promise.allSettled(
  Array.from({ length: 5 }, (_, i) =>
    loopTools.research_experiment.execute({ root: tR, title: `实验 ${i + 1}`, hypothesis: `H${i + 1}` }, exec)
  )
);
ok("5 个并行实验全部成功", expRes.every((s) => s.status === "fulfilled"));
m = JSON.parse(await fsp.readFile(path.join(tR, "research-manifest.json"), "utf8"));
const eIds = m.experiments.map((e) => e.id).sort();
ok("实验 ID 唯一且连续 E01..E05", JSON.stringify(eIds) === JSON.stringify(["E01", "E02", "E03", "E04", "E05"]), `实际 ${eIds.join(",")}`);
ok("关联假设全部进入 testing", m.hypotheses.every((h) => h.status === "testing"));

const findRes = await Promise.allSettled(
  Array.from({ length: 5 }, (_, i) =>
    loopTools.research_findings.execute(
      { root: tR, experiment: `E0${i + 1}`, finding: `发现 ${i + 1}`, conclusion: "supported" },
      exec
    )
  )
);
ok("5 个并行 findings 全部成功", findRes.every((s) => s.status === "fulfilled"));
m = JSON.parse(await fsp.readFile(path.join(tR, "research-manifest.json"), "utf8"));
ok("全部假设 supported", m.hypotheses.every((h) => h.status === "supported"));
ok("全部实验 concluded", m.experiments.every((e) => e.status === "concluded"));

// ── 4. 锁超时 ───────────────────────────────────────────────────────
console.log("\n== 4. 锁超时 ==");
const { loopTools: loopFast } = await registerEngines({ lock: { timeoutMs: 150, staleMs: 60000 } });
const tLock = sub("t-lock");
await loopFast.research_init.execute({ root: tLock, title: "锁测试" }, exec);
await fsp.writeFile(path.join(tLock, "research-manifest.json.lock"), JSON.stringify({ pid: 424242, at: new Date().toISOString() }), "utf8");
const t0 = Date.now();
try {
  await loopFast.research_hypothesis.execute({ root: tLock, text: "不应成功" }, exec);
  ok("锁超时抛 ERR_LOCK_TIMEOUT", false);
} catch (err) {
  ok("锁超时抛 ERR_LOCK_TIMEOUT", err?.code === "ERR_LOCK_TIMEOUT", `elapsed ${Date.now() - t0}ms`);
}
// 清理残留锁
await fsp.rm(path.join(tLock, "research-manifest.json.lock"), { force: true });

// ── 5. 写读原子性 ───────────────────────────────────────────────────
console.log("\n== 5. 写读原子性（读方永不见半截 JSON）==");
const tA = sub("t-atomic");
await loopTools.research_init.execute({ root: tA, title: "原子性", question: "Q?" }, exec);
await loopTools.research_hypothesis.execute({ root: tA, text: "H0" }, exec);
await loopTools.research_experiment.execute({ root: tA, title: "E0", hypothesis: "H1" }, exec);
let badReads = 0;
let reads = 0;
const writers = [];
for (let i = 0; i < 20; i++) {
  writers.push(
    (async () => {
      await loopTools.research_hypothesis.execute({ root: tA, text: `写轮 ${i}` }, exec);
      await new Promise((r) => setTimeout(r, Math.random() * 10));
    })()
  );
  // 写进行中立刻读（不加锁），必须读到完整 JSON
  const raw = await fsp.readFile(path.join(tA, "research-manifest.json"), "utf8");
  reads++;
  try {
    JSON.parse(raw);
  } catch {
    badReads++;
  }
}
await Promise.allSettled(writers);
ok("20 次并行写 + 实时读全部合法 JSON", badReads === 0 && reads === 20, `坏读 ${badReads}/${reads}`);

// ── 6. 死锁 soak：随机混合操作 ──────────────────────────────────────
console.log("\n== 6. 死锁 soak（随机混合 research_* + artifact_*）==");
const tS = sub("t-soak");
await loopTools.research_init.execute({ root: tS, title: "soak", question: "Q?" }, exec);
await loopTools.research_hypothesis.execute({ root: tS, text: "soak-H0" }, exec);
await loopTools.research_experiment.execute({ root: tS, title: "soak-E0", hypothesis: "H1" }, exec);
await fsp.mkdir(path.join(tS, "out"), { recursive: true });
await fsp.writeFile(path.join(tS, "out", "v.txt"), "v1\n", "utf8");

const opPool = [];
for (let i = 0; i < 30; i++) {
  const rnd = i % 5;
  if (rnd === 0) {
    opPool.push(() => artTools.artifact_save.execute({ root: tS, name: `soak-art-${i % 3}`, sources: ["out/v.txt"] }, exec));
  } else if (rnd === 1) {
    opPool.push(() => loopTools.research_hypothesis.execute({ root: tS, text: `soak-H${i}` }, exec));
  } else if (rnd === 2) {
    opPool.push(() => loopTools.research_state.execute({ root: tS }, exec));
  } else if (rnd === 3) {
    opPool.push(() => loopTools.research_experiment.execute({ root: tS, title: `soak-E${i}`, hypothesis: "H1" }, exec));
  } else {
    opPool.push(() => artTools.artifact_list.execute({ root: tS }, exec));
  }
}
// 分 6 批并发，批间随机延迟，模拟真实交错
const soakStart = Date.now();
let soakErrors = 0;
for (let batch = 0; batch < 6; batch++) {
  const slice = opPool.slice(batch * 5, batch * 5 + 5);
  const res = await Promise.allSettled(slice.map((fn) => fn()));
  for (const r of res) {
    if (r.status === "rejected" && r.reason?.code !== "ERR_VALIDATION") {
      // 假设状态机可能拒绝个别转移（如 H1 已 supported 时实验关联后 findings 未跑），
      // 属预期；锁/IO 类错误才算失败
      soakErrors++;
      console.error(`    soak 错误: ${r.reason?.code} ${r.reason?.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
}
ok("soak 无锁/IO 级错误", soakErrors === 0, `elapsed ${Date.now() - soakStart}ms`);

// 无残留锁文件
const lockFiles = [];
async function findLocks(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await findLocks(p);
    else if (e.name.endsWith(".lock")) lockFiles.push(p);
  }
}
await findLocks(tS);
ok("soak 后无残留 .lock 文件", lockFiles.length === 0, lockFiles.join(","));
const soakManifest = JSON.parse(await fsp.readFile(path.join(tS, "research-manifest.json"), "utf8"));
ok("soak 后 manifest 合法", soakManifest.schema === 2 && Array.isArray(soakManifest.hypotheses));

// ── 7. 循环压力：连续多轮完整循环 ───────────────────────────────────
console.log("\n== 7. 循环压力（20 轮完整循环）==");
const tC = sub("t-cycle");
await loopTools.research_init.execute({ root: tC, title: "压力循环", question: "Q?" }, exec);
let cycleOk = true;
for (let i = 1; i <= 20; i++) {
  try {
    await loopTools.research_hypothesis.execute({ root: tC, text: `C-H${i}` }, exec);
    await loopTools.research_experiment.execute({ root: tC, title: `C-E${i}`, hypothesis: `H${i}` }, exec);
    await loopTools.research_findings.execute(
      { root: tC, experiment: `E${String(i).padStart(2, "0")}`, finding: `f${i}`, conclusion: i % 2 ? "supported" : "refuted", nextQuestion: `下一问 ${i}` },
      exec
    );
  } catch (err) {
    cycleOk = false;
    console.error(`    第 ${i} 轮失败: ${err?.code} ${err?.message}`);
  }
}
const cycleManifest = JSON.parse(await fsp.readFile(path.join(tC, "research-manifest.json"), "utf8"));
ok("20 轮循环全部成功", cycleOk);
ok("20 假设 / 20 实验 / iteration=20", cycleManifest.hypotheses.length === 20 && cycleManifest.experiments.length === 20 && cycleManifest.loop.iteration === 20);
ok("假设状态按奇偶 supported/refuted", cycleManifest.hypotheses.every((h, i) => (i % 2 ? h.status === "refuted" : h.status === "supported")));

// ── 8. 结构化输出契约 ───────────────────────────────────────────────
console.log("\n== 8. 结构化输出契约 ==");
const tO = sub("t-out");
await loopTools.research_init.execute({ root: tO, title: "输出契约", question: "Q?" }, exec);
await fsp.mkdir(path.join(tO, "out"), { recursive: true });
await fsp.writeFile(path.join(tO, "out", "v.txt"), "v1\n", "utf8");
await artTools.artifact_save.execute({ root: tO, name: "o1", sources: ["out/v.txt"] }, exec);
const rep = await loopTools.research_report.execute({ root: tO }, exec);
ok("research_report 关键字段", rep && ["project", "loop", "generatedAt"].every((k) => k in rep) && Array.isArray(rep.hypotheses));
const d = await artTools.artifact_diff.execute({ root: tO, name: "o1" }, exec).catch(() => null);
ok("artifact_diff 关键字段", d && ["name", "to", "added", "removed", "changed", "unchanged"].every((k) => k in d));
const v = await artTools.artifact_verify.execute({ root: tO, name: "o1" }, exec).catch(() => null);
ok("artifact_verify 关键字段", v && ["name", "version", "status", "checked"].every((k) => k in v));

console.log(`\n结果: ${passed} 通过, ${failures} 失败`);
if (!process.argv[2]) await fsp.rm(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
