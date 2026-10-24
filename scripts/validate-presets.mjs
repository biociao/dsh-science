#!/usr/bin/env node
/**
 * validate-presets.mjs — agent preset 与 dsh 版本的配置 schema 兼容性门禁。
 *
 * WHY
 *   两个 preset（preset/ = 科学模式、preset-biomni/ = Biomni 模式）是按 dsh 的
 *   `standard` preset 克隆出来的，行里的 `config:` 必须能通过**当前安装的 dsh**
 *   各插件的 Schemastery schema 校验。dsh 升级会改 schema，而：
 *     - `test/verify-bundle.sh` 只验证 bundle（profile）形态，从不挂载 preset；
 *     - `dsh-agent-presets` 的健康检查只判断 YAML 合法 + 行名可解析，**不校验 config**；
 *     - preset 挂载发生在会话选中它时，引导日志里看不到。
 *   于是 schema 破坏（历史上：@deepseek-ai/dsh-persona 在 0.1.5 把 `text` 改成
 *   `prefix`，导致 persona 行报 `$.prefix missing required value`）会静默漏过所有门禁。
 *   本脚本把「逐行 config 校验」做成常驻门禁。
 *
 * WHAT
 *   1. 解析两个 preset 的 agent.cordis.yml（含 dsh 自定义 `!!js` tag、group 嵌套行）；
 *   2. 对每个 `@deepseek-ai/*` 行（含 config.plugins）取命名或默认导出的 Config / resolveConfig 校验；
 *      包缺失算失败，无 schema 的插件才跳过；
 *   3. 校验各 package.json 的 `dsh.client.inject` 条目在 dsh 发行版里存在
 *      （0.1.5 起 @deepseek-ai/dsh-client-runtime 已被移除，写进去只会被静默跳过）。
 *
 * USAGE
 *   node scripts/validate-presets.mjs [file-or-dir ...]
 *   默认校验 preset/agent.cordis.yml 与 preset-biomni/agent.cordis.yml。
 *
 *   dsh 包从「本包 node_modules」或「全局 npm root 下的 @deepseek-ai/dsh」解析；
 *   两者都找不到时脚本会跳过（打印提示）并以 0 退出 —— 除非设置
 *   PRESET_VALIDATE_REQUIRE=1（CI 的 bundle-verify job 用这个，跳过即失败）。
 *
 * EXIT CODES
 *   0 ok（含「无法解析 dsh 且未 REQUIRE」的跳过）
 *   1 有 config 校验失败 / inject 条目缺失 / REQUIRE=1 但无法校验
 */

import { promises as fsp, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, "..");

// ── 定位 dsh 发行版（提供 js-yaml 与各插件包）─────────────────────────────────

function findDshRoot() {
  const candidates = [];
  try {
    const req = createRequire(import.meta.url);
    candidates.push(path.dirname(req.resolve("@deepseek-ai/dsh/package.json")));
  } catch { /* 本包不依赖 dsh */ }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(globalRoot, "@deepseek-ai/dsh"));
  } catch { /* npm root 不可用 */ }
  return candidates.find((c) => c && existsSync(path.join(c, "package.json")));
}

const dshRoot = findDshRoot();
const REQUIRE = process.env.PRESET_VALIDATE_REQUIRE === "1";

if (dshRoot === undefined) {
  const msg = "找不到 @deepseek-ai/dsh（本包 node_modules 与全局 npm root 都没有）";
  if (REQUIRE) {
    console.error(`[validate-presets] ✗ ${msg}，但 PRESET_VALIDATE_REQUIRE=1 → 失败`);
    process.exit(1);
  }
  console.log(`[validate-presets] ⚠ ${msg} → 跳过 preset config 校验（装了 dsh 的环境会真跑）`);
  process.exit(0);
}

const dshRequire = createRequire(path.join(dshRoot, "package.json"));
console.log(`[validate-presets] dsh 根目录：${dshRoot}`);
console.log(`[validate-presets] dsh 版本：${dshRequire("./package.json").version}\n`);

let yaml;
try {
  yaml = dshRequire("js-yaml");
} catch {
  console.error("[validate-presets] ✗ dsh 发行版里找不到 js-yaml，无法解析 preset YAML");
  process.exit(1);
}

// dsh 的 loader 用自定义 `!!js` tag 表达行内表达式；当作不透明标量处理即可，
// 本脚本只关心 `config:`。
const JsTag = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  construct: (d) => ({ __js: d }),
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsTag]);

// ── 行遍历（递归 cordis:group 的 config 数组）─────────────────────────────────

function collectRows(doc) {
  const out = [];
  const walk = (rows) => {
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      out.push(row);
      if (Array.isArray(row.config)) walk(row.config);
      if (Array.isArray(row.config?.plugins)) walk(row.config.plugins);
    }
  };
  for (const entry of doc) {
    if (entry && Array.isArray(entry.insert)) walk(entry.insert);
    else if (Array.isArray(entry)) walk(entry);
    else if (entry && typeof entry === "object" && entry.id) walk([entry]);
  }
  return out;
}

// ── 逐行 config 校验 ─────────────────────────────────────────────────────────

async function validateRowConfig(name, config) {
  let mod;
  try {
    mod = await import(pathToFileURL(dshRequire.resolve(name)).href);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
      return { status: "unresolvable", why: "包在 dsh 发行版里解析不到" };
    }
    return { status: "fail", why: `加载失败：${err.message.split("\n")[0]}` };
  }
  // 多数插件导出 schemastery `Config`；plan-mode 走 resolveConfig()。
  const schema = mod.Config ?? mod.default?.Config;
  const validate = typeof schema === "function"
    ? (cfg) => schema(cfg)
    : typeof mod.resolveConfig === "function"
      ? (cfg) => mod.resolveConfig(cfg)
      : undefined;
  if (validate === undefined) return { status: "skip", why: "无 Config / resolveConfig（该行无 schema 可校验）" };
  try {
    validate(config ?? {});
    return { status: "ok" };
  } catch (err) {
    return { status: "fail", why: (err?.message ?? String(err)).split("\n")[0] };
  }
}

// ── 入口：收集要校验的 preset 文件 ───────────────────────────────────────────

const args = process.argv.slice(2);
const files = [];
if (args.length === 0) {
  files.push(path.join(pkgRoot, "preset", "agent.cordis.yml"), path.join(pkgRoot, "preset-biomni", "agent.cordis.yml"));
  files.push(path.join(pkgRoot, "preset", "cordis.patch.yml"), path.join(pkgRoot, "preset-biomni", "cordis.patch.yml"));
} else {
  for (const a of args) {
    const p = path.resolve(a);
    // eslint-disable-next-line no-await-in-loop
    const st = await fsp.stat(p);
    if (st.isDirectory()) files.push(path.join(p, "agent.cordis.yml"));
    else files.push(p);
  }
}

let failures = 0;
let checked = 0;
let skipped = 0;

for (const file of files) {
  console.log(`=== ${path.relative(pkgRoot, file) || file} ===`);
  let doc;
  try {
    doc = yaml.load(await fsp.readFile(file, "utf8"), { schema: SCHEMA });
  } catch (err) {
    console.error(`  FAIL  解析失败：${err.message.split("\n")[0]}`);
    failures++;
    continue;
  }
  for (const row of collectRows(doc)) {
    const name = row.name;
    if (typeof name !== "string" || !name.startsWith("@deepseek-ai/")) continue;
    const id = typeof row.id === "string" && row.id !== "" ? row.id : "(no id)";
    // eslint-disable-next-line no-await-in-loop
    const res = await validateRowConfig(name, row.config ?? {});
    if (res.status === "ok") {
      console.log(`  OK     ${id} -> ${name}`);
      checked++;
    } else if (res.status === "fail" || res.status === "unresolvable") {
      console.error(`  FAIL   ${id} -> ${name}\n         ${res.why}`);
      failures++;
    } else {
      console.log(`  skip   ${id} -> ${name}（${res.why}）`);
      skipped++;
    }
  }
  console.log("");
}

// ── dsh.client.inject 条目存在性（0.1.5 移除 dsh-client-runtime 的回归护栏）────

const injectTargets = [path.join(pkgRoot, "package.json"), path.join(pkgRoot, "packages", "dsh-model-tier", "package.json")];
console.log("=== dsh.client.inject 条目 ===");
for (const p of injectTargets) {
  if (!existsSync(p)) continue;
  const json = JSON.parse(await fsp.readFile(p, "utf8"));
  const inject = json?.dsh?.client?.inject;
  if (!Array.isArray(inject)) continue;
  for (const entry of inject) {
    let ok = true;
    try {
      dshRequire.resolve(entry);
    } catch {
      ok = false;
    }
    const label = `${path.relative(pkgRoot, p)} → ${entry}`;
    if (ok) {
      console.log(`  OK     ${label}`);
    } else {
      // inject 条目解析不到时 client-modules 会静默跳过（不报错但依赖顺序失效），
      // 所以这里按失败处理：@deepseek-ai/* 的 client 包都由 dsh 发行版提供。
      console.error(`  FAIL   ${label}（在 dsh 发行版里解析不到 → 该 inject 会被静默跳过）`);
      failures++;
    }
  }
}
console.log("");

console.log(`[validate-presets] 总计：${checked} 校验通过，${failures} 失败，${skipped} 跳过`);
process.exit(failures > 0 ? 1 : 0);
