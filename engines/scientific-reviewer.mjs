// science-scientific-reviewer —— 独立自动评审引擎（对齐 Claude Science 的 reviewer agent）
//
// 与"主 agent 自觉发起评审"的技能流程不同，本引擎挂在 HOST 平面（profile bundle），
// 独立于任务执行流：
//   观察：ctx.on("agent/request") waterfall —— 只做 turn 边界计数与项目根定位，
//         跳过 origin==="subagent" 的会话（不评审评审者），不修改请求内容；
//   触发：磁盘快照 diff（<root>/.reviewer/state.json）—— 新工件版本 / 假设更新
//         （新 findings）/ manuscript 变更，minIntervalSec 防抖控成本；
//   评审：引擎自己只读收集论断与执行记录（experiments/<id>/design·log.md、工件
//         provenance、manuscript 段落），用 config.model 显式指定的评审模型经
//         ctx.llm.stream() 发起一次独立调用（不经会话、不经 model-tier 路由）；
//   落盘：复用 research-loop 导出的 recordReview —— reviews/Rnn/report.md +
//         manifest.reviews + history，verdict 可终结 testing 假设；
//   反馈：dashboard 与 research_* 工具结果尾部的「待处理评审」提醒；
//         gate=true 时写 <root>/.reviewer/gate 标记，research_findings 对
//         最新评审待处理的假设抛 ERR_REVIEW_GATE。
//
// 零第三方依赖（只用 node 内置模块）。config 来自 cordis.patch.yml 行级 config:，
// 用户可在 profile 里用 `- update: - id: science-scientific-reviewer` 覆盖。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";
import { recordReview } from "./research-loop.mjs";

export const name = "science-scientific-reviewer";

// 需要 llm 服务就绪后才应用（ctx.llm.stream 发起独立评审调用）
export const inject = ["llm"];

const REVIEW_VERDICTS = ["supported", "refuted", "inconclusive", "needs-work", "unverifiable"];
const DEFAULTS = {
  triggers: {
    onArtifact: true,
    onHypothesis: true,
    onManuscript: true,
    minIntervalSec: 180,
    maxClaimsPerReview: 10,
    maxContextChars: 60000,
  },
  timeoutMs: 120000,
  maxTokens: 4096,
  gate: false,
};

// ── 配置归一化 ──────────────────────────────────────────────────────────────

export function normalizeConfig(config = {}) {
  const t = config.triggers ?? {};
  const model = config.model && typeof config.model === "object" ? config.model : {};
  return {
    enabled: config.enabled !== false,
    model: {
      provider: typeof model.provider === "string" ? model.provider : null,
      model: typeof model.model === "string" ? model.model : null,
      reasoningEffort: typeof model.reasoningEffort === "string" ? model.reasoningEffort : undefined,
    },
    triggers: {
      onArtifact: t.onArtifact !== false,
      onHypothesis: t.onHypothesis !== false,
      onManuscript: t.onManuscript !== false,
      minIntervalSec: Number.isFinite(Number(t.minIntervalSec)) ? Number(t.minIntervalSec) : DEFAULTS.triggers.minIntervalSec,
      maxClaimsPerReview: Number.isFinite(Number(t.maxClaimsPerReview)) ? Number(t.maxClaimsPerReview) : DEFAULTS.triggers.maxClaimsPerReview,
      maxContextChars: Number.isFinite(Number(t.maxContextChars)) ? Number(t.maxContextChars) : DEFAULTS.triggers.maxContextChars,
    },
    timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : DEFAULTS.timeoutMs,
    maxTokens: Number.isFinite(Number(config.maxTokens)) ? Number(config.maxTokens) : DEFAULTS.maxTokens,
    gate: config.gate === true,
    markers: Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"],
  };
}

// ── 磁盘快照与触发判定 ──────────────────────────────────────────────────────

async function mtimeMs(p) {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

// 项目状态快照：manifest 假设指纹 + artifacts 索引指纹 + manuscript 最新 mtime
export async function takeSnapshot(root) {
  const manifest = await core.readJson(path.join(root, "research-manifest.json"), null);
  const artIdx = await core.readJson(path.join(root, "artifacts", "artifacts.json"), { artifacts: [] });
  let manuscriptMtime = 0;
  try {
    for (const f of await fsp.readdir(path.join(root, "manuscript"))) {
      manuscriptMtime = Math.max(manuscriptMtime, await mtimeMs(path.join(root, "manuscript", f)));
    }
  } catch {
    /* manuscript/ 不存在 */
  }
  return {
    manifestMtime: await mtimeMs(path.join(root, "research-manifest.json")),
    hypotheses: (manifest?.hypotheses ?? []).map((h) => ({ id: h.id, status: h.status, updatedAt: h.updatedAt ?? "" })),
    artifacts: (artIdx.artifacts ?? []).map((a) => ({ name: a.name, latestVersion: a.latestVersion, deprecated: !!a.deprecated })),
    manuscriptMtime,
  };
}

// 快照 diff → 触发判定。prev 为 null（首次见到项目）只建基线，不触发评审。
// 返回 { fire, reasons, changedHypotheses, changedArtifacts, manuscriptChanged }
export function detectTriggers(prev, next, lastReviewAt, cfg) {
  const out = { fire: false, reasons: [], changedHypotheses: [], changedArtifacts: [], manuscriptChanged: false };
  if (!prev) return out;
  const t = cfg.triggers;
  if (t.onHypothesis) {
    const prevH = new Map(prev.hypotheses.map((h) => [h.id, h]));
    for (const h of next.hypotheses) {
      const p = prevH.get(h.id);
      if (!p || p.updatedAt !== h.updatedAt || p.status !== h.status) out.changedHypotheses.push(h.id);
    }
  }
  if (t.onArtifact) {
    const prevA = new Map(prev.artifacts.map((a) => [a.name, a]));
    for (const a of next.artifacts) {
      const p = prevA.get(a.name);
      if (!p || p.latestVersion !== a.latestVersion) out.changedArtifacts.push(a);
    }
  }
  if (t.onManuscript && next.manuscriptMtime > 0 && next.manuscriptMtime !== prev.manuscriptMtime) {
    out.manuscriptChanged = true;
  }
  if (out.changedHypotheses.length) out.reasons.push(`假设更新（${out.changedHypotheses.join(", ")}）`);
  if (out.changedArtifacts.length) out.reasons.push(`新工件版本（${out.changedArtifacts.map((a) => `${a.name} v${a.latestVersion}`).join(", ")}）`);
  if (out.manuscriptChanged) out.reasons.push("manuscript 变更");
  const elapsed = Date.now() - (Number(lastReviewAt) || 0);
  out.fire = out.reasons.length > 0 && elapsed >= t.minIntervalSec * 1000;
  return out;
}

// ── 论断提取与执行记录收集（引擎只读读盘）────────────────────────────────────

async function readTail(p, maxChars) {
  try {
    const s = await fsp.readFile(p, "utf8");
    return s.length > maxChars ? `…（截断，仅尾部 ${maxChars} 字符）\n` + s.slice(-maxChars) : s;
  } catch {
    return "（文件不存在或不可读）";
  }
}

// 收集待审论断 + 声称的证据（执行记录）。预算：maxClaimsPerReview / maxContextChars。
export async function collectClaims(root, diff, cfg) {
  const claims = [];
  const t = cfg.triggers;
  const manifest = await core.readJson(path.join(root, "research-manifest.json"), null);
  const perRecord = Math.max(2000, Math.floor(t.maxContextChars / Math.max(1, t.maxClaimsPerReview) / 2));

  for (const hid of diff.changedHypotheses.slice(0, t.maxClaimsPerReview)) {
    const h = manifest?.hypotheses?.find((x) => x.id === hid);
    if (!h) continue;
    const records = [];
    for (const eid of (h.experiments ?? []).slice(-2)) {
      records.push(`### 实验 ${eid} design.md（尾部）\n${await readTail(path.join(root, "experiments", eid, "design.md"), perRecord)}`);
      records.push(`### 实验 ${eid} log.md（尾部）\n${await readTail(path.join(root, "experiments", eid, "log.md"), perRecord)}`);
    }
    claims.push({
      target: `假设 ${h.id}：${h.text}（当前状态 ${h.status}）`,
      hypothesis: h.id,
      experiment: (h.experiments ?? []).slice(-1)[0] ?? null,
      records: records.join("\n\n"),
    });
  }

  for (const a of diff.changedArtifacts.slice(0, Math.max(0, t.maxClaimsPerReview - claims.length))) {
    const prov = await readTail(path.join(root, "artifacts", a.name, "provenance.md"), perRecord);
    claims.push({
      target: `工件 ${a.name} v${a.latestVersion}`,
      hypothesis: null,
      experiment: null,
      records: `### 工件溯源 provenance.md（尾部）\n${prov}`,
    });
  }

  if (diff.manuscriptChanged && claims.length < t.maxClaimsPerReview) {
    try {
      const files = (await fsp.readdir(path.join(root, "manuscript"))).filter((f) => f.endsWith(".md")).slice(-3);
      for (const f of files) {
        claims.push({
          target: `manuscript/${f} 中的关键论断（含数字、p 值、引用断言的段落）`,
          hypothesis: null,
          experiment: null,
          records: `### manuscript/${f}（尾部）\n${await readTail(path.join(root, "manuscript", f), perRecord)}`,
        });
      }
    } catch {
      /* manuscript/ 不可读 */
    }
  }

  // 总预算截断
  let total = 0;
  for (const c of claims) {
    total += c.records.length;
    if (total > t.maxContextChars) c.records = c.records.slice(0, Math.max(0, c.records.length - (total - t.maxContextChars)));
  }
  return claims.slice(0, t.maxClaimsPerReview);
}

// ── 评审 prompt 与结论解析 ──────────────────────────────────────────────────

export function buildReviewPrompt(claims) {
  const body = claims
    .map((c, i) => `## 论断 ${i + 1}\n对象：${c.target}\n\n执行记录：\n${c.records || "（无可用执行记录）"}`)
    .join("\n\n");
  return [
    "你是独立的科学评审代理（Reviewer）。下面是主研究代理产出的论断与对应执行记录。",
    "请逐条核查（只读核查，不重跑分析）：",
    "a. 论断 ↔ 代码/命令是否对得上（跑的是不是声称的分析）",
    "b. 数字 ↔ 结果文件是否一致（关键数值重新核算）",
    "c. 统计方法是否恰当（多重检验校正、效应量、样本量）",
    "d. 混淆变量与替代解释是否被讨论",
    "e. 是否区分了「结果」与「推测」",
    "",
    "# 论断与执行记录",
    body,
    "",
    "# 输出要求",
    "先给逐条简短分析，然后在回复末尾输出一个 JSON 代码块，格式：",
    "```json",
    '{"reviews":[{"target":"论断简述","verdict":"supported|refuted|inconclusive|needs-work|unverifiable","summary":"一句话依据","issues":["问题1"],"hypothesis":"H1 或 null","experiment":"E01 或 null"}]}',
    "```",
    "verdict 只能取上述枚举；执行记录不足以核实的论断给 unverifiable。",
  ].join("\n");
}

// 从回复文本提取最后一个含 "reviews" 的平衡 JSON 对象
function extractReviewsJson(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse(), String(text)];
  for (const c of candidates) {
    const idx = c.lastIndexOf('"reviews"');
    if (idx < 0) continue;
    // 从 "reviews" 向前找包含它的对象起点，向后做括号配平
    let start = c.lastIndexOf("{", idx);
    while (start >= 0) {
      let depth = 0;
      for (let i = start; i < c.length; i++) {
        if (c[i] === "{") depth++;
        else if (c[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              const obj = JSON.parse(c.slice(start, i + 1));
              if (obj && Array.isArray(obj.reviews)) return obj;
            } catch {
              /* 继续找外层 */
            }
            break;
          }
        }
      }
      start = c.lastIndexOf("{", start - 1);
    }
  }
  return null;
}

// 解析评审结论 → 合法的 verdict 列表；解析失败返回 null
export function parseVerdicts(text) {
  const obj = extractReviewsJson(text);
  if (!obj) return null;
  const out = [];
  for (const r of obj.reviews) {
    if (!r || typeof r.target !== "string" || !r.target.trim()) continue;
    out.push({
      target: r.target.trim().slice(0, 200),
      verdict: REVIEW_VERDICTS.includes(r.verdict) ? r.verdict : "unverifiable",
      summary: typeof r.summary === "string" ? r.summary : "",
      issues: Array.isArray(r.issues) ? r.issues.map(String) : [],
      hypothesis: typeof r.hypothesis === "string" && /^H\d+$/.test(r.hypothesis) ? r.hypothesis : undefined,
      experiment: typeof r.experiment === "string" && /^E\d+$/.test(r.experiment) ? r.experiment : undefined,
    });
  }
  return out.length ? out : null;
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) {
    ctx.logger?.info?.("[scientific-reviewer] 已禁用（enabled: false）");
    return;
  }

  // 评审模型解析：config.model 显式指定优先；缺省回落全局默认模型（warn 一次）
  let warnedFallback = false;
  const resolveReviewModel = async () => {
    if (cfg.model.provider && cfg.model.model) {
      return { provider: cfg.model.provider, model: cfg.model.model, reasoningEffort: cfg.model.reasoningEffort };
    }
    try {
      const adm = ctx.get ? ctx.get("agentDefaultModel") : ctx.agentDefaultModel;
      const sel = adm?.currentSelection?.();
      if (sel?.provider && sel?.model) {
        if (!warnedFallback) {
          warnedFallback = true;
          ctx.logger?.warn?.(
            `[scientific-reviewer] 未配置评审模型（config.model），回落全局默认 ${sel.provider}/${sel.model}；建议在 cordis.patch.yml 显式指定强推理模型`
          );
        }
        return { provider: sel.provider, model: sel.model, reasoningEffort: cfg.model.reasoningEffort };
      }
    } catch {
      /* 服务不可用 */
    }
    return null;
  };

  const statePath = (root) => path.join(root, ".reviewer", "state.json");
  const inFlight = new Set(); // 同一项目同一时刻只跑一轮评审

  const runReview = async (root, diff, next) => {
    const model = await resolveReviewModel();
    if (!model) {
      ctx.logger?.warn?.("[scientific-reviewer] 无可用评审模型，跳过本轮");
      return;
    }
    const claims = await collectClaims(root, diff, cfg);
    if (!claims.length) return;

    const iter = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      // content 必须是块数组（同 model-tier 分类器的实测约束）
      messages: [{ role: "user", content: [{ type: "text", text: buildReviewPrompt(claims) }] }],
      maxTokens: cfg.maxTokens,
      temperature: 0,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    });
    let out = "";
    const consume = (async () => {
      try {
        for await (const chunk of iter) {
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
        }
      } finally {
        try {
          await iter.return?.();
        } catch {
          /* 忽略 */
        }
      }
    })();
    await Promise.race([consume, new Promise((_, rej) => setTimeout(() => rej(new Error("评审调用超时")), cfg.timeoutMs))]);

    const verdicts = parseVerdicts(out);
    if (!verdicts) {
      ctx.logger?.warn?.("[scientific-reviewer] 评审输出解析失败，本轮不落盘");
      return;
    }
    for (const v of verdicts) {
      try {
        const { id } = await recordReview(root, v);
        ctx.logger?.info?.(`[scientific-reviewer] 评审 ${id}：${v.target} → ${v.verdict}（${model.provider}/${model.model}）`);
      } catch (err) {
        ctx.logger?.warn?.(`[scientific-reviewer] 评审落盘失败（${v.target}）：${err.message}`);
      }
    }
    if (cfg.gate) {
      const dir = path.join(root, ".reviewer");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "gate"), `评审门禁已启用（${core.nowISO()}，由 scientific-reviewer 引擎写入）\n`, "utf8");
    }
  };

  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    // 观察与评审异步进行，绝不阻塞请求链
    void (async () => {
      const sessionId = payload?.sessionId ?? payload?.session?.id ?? payload?.agent?.session?.id ?? payload?.id;
      if (!sessionId) return;
      let agent;
      try {
        agent = ctx.agents?.get?.(sessionId);
      } catch {
        return;
      }
      if (agent?.session?.meta?.origin === "subagent") return; // 不评审子代理/评审者
      const cwd = agent?.session?.header?.cwd ?? agent?.session?.cwd;
      if (!cwd) return;
      const root = await core.findProjectRoot(cwd, cfg.markers);
      if (!root || !existsSync(path.join(root, "research-manifest.json"))) return;
      if (inFlight.has(root)) return;

      const prev = await core.readJson(statePath(root), null);
      const nextSnap = await takeSnapshot(root);
      const diff = detectTriggers(prev?.snapshot ?? null, nextSnap, prev?.lastReviewAt ?? 0, cfg);
      if (!diff.fire) {
        // 只推进基线快照（含首次见到项目时建档）
        if (JSON.stringify(prev?.snapshot ?? null) !== JSON.stringify(nextSnap)) {
          await core.writeJsonAtomic(statePath(root), { lastReviewAt: prev?.lastReviewAt ?? 0, snapshot: nextSnap });
        }
        return;
      }
      inFlight.add(root);
      try {
        ctx.logger?.info?.(`[scientific-reviewer] 触发自动评审（${diff.reasons.join("；")}）：${root}`);
        await runReview(root, diff, nextSnap);
        await core.writeJsonAtomic(statePath(root), { lastReviewAt: Date.now(), snapshot: nextSnap });
      } catch (err) {
        ctx.logger?.warn?.(`[scientific-reviewer] 评审轮次失败：${err.message}`);
      } finally {
        inFlight.delete(root);
      }
    })().catch((err) => ctx.logger?.warn?.(`[scientific-reviewer] 观察钩子异常：${err.message}`));
    return resolved;
  });
}

export { apply };
