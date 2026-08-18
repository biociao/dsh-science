#!/usr/bin/env node
// build-client-bundle.mjs —— 把 client/model-tier-ui/src/index.js 打包为
// __ModuleLoader__.load({ id, factory }) 格式的 client bundle（lib/client.js）。
// 机制与 dsh-science/scripts/build-client-bundle.mjs 相同：factory 内注入
// `const React = require("react")` 与 `const h = React.createElement`，
// 追加 `module.exports = plugin`，其余源码原样内嵌。
//
// 用法：node scripts/build-client-bundle.mjs [--check]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcPath = path.join(root, "client", "model-tier-ui", "src", "index.js");
const outPath = path.join(root, "client", "model-tier-ui", "lib", "client.js");

const BUNDLE_ID = "dsh-model-tier";

function buildBundle(src) {
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(BUNDLE_ID)},`,
    "\tfactory: (require) => {",
    "\t\tvar module = { exports: {} };",
    "\t\tvar exports = module.exports;",
    '\t\tconst React = require("react");',
    "\t\tconst h = React.createElement;",
    "\t\t//#region dsh-model-tier/client/model-tier-ui/src",
    src.replace(/\n$/, ""),
    "\t\t//#endregion",
    "\t\tmodule.exports = plugin;",
    "\t\treturn module.exports;",
    "\t}",
    "});",
    "",
  ].join("\n");
}

const src = readFileSync(srcPath, "utf8");
const bundle = buildBundle(src);

if (process.argv.includes("--check")) {
  if (!existsSync(outPath)) {
    console.error(`✗ 缺少 client bundle：${outPath}（先运行 node scripts/build-client-bundle.mjs）`);
    process.exit(1);
  }
  const cur = readFileSync(outPath, "utf8");
  if (createHash("sha256").update(cur).digest("hex") !== createHash("sha256").update(bundle).digest("hex")) {
    console.error(`✗ client bundle 与源码不一致：${outPath}（重新运行 node scripts/build-client-bundle.mjs）`);
    process.exit(1);
  }
  console.log(`✔ client bundle 一致：${outPath}`);
  process.exit(0);
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, bundle, "utf8");
console.log(`✔ 已生成 client bundle：${outPath}`);
console.log(`   （id=${BUNDLE_ID}，factory 注入 React；源码 ${srcPath}）`);
