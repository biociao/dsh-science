// science-sidebar-ui —— Codex 风格侧边栏增强的宿主侧（webServer REST API）
//
// 浏览器侧侧边栏通过 POST /dsh-science/sidebar/<method> 调用本插件注册的 HTTP
// 路由，把「已固定的工作区」持久化到 $DSH_HOME/dsh-science/sidebar.json
// （schema 1），并提供 reveal/open 两条调系统文件管理器的通路：
//
//   config  → { ok, pinsFile, platform }
//   pins    → { ok, pins:[{workspaceId,path,title,pinnedAt}] }（最近固定在前）
//   pin     → 固定/刷新一个工作区（workspaceId 唯一，最多 100 条，原子写）
//   unpin   → 取消固定
//   reveal  → 在系统文件管理器中「选中」目录（darwin open -R / win32 explorer
//             /select, / 其他 xdg-open <父目录>）
//   open    → 用系统默认方式打开目录（open / explorer / xdg-open）
//
// 零第三方依赖（node 内置模块）。作为 bundle 行挂载于 profile
// （cordis.patch.yml），不进入 agent preset（侧边栏是 profile 级 UI）。
// 所有错误以 HTTP 200 + { ok:false, error } 返回，客户端只需看 ok 字段。

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn as nodeSpawn } from "node:child_process";
import { isTrustedLocalRequest } from "./http-guard.mjs";

export const name = "science-sidebar-ui";
export const inject = ["webServer"];

const MAX_PINS = 100;
const MAX_WORKSPACE_ID = 200;
const MAX_TITLE = 200;
const MAX_PATH = 4096;

// DSH_HOME：与工作台/远程主机引擎同一约定（env 优先，否则 ~/.dsh）。
function dshHome() {
  const env = String(process.env.DSH_HOME || "").trim();
  return env || path.join(os.homedir(), ".dsh");
}

function defaultPinsFile() {
  return path.join(dshHome(), "dsh-science", "sidebar.json");
}

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// 来源校验见 ./http-guard.mjs：有 Origin 时要求与 Host 同 authority；桌面壳
// 转发（无 Origin + 回环 Host）放行；Sec-Fetch-Site: cross-site 一律拒绝。

const fail = (msg) => ({ ok: false, error: String((msg && msg.message) || msg).slice(0, 400) });
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

function assertFields(a, allowed, what) {
  for (const k of Object.keys(a && typeof a === "object" ? a : {})) {
    if (!allowed.includes(k)) throw new Error(`${what}：未知字段 ${k}`);
  }
}

// ── 固定工作区存储（原子写 + 进程内 promise 互斥）────────────────────────

function normalizePins(raw) {
  const rows = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== "object") continue;
    const workspaceId = str(p.workspaceId);
    if (!workspaceId) continue;
    rows.push({ pin: { workspaceId, path: str(p.path), title: str(p.title), pinnedAt: str(p.pinnedAt) }, i: rows.length });
  }
  // 最近固定在前：按 pinnedAt 倒序；时间相同/缺失时保持文件里的相对顺序。
  return rows
    .sort((a, b) => (Date.parse(b.pin.pinnedAt) || 0) - (Date.parse(a.pin.pinnedAt) || 0) || a.i - b.i)
    .map((r) => r.pin)
    .slice(0, MAX_PINS);
}

function makeHandlers(config = {}) {
  const pinsFile = path.resolve(str(config.pinsFile || config.stateFile) || defaultPinsFile());
  const spawnFn = typeof config.spawn === "function" ? config.spawn : nodeSpawn;
  const platform = str(config.platform) || process.platform;

  // 进程内互斥：串行化所有 read-modify-write，避免同进程并发 pin/unpin 丢更新。
  // 跨进程并发由「临时文件 + rename 原子写」兜底（后写者整体覆盖）。
  let mutex = Promise.resolve();
  function exclusive(fn) {
    const run = mutex.then(() => fn(), () => fn());
    mutex = run.then(() => {}, () => {});
    return run;
  }

  async function loadStore() {
    let raw;
    try {
      raw = await fsp.readFile(pinsFile, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return { pins: [], corrupt: false };
      throw new Error(`读取固定工作区文件失败 ${pinsFile}：${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { pins: [], corrupt: true };
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.pins)) return { pins: [], corrupt: true };
    return { pins: normalizePins(data.pins), corrupt: false };
  }

  async function saveStore(pins) {
    const payload = { schema: 1, pins: pins.slice(0, MAX_PINS) };
    const dir = path.dirname(pinsFile);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(pinsFile)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      await fsp.rename(tmp, pinsFile);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw new Error(`写入固定工作区文件失败 ${pinsFile}：${err.message}`);
    }
  }

  // 损坏文件先备份（重命名，永不删除用户数据），再由调用方写入新内容。
  async function backupCorrupt() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${pinsFile}.corrupt-${stamp}.json`;
    try {
      await fsp.rename(pinsFile, backup);
      return backup;
    } catch {
      return null;
    }
  }

  async function mutate(fn) {
    return exclusive(async () => {
      const { pins, corrupt } = await loadStore();
      const backup = corrupt ? await backupCorrupt() : null;
      const next = await fn(pins.slice());
      await saveStore(next);
      return { pins: next.slice(0, MAX_PINS), backup };
    });
  }

  // ── 参数校验 ────────────────────────────────────────────────────────────

  function requireWorkspaceId(v) {
    const id = str(v);
    if (!id) throw new Error("缺少 workspaceId");
    if (id.length > MAX_WORKSPACE_ID) throw new Error(`workspaceId 过长（最多 ${MAX_WORKSPACE_ID} 字符）`);
    return id;
  }

  function requireTitle(v) {
    if (typeof v !== "string") throw new Error("title 必须是字符串");
    const t = v.trim();
    if (t.length > MAX_TITLE) throw new Error(`title 过长（最多 ${MAX_TITLE} 字符）`);
    return t;
  }

  function optionalPinPath(v) {
    if (typeof v !== "string") throw new Error("path 必须是字符串");
    const p = v.trim();
    if (!p) throw new Error("path 不能为空");
    if (p.length > MAX_PATH) throw new Error("path 过长");
    return p;
  }

  async function requireDirPath(v) {
    const p = str(v);
    if (!p) throw new Error("缺少 path");
    if (p.length > MAX_PATH) throw new Error("path 过长");
    if (!path.isAbsolute(p)) throw new Error(`path 必须是绝对路径：${p}`);
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      throw new Error(`目录不存在：${p}`);
    }
    if (!st.isDirectory()) throw new Error(`不是目录：${p}`);
    return p;
  }

  // ── 系统文件管理器 ──────────────────────────────────────────────────────

  function openerFor(action, target) {
    if (platform === "darwin") return action === "reveal" ? ["open", ["-R", target]] : ["open", [target]];
    if (platform === "win32") return action === "reveal" ? ["explorer", [`/select,${target}`]] : ["explorer", [target]];
    // linux / 其他 unix：reveal 只能打开父目录（xdg-open 没有「选中」语义）
    return ["xdg-open", [action === "reveal" ? path.dirname(target) : target]];
  }

  function launch(cmd, args) {
    try {
      const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
      // 真实 spawn 不会因 ENOENT 同步抛错，错误走 error 事件；测试桩可能没有发射器。
      if (child && typeof child.on === "function") child.on("error", () => {});
      if (child && typeof child.unref === "function") child.unref();
      return child;
    } catch (e) {
      throw new Error(`无法调用系统打开方式（${cmd}）：${e.message}`);
    }
  }

  async function launchAction(action, a) {
    assertFields(a, ["path"], action);
    const target = await requireDirPath(a.path);
    const [cmd, args] = openerFor(action, target);
    launch(cmd, args);
    return { ok: true, action, path: target, platform, command: [cmd, ...args] };
  }

  // ── 方法 ────────────────────────────────────────────────────────────────

  return {
    async config() {
      return { ok: true, pinsFile, platform };
    },

    async pins() {
      const { pins } = await loadStore();
      return { ok: true, pins };
    },

    async pin(a) {
      assertFields(a, ["workspaceId", "path", "title"], "pin");
      const workspaceId = requireWorkspaceId(a.workspaceId);
      const patch = {};
      if (a.path !== undefined) patch.path = optionalPinPath(a.path);
      if (a.title !== undefined) patch.title = requireTitle(a.title);

      const { pins, backup } = await mutate((list) => {
        const i = list.findIndex((p) => p.workspaceId === workspaceId);
        const prev = i >= 0 ? list.splice(i, 1)[0] : { path: "", title: "" };
        list.unshift({
          workspaceId,
          path: patch.path !== undefined ? patch.path : prev.path,
          title: patch.title !== undefined ? patch.title : prev.title,
          pinnedAt: new Date().toISOString(),
        });
        return list;
      });
      const pin = pins.find((p) => p.workspaceId === workspaceId) || null;
      return { ok: true, pin, pins, ...(backup ? { backup } : {}) };
    },

    async unpin(a) {
      assertFields(a, ["workspaceId"], "unpin");
      const workspaceId = requireWorkspaceId(a.workspaceId);
      let removed = false;
      const { pins, backup } = await mutate((list) => {
        const rest = list.filter((p) => p.workspaceId !== workspaceId);
        removed = rest.length !== list.length;
        return rest;
      });
      return { ok: true, removed, count: pins.length, pins, ...(backup ? { backup } : {}) };
    },

    async reveal(a) {
      return launchAction("reveal", a);
    },

    async open(a) {
      return launchAction("open", a);
    },
  };
}

// ── 路由挂载 ──────────────────────────────────────────────────────────────

const METHODS = ["config", "pins", "pin", "unpin", "reveal", "open"];

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  const handlers = makeHandlers(config);
  const byName = {
    config: handlers.config,
    pins: handlers.pins,
    pin: handlers.pin,
    unpin: handlers.unpin,
    reveal: handlers.reveal,
    open: handlers.open,
  };
  const disposer = webServer.register({
    kind: "prefix",
    path: "/dsh-science/sidebar",
    async handler(req, res) {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "仅支持 POST" });
      if (!isTrustedLocalRequest(req)) return send(res, 403, { ok: false, error: "请求来源校验失败（Origin 与 Host 不一致，或 Host 不是本机回环地址）" });
      const name = (req.url || "").split("?")[0].split("#")[0].replace(/^\/dsh-science\/sidebar\/?/, "").split("/")[0];
      if (!name || !METHODS.includes(name)) return send(res, 404, { ok: false, error: `未知方法 ${name}` });
      try {
        const body = await readBody(req);
        const result = await byName[name](body || {});
        send(res, 200, result);
      } catch (e) {
        // 契约：业务/校验错误一律 200 + {ok:false}，客户端只看 ok 字段。
        send(res, 200, fail(e));
      }
    },
  });
  ctx.on("dispose", disposer);
}

export { makeHandlers, apply };
