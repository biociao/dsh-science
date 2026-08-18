// dsh-model-tier 智能分档设置页 + 路由读数 —— Client 源码（正式 client 插件）
// 构建脚本 scripts/build-client-bundle.mjs 会把本文件包装为
// __ModuleLoader__.load({ id, factory }) 格式的 bundle（lib/client.js）。
// 约定：React 与 h(React.createElement) 由构建包装注入，本文件不声明。
// 数据通过 fetch 调用宿主侧 webServer 路由 /dsh-model-tier/<method>。
//
// 两个出口：
//   1. settings.section「智能分档」（order 11，紧跟内置「模型」之后）：
//      方案列表页 → 方案详情页。一个方案 = provider/模型到三档（深思(强)/主力/
//      执行(弱)）的映射 + 路由规则；多方案预设，activeId 是「默认方案」（会话
//      选中的方案 id 失效时回落）。保存写入 $DSH_HOME/model-tier.json（schema 2），
//      路由引擎按 mtime 热加载，无需重启。
//   2. conversation.composer.dock 路由读数：会话在模型选择器选中
//      「智能分档 / 某方案」后，输入框下方展示最近一次实际路由到的模型。
//      刷新是事件驱动的（新 turn / running 翻转时立即拉取，运行中 3s 轮询
//      跟踪逐步路由，空闲不轮询）。

const CSS = `
.mti{font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;padding:4px 2px 16px;max-width:720px}
.mti-title{font-size:16px;font-weight:500;line-height:24px}
.mti-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mti-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.mti-okmsg{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.mti-busy{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mti-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center}
.mti-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mti-btn:disabled{opacity:.5;cursor:default}
.mti-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.mti-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mti-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.mti-card-clickable{cursor:pointer}
.mti-card-clickable:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2));background:var(--dsw-alias-interactive-bg-hover)}
.mti-card-add{border-style:dashed;align-items:center;justify-content:center;min-height:44px;color:var(--dsw-alias-label-secondary)}
.mti-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mti-spread{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.mti-tier-name{font-weight:500;font-size:14px;line-height:22px}
.mti-badge{font-size:11px;line-height:16px;border-radius:4px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-secondary)}
.mti-badge-strong{color:var(--dsw-alias-state-error-primary)}
.mti-badge-default{color:var(--dsw-alias-brand-primary)}
.mti-badge-light{color:var(--dsw-alias-state-success-primary)}
.mti-badge-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.mti-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mti-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.mti-select{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary);min-width:180px}
.mti-input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary);width:120px}
.mti-input-name{width:240px}
.mti-sec-title{font-size:14px;font-weight:500;line-height:22px}
.mti-save{display:flex;gap:8px;align-items:center;margin-top:4px}
.mti-warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));font-size:12px}
.mti-back{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.mti-back:hover{color:var(--dsw-alias-label-primary)}
.mti-dock{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 4px;display:flex;align-items:center;gap:6px}
`

// 调用宿主侧 REST API（webServer 前缀路由）
const api = (method, body) =>
  fetch("/dsh-model-tier/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json())

const TIERS = [
  { key: "strong", label: "深思（强）", badge: "mti-badge-strong", desc: "深链子任务 / 超长输入升级到此档" },
  { key: "default", label: "主力", badge: "mti-badge-default", desc: "主对话走此档" },
  { key: "light", label: "执行（弱）", badge: "mti-badge-light", desc: "辅助请求（会话标题/压缩）+ 子任务" },
]
const TIER_LABEL = { strong: "深思（强）", default: "主力", light: "执行（弱）" }

const shortTier = (t) => (t && t.provider && t.model ? t.provider + " / " + t.model : null)

// ── 聊天页输入框下方的路由读数 ──────────────────────────────────────────────

function RouteDock({ sessionId, session }) {
  const [st, setSt] = React.useState(null)
  const running = !!session?.running
  const turnCount = session?.turnTimings?.size ?? 0
  React.useEffect(() => {
    if (!sessionId) return undefined
    let stop = false
    const tick = () =>
      api("route-status", { sessionId })
        .then((r) => { if (!stop && r?.ok) setSt(r) })
        .catch(() => {})
    // 事件驱动：挂载 / 新 turn 开始（LLM 请求发起）/ running 翻转时立即刷新；
    // 仅运行中保留 3s 轮询以跟踪逐步路由，空闲时不轮询。
    tick()
    const timer = running ? setInterval(tick, 3000) : null
    return () => { stop = true; if (timer) clearInterval(timer) }
  }, [sessionId, running, turnCount])
  if (!st?.tiered || !st?.last) return null
  const { model, tier } = st.last
  return h("div", { className: "mti-dock" },
    "智能分档 · " + (st.schemeName ?? "—") + " → " + model + (tier ? "（" + (TIER_LABEL[tier] ?? tier) + "）" : ""),
  )
}

// ── 设置页：单档编辑卡片 ────────────────────────────────────────────────────

function TierCard({ tier, value, providers, onChange }) {
  const setProv = (e) => onChange(tier.key, e.target.value ? { provider: e.target.value, model: "" } : null)
  const setModel = (e) => onChange(tier.key, value ? { ...value, model: e.target.value } : null)
  const prov = providers.find((p) => p.id === value?.provider)
  const missing = value?.provider && !prov
  return h("div", { className: "mti-card" },
    h("div", { className: "mti-row" },
      h("span", { className: "mti-tier-name" }, tier.label),
      h("span", { className: "mti-badge " + tier.badge }, tier.key),
      h("span", { className: "mti-meta" }, tier.desc),
    ),
    h("div", { className: "mti-row" },
      h("span", { className: "mti-label" }, "Provider"),
      h("select", { className: "mti-select", value: value?.provider ?? "", onChange: setProv },
        h("option", { value: "" }, "（未设置）"),
        missing ? h("option", { value: value.provider }, value.provider + "（未注册）") : null,
        providers.map((p) => h("option", { key: p.id, value: p.id }, p.name === p.id ? p.id : p.name + " (" + p.id + ")")),
      ),
      h("span", { className: "mti-label" }, "模型"),
      h("select", { className: "mti-select", value: value?.model ?? "", onChange: setModel, disabled: !value?.provider },
        h("option", { value: "" }, value?.provider ? "（选择模型）" : "（先选 provider）"),
        prov && value?.model && !prov.models.some((m) => m.id === value.model)
          ? h("option", { value: value.model }, value.model + "（不在清单）") : null,
        (prov?.models ?? []).map((m) => h("option", { key: m.id, value: m.id }, m.name === m.id ? m.id : m.name + " (" + m.id + ")")),
      ),
      value && !value.model ? h("span", { className: "mti-warn" }, "未选模型，保存后该档不生效") : null,
    ),
  )
}

// ── 设置页：方案列表 ────────────────────────────────────────────────────────

function SchemeList({ store, providers, busy, onEdit, onAdd, onSetActive, onDelete, onToggleEnabled, onReset, onRefresh }) {
  const activeId = store.activeId
  return h(React.Fragment, null,
    h("div", { className: "mti-row" },
      h("span", { className: "mti-title" }, "智能分档（Model Tier）"),
      h("span", { className: "mti-hint" }, "按任务难易度自动选择模型 · 在会话模型选择器选「智能分档 / 方案」即按会话启用"),
    ),
    h("div", { className: "mti-row" },
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13 } },
        h("input", { type: "checkbox", checked: store.enabled !== false, disabled: busy, onChange: (e) => onToggleEnabled(e.target.checked) }),
        "启用智能分档",
      ),
      activeId
        ? h("span", { className: "mti-badge mti-badge-active" }, "默认方案：" + ((store.schemes.find((s) => s.id === activeId) || {}).name ?? activeId))
        : h("span", { className: "mti-meta" }, "未设默认方案（会话选中方案的 id 失效时不做回落）"),
    ),
    store.schemes.map((s) =>
      h("div", { key: s.id, className: "mti-card" },
        h("div", { className: "mti-spread" },
          h("div", { className: "mti-row" },
            h("span", { className: "mti-tier-name" }, s.name),
            s.id === activeId ? h("span", { className: "mti-badge mti-badge-active" }, "默认") : null,
          ),
          h("div", { className: "mti-row" },
            h("button", { className: "mti-btn", disabled: busy, onClick: () => onEdit(s) }, "编辑"),
            s.id === activeId
              ? h("button", { className: "mti-btn", disabled: busy, onClick: () => onSetActive(null) }, "取消默认")
              : h("button", { className: "mti-btn mti-btn-primary", disabled: busy, onClick: () => onSetActive(s.id) }, "设为默认"),
            h("button", { className: "mti-btn mti-btn-danger", disabled: busy, onClick: () => { if (confirm("删除方案「" + s.name + "」？")) onDelete(s.id) } }, "删除"),
          ),
        ),
        h("div", { className: "mti-row" },
          TIERS.map((t) => {
            const v = shortTier(s.tiers?.[t.key])
            return h("span", { key: t.key, className: "mti-badge " + (v ? t.badge : "") }, t.label + "：" + (v ?? "未设置"))
          }),
        ),
        s.updatedAt ? h("div", { className: "mti-meta" }, "更新于 " + String(s.updatedAt).replace("T", " ").slice(0, 19)) : null,
      ),
    ),
    h("div", { className: "mti-card mti-card-add mti-card-clickable", onClick: busy ? undefined : onAdd }, "+ 添加分档方案"),
    h("div", { className: "mti-save" },
      store.schemes.length || store.hasFile ? h("button", { className: "mti-btn mti-btn-danger", disabled: busy, onClick: () => { if (confirm("恢复 bundle 默认分档配置？（删除整个配置文件，所有方案都会移除）")) onReset() } }, "恢复默认") : null,
      h("button", { className: "mti-btn", disabled: busy, onClick: onRefresh }, "刷新"),
    ),
    h("div", { className: "mti-meta" }, "配置写入 " + (store.configFile || "…") + "，路由引擎热加载；provider 未在「模型」中注册的档位自动不生效。"),
  )
}

// ── 设置页：方案详情（三级页面） ────────────────────────────────────────────

function SchemeDetail({ draft, setDraft, providers, busy, isNew, isActive, onSave, onBack }) {
  const setTier = (key, v) => setDraft((d) => ({ ...d, tiers: { ...d.tiers, [key]: v } }))
  const setRouting = (r) => setDraft((d) => ({ ...d, routing: { ...d.routing, ...r } }))
  return h(React.Fragment, null,
    h("div", { className: "mti-row" },
      h("span", { className: "mti-back", onClick: busy ? undefined : onBack }, "← 返回方案列表"),
      h("span", { className: "mti-title" }, isNew ? "新建分档方案" : "编辑分档方案"),
      isActive ? h("span", { className: "mti-badge mti-badge-active" }, "默认方案") : null,
    ),
    h("div", { className: "mti-row" },
      h("span", { className: "mti-label" }, "方案名称"),
      h("input", { className: "mti-input mti-input-name", value: draft.name, placeholder: "如：日常开发 / 重研究", onChange: (e) => setDraft((d) => ({ ...d, name: e.target.value })) }),
      isNew ? h("span", { className: "mti-meta" }, "保存后自动设为默认方案") : null,
    ),
    TIERS.map((t) => h(TierCard, { key: t.key, tier: t, value: draft.tiers[t.key] ?? null, providers, onChange: setTier })),
    h("div", { className: "mti-card" },
      h("span", { className: "mti-sec-title" }, "路由规则"),
      h("div", { className: "mti-row" },
        h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
          h("input", { type: "checkbox", checked: draft.routing.subagents === "light", onChange: (e) => setRouting({ subagents: e.target.checked ? "light" : "off" }) }),
          "子任务（子代理 / 后台任务）走执行（弱）档",
        ),
      ),
      h("div", { className: "mti-row" },
        h("span", { className: "mti-label" }, "深链子任务升级深思（强）档：delegationDepth ≥"),
        h("input", { className: "mti-input", value: draft.routing.subagentDepthStrong, placeholder: "留空关闭", onChange: (e) => setRouting({ subagentDepthStrong: e.target.value.replace(/[^0-9]/g, "") }) }),
      ),
      h("div", { className: "mti-row" },
        h("span", { className: "mti-label" }, "超长输入升级深思（强）档：用户消息 ≥"),
        h("input", { className: "mti-input", value: draft.routing.escalateOnChars, placeholder: "留空关闭", onChange: (e) => setRouting({ escalateOnChars: e.target.value.replace(/[^0-9]/g, "") }) }),
        h("span", { className: "mti-meta" }, "字符"),
      ),
    ),
    h("div", { className: "mti-card" },
      h("span", { className: "mti-sec-title" }, "复杂度分类（LLM 前置分类器）"),
      h("div", { className: "mti-row" },
        h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
          h("input", { type: "checkbox", checked: draft.routing.classify !== null, onChange: (e) => setRouting({ classify: e.target.checked ? { provider: "", model: "" } : null }) }),
          "每次用户提问 / 子任务派发前，先用小模型判断该走哪档（执行 / 主力 / 深思）",
        ),
      ),
      draft.routing.classify
        ? h("div", { className: "mti-row" },
            h("span", { className: "mti-label" }, "分类模型"),
            h("select", { className: "mti-select", value: draft.routing.classify.provider ?? "", onChange: (e) => setRouting({ classify: { provider: e.target.value, model: "" } }) },
              h("option", { value: "" }, "（默认：执行档模型）"),
              providers.map((p) => h("option", { key: p.id, value: p.id }, p.name === p.id ? p.id : p.name + " (" + p.id + ")")),
            ),
            h("select", { className: "mti-select", value: draft.routing.classify.model ?? "", disabled: !draft.routing.classify.provider, onChange: (e) => setRouting({ classify: { ...draft.routing.classify, model: e.target.value } }) },
              h("option", { value: "" }, draft.routing.classify.provider ? "（选择模型）" : "（先选 provider）"),
              ((providers.find((p) => p.id === draft.routing.classify.provider) || {}).models ?? []).map((m) => h("option", { key: m.id, value: m.id }, m.name === m.id ? m.id : m.name + " (" + m.id + ")")),
            ),
          )
        : null,
      h("div", { className: "mti-meta" }, "结构规则（超长输入 / 深链子任务升强）优先；分类失败或超时自动回落结构规则；同一轮提问只分类一次。"),
    ),
    h("div", { className: "mti-save" },
      h("button", { className: "mti-btn mti-btn-primary", disabled: busy || !draft.name.trim(), onClick: onSave }, busy ? "保存中…" : "保存方案"),
      h("button", { className: "mti-btn", disabled: busy, onClick: onBack }, "取消"),
    ),
  )
}

// ── 设置页：页面容器 ────────────────────────────────────────────────────────

function Page() {
  const [loading, setLoading] = React.useState(true)
  const [err, setErr] = React.useState("")
  const [msg, setMsg] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [providers, setProviders] = React.useState([])
  // 方案仓库视图：{ configFile, enabled, activeId, schemes, hasFile, effective }
  const [store, setStore] = React.useState({ enabled: true, activeId: null, schemes: [] })
  // 页内导航：null = 列表页；否则为详情页草稿 { id?, name, tiers, routing, isNew }
  const [draft, setDraft] = React.useState(null)

  const applyView = (c) => {
    setStore({
      configFile: c.configFile ?? "",
      hasFile: !!c.schemes?.length || c.activeId != null,
      enabled: c.enabled !== false,
      activeId: c.activeId ?? null,
      schemes: c.schemes ?? [],
    })
  }

  const load = async () => {
    setLoading(true); setErr("")
    try {
      const [c, p] = await Promise.all([api("config"), api("providers")])
      if (c && c.ok === false) throw new Error(c.error)
      if (p && p.ok === false) throw new Error(p.error)
      setProviders(p.providers ?? [])
      applyView(c)
    } catch (e) { setErr(String(e.message || e)) } finally { setLoading(false) }
  }
  React.useEffect(() => { load() }, [])

  // 通用调用：成功则刷新视图并返回列表页
  const call = async (method, body, okMsg) => {
    setBusy(true); setErr(""); setMsg("")
    try {
      const r = await api(method, body)
      if (r && r.ok === false) throw new Error(r.error)
      applyView(r)
      setDraft(null)
      if (okMsg) setMsg(okMsg)
    } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
  }

  const emptyDraft = () => ({
    name: "",
    tiers: { strong: null, default: null, light: null },
    routing: { subagents: "off", subagentDepthStrong: "", escalateOnChars: "", classify: null },
    isNew: true,
  })
  const draftOf = (s) => ({
    id: s.id,
    name: s.name,
    tiers: {
      strong: s.tiers?.strong ?? null,
      default: s.tiers?.default ?? null,
      light: s.tiers?.light ?? null,
    },
    routing: {
      subagents: s.routing?.subagents === "light" ? "light" : "off",
      subagentDepthStrong: s.routing?.subagentDepthStrong ?? "",
      escalateOnChars: s.routing?.escalateOnChars ?? "",
      // null = 关闭；{ provider?, model? } = 启用（空串 = 未选，回落执行档模型）
      classify: s.routing?.classify
        ? { provider: s.routing.classify.provider ?? "", model: s.routing.classify.model ?? "" }
        : null,
    },
    isNew: false,
  })

  const save = () => {
    const body = {
      id: draft.id,
      name: draft.name,
      tiers: {
        strong: draft.tiers.strong && draft.tiers.strong.model ? draft.tiers.strong : null,
        default: draft.tiers.default && draft.tiers.default.model ? draft.tiers.default : null,
        light: draft.tiers.light && draft.tiers.light.model ? draft.tiers.light : null,
      },
      routing: {
        subagents: draft.routing.subagents,
        subagentDepthStrong: draft.routing.subagentDepthStrong === "" ? null : Number(draft.routing.subagentDepthStrong),
        escalateOnChars: draft.routing.escalateOnChars === "" ? null : Number(draft.routing.escalateOnChars),
        // classify：null = 关闭；{provider, model} 成对填写，都空 = 启用并用执行档模型
        classify: (() => {
          const c = draft.routing.classify
          if (!c) return null
          const out = {}
          if (c.provider) out.provider = c.provider
          if (c.model) out.model = c.model
          return out
        })(),
      },
    }
    call("save-scheme", body, "已保存并即时生效（无需重启）")
  }

  if (loading) return h("div", { className: "mti" }, h("span", { className: "mti-busy" }, "加载中…"))

  return h("div", { className: "mti" },
    err ? h("div", { className: "mti-err" }, err) : null,
    msg ? h("div", { className: "mti-okmsg" }, msg) : null,
    draft
      ? h(SchemeDetail, {
          draft, setDraft, providers, busy,
          isNew: draft.isNew,
          isActive: !draft.isNew && draft.id === store.activeId,
          onSave: save,
          onBack: () => { setDraft(null); setErr("") },
        })
      : h(SchemeList, {
          store, providers, busy,
          onEdit: (s) => { setErr(""); setMsg(""); setDraft(draftOf(s)) },
          onAdd: () => { setErr(""); setMsg(""); setDraft(emptyDraft()) },
          onSetActive: (id) => call("set-active", { id }, id ? "已切换默认方案" : "已清除默认方案"),
          onDelete: (id) => call("delete-scheme", { id }, "方案已删除"),
          onToggleEnabled: (enabled) => call("set-enabled", { enabled }, enabled ? "已启用智能分档" : "已停用智能分档（选择器中不再出现）"),
          onReset: () => call("reset", {}, "已恢复 bundle 默认配置（配置文件已删除）"),
          onRefresh: load,
        }),
  )
}

function apply(ctx) {
  const slots = ctx.get("slots")
  if (slots === undefined) return
  // 注入样式（data-plugin 标签会被 client-modules 认领，随插件清理）
  const tagId = "dsh-model-tier/ui.css"
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
    const tag = document.createElement("style")
    tag.dataset.plugin = "dsh-model-tier"
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  // order 11：紧跟内置「模型」（settings.section id=models，order 10）之后
  slots.inject("settings.section", () => slots.register(
    { name: "settings.section", id: "model-tier", order: 11, label: "智能分档" },
    () => h(Page, null),
  ))
  // 聊天页输入框下方：实际路由读数（session 作用域；owner share 为 InputZone
  // { session, input }，框架另带 sessionId）。session 快照随会话活动重渲染，
  // RouteDock 借此在 LLM 请求发起（新 turn / running 翻转）时刷新读数。
  slots.inject("conversation.composer.dock", () => slots.register(
    { name: "conversation.composer.dock", id: "model-tier-route", order: 10, label: "智能分档路由" },
    (props) => h(RouteDock, { sessionId: props?.session?.sessionId ?? props?.sessionId, session: props?.session }),
  ))
}

// 构建脚本会把 `module.exports = plugin` 追加到包装末尾（factory 内导出）。
const plugin = { name: "model-tier-ui", inject: ["slots"], apply }
