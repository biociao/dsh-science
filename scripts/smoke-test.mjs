// dsh-science smoke test —— 在临时工作区上验证两个引擎插件的工具逻辑、
// 错误码体系、状态机约束、并发基础（锁/原子写）、schema 迁移与新工具
// （artifact_diff / artifact_verify / artifact_deprecate / research_report），
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
const exec = { agent: { session: { id: "smoke-test-session", header: { cwd: work } } } };

// ── 0. 项目根探测回归 ──
// 0a. 会话 cwd 必须取自 session.header.cwd（旧代码读 session.cwd，永远回退 process.cwd()）
{
  const core = await import(path.join(pkg, "engines", "core.mjs"));
  const fakeWork = path.join(work, "session-cwd-probe");
  await fsp.mkdir(fakeWork, { recursive: true });
  const execHeader = { agent: { session: { header: { cwd: fakeWork } } } };
  ok(
    "core.resolveCwd 读取 session.header.cwd",
    core.resolveCwd(execHeader) === fakeWork && fakeWork !== process.cwd(),
  );
  // 0b. HOME 不得作为自动探测的项目根（~/.dsh 是 DSH 配置目录，非项目标记）：
  //     伪造 HOME（os.homedir() 读 $HOME）含 .dsh，home 下无标记的目录
  //     探测不得爬到 HOME，而应以自身为根。
  {
    const fakeHome = path.join(work, "fake-home");
    await fsp.mkdir(path.join(fakeHome, ".dsh"), { recursive: true });
    const proj = path.join(fakeHome, "fresh-proj");
    await fsp.mkdir(proj, { recursive: true });
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const climbed = core.findProjectRoot(proj, [".dsh", ".git"]);
      ok("core.findProjectRoot 不经 ~/.dsh 爬到 HOME", climbed === proj);
    } finally {
      process.env.HOME = realHome;
    }
  }
  // 0c. 正常目录的探测不受影响：自身含 .git 即为根
  const gitProj = path.join(work, "git-proj");
  await fsp.mkdir(path.join(gitProj, ".git"), { recursive: true });
  ok("core.findProjectRoot 命中自身 .git", core.findProjectRoot(path.join(gitProj, "a", "b"), [".dsh", ".git"]) === gitProj);
}

async function registerEngines(config = {}) {
  const loopMod = await import(path.join(pkg, "engines", "research-loop.mjs"));
  const artMod = await import(path.join(pkg, "engines", "artifact-registry.mjs"));
  const loopTools = {};
  const artTools = {};
  await loopMod.apply({ tools: { register: (d) => (loopTools[d.name] = d) } }, config);
  await artMod.apply({ tools: { register: (d) => (artTools[d.name] = d) } }, config);
  return { loopTools, artTools, loopMod, artMod };
}

// approval：测试用审批桩（记录请求，可按需返回 allowed-once / rejected）
function approvalStub(reject = false) {
  const requests = [];
  return {
    requests,
    service: {
      request: async (req) => {
        requests.push(req.reason);
        return reject ? "rejected" : "allowed-once";
      },
    },
  };
}

async function registerRemote({ approval, ...config } = {}) {
  const remoteMod = await import(path.join(pkg, "engines", "remote-compute.mjs"));
  const remoteTools = {};
  const hostsDir = path.join(work, "remotes-hosts");
  await fsp.mkdir(hostsDir, { recursive: true });
  const ctx = {
    tools: { register: (d) => (remoteTools[d.name] = d) },
    get: (k) => (k === "approval" ? approval?.service : undefined),
  };
  await remoteMod.apply(ctx, {
    hostsDir,
    requireApproval: false,
    requireHostAccess: false,
    markers: ["research-manifest.json", ".dsh", ".git"],
    ...config,
  });
  return { remoteTools, remoteMod, hostsDir };
}

const sub = (name) => path.join(work, name);

// ── 1. 静态包校验 ───────────────────────────────────────────────────
console.log("== 1. 静态包校验 ==");
const pkgJson = JSON.parse(await fsp.readFile(path.join(pkg, "package.json"), "utf8"));
ok("package.json: dsh.bundle.patch", pkgJson?.dsh?.bundle?.patch === "./cordis.patch.yml");

const patchText = await fsp.readFile(path.join(pkg, "cordis.patch.yml"), "utf8");
let patchOk =
  patchText.includes("dsh-science/engines/research-loop.mjs") &&
  patchText.includes("dsh-science/engines/artifact-registry.mjs") &&
  patchText.includes("dsh-science/engines/remote-compute.mjs") &&
  patchText.includes("- id: model-tier") &&
  patchText.includes("name: dsh-model-tier");
ok("cordis.patch.yml: 子路径导出引用三个引擎 + dsh-model-tier 挂载行", patchOk);
ok("package.json 依赖 dsh-model-tier（配套路由 bundle）", typeof pkgJson.dependencies?.["dsh-model-tier"] === "string");
ok("package.json exports ./engines/*（含 core.mjs 子路径）", Boolean(pkgJson.exports?.["./engines/*"]));

let mirrorOk = true;
for (const e of ["core.mjs", "research-loop.mjs", "artifact-registry.mjs", "remote-compute.mjs"]) {
  const a = await sha256(path.join(pkg, "engines", e));
  const b = await sha256(path.join(pkg, "preset", "engines", e));
  if (a !== b) mirrorOk = false;
}
ok("engines/ ↔ preset/engines/ 镜像一致（含 core.mjs）", mirrorOk);

// ── 2. 插件契约与工具注册 ───────────────────────────────────────────
console.log("\n== 2. 插件契约与工具注册 ==");
const { loopTools, artTools, loopMod, artMod } = await registerEngines();
ok("research-loop: name/inject/apply", loopMod.name === "science-research-loop" && loopMod.inject?.includes("tools") && typeof loopMod.apply === "function");
ok("artifact-registry: name/inject/apply", artMod.name === "science-artifact-registry" && artMod.inject?.includes("tools") && typeof artMod.apply === "function");

// dsh-model-tier（配套依赖包）：契约 + 虚拟 provider 注册 + 默认模型守卫
const routerMod = await import(path.join(pkg, "packages", "dsh-model-tier", "engines", "model-tier.mjs"));
const routerListeners = {};
const routerCtx = {
  logger: { info() {}, warn() {} },
  llm: {
    listProviders: () => [{ id: "deepseek-official", name: "DeepSeek" }],
    registerAdapter(routes, adapter) { this._routes = routes; this._adapter = adapter; return () => {}; },
  },
  agents: { get: () => undefined },
  on: (name, fn) => { (routerListeners[name] ??= []).push(fn); return () => {}; },
};
routerMod.apply(routerCtx, {
  // 隔离：指向不存在的临时路径，避免读到真实 ~/.dsh/model-tier.json
  configFile: path.join(sub("t-mt-router-home"), "model-tier.json"),
  tiers: { strong: { provider: "deepseek-official", model: "x" }, default: { provider: "deepseek-official", model: "deepseek-v4-flash" }, light: { provider: "deepseek-official", model: "x" } },
});
ok("dsh-model-tier: name/inject/apply", routerMod.name === "dsh-model-tier" && routerMod.inject?.includes("llm") && typeof routerMod.apply === "function");
ok("dsh-model-tier: 注册虚拟 provider「智能分档」", JSON.stringify(routerCtx.llm._routes) === '["model-tier"]' && routerCtx.llm._adapter?.providerInfo?.("model-tier")?.name === "智能分档");
ok("dsh-model-tier: 注册默认模型守卫（agent/request ×1，不再全局路由）", (routerListeners["agent/request"] ?? []).length === 1 && (routerListeners["llm/stream"] ?? []).length === 0);
ok("dsh-model-tier: 决策/仓库函数导出", typeof routerMod.decideTier === "function" && typeof routerMod.resolveTierTarget === "function" && typeof routerMod.schemeStoreFrom === "function" && routerMod.routeStatus instanceof Map);
{
  // 无配置文件时，yaml tiers 暴露为「默认（bundle 配置）」方案供选择器选用
  const models = await routerCtx.llm._adapter.listModels("model-tier");
  ok("dsh-model-tier: listModels 暴露 bundle 默认方案", models.length === 1 && models[0].id === "bundle");
}

const EXPECT_LOOP = ["research_init", "research_state", "research_hypothesis", "research_experiment", "research_findings", "research_phase", "research_review", "research_report"];
const EXPECT_ART = ["artifact_save", "artifact_list", "artifact_show", "artifact_diff", "artifact_verify", "artifact_deprecate", "artifact_reproduce"];
const loopMissing = EXPECT_LOOP.filter((n) => !loopTools[n]);
const artMissing = EXPECT_ART.filter((n) => !artTools[n]);
ok(`research-loop 注册 8 工具`, loopMissing.length === 0, loopMissing.length ? `缺：${loopMissing}` : "");
ok(`artifact-registry 注册 7 工具`, artMissing.length === 0, artMissing.length ? `缺：${artMissing}` : "");
ok("结构化输出：research_report / artifact_diff / artifact_verify 有 JSON schema",
  loopTools.research_report.output?.schema?.type === "object" &&
  artTools.artifact_diff.output?.schema?.type === "object" &&
  artTools.artifact_verify.output?.schema?.type === "object");

// ── 3. 错误码 / 校验（隔离根目录，互不干扰）──────────────────────────
console.log("\n== 3. 错误码与校验约束 ==");
await expectThrow(() => loopTools.research_state.execute({ root: sub("t-err-uninit") }, exec), "ERR_NOT_INIT", "未初始化时 research_state");
await expectThrow(() => loopTools.research_hypothesis.execute({ root: sub("t-err-valid"), text: "" }, exec), "ERR_VALIDATION", "research_hypothesis 缺 text");
await expectThrow(() => loopTools.research_hypothesis.execute({ root: sub("t-err-valid"), text: "x", status: "supported" }, exec), "ERR_VALIDATION", "research_hypothesis 初始状态不得为结论态");
const tValid = sub("t-err-valid");
await loopTools.research_init.execute({ root: tValid, title: "校验测试" }, exec);
await expectThrow(() => loopTools.research_findings.execute({ root: tValid, experiment: "E99", finding: "x" }, exec), "ERR_NOT_FOUND", "research_findings 未知实验");
await expectThrow(() => loopTools.research_phase.execute({ root: tValid, phase: "nope" }, exec), "ERR_VALIDATION", "research_phase 未知阶段");
await expectThrow(() => loopTools.research_review.execute({ root: tValid, target: "c", verdict: "maybe" }, exec), "ERR_VALIDATION", "research_review verdict 枚举");
await expectThrow(() => artTools.artifact_save.execute({ root: sub("t-err-path"), name: "a", sources: ["../escape.txt"] }, exec), "ERR_PATH", "artifact_save 路径越界");

// 阶段回退（正向先建项目）
const tPhase = sub("t-phase");
await loopTools.research_init.execute({ root: tPhase, title: "阶段测试" }, exec);
await loopTools.research_phase.execute({ root: tPhase, phase: "experiment" }, exec);
await expectThrow(() => loopTools.research_phase.execute({ root: tPhase, phase: "literature" }, exec), "ERR_VALIDATION", "research_phase 回退阶段被拒");

// 假设状态机：实验关联自动推进 testing；终态不能直跳另一结论
const tSm = sub("t-statemachine");
await loopTools.research_init.execute({ root: tSm, title: "状态机测试", question: "Q?" }, exec);
await loopTools.research_hypothesis.execute({ root: tSm, text: "H 需经 testing" }, exec);
await loopTools.research_experiment.execute({ root: tSm, title: "E", hypothesis: "H1" }, exec);
const mSm = JSON.parse(await fsp.readFile(path.join(tSm, "research-manifest.json"), "utf8"));
ok("关联实验自动推进 H1 → testing", mSm.hypotheses.find((h) => h.id === "H1")?.status === "testing");
const refOut = await loopTools.research_findings.execute({ root: tSm, experiment: "E01", finding: "f2", conclusion: "refuted" }, exec);
ok("状态机：testing → refuted 合法", typeof refOut === "string" && refOut.includes("被否定"));
await expectThrow(
  () => loopTools.research_findings.execute({ root: tSm, experiment: "E01", finding: "f3", conclusion: "supported" }, exec),
  "ERR_VALIDATION",
  "状态机：终态不可直跳另一结论（refuted → supported）"
);

// 配额
const { artTools: artQuota } = await registerEngines({ maxFileBytes: 100 });
const tQuota = sub("t-quota");
await fsp.mkdir(path.join(tQuota, "analyses"), { recursive: true });
await fsp.writeFile(path.join(tQuota, "analyses", "big.bin"), Buffer.alloc(500, 7), "utf8");
await expectThrow(
  () => artQuota.artifact_save.execute({ root: tQuota, name: "big", sources: ["analyses/big.bin"] }, exec),
  "ERR_QUOTA",
  "artifact_save 大小配额"
);

// ── 4. 端到端研究循环 + 工件（含迁移、去重、结构化输出）──────────────
console.log("\n== 4. 端到端演练：研究循环 + 工件 + 新工具 ==");
const tE2e = sub("t-e2e");
const steps = [
  ["research_init", { root: tE2e, title: "AMR 病原体基因组监测（演示）", domain: "bioinformatics", question: "本地暴发菌株是否携带已知耐药基因？" }],
  ["research_hypothesis", { root: tE2e, text: "暴发菌株共享同一获得性耐药基因盒（如 blaNDM）", question: "暴发菌株是否共享耐药基因盒？" }],
  ["research_experiment", { root: tE2e, title: "耐药基因筛查", hypothesis: "H1", objective: "对 3 株暴发分离株做 WGS 耐药基因筛查", plan: ["fastp 修剪", "kraken2 污染检查", "ResFinder/AMRFinder 耐药基因注释"] }],
  ["research_findings", { root: tE2e, experiment: "E01", finding: "3 株均检出 blaNDM-5（覆盖度>30x，identity>99%）", conclusion: "supported", nextQuestion: "耐药基因是否位于可转移质粒？" }],
  ["research_phase", { root: tE2e, phase: "manuscript" }],
];
for (const [name, args] of steps) {
  const out = await loopTools[name].execute(args, exec);
  console.log(`  ${name} -> ${String(out).split("\n")[0].slice(0, 90)}`);
  passed++;
}
ok("研究循环 5 步全部执行", true);

// 清单状态断言
const manifest = JSON.parse(await fsp.readFile(path.join(tE2e, "research-manifest.json"), "utf8"));
ok("manifest schema=2", manifest.schema === 2);
ok("假设 H1 → supported", manifest.hypotheses.find((h) => h.id === "H1")?.status === "supported");
ok("实验 E01 → concluded", manifest.experiments.find((e) => e.id === "E01")?.status === "concluded");
ok("iteration=1（nextQuestion 递增，统一语义）", manifest.loop.iteration === 1);
ok("phase=manuscript（正向推进）", manifest.loop.phase === "manuscript");
ok("manifest.artifacts 初始为空", Array.isArray(manifest.artifacts) && manifest.artifacts.length === 0);

// research_experiment 输出含下一步建议
const expOut = await loopTools.research_experiment.execute({ root: tE2e, title: "质粒定位", hypothesis: "H1" }, exec);
ok("research_experiment 返回下一步建议", typeof expOut === "string" && expOut.includes("下一步建议"));

// 工件：v1 保存 + 回写 manifest + 仪表盘联动
const artifactFile = path.join(tE2e, "experiments", "E01", "results", "amr-summary.tsv");
await fsp.mkdir(path.dirname(artifactFile), { recursive: true });
await fsp.writeFile(artifactFile, "sample\tgene\tidentity\tcoverage\nS1\tblaNDM-5\t99.4\t42x\nS2\tblaNDM-5\t99.1\t38x\nS3\tblaNDM-5\t99.6\t51x\n", "utf8");
const envFile = path.join(tE2e, "envs", "amr.yaml");
await fsp.writeFile(envFile, "name: amr\nchannels: [bioconda]\ndependencies: [amrfinderplus=4.0.3]\n", "utf8");

const save1 = await artTools.artifact_save.execute(
  {
    root: tE2e,
    name: "amr-screening",
    description: "3 株暴发分离株耐药基因筛查结果",
    sources: ["experiments/E01/results/amr-summary.tsv"],
    command: "amrfinder --organism bacterium -p <assemblies>",
    inputs: ["data/raw/assemblies/"],
    envFile: "envs/amr.yaml",
    notes: "AMRFinderPlus v4.0.3, identity>=99%, coverage>=30x",
  },
  exec
);
ok("artifact_save v1", String(save1).includes("v1"));

const manifest2 = JSON.parse(await fsp.readFile(path.join(tE2e, "research-manifest.json"), "utf8"));
ok("artifact_save 回写 manifest.artifacts", manifest2.artifacts.some((a) => a.name === "amr-screening" && a.latestVersion === 1));

const stateOut = await loopTools.research_state.execute({ root: tE2e }, exec);
ok("research_state 仪表盘显示工件数（manifest↔artifacts 打通）", stateOut.includes("工件（1）"));

// v2：相同内容 → 去重（hardlink）
const save2 = await artTools.artifact_save.execute({ root: tE2e, name: "amr-screening", sources: ["experiments/E01/results/amr-summary.tsv"], command: "amrfinder ..." }, exec);
ok("artifact_save v2", String(save2).includes("v2"));
const meta = JSON.parse(await fsp.readFile(path.join(tE2e, "artifacts", "amr-screening", "artifact.json"), "utf8"));
ok("v2 去重：linkedFrom=v1", meta.versions[1].files[0]?.linkedFrom === "v1");
ok("v1 溯源含 envFile", meta.versions[0].provenance?.envFile?.path === "envs/amr.yaml");
ok("v2 溯源含 inputHashes 记录", Array.isArray(meta.versions[1].provenance?.inputHashes));
const shaA = meta.versions[0].files[0].sha256;
const shaB = meta.versions[1].files[0].sha256;
ok("v1/v2 内容哈希一致", shaA === shaB);

// artifact_diff：默认对比最新两版
const diff = await artTools.artifact_diff.execute({ root: tE2e, name: "amr-screening" }, exec);
ok("artifact_diff 结构化输出", diff && typeof diff === "object" && diff.from === 1 && diff.to === 2);
ok("artifact_diff unchanged 含文件", Array.isArray(diff.unchanged) && diff.unchanged.includes("amr-summary.tsv"));

// artifact_verify：重算哈希一致
const verify = await artTools.artifact_verify.execute({ root: tE2e, name: "amr-screening" }, exec);
ok("artifact_verify status=ok", verify && verify.status === "ok" && verify.checked === 1);

// 篡改后校验应报 mismatch
await fsp.appendFile(path.join(tE2e, "artifacts", "amr-screening", "v2", "amr-summary.tsv"), "\ntampered\n", "utf8");
const verifyBad = await artTools.artifact_verify.execute({ root: tE2e, name: "amr-screening" }, exec);
ok("artifact_verify 检出篡改", verifyBad.status === "mismatch" && verifyBad.mismatches.length === 1);
await fsp.writeFile(path.join(tE2e, "artifacts", "amr-screening", "v2", "amr-summary.tsv"), "sample\tgene\tidentity\tcoverage\nS1\tblaNDM-5\t99.4\t42x\nS2\tblaNDM-5\t99.1\t38x\nS3\tblaNDM-5\t99.6\t51x\n", "utf8");

// artifact_deprecate
const dep = await artTools.artifact_deprecate.execute({ root: tE2e, name: "amr-screening", reason: "已被 v2 取代" }, exec);
ok("artifact_deprecate", typeof dep === "string" && dep.includes("已标记废弃"));
const listOut = await artTools.artifact_list.execute({ root: tE2e }, exec);
ok("artifact_list 显示废弃标记", listOut.includes("已废弃"));

// research_review：枚举 + 假设联动（H2 处于 testing → 评审可终结）
await loopTools.research_hypothesis.execute({ root: tE2e, text: "耐药基因位于 IncF 质粒上" }, exec);
await loopTools.research_experiment.execute({ root: tE2e, title: "质粒分型", hypothesis: "H2" }, exec);
const rev = await loopTools.research_review.execute({ root: tE2e, target: "claim: blaNDM-5 位于质粒", verdict: "supported", hypothesis: "H2", experiment: "E02", issues: ["需补 S1 质粒组装验证"], summary: "命令与结果文件一致" }, exec);
ok("research_review 归档", typeof rev === "string" && rev.includes("R01"));
const manifest3 = JSON.parse(await fsp.readFile(path.join(tE2e, "research-manifest.json"), "utf8"));
ok("评审终结 testing 假设 H2 → supported", manifest3.hypotheses.find((h) => h.id === "H2")?.status === "supported");
ok("评审写入 reviews/R01/report.md", existsSync(path.join(tE2e, "reviews", "R01", "report.md")));

// research_report：结构化输出
const report = await loopTools.research_report.execute({ root: tE2e }, exec);
ok("research_report 结构化对象", report && typeof report === "object" && report.project?.title?.includes("AMR") && report.generatedAt);
ok("research_report artifacts ≥1", Array.isArray(report.artifacts) && report.artifacts.length >= 1);

// research_state detail + historyLimit 裁剪
const stateDetail = await loopTools.research_state.execute({ root: tE2e, detail: true, historyLimit: 2 }, exec);
const mJson = /```json\n([\s\S]*?)\n```/.exec(stateDetail)?.[1];
const detailParsed = mJson ? JSON.parse(mJson) : null;
ok("research_state detail 解析", !!detailParsed);
ok("historyLimit=2 生效", Array.isArray(detailParsed?.loop?.history) && detailParsed.loop.history.length <= 2);

// 审计日志：成功记录在 t-e2e，失败记录（错误码）在 tSm（有意的 ERR_VALIDATION）
const auditLog = await fsp.readFile(path.join(tE2e, ".science.log"), "utf8").catch(() => "");
const lines = auditLog.split("\n").filter(Boolean);
ok("审计日志 .science.log 存在且有记录", lines.length >= 8);
const auditFail = await fsp.readFile(path.join(tSm, ".science.log"), "utf8").catch(() => "");
ok("审计含失败记录（错误码）", auditFail.includes('"ok":false'));

// 空问题警告
const tWarn = sub("t-warn");
const initWarn = await loopTools.research_init.execute({ root: tWarn, title: "无问题项目" }, exec);
ok("research_init 空问题给出警告", String(initWarn).includes("未设置核心研究问题"));

// ── 5. schema 迁移（v1 → v2）───────────────────────────────────────
console.log("\n== 5. schema 迁移 ==");
const tMig = sub("t-migrate");
await fsp.mkdir(tMig, { recursive: true });
const v1Manifest = {
  schema: 1,
  project: { id: "old", title: "旧项目", domain: "bioinformatics", created: "2024-01-01T00:00:00.000Z", status: "active" },
  question: { text: "旧问题", updatedAt: "2024-01-01T00:00:00.000Z" },
  hypotheses: [{ id: "H1", text: "旧假设", status: "proposed", experiments: [] }],
  loop: { phase: "literature", iteration: 0, history: [{ iteration: 0, phase: "literature", action: "a", detail: "b", at: "2024-01-01T00:00:00.000Z" }] },
  experiments: [],
  artifacts: [],
  reviews: [],
  updatedAt: "2024-01-01T00:00:00.000Z",
};
await fsp.writeFile(path.join(tMig, "research-manifest.json"), JSON.stringify(v1Manifest, null, 2), "utf8");
const migState = await loopTools.research_state.execute({ root: tMig }, exec);
ok("v1 清单可被读取", String(migState).includes("旧项目"));
await loopTools.research_hypothesis.execute({ root: tMig, text: "新假设" }, exec);
const migManifest = JSON.parse(await fsp.readFile(path.join(tMig, "research-manifest.json"), "utf8"));
ok("迁移在下次写入时持久化 schema=2", migManifest.schema === 2);
ok("迁移补齐字段（hypotheses[].reviews）", Array.isArray(migManifest.hypotheses[0].reviews) && migManifest.hypotheses[0].reviews.length === 0);
ok("迁移保留旧数据", migManifest.hypotheses.length === 2 && migManifest.hypotheses[1].id === "H2");

// ── 6. 远程计算引擎（transport=local 端到端：加主机→提交→监控→拉取→取消）──
console.log("\n== 6. 远程计算引擎（local transport）==");
const { remoteTools, remoteMod, hostsDir } = await registerRemote();
const EXPECT_REMOTE = [
  "remote_host_add", "remote_host_list", "remote_host_show", "remote_host_probe",
  "remote_host_notes", "remote_host_remove", "remote_host_allowlist", "remote_host_allow",
  "remote_host_revoke", "remote_exec", "remote_run",
  "remote_status", "remote_logs", "remote_pull", "remote_cancel", "remote_jobs",
];
const remoteMissing = EXPECT_REMOTE.filter((n) => !remoteTools[n]);
ok("remote-compute 注册 16 工具", remoteMissing.length === 0, remoteMissing.length ? `缺：${remoteMissing}` : "");
ok("remote-compute: name/inject/apply", remoteMod.name === "science-remote-compute" && remoteMod.inject?.includes("tools") && typeof remoteMod.apply === "function");

const tRemote = sub("t-remote");
const remoteScratch = path.join(tRemote, "scratch");
const rExec = { ...exec, agent: { session: { id: "smoke-remote", cwd: tRemote } }, name: "remote_run", callId: "remote-c1" };

// 校验错误：未知主机 / 未提供脚本；主机 id 自动净化
await expectThrow(() => remoteTools.remote_run.execute({ host: "nope", script: "echo x" }, rExec), "ERR_HOST", "remote_run 未知主机");
await expectThrow(() => remoteTools.remote_run.execute({ host: "h1", title: "x" }, rExec), "ERR_VALIDATION", "remote_run 缺 script 与 scriptFile");
const addSan = await remoteTools.remote_host_add.execute({ host: "GPU!Cluster", transport: "local", scratch: path.join(tRemote, "scratch-san") }, rExec);
ok("remote_host_add 自动净化 id", addSan.host === "gpu-cluster");
await remoteTools.remote_host_remove.execute({ host: "gpu-cluster" }, rExec);

// 添加 local 主机（自动探测）
const addHost = await remoteTools.remote_host_add.execute({ host: "lab01", transport: "local", scratch: remoteScratch, notes: "本机演练主机" }, rExec);
ok("remote_host_add 注册并探测", addHost.host === "lab01" && addHost.probe && addHost.probe.cpus > 0);
ok("remote_host_add 输出字段类型合规（probe 非 null、probeError 为字符串）", addHost.probe !== null && typeof addHost.probe === "object" && addHost.probeError === "");
ok("remote_host_add 探测含 os/cpus 字段", typeof addHost.probe?.os === "string" && addHost.probe?.cpus > 0);

// 提交一个"生信流水线"作业：生成结果文件
const pipelineScript = [
  "set -e",
  "mkdir -p results",
  "echo 'sample,reads,mapped,frac' > results/alignment-stats.tsv",
  "echo 'S1,1200000,1180200,0.9835' >> results/alignment-stats.tsv",
  "echo 'S2,980000,961240,0.9809' >> results/alignment-stats.tsv",
  "echo pipeline-done",
].join("\n");
const runJob = await remoteTools.remote_run.execute({ host: "lab01", title: "比对统计", script: pipelineScript, scratch: remoteScratch, env: { PIPELINE: "test" } }, rExec);
ok("remote_run 返回 jobId/状态", runJob.jobId === "J01" && runJob.state === "running" && runJob.mode === "direct");
ok("remote_run 作业目录位于 scratch 下", runJob.jobDir.startsWith(remoteScratch));

// 监控：刚提交 → running；完成 → succeeded
const stEarly = await remoteTools.remote_status.execute({ root: tRemote, job: runJob.jobId }, rExec);
ok("remote_status 刚提交为 running（不误报 unknown）", stEarly.jobs[0]?.state === "running");
await new Promise((r) => setTimeout(r, 1500));
const stDone = await remoteTools.remote_status.execute({ root: tRemote, job: runJob.jobId }, rExec);
ok("remote_status 完成迁移 succeeded", stDone.jobs[0]?.state === "succeeded" && stDone.jobs[0]?.exitCode === 0);
ok("remote_status 结构化输出含 summary", stDone.summary && typeof stDone.summary.succeeded === "number");

// 日志
const logs = await remoteTools.remote_logs.execute({ root: tRemote, job: runJob.jobId, stream: "stdout" }, rExec);
ok("remote_logs 显示脚本输出", String(logs).includes("pipeline-done"));

// 拉取输出并校验文件内容
const pull = await remoteTools.remote_pull.execute({ root: tRemote, job: runJob.jobId }, rExec);
ok("remote_pull 拉回结果", pull.localOutDir.includes("analyses") && pull.pulled.some((f) => f.name === "results"));
const pulledStats = await fsp.readFile(path.join(tRemote, "analyses", "remote", "J01", "results", "alignment-stats.tsv"), "utf8");
ok("remote_pull 内容正确", pulledStats.includes("S1") && pulledStats.includes("0.9835"));
ok("remote_pull 写 pulled-manifest.json", existsSync(path.join(tRemote, "analyses", "remote", "J01", "pulled-manifest.json")));

// 失败作业 → failed + 退出码
const failJob = await remoteTools.remote_run.execute({ host: "lab01", title: "会失败的作业", script: "echo boom >&2\nexit 7", scratch: remoteScratch }, rExec);
await new Promise((r) => setTimeout(r, 1500));
const stFail = await remoteTools.remote_status.execute({ root: tRemote, job: failJob.jobId }, rExec);
ok("失败作业迁移 failed + exitCode=7", stFail.jobs[0]?.state === "failed" && stFail.jobs[0]?.exitCode === 7);
const errLogs = await remoteTools.remote_logs.execute({ root: tRemote, job: failJob.jobId, stream: "stderr" }, rExec);
ok("失败作业 stderr 可见", String(errLogs).includes("boom"));

// 长作业：running → cancel → killed
const longJob = await remoteTools.remote_run.execute({ host: "lab01", title: "长作业", script: "sleep 300\necho never", timeoutMinutes: 60, scratch: remoteScratch }, rExec);
const stLong = await remoteTools.remote_status.execute({ root: tRemote, job: longJob.jobId }, rExec);
ok("长作业状态 running", stLong.jobs[0]?.state === "running");
const cancel = await remoteTools.remote_cancel.execute({ root: tRemote, job: longJob.jobId }, rExec);
ok("remote_cancel → killed", cancel.state === "killed");
await new Promise((r) => setTimeout(r, 800));
const stKilled = await remoteTools.remote_status.execute({ root: tRemote, job: longJob.jobId }, rExec);
ok("取消后状态持久化为 killed", stKilled.jobs[0]?.state === "killed");

// remote_exec 快速命令 + 结构化输出
const ex = await remoteTools.remote_exec.execute({ host: "lab01", command: "echo hello-remote; exit 0", timeoutSeconds: 10 }, rExec);
ok("remote_exec 结构化输出", ex.exitCode === 0 && ex.stdout.includes("hello-remote") && typeof ex.elapsedMs === "number");

// 主机备注（Details 文档）与列表
await remoteTools.remote_host_notes.execute({ host: "lab01", text: "环境：conda env amr; 分区：gpu" }, rExec);
await remoteTools.remote_host_notes.execute({ host: "lab01", text: "追加：数据在 /data/raw", append: true }, rExec);
const showHost = await remoteTools.remote_host_show.execute({ host: "lab01" }, rExec);
ok("remote_host_notes 追加生效", showHost.host.notes.includes("分区：gpu") && showHost.host.notes.includes("追加：数据在 /data/raw"));
const hostList = await remoteTools.remote_host_list.execute({}, rExec);
ok("remote_host_list 含 lab01 与探测摘要", hostList.hosts.some((h) => h.id === "lab01" && h.cpus > 0));

// 作业列表与过滤
const allJobs = await remoteTools.remote_jobs.execute({ root: tRemote }, rExec);
ok("remote_jobs 共 3 个作业", allJobs.count === 3);
const finJobs = await remoteTools.remote_jobs.execute({ root: tRemote, state: "succeeded" }, rExec);
ok("remote_jobs 按状态过滤 succeeded=1", finJobs.count === 1);

// 并发上限：lab01 maxConcurrent=1 时第二个活动作业被拒
const hostsFile = path.join(hostsDir, "hosts.json");
const hd = JSON.parse(await fsp.readFile(hostsFile, "utf8"));
const lab = hd.hosts.find((h) => h.id === "lab01");
lab.maxConcurrent = 1;
await fsp.writeFile(hostsFile, JSON.stringify(hd, null, 2));
const c1 = await remoteTools.remote_run.execute({ host: "lab01", title: "c1", script: "sleep 30", timeoutMinutes: 60, scratch: remoteScratch }, rExec);
const c2 = await remoteTools.remote_run.execute({ host: "lab01", title: "c2", script: "sleep 30", timeoutMinutes: 60, scratch: remoteScratch }, rExec).catch((e) => ({ err: e?.code }));
ok("并发上限 ERR_LIMIT", c2?.err === "ERR_LIMIT");
await remoteTools.remote_cancel.execute({ root: tRemote, job: c1.jobId }, rExec);

// ── 7. 项目级主机白名单与审批授权（approval 桩）────────────────────
console.log("\n== 7. 项目级主机白名单与审批授权 ==");
const tAcl = sub("t-acl");
const aclScratch = path.join(tAcl, "scratch");
const approve = approvalStub(false);
const { remoteTools: aclTools } = await registerRemote({ requireHostAccess: true, requireApproval: false, approval: approve });
const aExec = { ...exec, agent: { session: { id: "smoke-acl", cwd: tAcl } }, name: "remote_exec", callId: "acl-c1" };
const aRunExec = { ...aExec, name: "remote_run", callId: "acl-c2" };

// 未授权主机：remote_exec 拒绝（审批桩返回 rejected 的实例验证 ERR_ACCESS）
const rejectStub = approvalStub(true);
const { remoteTools: denyTools } = await registerRemote({ requireHostAccess: true, requireApproval: false, approval: rejectStub });
await denyTools.remote_host_add.execute({ host: "deny01", transport: "local", scratch: aclScratch, probe: false }, aExec);
const denied = await denyTools.remote_exec.execute({ host: "deny01", command: "echo x" }, aExec).catch((e) => ({ err: e?.code, msg: e?.message }));
ok("未授权主机 remote_exec → ERR_ACCESS（审批被拒）", denied?.err === "ERR_ACCESS" && String(denied?.msg).includes("deny01"));
ok("审批桩收到授权申请", rejectStub.requests.length >= 1);

// 授权桩：首次 remote_exec 弹审批 → 批准 → 自动写入白名单；再次执行不再弹
await aclTools.remote_host_add.execute({ host: "acl01", transport: "local", scratch: aclScratch, probe: false }, aExec);
await aclTools.remote_exec.execute({ host: "acl01", command: "echo first" }, aExec);
ok("首次使用审批授权并执行", approve.requests.length === 1 && approve.requests[0].includes("acl01"));
const aclFile = path.join(tAcl, ".dsh", "remotes", "allowlist.json");
const aclJson = JSON.parse(await fsp.readFile(aclFile, "utf8"));
ok("授权按项目持久化到 allowlist.json", aclJson.hosts.some((h) => h.host === "acl01"));
await aclTools.remote_exec.execute({ host: "acl01", command: "echo second" }, aExec);
ok("白名单内主机不再弹审批", approve.requests.length === 1);

// remote_run 首次使用：授权+作业审批合并为一次弹窗
await aclTools.remote_host_add.execute({ host: "acl02", transport: "local", scratch: aclScratch, probe: false }, aExec);
const aclRun = await aclTools.remote_run.execute({ host: "acl02", title: "首次作业", script: "echo hi", scratch: aclScratch }, aRunExec);
ok("首次 remote_run 授权+作业合并为一次审批", aclRun.jobId === "J01" && approve.requests.length === 2 && approve.requests[1].includes("acl02"));
await new Promise((r) => setTimeout(r, 1500));
await aclTools.remote_status.execute({ root: tAcl, job: aclRun.jobId }, aRunExec);

// remote_host_allowlist / revoke / allow
const wl = await aclTools.remote_host_allowlist.execute({ root: tAcl }, aExec);
ok("remote_host_allowlist 列出已授权主机", wl.count === 2 && wl.hosts.some((h) => h.host === "acl01") && wl.requireHostAccess === true);
await aclTools.remote_host_revoke.execute({ root: tAcl, host: "acl01" }, aExec);
const wl2 = await aclTools.remote_host_allowlist.execute({ root: tAcl }, aExec);
ok("remote_host_revoke 移除授权", wl2.count === 1 && !wl2.hosts.some((h) => h.host === "acl01"));
await aclTools.remote_host_allow.execute({ root: tAcl, host: "acl01", approve: false }, aExec);
const wl3 = await aclTools.remote_host_allowlist.execute({ root: tAcl }, aExec);
ok("remote_host_allow 显式授权", wl3.count === 2);

// ── 8. 按 project 隔离（研究项目 research-manifest.json 优先于工作区 .dsh）──
console.log("\n== 8. 按 project 隔离（白名单/作业注册表）==");
const tIso = sub("t-iso"); // 模拟工作区根（含 .dsh 标记）
await fsp.mkdir(path.join(tIso, ".dsh"), { recursive: true });
const p1 = path.join(tIso, "projA");
const p2 = path.join(tIso, "projB");
for (const p of [p1, p2]) {
  await fsp.mkdir(p, { recursive: true });
  await fsp.writeFile(path.join(p, "research-manifest.json"), JSON.stringify({ schema: 2, project: { title: path.basename(p) } }), "utf8");
}
const isoApprove = approvalStub(false);
const { remoteTools: isoTools } = await registerRemote({ requireHostAccess: true, requireApproval: false, approval: isoApprove });
const isoScratch = path.join(tIso, "scratch");
await isoTools.remote_host_add.execute({ host: "iso01", transport: "local", scratch: isoScratch, probe: false }, { ...exec, agent: { session: { id: "iso", cwd: p1 } } });

// 在 projA 授权并执行
await isoTools.remote_exec.execute({ host: "iso01", command: "echo in-A" }, { ...exec, agent: { session: { id: "iso", cwd: p1 } }, name: "remote_exec", callId: "iso-c1" });
const aclP1 = path.join(p1, ".dsh", "remotes", "allowlist.json");
const aclP2 = path.join(p2, ".dsh", "remotes", "allowlist.json");
ok("projA 授权落在 projA 的白名单", existsSync(aclP1) && JSON.parse(await fsp.readFile(aclP1, "utf8")).hosts.some((h) => h.host === "iso01"));
ok("projB 尚无白名单文件（未泄漏）", !existsSync(aclP2));
ok("projB 未收到授权请求", isoApprove.requests.length === 1);

// projB 中使用同一主机 → 再次弹审批（隔离生效）
const execP2 = await isoTools.remote_exec.execute({ host: "iso01", command: "echo in-B" }, { ...exec, agent: { session: { id: "iso", cwd: p2 } }, name: "remote_exec", callId: "iso-c2" });
ok("projB 再次审批后可用", execP2.exitCode === 0 && isoApprove.requests.length === 2);
ok("projB 授权写入 projB 白名单", existsSync(aclP2) && JSON.parse(await fsp.readFile(aclP2, "utf8")).hosts.some((h) => h.host === "iso01"));

// 显式 root 参数优先于会话 cwd
await isoTools.remote_host_revoke.execute({ root: p1, host: "iso01" }, { ...exec, agent: { session: { id: "iso", cwd: p2 } }, name: "remote_host_revoke", callId: "iso-c3" });
const wlP1After = JSON.parse(await fsp.readFile(aclP1, "utf8"));
ok("显式 root=p1 撤销的是 projA（不误伤 projB）", wlP1After.hosts.length === 0 && JSON.parse(await fsp.readFile(aclP2, "utf8")).hosts.length === 1);

// 无 research-manifest 的子目录 → 回退到工作区 .dsh 根
const p3 = path.join(tIso, "plain"); // 无 research-manifest.json
await fsp.mkdir(p3, { recursive: true });
await isoTools.remote_exec.execute({ host: "iso01", command: "echo in-plain" }, { ...exec, agent: { session: { id: "iso", cwd: p3 } }, name: "remote_exec", callId: "iso-c4" });
const aclWs = path.join(tIso, ".dsh", "remotes", "allowlist.json");
ok("无研究项目标记时回退工作区根白名单", existsSync(aclWs) && JSON.parse(await fsp.readFile(aclWs, "utf8")).hosts.some((h) => h.host === "iso01"));

// ── 9. 远程主机配置 UI：client bundle 一致 + 宿主侧 webServer REST 路由 ──
console.log("\n== 9. 远程主机配置 UI（client bundle + webServer 路由）==");

// 9.1 静态：dsh.client 声明、exports["./client"]、bundle 存在且与源码一致
const pkgAfter = JSON.parse(await fsp.readFile(path.join(pkg, "package.json"), "utf8"));
ok("package.json 声明 dsh.client（platform=web）", pkgAfter?.dsh?.client?.platform === "web");
ok("package.json exports[\"./client\"] 指向 bundle", typeof pkgAfter?.exports?.["./client"] === "string" && pkgAfter.exports["./client"].includes("client/remote-hosts-ui/lib/client.js"));
const clientSrc = await fsp.readFile(path.join(pkg, "client", "remote-hosts-ui", "src", "index.js"), "utf8");
const clientBundle = await fsp.readFile(path.join(pkg, "client", "remote-hosts-ui", "lib", "client.js"), "utf8");
ok("client bundle 存在且含 __ModuleLoader__.load", clientBundle.includes("window.__ModuleLoader__.load") && clientBundle.includes('id: "dsh-science"'));
ok("client bundle 由源码生成（一致性）", clientBundle.includes(clientSrc.split("\n").find((l) => l.trim().startsWith("const plugin"))?.trim().slice(0, 40) || "const plugin"));

// 9.2 宿主侧：隔离 DSH_HOME 加载 remote-hosts-ui.mjs，用 webServer stub 捕获路由并模拟请求
const uiHome = sub("t-rhui-home");
await fsp.mkdir(uiHome, { recursive: true });
const prevDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = uiHome;
let capturedRoute = null;
const uiMod = await import(path.join(pkg, "engines", "remote-hosts-ui.mjs"));
const uiCtx = {
  get: (k) => (k === "webServer" ? { register: (route) => { capturedRoute = route; return () => {}; } } : undefined),
  on: () => {},
};
await uiMod.apply(uiCtx, {});
process.env.DSH_HOME = prevDshHome;

ok("remote-hosts-ui: name/inject/apply", uiMod.name === "science-remote-hosts-ui" && uiMod.inject?.includes("webServer") && typeof uiMod.apply === "function");
ok("注册前缀路由 /dsh-science/remote-hosts", capturedRoute?.kind === "prefix" && capturedRoute?.path === "/dsh-science/remote-hosts");

function fakeReqRes({ method, url, headers = {}, body }) {
  const json = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const res = {
      _status: 0, _body: "",
      writeHead(s) { this._status = s; },
      end(b) { this._body = b; resolve(this); },
    };
    const req = {
      method, url, headers,
      on(ev, cb) {
        if (ev === "data" && json !== null) cb(json);
        if (ev === "end") cb();
        return this;
      },
      destroy() {},
    };
    capturedRoute.handler(req, res);
  });
}
const hdr = { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" };

const r405 = await fakeReqRes({ method: "GET", url: "/dsh-science/remote-hosts/list", headers: hdr });
ok("非 POST → 405", r405._status === 405);
const r403 = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/list", headers: { host: "127.0.0.1:3080" } });
ok("缺 Origin → 403（同源校验）", r403._status === 403);
const r404 = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/nope", headers: hdr });
ok("未知方法 → 404", r404._status === 404);

const rAdd = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/add-host", headers: hdr, body: { host: "ui01", transport: "local", probe: false, notes: "来自 UI 测试" } });
const addJson = JSON.parse(rAdd._body);
ok("add-host 返回 ok + 主机", rAdd._status === 200 && addJson.ok === true && addJson.host?.id === "ui01" && addJson.host?.transport === "local");

const rList = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/list", headers: hdr });
const listJson = JSON.parse(rList._body);
ok("list 返回已添加主机", listJson.ok === true && listJson.hosts.some((h) => h.id === "ui01"));

const rUpd = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/update-host", headers: hdr, body: { host: "ui01", patch: { notes: "已更新备注", maxConcurrent: 5 } } });
ok("update-host 更新备注/并发", JSON.parse(rUpd._body)?.host?.notes === "已更新备注" && JSON.parse(rUpd._body)?.host?.maxConcurrent === 5);

const rProj = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/project-info", headers: hdr, body: { root: sub("t-rhui-home") } });
const projJson = JSON.parse(rProj._body);
ok("project-info 读取项目白名单/作业（空默认）", projJson.ok === true && Array.isArray(projJson.allowlist) && projJson.counts && projJson.allowlistFile.includes("allowlist.json"));

const rRev = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/revoke", headers: hdr, body: { root: sub("t-rhui-home"), host: "x" } });
ok("revoke 幂等（无授权时返回 ok）", JSON.parse(rRev._body)?.ok === true);

const rDel = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/remove-host", headers: hdr, body: { host: "ui01" } });
ok("remove-host 移除主机", JSON.parse(rDel._body)?.ok === true);
const rList2 = await fakeReqRes({ method: "POST", url: "/dsh-science/remote-hosts/list", headers: hdr });
ok("移除后 list 不再含 ui01", !JSON.parse(rList2._body).hosts.some((h) => h.id === "ui01"));

// ── 10. dsh-model-tier：智能分档设置页（client bundle + 宿主 REST 路由）─────
console.log("\n== 10. dsh-model-tier（智能分档 UI + webServer 路由）==");
const mtPkg = path.join(pkg, "packages", "dsh-model-tier");
const mtPkgJson = JSON.parse(await fsp.readFile(path.join(mtPkg, "package.json"), "utf8"));
ok("dsh-model-tier: dsh.bundle.patch", mtPkgJson?.dsh?.bundle?.patch === "./cordis.patch.yml");
ok("dsh-model-tier: dsh.client（platform=web）", mtPkgJson?.dsh?.client?.platform === "web");
ok("dsh-model-tier: exports[\"./client\"] 指向 bundle", typeof mtPkgJson?.exports?.["./client"] === "string" && mtPkgJson.exports["./client"].includes("client/model-tier-ui/lib/client.js"));
const mtPatch = await fsp.readFile(path.join(mtPkg, "cordis.patch.yml"), "utf8");
ok("dsh-model-tier: patch 含 model-tier + model-tier-ui 行", mtPatch.includes("- id: model-tier") && mtPatch.includes("name: dsh-model-tier") && mtPatch.includes("- id: model-tier-ui"));
const mtBundle = await fsp.readFile(path.join(mtPkg, "client", "model-tier-ui", "lib", "client.js"), "utf8");
ok("dsh-model-tier: client bundle 存在且 id 正确", mtBundle.includes("window.__ModuleLoader__.load") && mtBundle.includes('id: "dsh-model-tier"'));

// 宿主侧路由：webServer stub + llm stub，配置文件指向临时目录（不碰真实 DSH_HOME）
const mtUiMod = await import(path.join(mtPkg, "engines", "model-tier-ui.mjs"));
ok("model-tier-ui: name/inject/apply（webServer 为延迟注入，不阻塞 headless）", mtUiMod.name === "dsh-model-tier-ui" && mtUiMod.inject?.includes("llm") && !mtUiMod.inject?.includes("webServer") && typeof mtUiMod.apply === "function");
let mtRoute = null;
const mtConfigFile = path.join(sub("t-mti-home"), "model-tier.json");
const mtLlm = {
  listProviders: () => [{ id: "deepseek-official", name: "DeepSeek" }, { id: "opencode-go", name: "opencode-go" }],
  listModels: async (p) => (p === "opencode-go" ? [{ id: "minimax-m2.7" }] : [{ id: "deepseek-v4-flash" }]),
};
const mtCtx = {
  llm: mtLlm,
  _emitted: [],
  get(k) {
    if (k === "webServer") return { register: (route) => { mtRoute = route; return () => {}; } };
    if (k === "llm") return mtLlm;
  },
  // 模拟 web profile：延迟注入的 webServer 立即可用
  inject(names, cb) { if ((Array.isArray(names) ? names : Object.keys(names)).every((n) => this.get(n))) cb(this); },
  emit(name) { mtCtx._emitted.push(name); return true; },
  on: () => {},
};
await mtUiMod.apply(mtCtx, { configFile: mtConfigFile, tiers: { light: { provider: "opencode-go", model: "minimax-m2.7" } } });
ok("注册前缀路由 /dsh-model-tier", mtRoute?.kind === "prefix" && mtRoute?.path === "/dsh-model-tier");

function mtReqRes({ method, url, headers = {}, body }) {
  const json = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const res = {
      _status: 0, _body: "",
      writeHead(s) { this._status = s; },
      end(b) { this._body = b; resolve(this); },
    };
    const req = {
      method, url, headers,
      async *[Symbol.asyncIterator]() { if (json !== null) yield Buffer.from(json); },
      destroy() {},
    };
    Promise.resolve(mtRoute.handler(req, res)).catch(reject);
  });
}
const mt405 = await mtReqRes({ method: "GET", url: "/dsh-model-tier/config", headers: hdr });
ok("model-tier-ui: 非 POST → 405", mt405._status === 405);
const mt403 = await mtReqRes({ method: "POST", url: "/dsh-model-tier/config", headers: { host: "127.0.0.1:3080" } });
ok("model-tier-ui: 缺 Origin → 403", mt403._status === 403);
const mt404 = await mtReqRes({ method: "POST", url: "/dsh-model-tier/nope", headers: hdr });
ok("model-tier-ui: 未知方法 → 404", mt404._status === 404);
const mtCfg = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/config", headers: hdr }))._body);
ok("config 返回基线 + 空方案列表", mtCfg.ok === true && mtCfg.baseline?.tiers?.light?.model === "minimax-m2.7" && mtCfg.effective?.tiers?.light?.provider === "opencode-go" && Array.isArray(mtCfg.schemes) && mtCfg.schemes.length === 0 && mtCfg.activeId === null);
const mtProv = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/providers", headers: hdr }))._body);
ok("providers 返回 provider + 模型清单", mtProv.ok === true && mtProv.providers.length === 2 && mtProv.providers[1].models[0].id === "minimax-m2.7");
// save-scheme：新建方案并自动设为生效
const mtSave = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { name: "日常开发", tiers: { light: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, routing: { subagentDepthStrong: 4 } } }))._body);
const mtSchemeId = mtSave.schemes?.[0]?.id;
ok("save-scheme 新建方案并自动生效", mtSave.ok === true && mtSave.schemes.length === 1 && mtSave.schemes[0].name === "日常开发" && mtSave.schemes[0].tiers?.light?.provider === "deepseek-official" && mtSave.schemes[0].routing?.subagentDepthStrong === 4 && mtSave.activeId === mtSchemeId);
ok("save-scheme 触发 llm/adapters-updated（前端目录热刷新）", mtCtx._emitted.includes("llm/adapters-updated"));
const mtCfg2 = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/config", headers: hdr }))._body);
ok("生效方案覆盖基线（effective）", mtCfg2.effective?.tiers?.light?.provider === "deepseek-official" && mtCfg2.effective?.routing?.subagentDepthStrong === 4);
const mtBad = await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { name: "x", tiers: { light: { provider: "" } } } });
ok("save-scheme 参数校验（缺 model → 400）", mtBad._status === 400);
const mtBadName = await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { name: "", tiers: {} } });
ok("save-scheme 参数校验（缺名称 → 400）", mtBadName._status === 400);
// classify：provider/model 成对校验（回归：hasProv 曾拿字符串与布尔比较，成对填写也报错）
const mtCls = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { id: mtSchemeId, name: "日常开发", tiers: { light: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, routing: { classify: { provider: "minimax-cn", model: "MiniMax-M3" } } } }))._body);
ok("save-scheme classify 成对填写 → 保存成功", mtCls.ok === true && mtCls.schemes[0].routing?.classify?.provider === "minimax-cn" && mtCls.schemes[0].routing?.classify?.model === "MiniMax-M3");
const mtClsEmpty = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { id: mtSchemeId, name: "日常开发", tiers: { light: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, routing: { classify: {} } } }))._body);
ok("save-scheme classify 成对留空 → 启用且默认执行档", mtClsEmpty.ok === true && JSON.stringify(mtClsEmpty.schemes[0].routing?.classify) === "{}");
const mtClsBad = await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { id: mtSchemeId, name: "日常开发", tiers: { light: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, routing: { classify: { provider: "minimax-cn" } } } });
ok("save-scheme classify 只填 provider → 400", mtClsBad._status === 400);
// set-active：停用 → 回落基线；再切回 → 方案生效
const mtOff = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/set-active", headers: hdr, body: { id: null } }))._body);
ok("set-active null → 停用回落基线", mtOff.ok === true && mtOff.activeId === null && mtOff.effective?.tiers?.light?.provider === "opencode-go");
const mtOn = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/set-active", headers: hdr, body: { id: mtSchemeId } }))._body);
ok("set-active 切换生效方案", mtOn.ok === true && mtOn.activeId === mtSchemeId && mtOn.effective?.tiers?.light?.provider === "deepseek-official");
const mtBadActive = await mtReqRes({ method: "POST", url: "/dsh-model-tier/set-active", headers: hdr, body: { id: "nope" } });
ok("set-active 未知方案 → 400", mtBadActive._status === 400);
// set-enabled：总开关
const mtDis = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/set-enabled", headers: hdr, body: { enabled: false } }))._body);
ok("set-enabled false → 透传", mtDis.ok === true && mtDis.enabled === false && mtDis.effective?.enabled === false);
// 更新同一方案（带 id → 不改 activeId）
const mtUpd = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/save-scheme", headers: hdr, body: { id: mtSchemeId, name: "日常开发 v2", tiers: { light: { provider: "deepseek-official", model: "deepseek-v4-flash" }, strong: { provider: "opencode-go", model: "minimax-m2.7" } } } }))._body);
ok("save-scheme 更新已有方案", mtUpd.ok === true && mtUpd.schemes.length === 1 && mtUpd.schemes[0].name === "日常开发 v2" && mtUpd.schemes[0].tiers?.strong?.provider === "opencode-go" && mtUpd.activeId === mtSchemeId);
// delete-scheme：删除生效方案 → activeId 清空回落基线
const mtDel = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/delete-scheme", headers: hdr, body: { id: mtSchemeId } }))._body);
ok("delete-scheme 删除生效方案 → 回落基线", mtDel.ok === true && mtDel.schemes.length === 0 && mtDel.activeId === null && mtDel.effective?.tiers?.light?.provider === "opencode-go");
const mtReset = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/reset", headers: hdr }))._body);
ok("reset 删除配置回落基线", mtReset.ok === true && mtReset.effective?.tiers?.light?.provider === "opencode-go" && mtReset.schemes?.length === 0);

// route-status：会话最近一次实际路由读数（聊天页底部展示）
routerMod.routeStatus.set("S-mt", { schemeId: "s1", schemeName: "日常开发", provider: "deepseek-official", model: "deepseek-v4-flash", tier: "default", at: new Date().toISOString() });
const mtRs = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/route-status", headers: hdr, body: { sessionId: "S-mt" } }))._body);
ok("route-status 返回路由读数", mtRs.ok === true && mtRs.tiered === true && mtRs.last?.model === "deepseek-v4-flash" && mtRs.last?.tier === "default" && mtRs.schemeName === "日常开发");
const mtRs0 = JSON.parse((await mtReqRes({ method: "POST", url: "/dsh-model-tier/route-status", headers: hdr, body: { sessionId: "S-none" } }))._body);
ok("route-status 未路由会话 → tiered=false", mtRs0.ok === true && mtRs0.tiered === false && mtRs0.last === null);
const mtRsBad = await mtReqRes({ method: "POST", url: "/dsh-model-tier/route-status", headers: hdr, body: {} });
ok("route-status 缺 sessionId → 400", mtRsBad._status === 400);
routerMod.routeStatus.delete("S-mt");

console.log(`\n结果: ${passed} 通过, ${failures} 失败`);
if (!process.argv[2]) await fsp.rm(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
async function sha256(p) {
  const data = await fsp.readFile(p);
  return createHash("sha256").update(data).digest("hex");
}
