// sidebar-ui 单元测试 —— Codex 风格侧边栏增强的宿主侧：
//   1. 模块契约（name/inject/makeHandlers/apply）
//   2. 固定工作区存储：空/损坏文件容忍、pin/unpin/刷新/排序/持久化/重载/上限 100
//   3. 参数校验（workspaceId/title/path、绝对路径、存在且为目录、未知字段）
//   4. reveal/open 的平台命令（darwin/linux/win32，注入 fake spawn）
//   5. webServer 路由契约（405/403/404、200 + {ok:false}、body 上限、JSON 解析）
// 全部 headless、零依赖，只在 mkdtemp 临时目录里读写（绝不碰真实 ~/.dsh）。
// 用法：node test/sidebar-ui.test.mjs

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const mod = await import(path.join(pkg, "engines", "sidebar-ui.mjs"));

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-sci-sidebar-"));
const stateDir = path.join(tmp, "state");
const pinsFile = path.join(stateDir, "sidebar.json");

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

async function expectThrow(fn, re, name) {
  try {
    await fn();
    failures++;
    console.error(`  ✗ ${name}：期望抛错，但未抛`);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (re.test(msg)) {
      passed++;
      console.log(`  ✔ ${name} → ${msg}`);
    } else {
      failures++;
      console.error(`  ✗ ${name}：错误信息不符，实际 ${msg}`);
    }
  }
}

function makeFakeSpawn(opts = {}) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    if (opts.throwOnCall) throw new Error("spawn boom");
    const child = {
      cmd, args, options, unrefCalled: false, listeners: [],
      on(ev, cb) { this.listeners.push([ev, cb]); return this; },
      unref() { this.unrefCalled = true; return this; },
    };
    calls.push(child);
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const json = (res) => { try { return JSON.parse(res._body); } catch { return null; } };

// ── 0. 临时目录只用于测试（确保不误用真实 DSH_HOME）────────────────────────
const fakeHome = path.join(tmp, "home");
const filePath = path.join(tmp, "not-a-dir.txt");
await fsp.writeFile(filePath, "x");

// ── 1. 模块契约 ───────────────────────────────────────────────────────────
console.log("== 1. 模块契约 ==");
ok("name = science-sidebar-ui", mod.name === "science-sidebar-ui");
ok("inject = [webServer]", JSON.stringify(mod.inject) === '["webServer"]');
ok("导出 apply / makeHandlers", typeof mod.apply === "function" && typeof mod.makeHandlers === "function");
ok("无 webServer 时 apply 静默返回（headless 安全）", (() => {
  let onCalled = false;
  mod.apply({ get: () => undefined, on: () => { onCalled = true; } }, {});
  return onCalled === false;
})());

// ── 2. config：pinsFile / platform / DSH_HOME 默认值 ──────────────────────
console.log("\n== 2. config ==");
const darwin = makeFakeSpawn();
const H = mod.makeHandlers({ pinsFile, spawn: darwin, platform: "darwin" });
const cfg = await H.config();
ok("config 返回注入的 pinsFile 与 platform", cfg.ok === true && cfg.pinsFile === path.resolve(pinsFile) && cfg.platform === "darwin");
const HDefaultPlatform = mod.makeHandlers({ pinsFile });
ok("platform 缺省 = process.platform", (await HDefaultPlatform.config()).platform === process.platform);

const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = fakeHome;
const HDshHome = mod.makeHandlers({});
const cfgHome = await HDshHome.config();
process.env.DSH_HOME = prevHome;
ok("pinsFile 默认 $DSH_HOME/dsh-science/sidebar.json", cfgHome.pinsFile === path.join(fakeHome, "dsh-science", "sidebar.json"));
ok("config.stateFile 作为 pinsFile 的别名", (await mod.makeHandlers({ stateFile: path.join(tmp, "alias.json") }).config()).pinsFile === path.resolve(tmp, "alias.json"));

// ── 3. 空 / 损坏存储 ──────────────────────────────────────────────────────
console.log("\n== 3. 空与损坏存储 ==");
const empty = await H.pins();
ok("文件不存在 → 空列表", empty.ok === true && Array.isArray(empty.pins) && empty.pins.length === 0);

const corruptFile = path.join(stateDir, "corrupt.json");
await fsp.mkdir(stateDir, { recursive: true });
await fsp.writeFile(corruptFile, "{ 这不是 JSON");
const HCorrupt = mod.makeHandlers({ pinsFile: corruptFile, spawn: darwin, platform: "darwin" });
const c1 = await HCorrupt.pins();
ok("损坏 JSON → 返回空列表（不抛错）", c1.ok === true && c1.pins.length === 0);
const c2 = await HCorrupt.pin({ workspaceId: "w1", title: "修复后" });
const backupName = path.basename(c2.backup || "");
ok("损坏文件在写入前备份、新文件可读", c2.ok === true && backupName.startsWith("corrupt.json.corrupt-") &&
  (await fsp.readFile(path.join(stateDir, backupName), "utf8")) === "{ 这不是 JSON" &&
  JSON.parse(await fsp.readFile(corruptFile, "utf8")).schema === 1);
const shapeFile = path.join(stateDir, "bad-shape.json");
await fsp.writeFile(shapeFile, JSON.stringify({ schema: 1, pins: "nope" }));
ok("pins 不是数组 → 视为损坏（空列表）", (await mod.makeHandlers({ pinsFile: shapeFile }).pins()).pins.length === 0);

// ── 4. pin / unpin / 排序 / 持久化 / 重载 / 上限 ─────────────────────────
console.log("\n== 4. pin / unpin / 排序 / 持久化 ==");
const pA = await H.pin({ workspaceId: "a", path: "/work/alpha", title: "项目 A" });
ok("pin 新工作区 → ok + 回显", pA.ok === true && pA.pin.workspaceId === "a" && pA.pin.title === "项目 A" && Number.isFinite(Date.parse(pA.pin.pinnedAt)));
ok("pin 落盘 schema=1 且目录已创建", JSON.parse(await fsp.readFile(pinsFile, "utf8")).schema === 1);
const pB = await H.pin({ workspaceId: "b", path: "/work/beta", title: "项目 B" });
ok("最近固定在前（B 在 A 前）", pB.pins.map((p) => p.workspaceId).join(",") === "b,a");
const pA2 = await H.pin({ workspaceId: "a", title: "项目 A2" });
ok("重复 pin 刷新标题并置顶（不重复）", pA2.pins.map((p) => p.workspaceId).join(",") === "a,b" && pA2.pin.title === "项目 A2" && pA2.pins.length === 2);
ok("刷新时未提供的 path 保留原值", pA2.pin.path === "/work/alpha");

const HReload = mod.makeHandlers({ pinsFile, spawn: makeFakeSpawn(), platform: "darwin" });
const reloaded = await HReload.pins();
ok("重载后顺序/内容一致", reloaded.pins.map((p) => p.workspaceId).join(",") === "a,b" && reloaded.pins[0].path === "/work/alpha");
const row = reloaded.pins[0];
ok("pin 记录字段完整（workspaceId/path/title/pinnedAt）", ["workspaceId", "path", "title", "pinnedAt"].every((k) => typeof row[k] === "string"));

// 排序：手写乱序 pinnedAt，读取时按时间倒序
const sortFile = path.join(stateDir, "sort.json");
await fsp.writeFile(sortFile, JSON.stringify({
  schema: 1,
  pins: [
    { workspaceId: "old", path: "/x/old", title: "", pinnedAt: "2026-01-01T00:00:00.000Z" },
    { workspaceId: "new", path: "/x/new", title: "", pinnedAt: "2026-02-01T00:00:00.000Z" },
    { workspaceId: "", path: "/x/bad", title: "", pinnedAt: "2026-03-01T00:00:00.000Z" },
    { nope: true },
  ],
}));
const sorted = await mod.makeHandlers({ pinsFile: sortFile }).pins();
ok("读取时按 pinnedAt 倒序 + 过滤非法条目", sorted.pins.map((p) => p.workspaceId).join(",") === "new,old");

const un = await H.unpin({ workspaceId: "b" });
ok("unpin 移除并返回 removed=true", un.ok === true && un.removed === true && un.count === 1 && un.pins.map((p) => p.workspaceId).join(",") === "a");
const un2 = await H.unpin({ workspaceId: "nope" });
ok("unpin 未知 id 幂等（removed=false）", un2.ok === true && un2.removed === false && un2.count === 1);

const manyFile = path.join(stateDir, "many.json");
const HMany = mod.makeHandlers({ pinsFile: manyFile, spawn: makeFakeSpawn(), platform: "darwin" });
for (let i = 0; i < 105; i++) await HMany.pin({ workspaceId: `w${i}`, title: `t${i}` });
const many = await HMany.pins();
ok("最多保留 100 条固定工作区", many.pins.length === 100 && many.pins[0].workspaceId === "w104" && many.pins[99].workspaceId === "w5");
ok("原子写不残留临时文件", (await fsp.readdir(stateDir)).every((f) => !f.endsWith(".tmp")));

// ── 5. 参数校验 ──────────────────────────────────────────────────────────
console.log("\n== 5. 参数校验 ==");
await expectThrow(() => H.pin({}), /缺少 workspaceId/, "pin 缺 workspaceId 被拒");
await expectThrow(() => H.pin({ workspaceId: "x".repeat(201) }), /workspaceId 过长/, "workspaceId > 200 被拒");
await expectThrow(() => H.pin({ workspaceId: "x", title: "y".repeat(201) }), /title 过长/, "title > 200 被拒");
await expectThrow(() => H.pin({ workspaceId: "x", title: 123 }), /title 必须是字符串/, "非字符串 title 被拒");
await expectThrow(() => H.pin({ workspaceId: "x", path: 42 }), /path 必须是字符串/, "非字符串 path 被拒");
await expectThrow(() => H.pin({ workspaceId: "x", path: "  " }), /path 不能为空/, "空白 path 被拒");
await expectThrow(() => H.pin({ workspaceId: "x", bogus: 1 }), /未知字段 bogus/, "pin 未知字段被拒");
await expectThrow(() => H.unpin({}), /缺少 workspaceId/, "unpin 缺 workspaceId 被拒");
await expectThrow(() => H.unpin({ workspaceId: "x", extra: true }), /未知字段 extra/, "unpin 未知字段被拒");
await expectThrow(() => H.reveal({}), /缺少 path/, "reveal 缺 path 被拒");
await expectThrow(() => H.reveal({ path: "relative/dir" }), /必须是绝对路径/, "reveal 相对路径被拒");
await expectThrow(() => H.reveal({ path: path.join(tmp, "missing-dir") }), /目录不存在/, "reveal 不存在目录被拒");
await expectThrow(() => H.reveal({ path: filePath }), /不是目录/, "reveal 普通文件被拒");
await expectThrow(() => H.open({ path: "rel" }), /必须是绝对路径/, "open 相对路径被拒");
await expectThrow(() => H.open({ path: tmp, nope: 1 }), /未知字段 nope/, "open 未知字段被拒");

// ── 6. reveal / open 平台命令（fake spawn）──────────────────────────────
console.log("\n== 6. reveal / open 平台命令 ==");
const asCall = (s) => s.calls[s.calls.length - 1];

const darwinSpawn = makeFakeSpawn();
const HDarwin = mod.makeHandlers({ pinsFile, spawn: darwinSpawn, platform: "darwin" });
const rvDarwin = await HDarwin.reveal({ path: tmp });
const cRvDarwin = asCall(darwinSpawn);
ok("darwin reveal → open -R <path>", rvDarwin.ok === true && rvDarwin.action === "reveal" &&
  cRvDarwin.cmd === "open" && JSON.stringify(cRvDarwin.args) === JSON.stringify(["-R", tmp]) &&
  cRvDarwin.options?.detached === true && cRvDarwin.unrefCalled === true && cRvDarwin.listeners.some(([ev]) => ev === "error"));
const opDarwin = await HDarwin.open({ path: tmp });
const cOpDarwin = asCall(darwinSpawn);
ok("darwin open → open <path>", opDarwin.ok === true && cOpDarwin.cmd === "open" && JSON.stringify(cOpDarwin.args) === JSON.stringify([tmp]));

const linuxSpawn = makeFakeSpawn();
const HLinux = mod.makeHandlers({ pinsFile, spawn: linuxSpawn, platform: "linux" });
await HLinux.reveal({ path: tmp });
const cRvLinux = asCall(linuxSpawn);
ok("linux reveal → xdg-open <父目录>", cRvLinux.cmd === "xdg-open" && JSON.stringify(cRvLinux.args) === JSON.stringify([path.dirname(tmp)]));
await HLinux.open({ path: tmp });
const cOpLinux = asCall(linuxSpawn);
ok("linux open → xdg-open <path>", cOpLinux.cmd === "xdg-open" && JSON.stringify(cOpLinux.args) === JSON.stringify([tmp]));

const winSpawn = makeFakeSpawn();
const HWin = mod.makeHandlers({ pinsFile, spawn: winSpawn, platform: "win32" });
await HWin.reveal({ path: tmp });
const cRvWin = asCall(winSpawn);
ok("win32 reveal → explorer /select,<path>", cRvWin.cmd === "explorer" && JSON.stringify(cRvWin.args) === JSON.stringify([`/select,${tmp}`]));
await HWin.open({ path: tmp });
const cOpWin = asCall(winSpawn);
ok("win32 open → explorer <path>", cOpWin.cmd === "explorer" && JSON.stringify(cOpWin.args) === JSON.stringify([tmp]));

const HThrow = mod.makeHandlers({ pinsFile, spawn: makeFakeSpawn({ throwOnCall: true }), platform: "linux" });
await expectThrow(() => HThrow.open({ path: tmp }), /无法调用系统打开方式/, "spawn 同步抛错 → 可读错误");
ok("reveal/open 回显 command 数组", JSON.stringify(opDarwin.command) === JSON.stringify(["open", tmp]));

// ── 7. webServer 路由契约 ────────────────────────────────────────────────
console.log("\n== 7. webServer 路由契约 ==");
const httpPins = path.join(stateDir, "http.json");
const httpSpawn = makeFakeSpawn();
let route = null;
const ctx = {
  get: (k) => (k === "webServer" ? { register: (r) => { route = r; return () => {}; } } : undefined),
  on: () => {},
};
mod.apply(ctx, { pinsFile: httpPins, spawn: httpSpawn, platform: "darwin" });
ok("注册前缀路由 /dsh-science/sidebar", route?.kind === "prefix" && route?.path === "/dsh-science/sidebar");

const hdr = { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" };
function request({ method = "POST", url, headers = hdr, body, rawBody } = {}) {
  return new Promise((resolve) => {
    const payload = rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body);
    const res = { _status: 0, _body: "", writeHead(s) { this._status = s; }, end(b) { this._body = b; resolve(this); } };
    const req = new EventEmitter();
    req.method = method; req.url = url; req.headers = headers; req.destroy = () => {};
    setImmediate(() => { if (payload !== null) req.emit("data", payload); req.emit("end"); });
    route.handler(req, res);
  });
}

const r405 = await request({ method: "GET", url: "/dsh-science/sidebar/config" });
ok("非 POST → 405", r405._status === 405 && json(r405)?.ok === false);
const rCross = await request({ url: "/dsh-science/sidebar/config", headers: { ...hdr, origin: "http://evil.example" } });
ok("跨站 Origin → 403", rCross._status === 403);
const rCrossSite = await request({ url: "/dsh-science/sidebar/config", headers: { ...hdr, "sec-fetch-site": "cross-site" } });
ok("Sec-Fetch-Site: cross-site → 403", rCrossSite._status === 403);
const rLoop = await request({ url: "/dsh-science/sidebar/config", headers: { host: "127.0.0.1:3080" } });
ok("缺 Origin + 回环 Host → 放行（桌面壳转发）", rLoop._status === 200 && json(rLoop)?.ok === true);
const rRemote = await request({ url: "/dsh-science/sidebar/config", headers: { host: "10.0.0.7:3080" } });
ok("缺 Origin + 非回环 Host → 403", rRemote._status === 403);
const r404 = await request({ url: "/dsh-science/sidebar/nope", body: {} });
ok("未知方法 → 404", r404._status === 404 && /未知方法/.test(json(r404)?.error || ""));
const r404b = await request({ url: "/dsh-science/sidebar/" });
ok("空前缀方法 → 404", r404b._status === 404);

const rCfg = await request({ url: "/dsh-science/sidebar/config" });
ok("config 路由 → {ok,pinsFile,platform}", rCfg._status === 200 && json(rCfg).ok === true && json(rCfg).pinsFile === path.resolve(httpPins) && json(rCfg).platform === "darwin");
const rCfgQuery = await request({ url: "/dsh-science/sidebar/config?ts=1" });
ok("URL 查询串不影响方法解析", rCfgQuery._status === 200 && json(rCfgQuery).ok === true);

const rPin = await request({ url: "/dsh-science/sidebar/pin", body: { workspaceId: "ui", path: "/work/ui", title: "UI 工作区" } });
ok("pin 路由 → ok + 已固定", rPin._status === 200 && json(rPin).ok === true && json(rPin).pin.workspaceId === "ui");
const rPins = await request({ url: "/dsh-science/sidebar/pins" });
ok("pins 路由 → 最近固定在前", json(rPins).ok === true && json(rPins).pins.map((p) => p.workspaceId).join(",") === "ui");
const rUnpin = await request({ url: "/dsh-science/sidebar/unpin", body: { workspaceId: "ui" } });
ok("unpin 路由 → removed=true", json(rUnpin).ok === true && json(rUnpin).removed === true);
const rReveal = await request({ url: "/dsh-science/sidebar/reveal", body: { path: tmp } });
ok("reveal 路由 → 调 fake spawn（open -R）", json(rReveal).ok === true && asCall(httpSpawn)?.args?.[0] === "-R");
const rBad = await request({ url: "/dsh-science/sidebar/pin", rawBody: "{not json" });
ok("非法 JSON → 200 + {ok:false}", rBad._status === 200 && json(rBad).ok === false && /JSON/.test(json(rBad).error || ""));
const rField = await request({ url: "/dsh-science/sidebar/pin", body: { workspaceId: "x", unknown: 1 } });
ok("未知字段 → 200 + {ok:false}（可读错误）", json(rField).ok === false && /未知字段/.test(json(rField).error || ""));
const rInvalid = await request({ url: "/dsh-science/sidebar/open", body: { path: "rel" } });
ok("校验失败 → 200 + {ok:false}（非 4xx/5xx）", rInvalid._status === 200 && json(rInvalid).ok === false && /绝对路径/.test(json(rInvalid).error || ""));
const rBig = await request({ url: "/dsh-science/sidebar/pin", rawBody: "x".repeat(1024 * 1024 + 10) });
ok("请求体 > 1MB → 200 + {ok:false}", rBig._status === 200 && json(rBig).ok === false && /body too large/.test(json(rBig).error || ""));

// ── 清理并汇总 ────────────────────────────────────────────────────────────
await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n结果: ${passed} 通过, ${failures} 失败`);
process.exit(failures ? 1 : 0);
