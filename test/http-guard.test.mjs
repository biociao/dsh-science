// http-guard 单元测试 —— 面板 REST 路由的来源校验：
//   1. 同源浏览器请求放行（Origin ↔ Host 同 authority）
//   2. 跨站 / 不匹配 Origin / Origin: null 拒绝
//   3. 默认端口归一化（反代场景）
//   4. 桌面端（Electron dsh-app://app）转发：无 Origin + 回环 Host 放行
//   5. 无 Origin + 非回环 Host 拒绝
//   6. Sec-Fetch-Site: cross-site 一票否决
// 两份实现（dsh-science 与 dsh-model-tier 包）必须是同一套语义。
// 全部 headless、零依赖。用法：node test/http-guard.test.mjs

import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const a = await import(path.join(pkg, "engines", "http-guard.mjs"));
const b = await import(path.join(pkg, "packages", "dsh-model-tier", "engines", "http-guard.mjs"));

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

const req = (headers) => ({ headers });

const cases = [
  // 名称、headers、期望
  ["同源浏览器请求（http）", { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" }, true],
  ["同源浏览器请求（localhost）", { origin: "http://localhost:3080", host: "localhost:3080" }, true],
  ["同源浏览器请求（https + 默认端口归一化）", { origin: "https://app.example", host: "app.example:443" }, true],
  ["同源浏览器请求（https 显式端口）", { origin: "https://app.example:8443", host: "app.example:8443" }, true],
  ["跨站 Origin → 拒绝", { origin: "http://evil.example", host: "127.0.0.1:3080" }, false],
  ["同主机不同端口 → 拒绝", { origin: "http://127.0.0.1:3081", host: "127.0.0.1:3080" }, false],
  ["Origin: null → 拒绝", { origin: "null", host: "127.0.0.1:3080" }, false],
  ["Origin 非 http(s)（file:）→ 拒绝", { origin: "file:///tmp/x.html", host: "127.0.0.1:3080" }, false],
  ["缺 Host → 拒绝", { origin: "http://127.0.0.1:3080" }, false],
  ["缺 Origin + 回环 IPv4 → 放行（桌面壳转发）", { host: "127.0.0.1:52522" }, true],
  ["缺 Origin + 127/8 其他地址 → 放行", { host: "127.0.0.2:3080" }, true],
  ["缺 Origin + localhost → 放行", { host: "localhost:3080" }, true],
  ["缺 Origin + IPv6 回环 → 放行", { host: "[::1]:3080" }, true],
  ["缺 Origin + 非回环 Host → 拒绝", { host: "10.0.0.7:3080" }, false],
  ["缺 Origin + 公网域名 Host → 拒绝", { host: "app.example" }, false],
  ["Sec-Fetch-Site: cross-site 一票否决", { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" }, false],
  ["Sec-Fetch-Site: same-origin 不影响", { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" }, true],
];

for (const [label, mod] of [["dsh-science", a], ["dsh-model-tier", b]]) {
  console.log(`\n== ${label}/http-guard ==`);
  ok(`${label}: 导出 isTrustedLocalRequest / isLoopbackAuthority`, typeof mod.isTrustedLocalRequest === "function" && typeof mod.isLoopbackAuthority === "function");
  for (const [name, headers, expected] of cases) {
    ok(`${label}: ${name}`, mod.isTrustedLocalRequest(req(headers)) === expected);
  }
  ok(`${label}: isLoopbackAuthority 判定`, mod.isLoopbackAuthority("127.0.0.1:3080") === true && mod.isLoopbackAuthority("[::1]:3080") === true && mod.isLoopbackAuthority("localhost:3080") === true && mod.isLoopbackAuthority("10.0.0.7:3080") === false && mod.isLoopbackAuthority("") === false);
}

console.log(`\n结果: ${passed} 通过, ${failures} 失败`);
process.exit(failures ? 1 : 0);
