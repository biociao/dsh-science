window.__ModuleLoader__.load({
	id: "dsh-science",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		//#region dsh-science/client/remote-hosts-ui/src
// dsh-science 科研工作台 Web 面板 —— Client 源码（打包进 remote-hosts-ui 同一 client bundle）
//
// 说明：DSH 的 client-modules 按包名只解析一个 `exports["./client"]`/`dsh.client` 声明，
// 因此本面板与远程主机页共用同一个 client bundle（scripts/build-client-bundle.mjs 会把
// 本文件与主入口 src/index.js 按顺序拼接成 factory 作用域，共享 React / h / 主题变量）。
// 文件名统一加 wb 前缀避免跨文件命名冲突。数据通过 fetch 调用宿主侧 webServer 路由
// /dsh-science/workbench/<method>（engines/workbench-ui.mjs）。

// 主题对齐 DSH 设置页：全部使用 shell 提供的 --dsw-alias-* 主题变量（dsh-client-ui-theme）。
const wbCSS = `
.wbui{font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;padding:4px 2px 16px;max-width:860px}
.wbui-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbui-title{font-size:16px;font-weight:500;line-height:24px}
.wbui-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.wbui-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.wbui-busy{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wbui-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center}
.wbui-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wbui-btn:disabled{opacity:.5;cursor:default}
.wbui-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.wbui-btn-danger{color:var(--dsw-alias-state-error-primary)}
.wbui-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.wbui-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.wbui-stat{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.wbui-stat-num{font-size:18px;font-weight:600;line-height:24px}
.wbui-stat-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wbui-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbui-projtitle{font-weight:500;font-size:14px;line-height:22px}
.wbui-badge{font-size:11px;line-height:16px;border-radius:4px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-secondary)}
.wbui-badge-active{color:var(--dsw-alias-state-success-primary)}
.wbui-badge-paused{color:var(--dsw-alias-state-warn-primary)}
.wbui-badge-finished{color:var(--dsw-alias-label-tertiary)}
.wbui-badge-archived{color:var(--dsw-alias-label-secondary)}
.wbui-badge-priority{color:var(--dsw-alias-state-warn-primary)}
.wbui-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.wbui-parent{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wbui-cat{font-size:13px;font-weight:500;line-height:20px;margin-top:6px}
.wbui-input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary)}
.wbui-select{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary)}
.wbui-field{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.wbui-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.wbui-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 0}
.wbui-tags{font-size:12px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Menlo,monospace}
.wbui-section-head{display:flex;align-items:center;gap:8px;margin-top:4px}
.wbui-section-title{font-size:14px;font-weight:500;line-height:22px}
.wbui-filerow{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
`

const wbApi = (method, body) =>
  fetch("/dsh-science/workbench/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json())

const statusLabel = (s) => ({ active: "进行中", paused: "已暂停", finished: "已结束", archived: "已归档" }[s] || s)
const phaseLabel = (p) => ({ literature: "文献调研", hypothesis: "假设提出", experiment: "实验设计", analysis: "数据分析", manuscript: "论文撰写", concluded: "已收束" }[p] || p)

function WorkbenchPage() {
  const [root, setRoot] = React.useState("")
  const [overview, setOverview] = React.useState(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [filter, setFilter] = React.useState({ category: "", status: "", priority: "" })
  const [editPath, setEditPath] = React.useState("")
  const [addOpen, setAddOpen] = React.useState(false)

  const load = React.useCallback(async (target) => {
    if (!target) { setOverview(null); return }
    setBusy("加载中…"); setError("")
    try {
      const res = await wbApi("overview", { root: target })
      if (res && res.ok === false) throw new Error(res.error)
      setOverview(res)
    } catch (e) { setError(String(e.message)) } finally { setBusy("") }
  }, [])

  React.useEffect(() => {
    wbApi("config").then((c) => {
      if (c && c.ok !== false && c.defaultRoot) {
        setRoot(c.defaultRoot)
        load(c.defaultRoot)
      }
    }).catch(() => {})
  }, [load])

  const refresh = React.useCallback(() => { if (overview) load(overview.root) }, [overview, load])
  const classify = async (path, patch) => {
    setBusy("保存中…"); setError("")
    try {
      const res = await wbApi("classify", { root: overview.root, path, ...patch })
      if (res && res.ok === false) throw new Error(res.error)
      setEditPath("")
      await load(overview.root)
    } catch (e) { setError(String(e.message)) } finally { setBusy("") }
  }
  const register = async (path, patch) => {
    setBusy("登记中…"); setError("")
    try {
      const res = await wbApi("register", { root: overview.root, path, ...patch })
      if (res && res.ok === false) throw new Error(res.error)
      setAddOpen(false)
      await load(overview.root)
    } catch (e) { setError(String(e.message)) } finally { setBusy("") }
  }

  const projects = overview ? overview.projects.filter((p) =>
    (!filter.category || p.category === filter.category) &&
    (!filter.status || p.status === filter.status) &&
    (!filter.priority || p.priority === filter.priority)
  ) : []
  const categories = overview ? [...new Set(projects.map((p) => p.category || "(未分类)"))] : []
  const s = overview ? (overview.summary || {}) : {}

  return h("div", { className: "wbui" },
    h("div", { className: "wbui-head" },
      h("span", { className: "wbui-title" }, "科研工作台"),
      h("span", { className: "wbui-meta" }, s.projects != null ? "共 " + overview.projects.length + " 个项目（已登记 " + (overview.projects.filter((p) => p.registeredAt).length) + "）" : "…"),
      busy ? h("span", { className: "wbui-busy" }, busy) : null,
      h("div", { style: { flex: 1 } }),
      h("button", { className: "wbui-btn", disabled: !!busy, onClick: refresh }, "刷新"),
      h("button", { className: "wbui-btn wbui-btn-primary", disabled: !!busy, onClick: () => setAddOpen(true) }, "＋ 登记项目"),
    ),
    h("div", { className: "wbui-row" },
      h("input", { className: "wbui-input", style: { flex: 1 }, value: root, onChange: (e) => setRoot(e.target.value), placeholder: "工作台根（伞目录，如 /Users/me/labs）" }),
      h("button", { className: "wbui-btn", disabled: !!busy || !root, onClick: () => load(root) }, "加载"),
    ),
    overview ? h("div", { className: "wbui-hint" }, "注册表：" + overview.registryFile) : null,
    error ? h("div", { className: "wbui-err" }, error) : null,
    addOpen ? h(RegisterForm, { root: overview && overview.root, onDone: register, onCancel: () => setAddOpen(false) }) : null,

    Object.keys(s).length ? h("div", { className: "wbui-summary" },
      stat(s.projects || 0, "项目"),
      stat(s.withManifest || 0, "含清单"),
      stat((s.total && s.total.hypotheses) || 0, "假设"),
      stat((s.total && s.total.experiments) || 0, "实验"),
      stat((s.total && s.total.artifacts) || 0, "工件"),
      stat((s.total && s.total.pendingReviews) || 0, "待处理评审"),
      stat((s.runningJobs && (s.runningJobs.running + s.runningJobs.submitted)) || 0, "运行中作业"),
    ) : null,

    overview ? h("div", { className: "wbui-filerow" },
      h("select", { className: "wbui-select", value: filter.category, onChange: (e) => setFilter({ ...filter, category: e.target.value }) },
        h("option", { value: "" }, "全部分类"),
        categories.map((c) => h("option", { value: c, key: c }, c))),
      h("select", { className: "wbui-select", value: filter.status, onChange: (e) => setFilter({ ...filter, status: e.target.value }) },
        h("option", { value: "" }, "全部状态"),
        ["active", "paused", "finished", "archived"].map((st) => h("option", { value: st, key: st }, statusLabel(st)))),
      h("select", { className: "wbui-select", value: filter.priority, onChange: (e) => setFilter({ ...filter, priority: e.target.value }) },
        h("option", { value: "" }, "全部优先级"),
        ["high", "medium", "low"].map((pr) => h("option", { value: pr, key: pr }, pr === "high" ? "高" : pr === "medium" ? "中" : "低"))),
    ) : null,

    overview === null ? h("div", { className: "wbui-empty" }, "设置工作台根后加载。") :
      projects.length === 0 ? h("div", { className: "wbui-empty" }, "暂无项目。子目录含 research-manifest.json 会自动收录；也可点“登记项目”。") :
        categories.map((cat) => h("div", { key: cat },
          h("div", { className: "wbui-cat" }, cat + "（" + projects.filter((p) => (p.category || "(未分类)") === cat).length + "）"),
          projects.filter((p) => (p.category || "(未分类)") === cat).map((p) => h(ProjectCard, {
            key: p.path, p, root: overview.root, busy, onEdit: () => setEditPath(editPath === p.path ? "" : p.path), editing: editPath === p.path, onClassify: classify, onMsg: setError,
          })),
        )),
  )
}

function stat(n, label) {
  return h("div", { className: "wbui-stat" },
    h("div", { className: "wbui-stat-num" }, n),
    h("div", { className: "wbui-stat-label" }, label))
}

function ProjectCard({ p, root, busy, editing, onEdit, onClassify, onMsg }) {
  const [draft, setDraft] = React.useState({ category: p.category || "", priority: p.priority || "medium", status: p.status || "active", notes: p.notes || "", tags: (p.tags || []).join(",") })
  const save = async () => {
    const tags = draft.tags.split(",").map((x) => x.trim()).filter(Boolean)
    try { await onClassify(p.path, { category: draft.category, priority: draft.priority, status: draft.status, notes: draft.notes, tags }) }
    catch (e) { onMsg(String(e.message)) }
  }
  const hyp = p.counts.hypotheses || {}
  const exp = p.counts.experiments || {}
  const jb = (p.jobs && p.jobs.by) || {}
  const activeJobs = (jb.running || 0) + (jb.submitted || 0)
  const badgeCls = p.status === "active" ? "wbui-badge-active" : p.status === "paused" ? "wbui-badge-paused" : p.status === "finished" ? "wbui-badge-finished" : "wbui-badge-archived"
  return h("div", { className: "wbui-card" },
    h("div", { className: "wbui-row" },
      h("span", { className: "wbui-projtitle" }, p.title || p.path),
      h("span", { className: "wbui-badge " + badgeCls }, statusLabel(p.status)),
      p.priority === "high" ? h("span", { className: "wbui-badge wbui-badge-priority" }, "高") : null,
      p.domain ? h("span", { className: "wbui-badge" }, p.domain) : null,
      p.manifest ? h("span", { className: "wbui-badge" }, phaseLabel(p.manifest.phase)) : null,
      h("div", { style: { flex: 1 } }),
      h("button", { className: "wbui-btn", disabled: !!busy, onClick: onEdit }, editing ? "收起" : "分类"),
    ),
    p.path !== p.title ? h("div", { className: "wbui-meta" }, p.path) : null,
    h("div", { className: "wbui-parent" },
      "假设 " + (hyp.total || 0) + (hyp.testing ? "（验证中 " + hyp.testing + "）" : "") +
      " ｜ 实验 " + (exp.total || 0) + (exp.running ? "（运行 " + exp.running + "）" : "") +
      " ｜ 工件 " + (p.counts.artifacts || 0) +
      (p.counts.pendingReviews ? " ｜ 待评审 " + p.counts.pendingReviews : "") +
      (activeJobs ? " ｜ 作业运行 " + activeJobs : "") +
      (p.lastActive ? " ｜ 活跃于 " + String(p.lastActive).slice(0, 10) : "")),
    (p.tags && p.tags.length) ? h("div", { className: "wbui-tags" }, "#" + p.tags.join(" #")) : null,
    editing ? h("div", { style: { marginTop: 6 } },
      h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "分类"), h("input", { className: "wbui-input", value: draft.category, onChange: (e) => setDraft({ ...draft, category: e.target.value }), placeholder: "genomics / pathogen / review…" })),
      h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "标签（逗号分隔）"), h("input", { className: "wbui-input", value: draft.tags, onChange: (e) => setDraft({ ...draft, tags: e.target.value }) })),
      h("div", { className: "wbui-row", style: { marginTop: 6 } },
        h("div", { className: "wbui-field", style: { flex: 1 } }, h("span", { className: "wbui-label" }, "优先级"), h("select", { className: "wbui-select", value: draft.priority, onChange: (e) => setDraft({ ...draft, priority: e.target.value }) }, ["high", "medium", "low"].map((x) => h("option", { value: x, key: x }, x === "high" ? "高" : x === "medium" ? "中" : "低")))),
        h("div", { className: "wbui-field", style: { flex: 1 } }, h("span", { className: "wbui-label" }, "状态"), h("select", { className: "wbui-select", value: draft.status, onChange: (e) => setDraft({ ...draft, status: e.target.value }) }, ["active", "paused", "finished", "archived"].map((x) => h("option", { value: x, key: x }, statusLabel(x))))),
      ),
      h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "备注"), h("textarea", { className: "wbui-input", style: { minHeight: 48, resize: "vertical" }, value: draft.notes, onChange: (e) => setDraft({ ...draft, notes: e.target.value }) })),
      h("div", { className: "wbui-row", style: { marginTop: 8 } },
        h("button", { className: "wbui-btn", disabled: !!busy, onClick: onEdit }, "取消"),
        h("button", { className: "wbui-btn wbui-btn-primary", disabled: !!busy, onClick: save }, busy ? "保存中…" : "保存分类"),
      ),
    ) : null,
  )
}

function RegisterForm({ root, onDone, onCancel }) {
  const [f, setF] = React.useState({ path: "", category: "", priority: "medium", status: "active", notes: "", tags: "" })
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState("")
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const sub = async () => {
    setBusy(true); setErr("")
    const tags = f.tags.split(",").map((x) => x.trim()).filter(Boolean)
    try { await onDone(f.path, { category: f.category, priority: f.priority, status: f.status, notes: f.notes, tags }) }
    catch (e) { setErr(String(e.message)); setBusy(false) }
  }
  return h("div", { className: "wbui-card" },
    h("div", { className: "wbui-row" }, h("span", { className: "wbui-projtitle" }, "登记项目")),
    err ? h("div", { className: "wbui-err", style: { marginTop: 8 } }, err) : null,
    h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "项目目录（相对工作台根）"), h("input", { className: "wbui-input", value: f.path, onChange: set("path"), placeholder: "projA" })),
    h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "分类"), h("input", { className: "wbui-input", value: f.category, onChange: set("category") })),
    h("div", { className: "wbui-row", style: { marginTop: 6 } },
      h("div", { className: "wbui-field", style: { flex: 1 } }, h("span", { className: "wbui-label" }, "优先级"), h("select", { className: "wbui-select", value: f.priority, onChange: set("priority") }, ["medium", "high", "low"].map((x) => h("option", { value: x, key: x }, x === "high" ? "高" : x === "medium" ? "中" : "低")))),
      h("div", { className: "wbui-field", style: { flex: 1 } }, h("span", { className: "wbui-label" }, "状态"), h("select", { className: "wbui-select", value: f.status, onChange: set("status") }, ["active", "paused", "finished", "archived"].map((x) => h("option", { value: x, key: x }, statusLabel(x))))),
    ),
    h("div", { className: "wbui-field" }, h("span", { className: "wbui-label" }, "标签（逗号分隔）"), h("input", { className: "wbui-input", value: f.tags, onChange: set("tags") })),
    h("div", { className: "wbui-row", style: { marginTop: 8 } },
      h("button", { className: "wbui-btn", disabled: busy, onClick: onCancel }, "取消"),
      h("button", { className: "wbui-btn wbui-btn-primary", disabled: busy || !f.path, onClick: sub }, busy ? "登记中…" : "登记"),
    ),
  )
}

function applyWorkbench(ctx) {
  const slots = ctx.get("slots")
  if (slots === undefined) return
  const tagId = "dsh-science/workbench-ui.css"
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
    const tag = document.createElement("style")
    tag.dataset.plugin = "dsh-science"
    tag.dataset.pluginCss = tagId
    tag.textContent = wbCSS
    document.head.appendChild(tag)
  }
  slots.inject("settings.section", () => slots.register(
    { name: "settings.section", id: "workbench", order: 4, label: "科研工作台" },
    () => h(WorkbenchPage, null),
  ))
}
// dsh-science 远程主机配置 UI —— Client 源码（正式 client 插件）
// 构建脚本 scripts/build-client-bundle.mjs 会把本文件包装为
// __ModuleLoader__.load({ id, factory }) 格式的 bundle（lib/client.js）。
// 约定：React 与 h(React.createElement) 由构建包装注入，本文件不声明。
// 数据通过 fetch 调用宿主侧 webServer 路由 /dsh-science/remote-hosts/<method>。

// 主题对齐 DSH 设置页：全部使用 shell 提供的 --dsw-alias-* 主题变量
// （dsh-client-ui-theme），暗色/亮色主题自动适配，不再硬编码颜色。
const CSS = `
.rhui{font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px;padding:4px 2px 16px;max-width:720px}
.rhui-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rhui-title{font-size:16px;font-weight:500;line-height:24px}
.rhui-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.rhui-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.rhui-busy{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rhui-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center}
.rhui-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rhui-btn:disabled{opacity:.5;cursor:default}
.rhui-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.rhui-btn-danger{color:var(--dsw-alias-state-error-primary)}
.rhui-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.rhui-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rhui-hostid{font-weight:500;font-size:14px;line-height:22px}
.rhui-badge{font-size:11px;line-height:16px;border-radius:4px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-secondary)}
.rhui-badge-local{color:var(--dsw-alias-state-success-primary)}
.rhui-badge-slurm{color:var(--dsw-alias-state-warn-primary)}
.rhui-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rhui-probe{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rhui-probe-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.rhui-detail{font-size:12px;background:var(--dsw-alias-bg-module-platform);border-radius:12px;padding:10px 12px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.rhui-notes{font-size:12px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.rhui-field{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.rhui-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rhui-input{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary)}
.rhui-textarea{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px;min-height:64px;resize:vertical;background:0 0;color:var(--dsw-alias-label-primary)}
.rhui-select{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary)}
.rhui-sec-title{font-size:14px;font-weight:500;line-height:22px}
.rhui-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 0}
.rhui-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.rhui-save{display:flex;gap:8px;align-items:center;margin-top:6px}
.rhui-count{font-size:11px;padding:0 8px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`

// 调用宿主侧 REST API（webServer 前缀路由）
const api = (method, body) =>
  fetch("/dsh-science/remote-hosts/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json())

const fmtB = (n) => (!n ? "—" : n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(0) + " MB" : n + " B")

function AddForm({ onDone }) {
  const [f, setF] = React.useState({ host: "", alias: "", transport: "ssh", notes: "", scratch: "~/dsh-scratch", port: "", identityFile: "", maxConcurrent: "100", timeoutMinutes: "30", probe: true })
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState("")
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value })
  const sub = async () => {
    setBusy(true); setErr("")
    const a = { ...f }
    if (!a.port) delete a.port
    if (!a.identityFile) delete a.identityFile
    try {
      const r = await api("add-host", a)
      if (r && r.ok === false) throw new Error(r.error)
      onDone()
    } catch (e) { setErr(String(e.message)); setBusy(false) }
  }
  const F = (k, label, el) => h("div", { className: "rhui-field" }, h("span", { className: "rhui-label" }, label), el(k))
  return h("div", { className: "rhui-card" },
    h("div", { className: "rhui-row" }, h("span", { className: "rhui-hostid" }, "添加主机（Add SSH host）")),
    err ? h("div", { className: "rhui-err", style: { marginTop: 8 } }, err) : null,
    h("div", { className: "rhui-grid2" },
      F("host", "host id（字母数字-_）", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k), placeholder: "bio01" })),
      F("alias", "ssh alias（~/.ssh/config 或 user@host）", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k), placeholder: "dgx21.tun" })),
      F("transport", "传输", (k) => h("select", { className: "rhui-select", value: f[k], onChange: set(k) }, h("option", { value: "ssh" }, "ssh（远程）"), h("option", { value: "local" }, "local（本机演练）"))),
      F("scratch", "scratch 根目录", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k) })),
    ),
    F("notes", "备注（Details 文档：环境激活/分区/约定）", (k) => h("textarea", { className: "rhui-textarea", value: f[k], onChange: set(k) })),
    h("div", { className: "rhui-grid2" },
      F("port", "端口（可选）", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k), placeholder: "22" })),
      F("identityFile", "私钥（可选）", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k), placeholder: "~/.ssh/id_ed25519" })),
      F("maxConcurrent", "并发上限", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k) })),
      F("timeoutMinutes", "默认作业超时(分钟)", (k) => h("input", { className: "rhui-input", value: f[k], onChange: set(k) })),
    ),
    h("div", { className: "rhui-row", style: { marginTop: 8 } },
      h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 } }, h("input", { type: "checkbox", checked: f.probe, onChange: set("probe") }), "注册后立即只读探测"),
      h("div", { style: { flex: 1 } }),
      h("button", { className: "rhui-btn", onClick: onDone, disabled: busy }, "取消"),
      h("button", { className: "rhui-btn rhui-btn-primary", disabled: busy || !f.host, onClick: sub }, busy ? "添加中…" : "添加"),
    ),
  )
}

function HostCard({ host, onRefresh, onMsg }) {
  const [open, setOpen] = React.useState(false)
  const [notes, setNotes] = React.useState(host.notes || "")
  const [draft, setDraft] = React.useState({ scratch: host.scratch || "", maxConcurrent: String(host.maxConcurrent ?? ""), timeoutMinutes: String(host.timeoutMinutes ?? "") })
  const [busy, setBusy] = React.useState("")
  const p = host.probe || {}
  const gpus = (Array.isArray(p.gpus) ? p.gpus : []).filter((g) => g !== "none")
  const act = async (label, fn) => {
    setBusy(label)
    try { const r = await fn(); if (r && r.ok === false) onMsg(r.error); await onRefresh() }
    catch (e) { onMsg(String(e.message)) } finally { setBusy("") }
  }
  return h("div", { className: "rhui-card" },
    h("div", { className: "rhui-row" },
      h("span", { className: "rhui-hostid" }, host.id),
      h("span", { className: "rhui-badge" + (host.transport === "local" ? " rhui-badge-local" : "") }, host.transport === "local" ? "local" : "ssh"),
      p.sbatch ? h("span", { className: "rhui-badge rhui-badge-slurm" }, "slurm") : null,
      p.conda ? h("span", { className: "rhui-badge" }, "conda") : null,
      h("span", { className: "rhui-meta" }, host.alias ? "alias=" + host.alias : ""),
      h("div", { style: { flex: 1 } }),
      busy ? h("span", { className: "rhui-busy" }, busy) : null,
      h("button", { className: "rhui-btn", disabled: !!busy, onClick: () => act("探测中…", () => api("probe-host", { host: host.id })) }, "重新探测"),
      h("button", { className: "rhui-btn", disabled: !!busy, onClick: () => setOpen(!open) }, open ? "收起" : "详情/编辑"),
      h("button", { className: "rhui-btn rhui-btn-danger", disabled: !!busy, onClick: () => { if (confirm("确认移除主机 " + host.id + "？")) act("移除中…", () => api("remove-host", { host: host.id })) } }, "移除"),
    ),
    host.notes ? h("div", { className: "rhui-notes" }, host.notes) : null,
    h("div", { className: "rhui-probe", style: { marginTop: 4 } },
      (p.os ? p.os + " ｜ CPU " + p.cpus + " ｜ 内存 " + fmtB(p.memBytes) : "") + (gpus.length ? " ｜ GPU " + gpus.join("; ") : "") + (p.slurmVersion ? " ｜ SLURM " + p.slurmVersion : "") + (host.probedAt ? " ｜ 探测于 " + host.probedAt.slice(0, 19).replace("T", " ") : " ｜ 未探测"),
    ),
    host.probeError ? h("div", { className: "rhui-probe-err" }, "探测失败：" + host.probeError) : null,
    open ? h("div", { style: { marginTop: 8 } },
      h("div", { className: "rhui-sec-title" }, "备注（Details 文档）"),
      h("textarea", { className: "rhui-textarea", value: notes, onChange: (e) => setNotes(e.target.value), style: { marginTop: 4 } }),
      h("div", { className: "rhui-save" }, h("button", { className: "rhui-btn", disabled: !!busy || notes === (host.notes || ""), onClick: () => act("保存备注…", () => api("update-host", { host: host.id, patch: { notes } })) }, "保存备注")),
      h("div", { className: "rhui-sec-title", style: { marginTop: 10 } }, "运行设置"),
      h("div", { className: "rhui-grid2" },
        h("div", { className: "rhui-field" }, h("span", { className: "rhui-label" }, "scratch"), h("input", { className: "rhui-input", value: draft.scratch, onChange: (e) => setDraft({ ...draft, scratch: e.target.value }) })),
        h("div", { className: "rhui-field" }, h("span", { className: "rhui-label" }, "并发上限"), h("input", { className: "rhui-input", value: draft.maxConcurrent, onChange: (e) => setDraft({ ...draft, maxConcurrent: e.target.value }) })),
        h("div", { className: "rhui-field" }, h("span", { className: "rhui-label" }, "作业超时(分钟)"), h("input", { className: "rhui-input", value: draft.timeoutMinutes, onChange: (e) => setDraft({ ...draft, timeoutMinutes: e.target.value }) })),
      ),
      h("div", { className: "rhui-save" }, h("button", { className: "rhui-btn", disabled: !!busy, onClick: () => act("保存设置…", () => api("update-host", { host: host.id, patch: draft })) }, "保存设置")),
      h("div", { className: "rhui-sec-title", style: { marginTop: 10 } }, "配置与探测（JSON）"),
      h("div", { className: "rhui-detail" }, JSON.stringify(host, null, 2)),
    ) : null,
  )
}

function ProjectSection() {
  const [root, setRoot] = React.useState("")
  const [info, setInfo] = React.useState(null)
  const [busy, setBusy] = React.useState("")
  const [msg, setMsg] = React.useState("")
  const load = async (path) => {
    if (!path) { setInfo(null); setMsg(""); return }
    setBusy("读取项目数据…"); setMsg("")
    try {
      const r = await api("project-info", { root: path })
      if (r && r.ok === false) throw new Error(r.error)
      setInfo(r)
      setMsg(r.allowlistFile ? "白名单：" + r.allowlistFile + " ｜ 作业：" + r.jobsFile : "未找到项目数据（.dsh/remotes/ 不存在）")
    } catch (e) { setMsg(String(e.message)) } finally { setBusy("") }
  }
  const revoke = async (hid) => {
    if (!info || !root) return
    setBusy("撤销中…")
    try {
      const r = await api("revoke", { root, host: hid })
      if (r && r.ok === false) setMsg(r.error)
      else { setMsg("已撤销 " + hid + " 在本项目的授权"); await load(root) }
    } catch (e) { setMsg(String(e.message)) } finally { setBusy("") }
  }
  const stColor = { running: "var(--dsw-alias-brand-primary)", succeeded: "var(--dsw-alias-state-success-primary)", failed: "var(--dsw-alias-state-error-primary)", killed: "var(--dsw-alias-state-warn-primary)", submitted: "var(--dsw-alias-state-warn-primary)", unknown: "var(--dsw-alias-label-tertiary)" }
  return h("div", { className: "rhui-card" },
    h("div", { className: "rhui-sec-title" }, "项目访问白名单与作业（按 project 隔离）"),
    h("div", { className: "rhui-row", style: { marginTop: 6 } },
      h("input", { className: "rhui-input", style: { flex: 1 }, value: root, onChange: (e) => setRoot(e.target.value), placeholder: "项目根目录（如 /Users/me/projA），留空跳过" }),
      h("button", { className: "rhui-btn", disabled: !!busy || !root, onClick: () => load(root) }, "加载"),
    ),
    msg ? h("div", { className: "rhui-meta", style: { marginTop: 4 } }, msg) : null,
    info ? h("div", { style: { marginTop: 8 } },
      h("div", { className: "rhui-label" }, "白名单（" + info.allowlist.length + "）"),
      info.allowlist.length === 0 ? h("div", { className: "rhui-empty" }, "暂无授权主机——首次使用主机会弹审批自动加入") :
        info.allowlist.map((x) => h("div", { className: "rhui-row", key: x.host, style: { marginTop: 4 } },
          h("span", { className: "rhui-hostid", style: { fontSize: 12 } }, x.host),
          h("span", { className: "rhui-meta" }, "授权于 " + (x.grantedAt || "").slice(0, 19).replace("T", " ") + (x.note ? " ｜ " + x.note : "")),
          h("div", { style: { flex: 1 } }),
          h("button", { className: "rhui-btn rhui-btn-danger", disabled: !!busy, onClick: () => revoke(x.host) }, "撤销"),
        )),
      h("div", { className: "rhui-label", style: { marginTop: 8 } }, "作业（最近 " + info.jobs.length + "）"),
      h("div", { className: "rhui-row", style: { marginTop: 4 } },
        Object.keys(info.counts).length === 0 ? h("span", { className: "rhui-empty" }, "暂无作业") :
          Object.entries(info.counts).map(([s, n]) => h("span", { className: "rhui-count", style: { color: stColor[s] || "#555" } }, s + ": " + n)),
      ),
      info.jobs.length ? h("div", { className: "rhui-detail" }, info.jobs.map((j) => j.id + " [" + j.state + "] " + j.title + "（" + j.host + (j.exitCode != null ? ", exit=" + j.exitCode : "") + "）").join("\n")) : null,
    ) : null,
  )
}

function Page() {
  const [cfg, setCfg] = React.useState(null)
  const [hosts, setHosts] = React.useState(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [addOpen, setAddOpen] = React.useState(false)
  const refresh = React.useCallback(async () => {
    setBusy("加载中…"); setError("")
    try {
      const [c, hh] = await Promise.all([api("config"), api("list")])
      if (c && c.ok === false) throw new Error(c.error)
      if (hh && hh.ok === false) throw new Error(hh.error)
      setCfg(c); setHosts((hh && hh.hosts) || [])
    } catch (e) { setError(String(e.message)) } finally { setBusy("") }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  return h("div", { className: "rhui" },
    h("div", { className: "rhui-head" },
      h("span", { className: "rhui-title" }, "远程主机（Remote Hosts）"),
      h("span", { className: "rhui-meta" }, "共 " + (hosts ? hosts.length : "…") + " 台"),
      busy ? h("span", { className: "rhui-busy" }, busy) : null,
      h("div", { style: { flex: 1 } }),
      h("button", { className: "rhui-btn", disabled: !!busy, onClick: refresh }, "刷新"),
      h("button", { className: "rhui-btn rhui-btn-primary", disabled: !!busy, onClick: () => setAddOpen(true) }, "＋ 添加主机"),
    ),
    cfg && cfg.hostsFile ? h("div", { className: "rhui-hint" }, "主机注册表：" + cfg.hostsFile + "（全机共享；白名单/作业按项目存于各项目 .dsh/remotes/）") : null,
    error ? h("div", { className: "rhui-err" }, error) : null,
    addOpen ? h(AddForm, { onDone: () => { setAddOpen(false); refresh() } }) : null,
    hosts === null ? h("div", { className: "rhui-empty" }, "加载中…") :
      hosts.length === 0 ? h("div", { className: "rhui-empty" }, "暂无主机。点“添加主机”注册。") :
        hosts.map((x) => h(HostCard, { key: x.id, host: x, onRefresh: refresh, onMsg: setError })),
    h(ProjectSection, null),
  )
}

function apply(ctx) {
  const slots = ctx.get("slots")
  if (slots === undefined) return
  // 注入样式（data-plugin 标签会被 client-modules 认领，随插件清理）
  const tagId = "dsh-science/remote-hosts-ui.css"
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
    const tag = document.createElement("style")
    tag.dataset.plugin = "dsh-science"
    tag.dataset.pluginCss = tagId
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  slots.inject("settings.section", () => slots.register(
    { name: "settings.section", id: "remote-hosts", order: 5, label: "远程主机" },
    (props) => h(Page, null),
  ))
  // 科研工作台面板（多项目分类/状态管理），来自同一 bundle 的 workbench.js（拼接注入）
  applyWorkbench(ctx)
}

// 构建脚本会把 `module.exports = plugin` 追加到包装末尾（factory 内导出）。
const plugin = { name: "remote-hosts-ui", inject: ["slots"], apply }
		//#endregion
		module.exports = plugin;
		return module.exports;
	}
});
