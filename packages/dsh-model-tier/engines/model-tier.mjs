// dsh-model-tier —— 模型分档路由引擎（按任务难易度自动分档，跨 provider）
//
// 形态：注册一个**虚拟 provider**「智能分档」（id = "model-tier"），每个分档方案
//   是它下面的一个"模型"。用户在会话模型选择器里选中「智能分档 / 某方案」后，
//   该会话的所有模型调用都经本适配器 stream() 按规则路由到真实 provider/model：
//     辅助请求（purpose = session-title / compaction）        → 执行（弱 light）
//     超长输入（最近用户消息 ≥ escalateOnChars，可选）        → 深思（强 strong）
//     深链子任务（delegationDepth ≥ subagentDepthStrong）     → 深思（强 strong）
//     子任务（subagents = "light"）                           → 执行（弱 light）
//     其余（主对话）                                          → 主力（default）
//   可选 LLM 前置分类器（routing.classify）：每次用户提问/子任务派发前用小模型
//   分类 light/default/strong 覆盖结构档位（结构升强与辅助请求除外），按
//   (sessionId, 消息哈希) 缓存，失败/超时回落结构档位。
//   未选中「智能分档」的会话完全不受影响（无全局路由）；选中档位的目标 provider
//   未配置时按 default→light→strong 次序回落，再不行回落全局默认模型。
//
// 语义边界（与设置页一致）：
//   - 多方案 = 多套预设；会话选择器里的方案 id 决定该会话用哪套；
//     文件里的 activeId 仅作"方案 id 失效（被删等）时的回落方案"。
//   - 仅当前会话生效：session.selectModel 会把选择写成全局默认模型（平台固有
//     副作用），本引擎用 agent/request 监听做 best-effort 回退（见 guardDefaultModel）。
//
// 分发形式：独立 bundle（dsh.bundle.patch = ./cordis.patch.yml），既可被
//   dsh-science 作为依赖携带，也可在任何 profile 单独 `dsh plugin add dsh-model-tier`。
//
// 挂载位置：HOST 平面（profile bundle 的 cordis.patch.yml），不是 agent preset ——
//   虚拟 provider 必须注册进进程级 llm 适配器注册表，agent preset 的按 agent
//   隔离平面装不下。
//
// 配置文件（设置页「智能分档」写入）：
//   $DSH_HOME/model-tier.json（默认 ~/.dsh/model-tier.json，config.configFile 可覆盖）。
//   schema 2 多方案：{ schema:2, enabled?, activeId, schemes:[{id,name,tiers,routing}] }；
//   旧版扁平 { enabled?, tiers?, routing? } 视为 id="legacy" 的单方案；
//   无文件时以 cordis.patch.yml 的 config 为 id="bundle" 的默认方案（tiers 为空则无方案）。
//   按 mtime 缓存、改动即热生效（无需重启）。

import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const name = "dsh-model-tier";
export const inject = ["llm"];

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 虚拟 provider id（会话模型选择器里的「智能分档」组）。 */
export const VIRTUAL_PROVIDER = "model-tier";
const PROVIDER_NAME = "智能分档";
const BUNDLE_SCHEME_ID = "bundle";
const LEGACY_SCHEME_ID = "legacy";

const DEFAULT_AUXILIARY_PURPOSES = ["session-title", "compaction"];
// 档位未配置时的回落次序
const TIER_FALLBACK = {
  strong: ["strong", "default", "light"],
  light: ["light", "default", "strong"],
  default: ["default", "light", "strong"],
};

// ── 路由状态（供 model-tier-ui 的 route-status 读取；同进程同模块实例）──────

/** sessionId → { schemeId, schemeName, provider, model, tier, at }（最近一次路由）。 */
export const routeStatus = new Map();

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 规整 routing.classify（LLM 前置分类器）：
 * true → {}（全默认）；对象 → { provider?, model?, timeoutMs?, maxChars? }；
 * 缺省 / false / null / { enabled:false } → undefined（不启用）。
 */
export function normalizeClassify(v) {
  if (!v) return undefined;
  const o = v === true ? {} : typeof v === "object" ? v : undefined;
  if (!o || o.enabled === false) return undefined;
  const out = {};
  if (typeof o.provider === "string" && o.provider && typeof o.model === "string" && o.model) {
    out.provider = o.provider;
    out.model = o.model;
  }
  if (Number(o.timeoutMs) > 0) out.timeoutMs = Math.floor(Number(o.timeoutMs));
  if (Number(o.maxChars) > 0) out.maxChars = Math.floor(Number(o.maxChars));
  if (Number(o.maxTokens) > 0) out.maxTokens = Math.floor(Number(o.maxTokens));
  return out;
}

function mergeConfig(config) {
  const routing = {
    auxiliary: DEFAULT_AUXILIARY_PURPOSES,
    subagents: "light",
    subagentDepthStrong: null,
    escalateOnChars: null,
    ...(config?.routing ?? {}),
  };
  return {
    enabled: config?.enabled !== false,
    tiers: config?.tiers && typeof config.tiers === "object" ? config.tiers : {},
    routing: {
      ...routing,
      auxiliary: Array.isArray(routing.auxiliary)
        ? routing.auxiliary.map(String)
        : DEFAULT_AUXILIARY_PURPOSES,
      classify: normalizeClassify(routing.classify),
    },
  };
}

// ── 配置文件（$DSH_HOME/model-tier.json，设置页「智能分档」写入）────────────

/** 默认配置文件路径：$DSH_HOME/model-tier.json（未设 DSH_HOME 时 ~/.dsh）。 */
export function defaultConfigFile() {
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "model-tier.json");
}

/**
 * 把文件配置叠加到 yaml config 上（文件优先）。overlay 形如
 * { enabled?, tiers?, routing? }；tiers 只认 strong/default/light 三键，
 * 值为 null 表示删除该档（覆盖 yaml 里的同名片段）。
 */
export function overlayConfig(base, overlay) {
  if (!overlay || typeof overlay !== "object") return base;
  const out = { ...(base ?? {}) };
  if (typeof overlay.enabled === "boolean") out.enabled = overlay.enabled;
  if (overlay.tiers && typeof overlay.tiers === "object") {
    const tiers = { ...(base?.tiers ?? {}) };
    for (const k of ["strong", "default", "light"]) {
      if (!(k in overlay.tiers)) continue;
      const v = overlay.tiers[k];
      if (v === null) delete tiers[k];
      else if (v && typeof v === "object") tiers[k] = v;
    }
    out.tiers = tiers;
  }
  if (overlay.routing && typeof overlay.routing === "object") {
    out.routing = { ...(base?.routing ?? {}), ...overlay.routing };
  }
  return out;
}

/** 读配置文件；不存在/解析失败返回 null（视为无覆盖）。 */
export function readFileConfig(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 规整文件配置为扁平覆盖形态 { enabled?, tiers?, routing? }：
 * - schema 2（设置页多方案）：取 activeId 指向的方案；activeId 为 null 或无命中
 *   → 无档位覆盖（仅 enabled 透传），回落 yaml 配置；
 * - 旧版扁平 {tiers, routing}（schema 缺省）：原样使用。
 * （设置页 viewOf 展示「生效配置」用；路由本身按会话选中的方案进行。）
 */
export function normalizeFileConfig(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.schema === 2) {
    const out = {};
    if (typeof parsed.enabled === "boolean") out.enabled = parsed.enabled;
    const schemes = Array.isArray(parsed.schemes) ? parsed.schemes : [];
    const active = parsed.activeId == null ? undefined : schemes.find((s) => s && s.id === parsed.activeId);
    if (active) {
      if (active.tiers && typeof active.tiers === "object") out.tiers = active.tiers;
      if (active.routing && typeof active.routing === "object") out.routing = active.routing;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return parsed;
}

/**
 * 把文件配置规整为方案仓库 { enabled, activeId, schemes[] }：
 * - schema 2：原样（过滤非法方案）；
 * - 旧版扁平 → id="legacy" 的单方案并保持生效；
 * - 无文件 → 以 yaml config 为 id="bundle" 的默认方案（tiers 为空则无方案）。
 */
export function schemeStoreFrom(parsed, yamlConfig) {
  if (parsed?.schema === 2 && Array.isArray(parsed.schemes)) {
    return {
      enabled: parsed.enabled !== false,
      activeId: parsed.activeId ?? null,
      schemes: parsed.schemes.filter((s) => s && typeof s === "object" && typeof s.id === "string"),
    };
  }
  if (parsed && (parsed.tiers || parsed.routing)) {
    return {
      enabled: parsed.enabled !== false,
      activeId: LEGACY_SCHEME_ID,
      schemes: [{
        id: LEGACY_SCHEME_ID,
        name: "迁移的旧配置",
        tiers: parsed.tiers ?? {},
        routing: parsed.routing ?? {},
      }],
    };
  }
  const yaml = mergeConfig(yamlConfig);
  if (Object.keys(yaml.tiers).length > 0) {
    return {
      enabled: yaml.enabled,
      activeId: BUNDLE_SCHEME_ID,
      schemes: [{ id: BUNDLE_SCHEME_ID, name: "默认（bundle 配置）", tiers: yaml.tiers, routing: yaml.routing }],
    };
  }
  return { enabled: yaml.enabled, activeId: null, schemes: [] };
}

/** 按 mtime 缓存的方案仓库读取器：文件不变不重复读盘，改动即热生效。 */
export function makeSchemeStoreSource(file, yamlConfig) {
  let cache = { mtimeMs: -2, data: null };
  return () => {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      /* 文件不存在 */
    }
    if (mtimeMs === cache.mtimeMs) return cache.data;
    const parsed = mtimeMs >= 0 ? readFileConfig(file) : null;
    const data = schemeStoreFrom(parsed, yamlConfig);
    cache = { mtimeMs, data };
    return data;
  };
}

// ── 路由决策（导出以便单测） ────────────────────────────────────────────────

/** harness 注入的用户角色系统提醒（技能目录等），不参与计量与分类。 */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * 最近一条真实 user 消息的文本（失败返回 ""）。
 * 剥离 <system-reminder> 段；整条都是提醒的 user 消息直接跳过、继续往上找
 * —— 否则 harness 注入的技能目录（~1800 字符）会被当成用户输入，导致
 * escalateOnChars 无条件升强、分类器对着目录分类（实测误报）。
 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    const raw =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
          : "";
    const text = raw.replace(SYSTEM_REMINDER_RE, "").trim();
    // raw 本身为空 = 真实用户消息但无文本（如纯图片），就此打住；
    // raw 非空但剥离后为空 = 纯注入提醒，继续找上一条。
    if (text || !raw.trim()) return text;
  }
  return "";
}

/** 最近一条 user 消息的文本总长（escalateOnChars 启发式；失败返回 0）。 */
function lastUserChars(messages) {
  return lastUserText(messages).length;
}

/**
 * 单次模型调用的档位决策。cfg 为方案合并配置（mergeConfig 输出），
 * options 为 GenerateOptions（purpose / messages / sessionId），agent 为
 * 该会话的 agent（可缺省）。
 * @returns {"strong"|"default"|"light"}
 */
export function decideTier(cfg, options, agent) {
  const routing = cfg?.routing ?? {};
  // 1) 辅助请求（会话标题 / 压缩）→ 轻档
  if (options?.purpose && routing.auxiliary.includes(options.purpose)) return "light";
  // 2) 超长输入 → 强档（可选启发式，所有 agent）
  if (routing.escalateOnChars && lastUserChars(options?.messages) >= Number(routing.escalateOnChars)) {
    return "strong";
  }
  // 3) 子任务
  const meta = agent?.session?.meta;
  if (meta?.origin === "subagent") {
    const depth = meta.delegationDepth ?? 1;
    if (routing.subagentDepthStrong && depth >= Number(routing.subagentDepthStrong)) return "strong";
    if (routing.subagents === "light") return "light";
  }
  // 4) 主对话 → 主力档
  return "default";
}

/**
 * 按期望档位取目标 { provider, model, reasoningEffort?, tier }；
 * 该档未配置（缺 provider/model）时按 TIER_FALLBACK 次序回落；全无 → null。
 */
export function resolveTierTarget(tiers, wanted) {
  for (const k of TIER_FALLBACK[wanted] ?? TIER_FALLBACK.default) {
    const t = tiers?.[k];
    if (t && typeof t === "object" && typeof t.provider === "string" && t.provider &&
        typeof t.model === "string" && t.model) {
      return { ...t, tier: k };
    }
  }
  return null;
}

// ── LLM 前置分类器（routing.classify）──────────────────────────────────────
//
// 每次用户提问（主对话新消息）/ 子任务派发前，用一个小模型把任务分类为
// light / default / strong，按分类档位派发。按 (sessionId, 消息哈希) 缓存：
// 同一 turn 的后续步骤复用结果，不重复分类。失败 / 超时 / 乱答 → null，
// 回落结构档位（decideTier）。分类器目标缺省用执行（弱）档。

const CLASSIFY_DEFAULT_TIMEOUT_MS = 10000;
const CLASSIFY_DEFAULT_MAX_CHARS = 4000;
// maxTokens 要留足：thinking 模型的推理内容也吃输出额度，16 会被思考
// 吃光导致正文为空（实测 deepseek thinking：content:""、reasoning_tokens:16）。
// 仍建议分类目标选非 thinking 模型。
const CLASSIFY_DEFAULT_MAX_TOKENS = 512;
const CLASSIFY_CACHE_MAX = 200;

const CLASSIFY_PROMPT = (task) => [
  "你是任务复杂度分类器。判断下面的任务适合哪种档位的模型处理，只回复三个词之一：",
  "- light：简单执行——运行命令、取返回值、流程执行与监控、机械改写、格式转换",
  "- default：常规开发与问答——普通编码、概念解释、总结、一般性问题",
  "- strong：复杂决策与深度思考——架构设计、多因素权衡、疑难排查、需要理解全局关系的分析推理",
  "只输出 light、default 或 strong 一个词，不要任何其他内容。",
  "",
  "任务：",
  task,
].join("\n");

/** 从分类器输出里解析档位；无法识别 → null。 */
export function parseClassifyVerdict(text) {
  const m = String(text ?? "").match(/\b(strong|default|light)\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** 短文本的稳定散列（缓存键用，非加密）。 */
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── thinking 回传兼容（reasoning_content passback）──────────────────────────
//
// DeepSeek 等 thinking 模式的 API 要求：历史里带 tool_calls 的助手消息必须回传
// reasoning_content，否则 400 INVALID_REQUEST。分档按消息换目标后，历史里可能
// 夹着其它档位（非 thinking / 无推理捕获）产生的工具调用消息，DeepSeek 适配器
// 序列化时给不出 reasoning_content（dsh-llm-deepseek 仅在 tool-call + reasoning
// 块同时存在时回传）。这里在探测到该错误后给这类消息补占位 reasoning 块、透明
// 重试一次 —— 只在首块内容发出前的立即失败时触发，绝不重放已产出的内容。

const REASONING_PASSBACK_RE = /reasoning_content/i;
const CONTENT_CHUNK_TYPES = new Set(["block-start", "text-delta", "reasoning-delta", "tool-call-delta", "block-end"]);

function isReasoningPassbackError(value) {
  return REASONING_PASSBACK_RE.test(String(value?.message ?? value ?? ""));
}

/** 给「有 tool-call 但无 reasoning 块」的助手消息补一个占位推理块（其余消息原样）。 */
export function withPlaceholderReasoning(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
    const hasToolCall = m.content.some((b) => b?.type === "tool-call");
    const hasReasoning = m.content.some((b) => b?.type === "reasoning");
    if (!hasToolCall || hasReasoning) return m;
    return { ...m, content: [{ type: "reasoning", text: "（历史消息，无推理记录）" }, ...m.content] };
  });
}

/** 派发真实调用；若因 reasoning_content 未回传被立即拒绝，补占位块重试一次。 */
async function* dispatchWithPassbackRetry(ctx, options) {
  const retry = () => {
    ctx.logger?.warn?.(
      `[dsh-model-tier] 目标要求 reasoning_content 回传，已为无推理记录的工具调用消息补占位块并重试（${options.provider}/${options.model}）`
    );
    return ctx.llm.stream({ ...options, messages: withPlaceholderReasoning(options.messages) });
  };
  let source;
  try {
    source = ctx.llm.stream(options);
  } catch (e) {
    if (isReasoningPassbackError(e)) {
      yield* retry();
      return;
    }
    throw e;
  }
  const it = source[Symbol.asyncIterator]();
  const pending = [];
  let passbackFailed = false;
  try {
    // 预读：usage 等非内容块先缓冲；见到首个内容块即转入正常转发；直接终结
    // 且是 passback 错误 → 吞掉走重试（其它错误原样转发）。
    while (true) {
      const { value: chunk, done } = await it.next();
      if (done) break;
      if (CONTENT_CHUNK_TYPES.has(chunk?.type)) {
        pending.push(chunk);
        break;
      }
      if (chunk?.type === "finish") {
        if (chunk.reason?.kind === "error" && isReasoningPassbackError(chunk.reason.failure)) passbackFailed = true;
        else pending.push(chunk);
        break;
      }
      pending.push(chunk);
    }
  } catch (e) {
    if (isReasoningPassbackError(e)) passbackFailed = true;
    else throw e;
  }
  if (passbackFailed) {
    try {
      await it.return?.();
    } catch {
      /* 忽略 */
    }
    yield* retry();
    return;
  }
  for (const c of pending) yield c;
  while (true) {
    const { value, done } = await it.next();
    if (done) break;
    yield value;
  }
}

// ── 虚拟 provider 适配器 ────────────────────────────────────────────────────

function makeVirtualAdapter(ctx, storeOf) {
  const schemeOf = (schemeId) => {
    const store = storeOf();
    const scheme =
      store.schemes.find((s) => s.id === schemeId) ??
      store.schemes.find((s) => s.id === store.activeId) ??
      null;
    return { store, scheme };
  };

  // 透传兜底：全局默认模型 → 任一已注册真实 provider 的首个模型
  const fallbackTarget = async () => {
    try {
      const adm = ctx.get ? ctx.get("agentDefaultModel") : ctx.agentDefaultModel;
      const sel = adm?.currentSelection?.();
      if (sel?.provider && sel?.model && sel.provider !== VIRTUAL_PROVIDER) {
        return { provider: sel.provider, model: sel.model };
      }
    } catch {
      /* 服务不可用 */
    }
    for (const p of ctx.llm?.listProviders?.() ?? []) {
      const id = p && (p.id ?? p.provider);
      if (!id || id === VIRTUAL_PROVIDER) continue;
      try {
        const models = await ctx.llm.listModels(id);
        if (models[0]?.id) return { provider: id, model: models[0].id };
      } catch {
        /* 该 provider 暂不可枚举 */
      }
    }
    return null;
  };

  // LLM 前置分类器：key = sessionId#消息哈希 → 进行中的 Promise（落定后
  // Promise.resolve(命中) 对普通值与 Promise  alike 有效，无需替换缓存项）。
  const classifyCache = new Map();
  const classifyTier = (cfg, sessionId, taskText) => {
    const c = cfg.routing.classify;
    if (!c || !taskText) return Promise.resolve(null);
    // 分类器目标：显式 provider/model > 执行（弱）档（按其回落次序）
    const target =
      c.provider && c.model
        ? { provider: c.provider, model: c.model }
        : resolveTierTarget(cfg.tiers, "light");
    if (!target) return Promise.resolve(null);
    const key = `${sessionId ?? ""}#${taskText.length}:${hashText(taskText)}`;
    const hit = classifyCache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const timeoutMs = c.timeoutMs ?? CLASSIFY_DEFAULT_TIMEOUT_MS;
    const maxChars = c.maxChars ?? CLASSIFY_DEFAULT_MAX_CHARS;
    const maxTokens = c.maxTokens ?? CLASSIFY_DEFAULT_MAX_TOKENS;
    const run = (async () => {
      let out = "";
      const iter = ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        // content 必须是块数组：pi-ai 等适配器对 content 做数组断言，
        // 纯字符串会被拒绝（content.some is not a function）
        messages: [{ role: "user", content: [{ type: "text", text: CLASSIFY_PROMPT(taskText.slice(0, maxChars)) }] }],
        maxTokens,
        temperature: 0,
      });
      try {
        for await (const chunk of iter) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
          if (out.length > 64) break; // 只要一个词，多了直接截断
        }
      } finally {
        try {
          await iter.return?.();
        } catch {
          /* 忽略 */
        }
      }
      return parseClassifyVerdict(out);
    })();
    // 超时 / 异常 → null（回落结构档位）；null 也缓存：分类器故障时
    // 避免同一 turn 的每一步都白等一次超时。
    const timed = Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]).catch(() => null);
    classifyCache.set(key, timed);
    void timed.then(() => {
      if (classifyCache.size > CLASSIFY_CACHE_MAX) {
        classifyCache.delete(classifyCache.keys().next().value);
      }
    });
    return timed;
  };

  return {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME };
    },
    providerRetryPolicy() {
      return undefined;
    },
    async listModels() {
      const store = storeOf();
      if (!store.enabled) return [];
      // provider 必须回填且等于本虚拟 provider id：宿主 dsh-llm 校验目录元数据
      // （INVALID_CATALOG：provider 缺失/不符、id/name 为空或重复会整体判失败），
      // 因此这里同时过滤空 id、按 id 去重、name 空串回落 id。
      // inputModalities 含 image：否则含图片的会话会被 selectModel 的准入检查拒掉
      const seen = new Set();
      return store.schemes
        .filter((s) => typeof s.id === "string" && s.id.length > 0 && !seen.has(s.id) && seen.add(s.id))
        .map((s) => ({
          provider: VIRTUAL_PROVIDER,
          id: s.id,
          name: (typeof s.name === "string" && s.name) || s.id,
          inputModalities: ["text", "image"],
        }));
    },
    async resolveModel(provider, schemeId) {
      const { scheme } = schemeOf(schemeId);
      const target = scheme ? resolveTierTarget(scheme.tiers ?? {}, "default") : null;
      if (target) {
        try {
          const info = await ctx.llm.resolveModelInfo(target.provider, target.model);
          if (info && typeof info === "object") {
            return {
              ...info,
              // 宿主校验：provider/id 必须与请求一致（dsh-llm INVALID_MODEL_INFO）
              provider,
              id: schemeId,
              name: scheme.name ?? schemeId,
              inputModalities: info.inputModalities ?? ["text", "image"],
            };
          }
        } catch {
          /* 委托失败走通用回落 */
        }
      }
      return { provider, id: schemeId, name: scheme?.name ?? schemeId, inputModalities: ["text", "image"] };
    },
    async *stream(options) {
      const { store, scheme } = schemeOf(options?.model);
      let target = null;
      let via = "structural";
      if (store.enabled && scheme) {
        const cfg = mergeConfig({ enabled: store.enabled, tiers: scheme.tiers, routing: scheme.routing });
        let agent;
        try {
          agent = options?.sessionId ? ctx.agents?.get?.(options.sessionId) : undefined;
        } catch {
          agent = undefined;
        }
        let tier = decideTier(cfg, options, agent);
        // LLM 前置分类器：辅助请求（标题/压缩）与结构规则已升强（超长输入/
        // 深链子任务）的不再分类；分类成功覆盖结构档位，失败回落结构档位。
        const auxHit = options?.purpose && cfg.routing.auxiliary.includes(options.purpose);
        if (cfg.routing.classify && tier !== "strong" && !auxHit) {
          const classified = await classifyTier(cfg, options?.sessionId, lastUserText(options?.messages));
          if (classified) {
            via = "classify";
            ctx.logger?.info?.(`[dsh-model-tier] 分类器判定 ${classified} 档（结构档位 ${tier}）`);
            tier = classified;
          }
        }
        target = resolveTierTarget(cfg.tiers, tier);
      }
      if (!target) {
        target = await fallbackTarget();
        ctx.logger?.warn?.(
          `[dsh-model-tier] 方案 ${options?.model} 无可路由档位，透传 ` +
          (target ? `${target.provider}/${target.model}` : "（无可用模型）")
        );
      }
      if (!target) {
        throw new Error("dsh-model-tier: 无可用模型（方案未配置档位且无全局默认模型）");
      }
      if (options?.sessionId) {
        routeStatus.set(String(options.sessionId), {
          schemeId: scheme?.id ?? null,
          schemeName: scheme?.name ?? null,
          provider: target.provider,
          model: target.model,
          tier: target.tier ?? null,
          via: target.tier ? via : null,
          at: new Date().toISOString(),
        });
      }
      ctx.logger?.info?.(
        `[dsh-model-tier] ${options?.purpose ?? "main"} → ${target.provider}/${target.model}` +
        (target.tier ? `（${target.tier} 档）` : "")
      );
      // 推理强度：档位显式配置的原样转发；选择器的等级仅在目标模型声明支持时
      // 转发 —— 否则宿主以 UNSUPPORTED_REASONING_EFFORT 硬失败（轻档模型通常
      // 不支持推理，标题/压缩会随之静默回退）。
      const inner = { ...(options ?? {}), provider: target.provider, model: target.model };
      let effort = target.reasoningEffort;
      if (!effort && options?.reasoningEffort) {
        try {
          const info = await ctx.llm.resolveModelInfo(target.provider, target.model);
          const efforts = info?.reasoning?.efforts;
          if (Array.isArray(efforts) && efforts.some((e) => (e?.id ?? e) === options.reasoningEffort)) {
            effort = options.reasoningEffort;
          }
        } catch {
          /* 查询失败：不转发 */
        }
      }
      if (effort) inner.reasoningEffort = effort;
      else delete inner.reasoningEffort;
      yield* dispatchWithPassbackRetry(ctx, inner);
    },
  };
}

// ── 全局默认模型回退守卫（分档仅按会话生效）─────────────────────────────────
//
// session.selectModel 会把选择持久化为全局默认模型（apiproxy 固有行为），导致
// 新建会话也默认走分档。这里在任何请求经过时检查：全局默认若是虚拟 provider，
// 立即恢复为最近记住的真实选择。best-effort：选中到下一次请求之间的窗口内新建
// 会话会继承分档（已知限制）。
function guardDefaultModel(ctx) {
  const adm = () => {
    try {
      return ctx.get ? ctx.get("agentDefaultModel") : ctx.agentDefaultModel;
    } catch {
      return undefined;
    }
  };
  // lastNonTier 只在请求链上观察到真实选择时记录 —— 不在启动时采样：
  // 启动窗口内 settings 层可能尚未挂载，currentSelection() 读到的是组合
  // 默认值，随后守卫会把这个错误值写回 settings，把同一 DSH_HOME 的后续
  // 会话整体去路由（实测竞态）。没观察到过真实选择就宁可不写回。
  let lastNonTier;
  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    try {
      const sel = adm()?.currentSelection?.();
      if (sel?.provider === VIRTUAL_PROVIDER) {
        if (lastNonTier) {
          adm().saveSelection(lastNonTier);
          ctx.logger?.info?.("[dsh-model-tier] 已回退全局默认模型（智能分档仅按会话生效）");
        }
      } else if (sel?.provider) {
        lastNonTier = sel;
      }
    } catch {
      /* best-effort，绝不影响请求链 */
    }
    return resolved;
  });
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const storeOf = makeSchemeStoreSource(config?.configFile ?? defaultConfigFile(), config);
  const handle = ctx.llm.registerAdapter([VIRTUAL_PROVIDER], makeVirtualAdapter(ctx, storeOf));
  ctx.on?.("dispose", () => {
    try {
      handle?.();
    } catch {
      /* 已释放 */
    }
  });
  guardDefaultModel(ctx);
}

export { apply };
