// dsh-science 侧栏增强（client bundle）单元测试 —— 纯函数 + bundle 契约：
//   1. bundle 形状：window.__ModuleLoader__.load({id, factory})、可被 Node 加载
//   2. 纯函数：HTML 转义 / 相对时间 / 平台文案 / 菜单模型 / 菜单夹取 /
//      会话统计 / 置顶列表规范化
//   3. apply 契约：无 DOM（Node）时静默跳过，不抛错
//   4. 静态护栏：bundle 含侧栏锚点与宿主路由、package.json exports["./client"] 未变
// 全部 headless、零依赖。用法：node test/sidebar-client.test.mjs

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");

let passed = 0;
let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const bundlePath = path.join(pkg, "client", "remote-hosts-ui", "lib", "client.js");
const bundle = readFileSync(bundlePath, "utf8");

// ── 1. 在 Node VM 中加载 bundle（模拟浏览器 module loader）──────────────
console.log("\n== 1. client bundle 加载 ==");
let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (mod) => { loaded = mod } } },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
  navigator: { platform: "darwin" },
}
vm.createContext(sandbox);
let loadError = null;
try {
  vm.runInContext(bundle, sandbox, { filename: "dsh-science-client.js" });
} catch (error) {
  loadError = error;
}
ok("bundle 可执行且注册 ModuleLoader 模块", loadError === null && loaded !== null && typeof loaded.factory === "function", loadError ? String(loadError) : "");
ok("bundle id 为 dsh-science", loaded?.id === "dsh-science");

const reactStub = {
  createElement: () => ({}),
  useState: () => [],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}
const plugin = loaded.factory((name) => (name === "react" ? reactStub : undefined));
ok("factory 返回插件对象（name/inject/apply）", plugin?.name === "remote-hosts-ui" && Array.isArray(plugin?.inject) && typeof plugin?.apply === "function");
ok("插件导出侧栏纯函数表", plugin?._sidebarTest && typeof plugin._sidebarTest.sbRelativeTime === "function");

// ── 2. apply 的降级契约（无 DOM 的 Node 环境）──────────────────────────
console.log("\n== 2. apply 降级 ==");
let applyError = null;
try {
  plugin.apply({ get: () => undefined, effect: undefined, on: () => {} });
} catch (error) {
  applyError = error;
}
ok("无 DOM / 无 slots 时 apply 静默返回", applyError === null, applyError ? String(applyError) : "");

// ── 3. 纯函数 ─────────────────────────────────────────────────────────
console.log("\n== 3. 纯函数 ==");
const t = plugin._sidebarTest;

ok("sbEscapeHtml 转义 5 类字符", t.sbEscapeHtml(`<a href="x">'&'</a>`) === "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
ok("sbEscapeHtml null/undefined → 空串", t.sbEscapeHtml(null) === "" && t.sbEscapeHtml(undefined) === "");

const now = Date.parse("2026-10-18T12:00:00Z");
ok("sbRelativeTime 60s 内 → 刚刚", t.sbRelativeTime(now - 30 * 1000, now) === "刚刚");
ok("sbRelativeTime 分钟级", t.sbRelativeTime(now - 5 * 60 * 1000, now) === "5 分钟前");
ok("sbRelativeTime 小时级", t.sbRelativeTime(now - 3 * 60 * 60 * 1000, now) === "3 小时前");
ok("sbRelativeTime 昨天", t.sbRelativeTime(now - 30 * 60 * 60 * 1000, now) === "昨天");
ok("sbRelativeTime 天级", t.sbRelativeTime(now - 3 * 24 * 60 * 60 * 1000, now) === "3 天前");
ok("sbRelativeTime 超过 7 天 → 日期", /^\d{4}-\d{2}-\d{2}$/.test(t.sbRelativeTime(now - 30 * 24 * 60 * 60 * 1000, now)));
ok("sbRelativeTime 非法值 → 空串", t.sbRelativeTime(0, now) === "" && t.sbRelativeTime("", now) === "");

ok("sbRevealLabel darwin → Finder", t.sbRevealLabel("darwin") === "在 Finder 中显示");
ok("sbRevealLabel win32 → 资源管理器", t.sbRevealLabel("win32") === "在资源管理器中显示");
ok("sbRevealLabel linux → 文件管理器", t.sbRevealLabel("linux") === "在文件管理器中显示");

const unpinnedMenu = t.sbMenuModel({ pinned: false, platform: "darwin" });
const pinnedMenu = t.sbMenuModel({ pinned: true, platform: "darwin" });
ok("菜单含 6 个可点击项 + 1 个分隔符", unpinnedMenu.filter((x) => !x.sep).length === 6 && unpinnedMenu.filter((x) => x.sep).length === 1);
ok("未置顶 → 置顶项目", unpinnedMenu[0].act === "pin" && unpinnedMenu[0].label === "置顶项目");
ok("已置顶 → 取消置顶项目", pinnedMenu[0].act === "unpin" && pinnedMenu[0].label === "取消置顶项目");
ok("菜单含在 Finder 中显示 / 打开目录 / 复制路径", ["reveal", "open", "copy"].every((act) => unpinnedMenu.some((x) => x.act === act)));

const clamped = t.sbClampMenuPosition(1500, 900, 300, 260, 1400, 950);
ok("菜单越界时夹取到视口内", clamped.left + 300 <= 1400 && clamped.top + 260 <= 950 && clamped.left >= 8 && clamped.top >= 8, JSON.stringify(clamped));
const normal = t.sbClampMenuPosition(100, 120, 240, 200, 1400, 950);
ok("菜单未越界时保持原位", normal.left === 100 && normal.top === 120);

const stats = t.sbSessionStats({ sessionIds: ["a", "b", "c", "d"] }, {
  a: { blank: false, running: false, updatedAt: now - 60 * 1000 },
  b: { blank: false, running: true, updatedAt: now - 5 * 60 * 1000 },
  c: { blank: true, running: true, updatedAt: now },
  d: undefined,
});
ok("sbSessionStats 统计非空白会话", stats.count === 2, JSON.stringify(stats));
ok("sbSessionStats 运行中数量", stats.running === 1);
ok("sbSessionStats 最近活跃", stats.lastActive === now - 60 * 1000);
ok("sbSessionStats 缺省安全", t.sbSessionStats(undefined, undefined).count === 0);

const pins = t.sbNormalizePins([
  { workspaceId: "w1", path: "/p/one", title: "one", pinnedAt: "2026-10-18T01:00:00Z" },
  { workspaceId: "w1", title: "dup" },
  { workspaceId: "", title: "no-id" },
  { title: "no-workspace-id" },
  null,
  { workspaceId: "w2" },
]);
ok("sbNormalizePins 去重 / 去坏条目", pins.length === 2 && pins[0].workspaceId === "w1" && pins[1].workspaceId === "w2", JSON.stringify(pins));
ok("sbNormalizePins 缺字段补空串", pins[1].path === "" && pins[1].title === "" && pins[1].pinnedAt === "");

// ── 4. 静态护栏 ───────────────────────────────────────────────────────
console.log("\n== 4. 静态护栏 ==");
ok("bundle 含侧栏注入锚点", bundle.includes("data-dshsci-section") && bundle.includes("dshsci-pinned-row"));
ok("bundle 含宿主路由前缀", bundle.includes("/dsh-science/sidebar/"));
ok("bundle 含原生行锚点（data-row-key workspace:）", bundle.includes('[data-row-key^="workspace:"]'));
ok("bundle 含原生「…」菜单增强锚点", bundle.includes("data-dshsci-native-item") && bundle.includes("sbMenuModel"));
ok("悬停卡只做状态展示（不含操作按钮实现）", bundle.includes("dshsci-hover-stats") && !bundle.includes("dshsci-hover-actions") && !bundle.includes("dshsci-mini"));
ok("bundle 含三段式 section（置顶与最近）", bundle.includes("dshsci-section-head") && bundle.includes("dshsci-recent-row") && bundle.includes("data-dshsci-section"));
ok("最近会话经 uiWorkspace.openSession 打开", bundle.includes("uiWorkspace") && bundle.includes("openSession"));
const pkgJson = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
ok("package.json exports[\"./client\"] 指向 bundle", pkgJson?.exports?.["./client"] === "./client/remote-hosts-ui/lib/client.js");
ok("dsh.client 声明保留 web platform", pkgJson?.dsh?.client?.platform === "web");
ok("源码文件存在（sidebar.js 参与拼接）", existsSync(path.join(pkg, "client", "remote-hosts-ui", "src", "sidebar.js")));

console.log(`\n结果：${passed} 通过，${failures} 失败`);
process.exit(failures === 0 ? 0 : 1);
