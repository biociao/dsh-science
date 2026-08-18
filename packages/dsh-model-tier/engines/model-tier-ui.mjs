// dsh-model-tier-ui —— 「智能分档」设置页的宿主侧（webServer REST API）
//
// 浏览器设置页通过 fetch 调用本插件注册的 HTTP 路由：
//   POST /dsh-model-tier/config        方案列表 + 生效方案 + 基线/生效配置 + 配置文件路径
//   POST /dsh-model-tier/providers     已注册 provider 及其模型清单（供档位下拉选择）
//   POST /dsh-model-tier/save-scheme   新建/更新方案（新方案自动设为生效）
//   POST /dsh-model-tier/delete-scheme 删除方案
//   POST /dsh-model-tier/set-active    切换生效方案（id 为 null → 停用，回落 bundle 默认）
//   POST /dsh-model-tier/set-enabled   总开关
//   POST /dsh-model-tier/reset         删除整个配置文件，回落 bundle 自带配置
//
// 配置文件 $DSH_HOME/model-tier.json 为 schema 2 多方案形态：
//   { schema:2, enabled, activeId, schemes:[{id,name,tiers,routing,createdAt,updatedAt}] }
// 路由引擎（engines/model-tier.mjs 的 normalizeFileConfig）取 activeId 方案热生效，
// 保存后无需重启。同一时间只有一个方案生效（路由是全局单映射）。
//
// 安全：POST-only + Origin↔Host 同源校验（防跨站调用本地服务）；设置页是用户手动
// 操作，不弹审批。零第三方依赖（node 内置模块）。
//
// 注意：本行的 config 应与同包（及 dsh-science）cordis.patch.yml 里 model-tier 行的
// config 保持一致 —— 它是「无生效方案时」界面展示的基线。

import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  defaultConfigFile,
  normalizeFileConfig,
  overlayConfig,
  readFileConfig,
  resolveTierTarget,
  routeStatus,
} from "./model-tier.mjs";

export const name = "dsh-model-tier-ui";
// 只硬依赖 llm（任何 profile 都有）；webServer 在 apply 里用延迟注入（ctx.inject）
// 获取 —— headless / CLI profile 没有 webServer 服务，若写进 inject 会让整个
// profile 启动失败（条目 pending 等待一个永不出现的服务）。
export const inject = ["llm"];

const METHODS = ["config", "providers", "save-scheme", "delete-scheme", "set-active", "set-enabled", "reset", "route-status"];
const TIER_KEYS = ["strong", "default", "light"];

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// 同源校验：只接受浏览器同源请求（防止跨站调用本地服务）
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // 非浏览器（curl 等）拒绝
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const fail = (msg) => ({ ok: false, error: String((msg && msg.message) || msg).slice(0, 400) });

/** 校验并规整一档配置：{provider, model, reasoningEffort?} 或 null（该档不设置）。 */
function normTier(v) {
  if (v === null) return null;
  if (!v || typeof v !== "object") throw new Error("档位必须是对象或 null");
  if (typeof v.provider !== "string" || !v.provider) throw new Error("档位缺 provider");
  if (typeof v.model !== "string" || !v.model) throw new Error("档位缺 model");
  const out = { provider: v.provider, model: v.model };
  if (typeof v.reasoningEffort === "string" && v.reasoningEffort) out.reasoningEffort = v.reasoningEffort;
  return out;
}

/** 校验并规整 LLM 前置分类器配置：{provider?, model?, timeoutMs?, maxChars?} 或 null（关闭）。 */
function normClassify(v) {
  if (v === null || v === false) return null;
  const c = v === true ? {} : v;
  if (!c || typeof c !== "object") throw new Error("classify 必须是对象或 null");
  const out = {};
  const hasProv = !!(typeof c.provider === "string" && c.provider);
  const hasModel = !!(typeof c.model === "string" && c.model);
  if (hasProv !== hasModel) throw new Error("classify 的 provider / model 需同时填写或同时留空（留空 = 用执行档模型分类）");
  if (hasProv) {
    out.provider = c.provider;
    out.model = c.model;
  }
  for (const k of ["timeoutMs", "maxChars", "maxTokens"]) {
    if (c[k] === undefined || c[k] === null || c[k] === "") continue;
    const n = Number(c[k]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`classify.${k} 必须是正数或留空`);
    out[k] = Math.floor(n);
  }
  return out;
}

/** 校验并规整路由规则：{subagents?, subagentDepthStrong?, escalateOnChars?, classify?}。 */
function normRouting(v) {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") throw new Error("routing 必须是对象");
  const out = {};
  if (v.subagents !== undefined) out.subagents = String(v.subagents);
  for (const k of ["subagentDepthStrong", "escalateOnChars"]) {
    if (v[k] === null || v[k] === "") out[k] = null;
    else if (v[k] !== undefined) {
      const n = Number(v[k]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} 必须是正数或留空`);
      out[k] = Math.floor(n);
    }
  }
  if (v.classify !== undefined) out.classify = normClassify(v.classify);
  return out;
}

function makeHandlers(ctx, config) {
  const configFile = config?.configFile ?? defaultConfigFile();
  const baseline = {
    enabled: config?.enabled !== false,
    tiers: config?.tiers && typeof config.tiers === "object" ? config.tiers : {},
    routing: config?.routing && typeof config.routing === "object" ? config.routing : {},
  };

  async function loadStore() {
    const parsed = readFileConfig(configFile);
    if (parsed?.schema === 2 && Array.isArray(parsed.schemes)) {
      return {
        schema: 2,
        enabled: parsed.enabled !== false,
        activeId: parsed.activeId ?? null,
        schemes: parsed.schemes.filter((s) => s && typeof s === "object" && typeof s.id === "string"),
      };
    }
    // 旧版扁平配置 → 迁移为单方案的 schema 2（不自动生效，由用户确认启用）
    if (parsed && (parsed.tiers || parsed.routing)) {
      return {
        schema: 2,
        enabled: parsed.enabled !== false,
        activeId: null,
        schemes: [{
          id: "legacy",
          name: "迁移的旧配置",
          tiers: parsed.tiers ?? {},
          routing: parsed.routing ?? {},
          createdAt: parsed.updatedAt ?? new Date().toISOString(),
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        }],
        legacyActive: true,
      };
    }
    return { schema: 2, enabled: true, activeId: null, schemes: [] };
  }

  async function saveStore(store) {
    store.schema = 2;
    store.updatedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(configFile), { recursive: true });
    await fsp.writeFile(configFile, JSON.stringify(store, null, 2) + "\n", "utf8");
    // 通知前端模型目录刷新（虚拟 provider 的方案列表随文件热变）
    try {
      ctx.emit?.("llm/adapters-updated");
    } catch {
      /* 事件不可发时忽略 */
    }
  }

  function viewOf(store) {
    const flat = normalizeFileConfig(readFileConfig(configFile));
    return {
      ok: true,
      configFile,
      baseline,
      enabled: store.enabled !== false,
      activeId: store.legacyActive ? "legacy" : store.activeId,
      schemes: store.schemes,
      effective: overlayConfig(baseline, flat),
    };
  }

  return {
    async config() {
      return viewOf(await loadStore());
    },
    async providers() {
      const out = [];
      for (const p of ctx.llm?.listProviders?.() ?? []) {
        const id = p && (p.id ?? p.provider);
        if (!id) continue;
        let models = [];
        try {
          models = (await ctx.llm.listModels(id)).map((m) => ({ id: m.id, name: m.name ?? m.id }));
        } catch {
          /* 该 provider 暂不可枚举（未认证等），仍列出 provider 本身 */
        }
        out.push({ id, name: p.name ?? id, models });
      }
      return { ok: true, providers: out };
    },
    async "save-scheme"(body) {
      if (typeof body?.name !== "string" || !body.name.trim()) throw new Error("方案需要名称");
      if (!body.tiers || typeof body.tiers !== "object") throw new Error("tiers 必须是对象");
      const tiers = {};
      for (const k of TIER_KEYS) {
        if (!(k in body.tiers)) continue;
        const t = normTier(body.tiers[k]);
        if (t) tiers[k] = t;
      }
      const routing = normRouting(body.routing) ?? {};
      const store = await loadStore();
      const now = new Date().toISOString();
      let scheme;
      if (body.id) {
        scheme = store.schemes.find((s) => s.id === body.id);
        if (!scheme) throw new Error(`方案不存在：${body.id}`);
        scheme.name = body.name.trim();
        scheme.tiers = tiers;
        scheme.routing = routing;
        scheme.updatedAt = now;
      } else {
        scheme = {
          id: "scheme-" + now.replace(/[-:T.Z]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6),
          name: body.name.trim(),
          tiers,
          routing,
          createdAt: now,
          updatedAt: now,
        };
        store.schemes.push(scheme);
        // 新方案自动设为生效（用户保存即"我要用它"）
        store.activeId = scheme.id;
        delete store.legacyActive;
      }
      await saveStore(store);
      return viewOf(store);
    },
    async "delete-scheme"(body) {
      const store = await loadStore();
      const i = store.schemes.findIndex((s) => s.id === body?.id);
      if (i < 0) throw new Error(`方案不存在：${body?.id}`);
      store.schemes.splice(i, 1);
      if (store.activeId === body.id) store.activeId = null;
      if (store.legacyActive && body.id === "legacy") delete store.legacyActive;
      await saveStore(store);
      return viewOf(store);
    },
    async "set-active"(body) {
      const store = await loadStore();
      if (body?.id === null) {
        store.activeId = null;
        delete store.legacyActive;
      } else if (body?.id === "legacy" && store.legacyActive !== undefined) {
        store.legacyActive = true;
      } else {
        if (!store.schemes.some((s) => s.id === body?.id)) throw new Error(`方案不存在：${body?.id}`);
        store.activeId = body.id;
        delete store.legacyActive;
      }
      await saveStore(store);
      return viewOf(store);
    },
    async "set-enabled"(body) {
      const store = await loadStore();
      store.enabled = body?.enabled !== false;
      await saveStore(store);
      return viewOf(store);
    },
    async reset() {
      await fsp.rm(configFile, { force: true });
      try {
        ctx.emit?.("llm/adapters-updated");
      } catch {
        /* 忽略 */
      }
      return { ok: true, configFile, effective: baseline, schemes: [], activeId: null, enabled: true };
    },
    // 会话路由读数：该会话最近一次实际路由到的模型（供聊天页底部读数）
    async "route-status"(body) {
      const sessionId = body?.sessionId;
      if (!sessionId) throw new Error("缺 sessionId");
      const rec = routeStatus.get(String(sessionId)) ?? null;
      let willUse = null;
      if (rec?.schemeId) {
        const store = await loadStore();
        const scheme = store.schemes.find((s) => s.id === rec.schemeId);
        const hit = scheme ? resolveTierTarget(scheme.tiers ?? {}, "default") : null;
        if (hit) willUse = { provider: hit.provider, model: hit.model };
      }
      return {
        ok: true,
        tiered: !!rec,
        schemeName: rec?.schemeName ?? null,
        last: rec ? { provider: rec.provider, model: rec.model, tier: rec.tier, via: rec.via ?? null, at: rec.at } : null,
        willUse,
      };
    },
  };
}

function apply(ctx, config = {}) {
  const handlers = makeHandlers(ctx, config);
  // 延迟注入 webServer：web profile 下服务就绪后回调执行；headless profile
  // 无此服务，回调永不触发（本条目静默空转，不影响路由引擎与启动）。
  ctx.inject(["webServer"], (ctx2) => {
    const webServer = ctx2.get("webServer");
    if (!webServer) return;
    const disposer = webServer.register({
      kind: "prefix",
      path: "/dsh-model-tier",
      async handler(req, res) {
        if (req.method !== "POST") return send(res, 405, { ok: false, error: "仅支持 POST" });
        if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "非浏览器同源请求被拒绝（缺少/不匹配 Origin）" });
        const name = (req.url || "").replace(/^\/dsh-model-tier\/?/, "").split("/")[0];
        if (!name || !METHODS.includes(name)) return send(res, 404, { ok: false, error: `未知方法 ${name}` });
        try {
          const body = await readBody(req);
          send(res, 200, await handlers[name](body));
        } catch (e) {
          send(res, 400, fail(e));
        }
      },
    });
    ctx2.on("dispose", disposer);
  });
}

export { apply };
