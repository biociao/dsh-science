#!/usr/bin/env node
// build-client-bundle.mjs —— 把 client/remote-hosts-ui/src/index.js 打包为
// __ModuleLoader__.load({ id, factory }) 格式的 client bundle（lib/client.js）。
//
// 背景：DSH 的 client 插件以预构建 bundle 分发（`dsh.client` + `exports["./client"]`），
// 正常由 dsh 仓库的 `pnpm run build` 工具链（rolldown）生成。本项目插件零依赖、
// 只用 React.createElement + 浏览器原生 fetch，因此用本脚本做等价的手写包装：
// factory 内注入 `const React = require("react")` 与 `const h = React.createElement`，
// 追加 `module.exports = plugin`，其余源码原样内嵌。将来若接入正式构建工具链，
// 只需替换本脚本的输出（lib/client.js 仍是被加载的产物）。
//
// 用法：node scripts/build-client-bundle.mjs [--check]
//   --check：只校验产物存在且与源码哈希一致（CI 用）

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcPath = path.join(root, "client", "remote-hosts-ui", "src", "index.js");
const outPath = path.join(root, "client", "remote-hosts-ui", "lib", "client.js");

const BUNDLE_ID = "dsh-science";

function buildBundle(src) {
  return [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(BUNDLE_ID)},`,
    "\tfactory: (require) => {",
    "\t\tvar module = { exports: {} };",
    "\t\tvar exports = module.exports;",
    '\t\tconst React = require("react");',
    "\t\tconst h = React.createElement;",
    "\t\t//#region dsh-science/client/remote-hosts-ui/src",
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

writeFileSync(outPath, bundle, "utf8");
console.log(`✔ 已生成 client bundle：${outPath}`);
console.log(`   （id=${BUNDLE_ID}，factory 注入 React；源码 ${srcPath}）`);
