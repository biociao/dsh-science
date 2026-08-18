// dsh-model-tier 单元测试 —— 虚拟 provider 形态：
//   1. 插件契约 + 适配器注册
//   2. 方案仓库（schemeStoreFrom / makeSchemeStoreSource 热加载）
//   3. 适配器 listModels / resolveModel
//   4. 适配器 stream 路由（档位决策矩阵 + 回落 + routeStatus）
//   5. 全局默认模型回退守卫
//   6. 配置文件覆盖（overlayConfig / normalizeFileConfig）
//   7. LLM 前置分类器（routing.classify：分类路由 + 缓存 + 回落）
// 用法：node test/model-tier.test.mjs

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// 隔离默认配置文件（$DSH_HOME/model-tier.json）：指向空临时目录，
// 防止真实 ~/.dsh 下的用户配置污染路由断言。
process.env.DSH_HOME = path.join(os.tmpdir(), `model-tier-test-home-${process.pid}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, "..", "engines", "model-tier.mjs"));

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

// ── 工具 ──────────────────────────────────────────────────────────────

const CHUNK_OK = { type: "finish", reason: { kind: "success" } };

function makeCtx({ providers = [], agents = new Map(), defaultSelection = null, classifyReply } = {}) {
  const listeners = new Map();
  const saved = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async (p) => [{ id: p + "-model" }],
      resolveModelInfo: async (provider, model) => ({
        id: model, name: model, inputModalities: ["text"],
        reasoning: { efforts: [{ id: "high" }] },
      }),
      stream: (options) => {
        // 分类器调用：引擎发给真实 provider 的单条分类 prompt（content 为块数组）
        const msg0 = options?.messages?.[0]?.content;
        const firstText = typeof msg0 === "string"
          ? msg0
          : Array.isArray(msg0)
            ? msg0.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
            : "";
        if (firstText.includes("任务复杂度分类器")) {
          ctx._classifyCalls = (ctx._classifyCalls ?? 0) + 1;
          ctx._classifyTarget = { provider: options.provider, model: options.model };
          ctx._classifyContent = msg0;
          ctx._classifyPrompt = firstText;
          ctx._classifyMaxTokens = options.maxTokens;
          const reply = typeof classifyReply === "function" ? classifyReply() : classifyReply;
          return (async function* () {
            if (reply != null) yield { type: "text-delta", index: 0, text: String(reply) };
            yield CHUNK_OK;
          })();
        }
        ctx.lastStreamOptions = options;
        return (async function* () { yield CHUNK_OK; })();
      },
      registerAdapter: (routes, adapter) => {
        ctx._adapterRoutes = routes;
        ctx._adapter = adapter;
        return () => {};
      },
    },
    agents: { get: (id) => agents.get(id) },
    _defaultModel: {
      currentSelection: () => ctx._defaultModel._sel,
      saveSelection: (s) => { saved.push(s); ctx._defaultModel._sel = s; },
      _sel: defaultSelection,
      _saved: saved,
    },
    get(k) { return k === "agentDefaultModel" ? ctx._defaultModel : undefined; },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
  };
  ctx._listeners = listeners;
  return ctx;
}

async function drain(iter) {
  const chunks = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

const ALL_PROVIDERS = ["deepseek-official", "zai-coding-cn", "opencode-go", "kimi-code"];

const SCHEME = {
  id: "s1",
  name: "日常开发",
  tiers: {
    strong: { provider: "zai-coding-cn", model: "glm-5.3" },
    default: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    light: { provider: "opencode-go", model: "minimax-m2.7" },
  },
  routing: { subagents: "light", subagentDepthStrong: 3, escalateOnChars: 40000 },
};

// 把 schema2 文件写入临时路径并返回路径
function writeStore(obj) {
  const tmp = path.join(os.tmpdir(), `model-tier-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(obj));
  return tmp;
}

function applyWith(ctx, storeObj) {
  const file = storeObj === undefined
    ? path.join(os.tmpdir(), `model-tier-test-none-${process.pid}.json`) // 不存在
    : writeStore(storeObj);
  mod.apply(ctx, { configFile: file });
  return ctx._adapter;
}

// ── 1. 插件契约 ───────────────────────────────────────────────────────

console.log("== 1. 插件契约 ==");
ok("name = dsh-model-tier", mod.name === "dsh-model-tier");
ok("inject 含 llm", Array.isArray(mod.inject) && mod.inject.includes("llm"));
ok("导出 apply", typeof mod.apply === "function");
ok("导出决策/工具函数", typeof mod.decideTier === "function" && typeof mod.resolveTierTarget === "function"
  && typeof mod.schemeStoreFrom === "function" && typeof mod.makeSchemeStoreSource === "function");
ok("VIRTUAL_PROVIDER = model-tier", mod.VIRTUAL_PROVIDER === "model-tier");
ok("routeStatus 为 Map", mod.routeStatus instanceof Map);

{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  mod.apply(ctx, {});
  ok("registerAdapter 注册虚拟 provider", JSON.stringify(ctx._adapterRoutes) === '["model-tier"]');
  ok("providerInfo 名为智能分档", ctx._adapter.providerInfo("model-tier").name === "智能分档");
  ok("注册默认模型守卫（agent/request ×1）", (ctx._listeners.get("agent/request") ?? []).length === 1);
}

// ── 2. 方案仓库 ───────────────────────────────────────────────────────

console.log("\n== 2. 方案仓库 ==");
{
  const schema2 = { schema: 2, enabled: true, activeId: "s1", schemes: [SCHEME] };
  const st = mod.schemeStoreFrom(schema2, {});
  ok("schema2 原样", st.schemes.length === 1 && st.activeId === "s1" && st.enabled === true);
  const legacy = mod.schemeStoreFrom({ tiers: { light: { provider: "p9", model: "m9" } } }, {});
  ok("旧扁平 → legacy 方案且生效", legacy.schemes[0].id === "legacy" && legacy.activeId === "legacy");
  const bundle = mod.schemeStoreFrom(null, { tiers: { default: { provider: "a", model: "x" } } });
  ok("无文件 → bundle 默认方案", bundle.schemes[0].id === "bundle" && bundle.activeId === "bundle");
  const empty = mod.schemeStoreFrom(null, {});
  ok("无文件无 yaml 档位 → 空", empty.schemes.length === 0 && empty.activeId === null);
  const dis = mod.schemeStoreFrom({ schema: 2, enabled: false, schemes: [SCHEME] }, {});
  ok("schema2 enabled:false", dis.enabled === false);
}
{
  // 热加载：写文件 → 生效；删除 → 回落 bundle
  const file = writeStore({ schema: 2, activeId: "s1", schemes: [SCHEME] });
  const src = mod.makeSchemeStoreSource(file, { tiers: { light: { provider: "b", model: "y" } } });
  ok("热读 schema2", src().schemes[0].id === "s1");
  fs.writeFileSync(file, JSON.stringify({ schema: 2, activeId: null, schemes: [{ ...SCHEME, id: "s2" }] }));
  ok("改动即热生效", src().schemes[0].id === "s2");
  fs.rmSync(file);
  ok("删除回落 bundle 方案", src().schemes[0].id === "bundle");
}

// ── 3. 适配器 listModels / resolveModel ───────────────────────────────

console.log("\n== 3. 适配器 listModels / resolveModel ==");
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  const models = await adapter.listModels("model-tier");
  ok("listModels 返回方案", models.length === 1 && models[0].id === "s1" && models[0].name === "日常开发");
  ok("listModels 回填 provider（宿主目录校验）", models[0].provider === "model-tier");
  ok("listModels 含 image 模态", models[0].inputModalities.includes("image"));

  const info = await adapter.resolveModel("model-tier", "s1");
  ok("resolveModel 委托主力档真实模型", info.name === "日常开发" && info.reasoning?.efforts?.[0]?.id === "high");
  // 未知方案 id 回落默认方案（与 stream 一致），仍委托真实模型
  ok("resolveModel 未知方案回落默认方案", (await adapter.resolveModel("model-tier", "nope")).name === "日常开发");

  const ctxEmpty = makeCtx({ providers: ALL_PROVIDERS });
  const adapterEmpty = applyWith(ctxEmpty, { schema: 2, activeId: null, schemes: [] });
  ok("resolveModel 无方案 → 通用回落（含 image）", (await adapterEmpty.resolveModel("model-tier", "x")).inputModalities.includes("image"));

  const ctx2 = makeCtx({ providers: ALL_PROVIDERS });
  const adapter2 = applyWith(ctx2, { schema: 2, enabled: false, activeId: "s1", schemes: [SCHEME] });
  ok("enabled:false → listModels 为空", (await adapter2.listModels("model-tier")).length === 0);
}

// ── 4. 适配器 stream 路由 ─────────────────────────────────────────────

console.log("\n== 4. 适配器 stream 路由 ==");

// 4.1 主对话 → 主力档 + routeStatus 记录
{
  mod.routeStatus.clear();
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  const chunks = await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [{ role: "user", content: "hi" }] }));
  ok("主对话 → 主力档", ctx.lastStreamOptions.provider === "deepseek-official" && ctx.lastStreamOptions.model === "deepseek-v4-flash");
  ok("保留 sessionId 且流透传", ctx.lastStreamOptions.sessionId === "S1" && chunks.length === 1);
  const rec = mod.routeStatus.get("S1");
  ok("routeStatus 记录", rec?.schemeId === "s1" && rec?.tier === "default" && rec?.model === "deepseek-v4-flash");
}

// 4.2 辅助请求（purpose）→ 轻档
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", purpose: "session-title", messages: [] }));
  ok("session-title → 轻档", ctx.lastStreamOptions.provider === "opencode-go" && ctx.lastStreamOptions.model === "minimax-m2.7");
  ok("purpose 透传", ctx.lastStreamOptions.purpose === "session-title");
}

// 4.3 超长输入 → 强档
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [{ role: "user", content: [{ text: "x".repeat(50000) }] }] }));
  ok("超长输入 → 强档", ctx.lastStreamOptions.provider === "zai-coding-cn" && ctx.lastStreamOptions.model === "glm-5.3");
}

// 4.4 子任务：深度 1 → 轻档；深度 3 → 强档
{
  const agents = new Map([
    ["C1", { session: { meta: { origin: "subagent", delegationDepth: 1 } } }],
    ["C3", { session: { meta: { origin: "subagent", delegationDepth: 3 } } }],
  ]);
  const ctx = makeCtx({ providers: ALL_PROVIDERS, agents });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "C1", messages: [] }));
  ok("子任务 depth1 → 轻档", ctx.lastStreamOptions.model === "minimax-m2.7");
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "C3", messages: [] }));
  ok("子任务 depth3 → 强档", ctx.lastStreamOptions.model === "glm-5.3");
}

// 4.5 档位回落：只配轻档时主对话也走轻档；reasoningEffort 覆盖
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, {
    schema: 2, activeId: "s2",
    schemes: [{ id: "s2", name: "B", tiers: { light: { provider: "opencode-go", model: "minimax-m2.7", reasoningEffort: "low" } } }],
  });
  await drain(adapter.stream({ provider: "model-tier", model: "s2", sessionId: "S2", messages: [], reasoningEffort: "high" }));
  ok("缺主力档 → 回落轻档", ctx.lastStreamOptions.model === "minimax-m2.7");
  ok("档位 reasoningEffort 覆盖选择器", ctx.lastStreamOptions.reasoningEffort === "low");
}

// 4.6 方案 id 失效 → 回落默认方案（activeId）
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "deleted-scheme", sessionId: "S1", messages: [] }));
  ok("未知方案 id → 回落默认方案", ctx.lastStreamOptions.model === "deepseek-v4-flash");
}

// 4.7 enabled:false → 透传全局默认模型（tier 为 null）
{
  mod.routeStatus.clear();
  const ctx = makeCtx({ providers: ALL_PROVIDERS, defaultSelection: { provider: "kimi-code", model: "k3-256k" } });
  const adapter = applyWith(ctx, { schema: 2, enabled: false, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S9", messages: [] }));
  ok("enabled:false → 透传全局默认", ctx.lastStreamOptions.provider === "kimi-code" && ctx.lastStreamOptions.model === "k3-256k");
  ok("透传也记录 routeStatus（tier=null）", mod.routeStatus.get("S9")?.tier === null);
}

// 4.8 无方案且无全局默认 → 报错（不静默）
{
  const ctx = makeCtx({ providers: [] });
  const adapter = applyWith(ctx, { schema: 2, activeId: null, schemes: [] });
  let threw = false;
  try {
    await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [] }));
  } catch { threw = true; }
  ok("无可用模型 → 抛错", threw);
}

// 4.9 decideTier / resolveTierTarget 决策矩阵
{
  const cfg = { tiers: SCHEME.tiers, routing: { auxiliary: ["session-title", "compaction"], subagents: "light", subagentDepthStrong: 3, escalateOnChars: 40000 } };
  ok("aux purpose → light", mod.decideTier(cfg, { purpose: "compaction" }) === "light");
  ok("普通 → default", mod.decideTier(cfg, { messages: [{ role: "user", content: "hi" }] }) === "default");
  ok("subagent 关闭时 → default", mod.decideTier({ ...cfg, routing: { ...cfg.routing, subagents: "off" } }, {}, { session: { meta: { origin: "subagent", delegationDepth: 1 } } }) === "default");
  const t = mod.resolveTierTarget(SCHEME.tiers, "strong");
  ok("resolveTierTarget 命中并带 tier 名", t.model === "glm-5.3" && t.tier === "strong");
  ok("resolveTierTarget 全空 → null", mod.resolveTierTarget({}, "default") === null);
  ok("不完整档位被跳过", mod.resolveTierTarget({ default: { provider: "a" }, light: { provider: "b", model: "y" } }, "default").model === "y");
}

// 4.10 推理强度转发：目标声明支持才转发（UNSUPPORTED_REASONING_EFFORT 回归）
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS }); // resolveModelInfo 声明 efforts: ["high"]
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [], reasoningEffort: "high" }));
  ok("目标支持 → 转发选择器推理等级", ctx.lastStreamOptions.reasoningEffort === "high");
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [], reasoningEffort: "low" }));
  ok("目标不支持 → 丢弃不转发", !("reasoningEffort" in ctx.lastStreamOptions));
}

// ── 5. 全局默认模型回退守卫 ───────────────────────────────────────────

console.log("\n== 5. 默认模型回退守卫 ==");
async function runGuard(ctx, payload, inner) {
  const [fn] = ctx._listeners.get("agent/request");
  const cbs = [fn];
  const next = () => (cbs.shift() ?? inner)(payload, next);
  return next();
}
{
  // 先在请求链上观察到真实默认 → 记录；之后被写成分档方案 → 守卫恢复
  const real = { provider: "deepseek-official", model: "deepseek-v4-flash" };
  const ctx = makeCtx({ providers: ALL_PROVIDERS, defaultSelection: real });
  mod.apply(ctx, {});
  await runGuard(ctx, { agent: {} }, () => ({}));
  ok("观察真实默认时不写回", ctx._defaultModel._saved.length === 0);
  // 模拟 selectModel 把默认写成虚拟 provider
  ctx._defaultModel._sel = { provider: "model-tier", model: "s1" };
  const resolved = { provider: "model-tier", model: "s1" };
  const out = await runGuard(ctx, { agent: {} }, () => resolved);
  ok("守卫回退全局默认", ctx._defaultModel._saved.length === 1 && ctx._defaultModel._saved[0] === real);
  ok("守卫不改写请求本身", out === resolved);
}
{
  // 竞态回归：启动时采样已移除 —— 从未在请求链上观察到真实选择时，
  // 守卫不得把启动窗口读到的组合默认值写回 settings
  const ctx = makeCtx({ providers: ALL_PROVIDERS, defaultSelection: { provider: "model-tier", model: "s1" } });
  mod.apply(ctx, {});
  await runGuard(ctx, { agent: {} }, () => ({}));
  ok("无真实选择样本 → 守卫不写回", ctx._defaultModel._saved.length === 0);
}
{
  // 默认是真实模型 → 只更新记忆，不写回
  const real = { provider: "kimi-code", model: "k3-256k" };
  const ctx = makeCtx({ providers: ALL_PROVIDERS, defaultSelection: real });
  mod.apply(ctx, {});
  await runGuard(ctx, { agent: {} }, () => ({}));
  ok("真实默认不写回", ctx._defaultModel._saved.length === 0);
}

// ── 6. 配置文件覆盖工具 ───────────────────────────────────────────────

console.log("\n== 6. 配置文件覆盖工具 ==");

// 6.1 overlayConfig 语义：逐键覆盖、null 删档、未知键忽略
{
  const base = { tiers: { strong: { provider: "a", model: "x" }, light: { provider: "b", model: "y" } }, routing: { subagents: "light" } };
  const out = mod.overlayConfig(base, { tiers: { strong: { provider: "c", model: "z" }, light: null, bogus: { provider: "d", model: "w" } }, routing: { escalateOnChars: 1000 }, enabled: false });
  ok("覆盖 strong 档", out.tiers.strong.provider === "c" && out.tiers.strong.model === "z");
  ok("null 删除 light 档", !("light" in out.tiers));
  ok("未知档位键被忽略", !("bogus" in out.tiers));
  ok("routing 合并", out.routing.subagents === "light" && out.routing.escalateOnChars === 1000);
  ok("enabled 覆盖", out.enabled === false);
  ok("无 overlay 原样返回", mod.overlayConfig(base, null) === base);
}

// 6.2 normalizeFileConfig：schema 2 多方案
{
  const file = {
    schema: 2,
    enabled: true,
    activeId: "s1",
    schemes: [
      { id: "s1", name: "A", tiers: { light: { provider: "p1", model: "m1" } }, routing: { subagentDepthStrong: 5 } },
      { id: "s2", name: "B", tiers: { light: { provider: "p2", model: "m2" } } },
    ],
  };
  const flat = mod.normalizeFileConfig(file);
  ok("schema2: 取 activeId 方案", flat.tiers.light.provider === "p1" && flat.routing.subagentDepthStrong === 5);
  ok("schema2: activeId=null → 无档位覆盖", mod.normalizeFileConfig({ ...file, activeId: null }).tiers === undefined);
  ok("schema2: activeId 未命中 → 无档位覆盖", mod.normalizeFileConfig({ ...file, activeId: "nope" }).tiers === undefined);
  ok("schema2: enabled 透传", mod.normalizeFileConfig({ ...file, enabled: false, activeId: null }).enabled === false);
  ok("schema2: 无方案且无 enabled → null", mod.normalizeFileConfig({ schema: 2, schemes: [] }) === null);
  const legacy = { tiers: { light: { provider: "p9", model: "m9" } } };
  ok("旧版扁平配置原样使用", mod.normalizeFileConfig(legacy) === legacy);
}

// ── 7. LLM 前置分类器（routing.classify）──────────────────────────────

console.log("\n== 7. LLM 前置分类器 ==");

const SCHEME_CLASSIFY = { ...SCHEME, routing: { ...SCHEME.routing, classify: true } };

// 7.1 主对话分类 strong → 强档；分类器默认用执行档模型
{
  mod.routeStatus.clear();
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "strong" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S1", messages: [{ role: "user", content: "设计一个分布式事务方案" }] }));
  ok("分类 strong → 强档", ctx.lastStreamOptions.model === "glm-5.3");
  ok("分类器默认走执行档", ctx._classifyTarget?.provider === "opencode-go" && ctx._classifyTarget?.model === "minimax-m2.7");
  ok("分类 content 为块数组（pi-ai 数组断言回归）",
    Array.isArray(ctx._classifyContent) && ctx._classifyContent[0]?.type === "text" && ctx._classifyContent[0].text.includes("设计一个分布式事务方案"));
  ok("分类 maxTokens 默认 512（thinking 吃额度回归）", ctx._classifyMaxTokens === 512);
  ok("routeStatus via=classify", mod.routeStatus.get("S1")?.via === "classify");
}

// 7.2 分类 light → 弱档；同一提问第二次调用命中缓存
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "light" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  const msgs = [{ role: "user", content: "跑一下 npm test 并告诉我结果" }];
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S2", messages: msgs }));
  ok("分类 light → 弱档", ctx.lastStreamOptions.model === "minimax-m2.7");
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S2", messages: msgs }));
  ok("同一提问只分类一次", ctx._classifyCalls === 1);
}

// 7.3 分类器乱答 → 回落结构档位
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "我不知道" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S3", messages: [{ role: "user", content: "hi" }] }));
  ok("乱答 → 回落结构档位（主力）", ctx.lastStreamOptions.model === "deepseek-v4-flash" && ctx._classifyCalls === 1);
}

// 7.4 子任务：分类覆盖结构档位（light → strong）
{
  const agents = new Map([["C1", { session: { meta: { origin: "subagent", delegationDepth: 1 } } }]]);
  const ctx = makeCtx({ providers: ALL_PROVIDERS, agents, classifyReply: "strong" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "C1", messages: [{ role: "user", content: "分析这个竞态条件的根因" }] }));
  ok("子任务分类 strong 覆盖 light", ctx.lastStreamOptions.model === "glm-5.3");
}

// 7.5 辅助请求（purpose）跳过分类器
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "strong" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S4", purpose: "session-title", messages: [{ role: "user", content: "hi" }] }));
  ok("辅助请求跳过分类器", ctx._classifyCalls === undefined && ctx.lastStreamOptions.model === "minimax-m2.7");
}

// 7.6 显式指定分类模型 + 工具函数
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "default" });
  const scheme = { ...SCHEME_CLASSIFY, routing: { ...SCHEME_CLASSIFY.routing, classify: { provider: "kimi-code", model: "k3-256k", timeoutMs: 5000, maxChars: 1000 } } };
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [scheme] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S5", messages: [{ role: "user", content: "写个 hello world" }] }));
  ok("显式分类目标生效", ctx._classifyTarget?.provider === "kimi-code" && ctx._classifyTarget?.model === "k3-256k");
  ok("分类 default → 主力档", ctx.lastStreamOptions.model === "deepseek-v4-flash");
  ok("normalizeClassify: true → {}", JSON.stringify(mod.normalizeClassify(true)) === "{}");
  ok("normalizeClassify: null/false/{enabled:false} → undefined",
    mod.normalizeClassify(null) === undefined && mod.normalizeClassify(false) === undefined && mod.normalizeClassify({ enabled: false }) === undefined);
  ok("parseClassifyVerdict 解析", mod.parseClassifyVerdict("Strong.") === "strong" && mod.parseClassifyVerdict("废话") === null);
}

// 7.7 结构规则已升强 → 跳过分类器
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "light" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S6", messages: [{ role: "user", content: "x".repeat(50000) }] }));
  ok("结构升强优先，不分类", ctx._classifyCalls === undefined && ctx.lastStreamOptions.model === "glm-5.3");
}

// 7.8 纯 system-reminder 的末尾 user 消息不参与分类与升强（harness 注入回归）
{
  const reminder = "<system-reminder>" + "技能目录".repeat(500) + "</system-reminder>";
  const ctx = makeCtx({ providers: ALL_PROVIDERS, classifyReply: "strong" });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME_CLASSIFY] });
  await drain(adapter.stream({
    provider: "model-tier", model: "s1", sessionId: "S7",
    messages: [{ role: "user", content: "评估一下这两个架构的取舍" }, { role: "user", content: reminder }],
  }));
  ok("分类器拿到真实提问而非注入提醒",
    ctx._classifyPrompt?.includes("评估一下这两个架构的取舍") && !ctx._classifyPrompt?.includes("技能目录"));

  const ctx2 = makeCtx({ providers: ALL_PROVIDERS });
  const scheme = { id: "s3", name: "C", tiers: SCHEME.tiers, routing: { escalateOnChars: 100 } };
  const adapter2 = applyWith(ctx2, { schema: 2, activeId: "s3", schemes: [scheme] });
  await drain(adapter2.stream({
    provider: "model-tier", model: "s3", sessionId: "S8",
    messages: [{ role: "user", content: "hi" }, { role: "user", content: reminder }],
  }));
  ok("纯提醒消息不触发超长升强", ctx2.lastStreamOptions.model === "deepseek-v4-flash");
  await drain(adapter2.stream({
    provider: "model-tier", model: "s3", sessionId: "S8",
    messages: [{ role: "user", content: "长".repeat(200) + reminder }],
  }));
  ok("真实文本超长仍升强", ctx2.lastStreamOptions.model === "glm-5.3");
}

// 7.9 thinking 回传：目标 400（reasoning_content）→ 补占位推理块透明重试一次
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  let calls = 0;
  ctx.llm.stream = (options) => {
    calls++;
    if (calls === 1) {
      return (async function* () {
        yield { type: "finish", reason: { kind: "error", failure: { message: "The `reasoning_content` in the thinking mode must be passed back to the API.", code: "INVALID_REQUEST" } } };
      })();
    }
    ctx.lastStreamOptions = options;
    return (async function* () { yield CHUNK_OK; })();
  };
  const history = [
    { role: "user", content: [{ type: "text", text: "帮我跑下测试" }] },
    { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "bash", arguments: "{}" }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "ok" }] }] },
  ];
  const chunks = await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S10", messages: history }));
  ok("reasoning_content 400 → 自动重试成功", calls === 2 && chunks.length === 1);
  const retried = ctx.lastStreamOptions.messages;
  ok("重试给无推理的工具调用消息补占位块",
    retried[1].content[0]?.type === "reasoning" && retried[1].content.some((b) => b.type === "tool-call"));
  ok("其余消息原样（同引用）", retried[0] === history[0] && retried[2] === history[2]);
}

// 7.10 非 passback 错误不重试、原样透传
{
  const ctx = makeCtx({ providers: ALL_PROVIDERS });
  const adapter = applyWith(ctx, { schema: 2, activeId: "s1", schemes: [SCHEME] });
  let calls = 0;
  ctx.llm.stream = () => {
    calls++;
    return (async function* () {
      yield { type: "finish", reason: { kind: "error", failure: { message: "quota exceeded", code: "QUOTA_EXCEEDED" } } };
    })();
  };
  const chunks = await drain(adapter.stream({ provider: "model-tier", model: "s1", sessionId: "S11", messages: [{ role: "user", content: "hi" }] }));
  ok("其它错误不重试", calls === 1 && chunks[0]?.reason?.failure?.code === "QUOTA_EXCEEDED");
}

// 7.11 withPlaceholderReasoning 单元语义
{
  const withReasoning = { role: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "tool-call", id: "t", name: "n", arguments: "{}" }] };
  const noTool = { role: "assistant", content: [{ type: "text", text: "回答" }] };
  const out = mod.withPlaceholderReasoning([withReasoning, noTool]);
  ok("已有推理或无工具调用的消息不动", out[0] === withReasoning && out[1] === noTool);
}

// ── 汇总 ───────────────────────────────────────────────────────────────

console.log(`\n${passed} 通过, ${failures} 失败`);
process.exitCode = failures > 0 ? 1 : 0;
