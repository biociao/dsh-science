// science-workbench-ui —— 科研工作台 Web 面板的宿主侧（webServer REST API）
//
// 对应 Claude Science 的 Projects 多项目管理/分类视图。浏览器侧 UI 通过 fetch 调用
// 本插件注册的 HTTP 路由，复用 workbench 引擎（./workbench.mjs）的注册表读写、项目
// 发现与状态汇总逻辑（同一份数据：<工作台根>/.dsh/workbench.json + 各项目
// research-manifest.json / artifacts.json / .dsh/remotes/jobs.json）。
//
// 零第三方依赖（node 内置模块）。作为 bundle 行挂载于 profile（cordis.patch.yml），
// 不进入 agent preset（工作台面板是 profile 级 UI）。
//
// 工作台根默认取 config.workbench.defaultRoot；客户端每次调用也可传 root 覆盖。

import path from "node:path";
import * as wb from "./workbench.mjs";
import { isTrustedLocalRequest } from "./http-guard.mjs";

export const name = "science-workbench-ui";
export const inject = ["webServer"];

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(buf ? JSON.parse(buf) : {}));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// 来源校验见 ./http-guard.mjs：桌面端转发（dsh-app://app → 本机 Host）会删除
// Origin，因此「无 Origin + 回环 Host」放行；跨站/不匹配 Origin 仍然拒绝。

const fail = (msg) => ({ ok: false, error: String(msg && msg.message || msg).slice(0, 400) });
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));

function makeHandlers(config = {}) {
  const defaultRoot = str(config.workbenchRoot || config.defaultRoot || "");

  async function rootOf(a) {
    const r = str(a.root) || defaultRoot;
    if (!r) throw new Error("缺少工作台根（root），请在面板顶部设置");
    return path.resolve(r);
  }

  async function overviewAt(root) {
    const reg = await wb.loadRegistry(root);
    const projects = await wb.discoverProjects(root, reg);
    return {
      root,
      registryFile: reg.file,
      categories: reg.categories,
      summary: wb.summarize(projects),
      projects,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    async config() {
      return { ok: true, defaultRoot, registryPattern: ".dsh/workbench.json" };
    },
    async overview(a) {
      const root = await rootOf(a);
      const overview = await overviewAt(root);
      return { ok: true, ...overview };
    },
    async list(a) {
      const root = await rootOf(a);
      const overview = await overviewAt(root);
      const filtered = overview.projects.filter((p) => {
        if (a.which === "classified" && !p.registeredAt) return false;
        if (a.category && p.category !== a.category) return false;
        if (a.status && p.status !== a.status) return false;
        if (a.priority && p.priority !== a.priority) return false;
        if (a.tag && !p.tags.includes(str(a.tag).toLowerCase())) return false;
        return true;
      });
      return { ok: true, root, count: filtered.length, projects: filtered, summary: overview.summary, generatedAt: overview.generatedAt };
    },
    async classify(a) {
      const root = await rootOf(a);
      const p = str(a.path);
      if (!p) return fail("缺少 path");
      const patch = {
        category: a.category,
        tags: a.tags,
        priority: a.priority,
        status: a.status,
        notes: a.notes,
        name: a.name,
      };
      const view = await wb.classifyProject(root, p, patch, undefined);
      return { ok: true, project: view, registryFile: view.registryFile };
    },
    async register(a) {
      const root = await rootOf(a);
      const p = str(a.path);
      if (!p) return fail("缺少 path");
      const view = await wb.classifyProject(root, p, {
        category: a.category, tags: a.tags, priority: a.priority, status: a.status, notes: a.notes, name: a.name,
      }, undefined);
      return { ok: true, project: view, registryFile: view.registryFile };
    },
    async remove(a) {
      const root = await rootOf(a);
      const p = str(a.path);
      if (!p) return fail("缺少 path");
      const out = await wb.removeProject(root, p, undefined);
      return { ok: true, ...out };
    },
  };
}

const METHODS = ["config", "overview", "list", "classify", "register", "remove"];

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  const handlers = makeHandlers(config);
  const byName = {
    config: handlers.config,
    overview: handlers.overview,
    list: handlers.list,
    classify: handlers.classify,
    register: handlers.register,
    remove: handlers.remove,
  };
  const disposer = webServer.register({
    kind: "prefix",
    path: "/dsh-science/workbench",
    async handler(req, res) {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "仅支持 POST" });
      if (!isTrustedLocalRequest(req)) return send(res, 403, { ok: false, error: "请求来源校验失败（Origin 与 Host 不一致，或 Host 不是本机回环地址）" });
      const name = (req.url || "").replace(/^\/dsh-science\/workbench\/?/, "").split("/")[0];
      if (!name || !METHODS.includes(name)) return send(res, 404, { ok: false, error: `未知方法 ${name}` });
      try {
        const body = await readBody(req);
        const result = await byName[name](body || {});
        send(res, 200, result);
      } catch (e) {
        send(res, 200, fail(e));
      }
    },
  });
  ctx.on("dispose", disposer);
}

export { apply };
