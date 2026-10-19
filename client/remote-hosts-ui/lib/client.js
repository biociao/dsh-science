window.__ModuleLoader__.load({
	id: "dsh-science",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		//#region dsh-science/client/remote-hosts-ui/src
// dsh-science Codex 式侧栏增强 —— Client 侧（DOM 增强，纯浏览器 API + fetch）
//
// 背景：DSH 的左侧栏（brand / New session / 全局面板行 / 工作区·会话浏览区 / 设置）
// 中，浏览区由 shell 的 `sidebar.workspaces` **single slot** 提供，插件无法再注册
// 第二个 occupant。因此本文件的增强走 DOM 层：在真实侧栏 DOM 上叠加
//
//   1. 「置顶」项目区（pinned projects）：工作区行右键「置顶项目」后出现在会话列表上方，
//      可点击展开/收起对应工作区、可悬停看项目卡、可右键管理；
//   2. 工作区行右键菜单：置顶/取消置顶、在 Finder 中显示、打开项目目录、复制路径、
//      在新会话中打开项目、展开/收起会话（原生「...」菜单只有重命名/移除）；
//   3. 悬停信息：原生工作区悬停卡（名称/路径/创建时间）追加上「会话数 / 最近活跃 /
//      已置顶」与快捷操作；置顶区行有独立项目卡。
//
// 数据：优先读取平台 client 服务（ctx.get("workspaces") / ctx.get("sessions")）的
// 快照（与原生列表同一份数据）；置顶状态与「在文件管理器中打开」经宿主路由
// /dsh-science/sidebar/*（engines/sidebar-ui.mjs）落地，置顶按 workspaceId 持久化在
// $DSH_HOME/dsh-science/sidebar.json。
//
// 稳定性：所有 DOM 锚点都基于 DSH 语义属性而非 CSS Module 哈希类名
// （[data-row-key^="workspace:"]、role、aria-label、原生 hover 卡的 *_hoverContent 局部名），
// 并用 MutationObserver 在 React 重渲染后自动恢复注入节点。

// ── 主题与样式（全部走 shell 的 --dsw-alias-* 变量，亮/暗色自动适配）──────────
const SIDEBAR_CSS = `
.dshsci-section{flex:none;display:flex;flex-direction:column;min-width:0;margin:2px 0 0}
.dshsci-section.is-hidden{display:none}
.dshsci-section-head{display:flex;align-items:center;gap:4px;height:36px;padding:0 4px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:20px;font-weight:400;user-select:none}
.dshsci-section-head-btn{display:inline-flex;align-items:center;gap:4px;border:0;background:0 0;color:inherit;font:inherit;font-weight:inherit;cursor:pointer;padding:0;border-radius:4px}
.dshsci-section-head-btn:focus-visible{outline:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));outline-offset:2px}
.dshsci-section-caret{display:inline-flex;transition:transform .12s ease;transform:rotate(90deg);opacity:.85}
.dshsci-section.is-collapsed .dshsci-section-caret{transform:rotate(0deg)}
.dshsci-section-count{margin-inline-start:auto;font-size:11px;font-variant-numeric:tabular-nums;opacity:.9}
.dshsci-section-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.dshsci-section.is-collapsed .dshsci-section-body{display:none}
.dshsci-section-empty{padding:2px 8px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshsci-recent-row{position:relative;display:flex;align-items:center;gap:6px;height:28px;min-width:0;padding:0 6px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;user-select:none}
.dshsci-recent-row:hover,.dshsci-recent-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dshsci-recent-ico{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dshsci-recent-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-recent-time{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsci-recent-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dshsci-workspaces-toggle{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;background:0 0;color:inherit;font:inherit;cursor:pointer;border-radius:4px}
.dshsci-workspaces-toggle:focus-visible{outline:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));outline-offset:2px}
/* 整个中段（置顶 + 工作区 + 最近）共用一个滚动容器：置顶/最近不再各自限高滚动，
   避免展开大量会话时把「工作区 / 最近」挤掉。 */
[data-dshsci-scroll="1"]{overflow-y:auto;overflow-x:hidden}
[data-dshsci-scroll="1"] > div:not([data-dshsci-section]){flex:0 0 auto;min-height:0}
[data-dshsci-scroll="1"] [data-dshsci-browser="1"]{flex:0 0 auto;height:auto;min-height:0;overflow:visible}
[data-dshsci-scroll="1"] [data-dshsci-browser="1"] > [class*="_listArea"]{flex:0 0 auto;min-height:0;overflow:visible}
[data-dshsci-scroll="1"] [class*="_treeBody"]{flex:0 0 auto;min-height:0;height:auto}
[data-dshsci-scroll="1"] [class*="_list"]{flex:0 0 auto!important;height:auto!important;max-height:none!important;overflow:visible!important;padding-bottom:8px}
[data-dshsci-scroll="1"] [class*="_fade"]{display:none}
[data-dshsci-scroll="1"] .dshsci-section-body{overflow:visible;max-height:none}
[data-dshsci-workspaces="collapsed"] .dshsci-workspaces-toggle .dshsci-section-caret{transform:rotate(0deg)}
[data-dshsci-workspaces="collapsed"] > [class*="_listArea"]{display:none!important}
[data-dshsci-workspaces="collapsed"] [class*="_sectionHeader"]{justify-content:flex-start}
[data-dshsci-workspaces="collapsed"] [class*="_sectionHeader"] [class*="_searchSlot"],
[data-dshsci-workspaces="collapsed"] [class*="_sectionHeader"] [class*="_headerActions"]{display:none!important}
.dshsci-pinned-row{position:relative;display:flex;align-items:center;gap:6px;height:34px;min-width:0;padding:0 8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;user-select:none}
.dshsci-pinned-row:hover,.dshsci-pinned-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dshsci-pin-ico{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dshsci-pinned-row .dshsci-pinned-caret{display:none}
.dshsci-pinned-row:hover .dshsci-pinned-caret,.dshsci-pinned-row:focus-within .dshsci-pinned-caret{display:inline-flex}
.dshsci-pinned-row:hover .dshsci-pin-ico,.dshsci-pinned-row:focus-within .dshsci-pin-ico{display:none}
.dshsci-pinned-row:hover .dshsci-row-pin{opacity:0}
.dshsci-pinned-more{display:none;flex:none;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.dshsci-pinned-row:hover .dshsci-pinned-more,.dshsci-pinned-row:focus-within .dshsci-pinned-more{display:inline-flex}
.dshsci-pinned-more:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsci-pinned-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-count{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsci-pinned-new{display:none;flex:none;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.dshsci-pinned-row:hover .dshsci-pinned-new,.dshsci-pinned-row:focus-within .dshsci-pinned-new{display:inline-flex}
.dshsci-pinned-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsci-pinned-caret{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;background:0 0;color:inherit;font:inherit;cursor:pointer;border-radius:4px;opacity:.85}
.dshsci-pinned-caret:hover{opacity:1}
.dshsci-pinned-caret:focus-visible{outline:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));outline-offset:2px}
.dshsci-pinned-caret .dshsci-section-caret{transform:rotate(0deg)}
.dshsci-pinned-row.is-open .dshsci-pinned-caret .dshsci-section-caret{transform:rotate(90deg)}
.dshsci-pinned-session{display:flex;align-items:center;gap:4px;height:32px;min-width:0;padding:0 8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;user-select:none}
.dshsci-pinned-session:hover,.dshsci-pinned-session:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dshsci-session-slot{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px}
.dshsci-session-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dshsci-pinned-session .dshsci-recent-time{font-size:11px}
.dshsci-pinned-more-sessions{display:flex;align-items:center;min-height:26px;margin:0;padding:0 8px 0 26px;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left;border-radius:var(--dsw-radius-md,8px)}
.dshsci-pinned-more-sessions:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsci-row-pin{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:inline-flex;pointer-events:none;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
[data-row-key^="workspace:"]:hover .dshsci-row-pin,[data-row-key^="workspace:"]:focus-within .dshsci-row-pin{opacity:0}
[data-row-key^="workspace:"]{position:relative}
.dshsci-menu{position:fixed;z-index:2147483000;min-width:248px;max-width:380px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 10px 34px rgba(0,0,0,.18);font-size:13px;line-height:20px;user-select:none}
.dshsci-menu-head{display:flex;flex-direction:column;gap:2px;padding:6px 8px 8px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshsci-menu-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-menu-path{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:8px;background:0 0;color:inherit;font:inherit;cursor:pointer;text-align:left}
.dshsci-menu-item:hover,.dshsci-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dshsci-menu-item.is-danger{color:var(--dsw-alias-state-error-primary)}
.dshsci-menu-item svg{flex:none;opacity:.75}
.dshsci-menu-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l2)}
.dshsci-pop{position:fixed;z-index:2147483000;min-width:264px;max-width:400px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 10px 34px rgba(0,0,0,.18);font-size:12px;line-height:18px}
.dshsci-pop-title{font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-pop-path{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.dshsci-hover-extra{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px}
.dshsci-hover-stats{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dshsci-hover-stats b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsci-hover-chip{margin-inline-start:auto;padding:0 6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.dshsci-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483000;max-width:520px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 10px 34px rgba(0,0,0,.18);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsci-toast.is-error{color:var(--dsw-alias-state-error-primary)}
`

// ── 纯函数（无 DOM；供 test/sidebar-client.test.mjs 通过 plugin._sidebarTest 断言）──

/** HTML 转义（所有插入 innerHTML 的文本都必须经过它）。 */
function sbEscapeHtml(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, (ch) => (
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  ))
}

/** 「N 分钟前」形式的时间；数值按毫秒时间戳处理。 */
function sbRelativeTime(timestamp, now) {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || ts <= 0) return ""
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const diff = Math.max(0, current - ts)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return "刚刚"
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return "昨天"
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 平台对应的「在文件管理器中显示」文案。 */
function sbRevealLabel(platform) {
  const p = String(platform || "")
  if (p === "darwin" || p === "mac" || p === "macos") return "在 Finder 中显示"
  if (p === "win32" || p === "windows") return "在资源管理器中显示"
  return "在文件管理器中显示"
}

/** 右键菜单条目模型（纯数据，便于单测与实际渲染共用）。 */
function sbMenuModel(info) {
  const pinned = Boolean(info && info.pinned)
  return [
    { act: pinned ? "unpin" : "pin", label: pinned ? "取消置顶项目" : "置顶项目", icon: "pin" },
    { act: "reveal", label: sbRevealLabel(info && info.platform), icon: "folder" },
    { act: "open", label: "打开项目目录", icon: "external" },
    { act: "copy", label: "复制项目路径", icon: "copy" },
    { sep: true },
    { act: "new", label: "在新会话中打开项目", icon: "plus" },
    { act: "toggle", label: "展开 / 收起会话", icon: "chevron" },
  ]
}

/** 把菜单限制在视口内（先右/下展开，越界则翻转，最后夹紧）。 */
function sbClampMenuPosition(x, y, width, height, viewportWidth, viewportHeight, margin = 8) {
  const vw = Math.max(0, Number(viewportWidth) || 0)
  const vh = Math.max(0, Number(viewportHeight) || 0)
  const w = Math.max(0, Number(width) || 0)
  const h = Math.max(0, Number(height) || 0)
  const m = Math.max(0, Number(margin) || 0)
  let left = Number(x) || 0
  let top = Number(y) || 0
  if (vw > 0 && left + w + m > vw) left = Math.max(m, vw - w - m)
  if (vh > 0 && top + h + m > vh) top = Math.max(m, vh - h - m)
  return { left: Math.round(left), top: Math.round(top) }
}

/** 会话统计：非空白会话数、运行中数量、最近活跃时间（毫秒）。 */
function sbSessionStats(workspace, sessionsById) {
  if (!workspace || !Array.isArray(workspace.sessionIds)) return { count: 0, running: 0, lastActive: 0 }
  let count = 0
  let running = 0
  let lastActive = 0
  for (const id of workspace.sessionIds) {
    const summary = sessionsById ? sessionsById[id] : undefined
    if (!summary) continue
    if (summary.blank) continue
    count += 1
    if (summary.running) running += 1
    const updated = Number(summary.updatedAt)
    if (Number.isFinite(updated) && updated > lastActive) lastActive = updated
  }
  return { count, running, lastActive }
}

/** 规范化宿主返回的置顶列表：去掉坏条目，去重，按 pinnedAt 倒序（最新置顶在前）。 */
function sbNormalizePins(raw) {
  const list = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const workspaceId = typeof item.workspaceId === "string" ? item.workspaceId.trim() : ""
    if (!workspaceId || seen.has(workspaceId)) continue
    seen.add(workspaceId)
    out.push({
      workspaceId,
      path: typeof item.path === "string" ? item.path : "",
      title: typeof item.title === "string" ? item.title : "",
      pinnedAt: typeof item.pinnedAt === "string" ? item.pinnedAt : "",
    })
  }
  return out
}

// ── DOM 层 ───────────────────────────────────────────────────────────

const SIDEBAR_ROW_SEL = '[data-row-key^="workspace:"]'
const SIDEBAR_ROW_PREFIX = "workspace:"
const SIDEBAR_PINNED_CLS = "dshsci-pinned-row"
const NATIVE_CARD_SEL = 'body > div[role="button"][aria-label^="Copy: "]'
const SECTION_ATTR = "data-dshsci-section"
const HOVER_EXTRA_CLS = "dshsci-hover-extra"
const HOVER_DELAY_MS = 240
const PINNED_COLLAPSED_KEY = "dsh-science/sidebar/pinned-collapsed"
const RECENTS_COLLAPSED_KEY = "dsh-science/sidebar/recents-collapsed"
const WORKSPACES_COLLAPSED_KEY = "dsh-science/sidebar/workspaces-collapsed"
const PINNED_EXPANDED_KEY = "dsh-science/sidebar/pinned-expanded"
const RECENTS_LIMIT = 20
const PINNED_SESSION_WATERMARK = 5

const sbIcon = (name) => {
  const svg = (paths) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  switch (name) {
    case "pin": return svg('<path d="M6.2 2.4h3.6l-.5 3.1 2 2v1.2H4.7V7.5l2-2-.5-3.1Z"/><path d="M8 8.7v4.9"/>')
    case "folder": return svg('<path d="M2.4 5.2c0-.7.5-1.2 1.2-1.2h2.1l1.1 1.2h4.6c.7 0 1.2.5 1.2 1.2v4.4c0 .7-.5 1.2-1.2 1.2H3.6c-.7 0-1.2-.5-1.2-1.2V5.2Z"/>')
    case "external": return svg('<path d="M9.2 3.2h3.6v3.6"/><path d="M12.8 3.2 7.4 8.6"/><path d="M12.4 9.6v2.6c0 .4-.3.7-.7.7H3.9c-.4 0-.7-.3-.7-.7V4.4c0-.4.3-.7.7-.7h2.6"/>')
    case "copy": return svg('<rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1.4"/><path d="M10.6 5.4V4.2c0-.6-.5-1.1-1.1-1.1H4.2c-.6 0-1.1.5-1.1 1.1v5.3c0 .6.5 1.1 1.1 1.1h1.2"/>')
    case "plus": return svg('<path d="M8 3.6v8.8"/><path d="M3.6 8h8.8"/>')
    case "chevron": return svg('<path d="m6 4.2 3.8 3.8L6 11.8"/>')
    case "ellipsis": return svg('<circle cx="3.4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.6" cy="8" r="1" fill="currentColor" stroke="none"/>')
    case "chat": return svg('<path d="M2.8 4.2c0-.8.6-1.4 1.4-1.4h7.6c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H7.4L4.4 13v-2.2H4.2c-.8 0-1.4-.6-1.4-1.4V4.2Z"/>')
    case "caret": return svg('<path d="m6 4.2 3.8 3.8L6 11.8"/>')
    default: return ""
  }
}

/** 宿主 REST 调用（与脚本里其它面板同一约定：POST JSON）。 */
function sbApi(method, body) {
  return fetch("/dsh-science/sidebar/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (res) => {
    let payload = null
    try { payload = await res.json() } catch { /* 宿主未安装时可能返回空响应 */ }
    if (!payload || typeof payload !== "object") throw new Error("宿主未响应（HTTP " + res.status + "）")
    return payload
  })
}

/** 侧栏增强入口：由 index.js 的 apply 调用。 */
function applySidebar(ctx) {
  if (typeof window === "undefined" || typeof document === "undefined") return
  if (typeof fetch !== "function") return

  const state = {
    pins: [],
    platform: "",
    view: new Map(),
    pinnedEl: null,
    recentsEl: null,
    menu: null,
    pop: null,
    toast: null,
    toastTimer: 0,
    hoverRow: null,
    hoverTimer: 0,
    hoverRestoreTimer: 0,
    hideTimer: 0,
    nativeCardObserver: null,
    nativeMenuObserver: null,
    nativeMenuTimer: 0,
    nativeMenuFallback: 0,
    pendingNativeMenu: "",
    pinnedCollapsed: false,
    recentsCollapsed: false,
    workspacesCollapsed: false,
    pinnedExpanded: new Set(),
    pinnedWatermark: new Map(),
    pinnedItems: [],
    sig: "",
    servicesReady: false,
    unsubs: [],
    observers: [],
    intervals: [],
    disposed: false,
  }

  // 样式注入：data-plugin / data-plugin-css 会被 client-modules 认领并随插件清理。
  const cssTagId = "dsh-science/sidebar-ui.css"
  let cssTag = document.querySelector('style[data-plugin-css="' + cssTagId + '"]')
  if (cssTag === null) {
    cssTag = document.createElement("style")
    cssTag.dataset.plugin = "dsh-science"
    cssTag.dataset.pluginCss = cssTagId
    cssTag.textContent = SIDEBAR_CSS
    document.head.appendChild(cssTag)
  }

  try {
    state.pinnedCollapsed = window.localStorage.getItem(PINNED_COLLAPSED_KEY) === "1"
    state.recentsCollapsed = window.localStorage.getItem(RECENTS_COLLAPSED_KEY) === "1"
    state.workspacesCollapsed = window.localStorage.getItem(WORKSPACES_COLLAPSED_KEY) === "1"
    const expanded = JSON.parse(window.localStorage.getItem(PINNED_EXPANDED_KEY) || "[]")
    if (Array.isArray(expanded)) state.pinnedExpanded = new Set(expanded.filter((id) => typeof id === "string"))
  } catch { state.pinnedCollapsed = false; state.recentsCollapsed = false; state.workspacesCollapsed = false }

  const safeGet = (name) => {
    try { return ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined } catch { return undefined }
  }

  const bindServices = () => {
    const ws = safeGet("workspaces")
    const ss = safeGet("sessions")
    if (!ws && !ss) return false
    try {
      if (ws && ws.list && typeof ws.list.subscribe === "function") state.unsubs.push(ws.list.subscribe(scheduleSync))
      if (ss && ss.list && typeof ss.list.subscribe === "function") state.unsubs.push(ss.list.subscribe(scheduleSync))
    } catch { /* 服务形状不同则退化为 DOM MutationObserver 刷新 */ }
    return true
  }

  const readData = () => {
    let workspaces = null
    let sessionsById = null
    let sessionIds = null
    let archivedSessionIds = []
    let pinnedSessionIds = []
    try {
      const ws = safeGet("workspaces")
      const snapshot = ws && ws.list && ws.list.getSnapshot ? ws.list.getSnapshot() : null
      if (snapshot && Array.isArray(snapshot.items)) workspaces = snapshot.items
      if (snapshot && Array.isArray(snapshot.archivedSessionIds)) archivedSessionIds = snapshot.archivedSessionIds
      if (snapshot && Array.isArray(snapshot.pinnedSessionIds)) pinnedSessionIds = snapshot.pinnedSessionIds
    } catch { /* ignore */ }
    try {
      const ss = safeGet("sessions")
      const snapshot = ss && ss.list && ss.list.getSnapshot ? ss.list.getSnapshot() : null
      if (snapshot && snapshot.byId && typeof snapshot.byId === "object") {
        sessionsById = snapshot.byId
        sessionIds = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId)
      }
    } catch { /* ignore */ }
    return { workspaces, sessionsById, sessionIds, archivedSessionIds, pinnedSessionIds }
  }

  const findBrowserRoot = (row) => {
    let node = row
    for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1, node = node.parentElement) {
      const children = node.children || []
      for (const child of children) {
        if (typeof child.className === "string" && child.className.includes("_sectionHeader")) return node
      }
    }
    return null
  }

  const findRegion = (root) => {
    let node = root
    for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1, node = node.parentElement) {
      const cls = typeof node.className === "string" ? node.className : ""
      if (cls.includes("_regionArea")) return node
    }
    return null
  }

  const createSection = (kind) => {
    const el = document.createElement("div")
    el.className = "dshsci-section is-hidden"
    el.setAttribute(SECTION_ATTR, kind)
    return el
  }

  // 置顶/最近是与原生「工作区」平行的两个 section：置顶插在浏览区之前，
  // 最近插在浏览区之后、侧栏 footer 之前（Codex 的 Pinned / Projects / Recents 顺序）。
  const ensureSections = (root) => {
    if (!state.pinnedEl) state.pinnedEl = createSection("pinned")
    if (!state.recentsEl) state.recentsEl = createSection("recents")
    if (!root) {
      state.pinnedEl.classList.add("is-hidden")
      state.recentsEl.classList.add("is-hidden")
      resetScrollMarkers()
      return false
    }
    const region = findRegion(root)
    const wrapper = root.parentElement
    if (!region || !wrapper || wrapper.parentElement !== region) {
      // 兜底：找不到 regionArea 时把置顶区塞进浏览区顶部（视觉略差但不丢功能）。
      if (state.pinnedEl.parentElement !== root) root.insertBefore(state.pinnedEl, root.firstChild)
      state.recentsEl.classList.add("is-hidden")
      return true
    }
    // 置顶 / 工作区 / 最近 都放进 regionArea 这一个滚动容器：置顶在前、最近在后。
    if (state.pinnedEl.parentElement !== region || state.pinnedEl.nextElementSibling !== wrapper) {
      region.insertBefore(state.pinnedEl, wrapper)
    }
    if (state.recentsEl.parentElement !== region || state.recentsEl.previousElementSibling !== wrapper) {
      region.insertBefore(state.recentsEl, wrapper.nextSibling)
    }
    region.setAttribute("data-dshsci-scroll", "1")
    root.setAttribute("data-dshsci-browser", "1")
    ensureWorkspacesToggle(root)
    return true
  }

  const resetScrollMarkers = () => {
    for (const region of document.querySelectorAll("[data-dshsci-scroll]")) region.removeAttribute("data-dshsci-scroll")
    for (const root of document.querySelectorAll("[data-dshsci-browser]")) root.removeAttribute("data-dshsci-browser")
  }

  // 原生「工作区」sectionHeader 没有折叠控件：注入一个与置顶/最近一致的 caret 按钮，
  // 折叠时隐藏 listArea 与搜索/添加图标，并让 region 让出高度给「最近」。
  const ensureWorkspacesToggle = (root) => {
    const header = Array.prototype.find.call(root.children, (child) => typeof child.className === "string" && child.className.includes("_sectionHeader"))
    if (!header) return
    let toggle = header.querySelector(":scope > .dshsci-workspaces-toggle")
    if (!toggle) {
      toggle = document.createElement("button")
      toggle.type = "button"
      toggle.className = "dshsci-workspaces-toggle"
      toggle.setAttribute("data-dshsci-act", "toggle-workspaces")
      toggle.setAttribute("aria-label", "展开 / 收起工作区")
      toggle.innerHTML = '<span class="dshsci-section-caret">' + sbIcon("caret") + "</span>"
      header.insertBefore(toggle, header.firstChild)
    }
    root.setAttribute("data-dshsci-workspaces", state.workspacesCollapsed ? "collapsed" : "expanded")
    toggle.setAttribute("aria-expanded", state.workspacesCollapsed ? "false" : "true")
    toggle.title = state.workspacesCollapsed ? "展开工作区" : "收起工作区"
  }

  const buildView = (rows, workspaces, sessionsById) => {
    const byId = new Map()
    if (Array.isArray(workspaces)) {
      for (const ws of workspaces) if (ws && ws.workspaceId !== undefined) byId.set(String(ws.workspaceId), ws)
    }
    const pinsById = new Map(state.pins.map((pin) => [pin.workspaceId, pin]))
    const view = new Map()
    for (const row of rows) {
      const key = String(row.getAttribute("data-row-key") || "")
      const workspaceId = key.slice(SIDEBAR_ROW_PREFIX.length)
      if (!workspaceId) continue
      const ws = byId.get(workspaceId)
      const pin = pinsById.get(workspaceId)
      const title = (ws && ws.title) || (pin && pin.title) || String(row.textContent || "").trim()
      const workspacePath = (ws && ws.path) || (pin && pin.path) || ""
      view.set(workspaceId, {
        workspaceId,
        title,
        path: workspacePath,
        pinned: pinsById.has(workspaceId),
        stats: sbSessionStats(ws, sessionsById),
      })
    }
    return { byId, view }
  }

  const buildPinnedList = (byId, view, data) => {
    const sessionsById = data.sessionsById
    const archived = new Set(data.archivedSessionIds || [])
    const list = []
    for (const pin of state.pins) {
      const ws = byId.get(pin.workspaceId)
      const rendered = view.get(pin.workspaceId)
      if (!ws && !rendered) continue // 工作区已注销：不展示悬空置顶
      const title = (ws && ws.title) || (rendered && rendered.title) || pin.title || pin.workspaceId
      const workspacePath = (ws && ws.path) || (rendered && rendered.path) || pin.path || ""
      // 置顶项目内联展示它的会话（与 Codex 的 pinned project 展开一致）：
      // 排除空白草稿/子代理/已归档，按最近活跃倒序。
      const sessions = (ws && Array.isArray(ws.sessionIds) ? ws.sessionIds : [])
        .map((id) => (sessionsById ? sessionsById[id] : undefined))
        .filter((summary) => summary && !summary.blank && summary.origin !== "subagent" && !archived.has(summary.id))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .map((summary) => ({
          id: summary.id,
          title: summary.displayTitle || summary.title || title,
          updatedAt: Number(summary.updatedAt) || 0,
          running: Boolean(summary.running),
        }))
      list.push({
        workspaceId: pin.workspaceId,
        title,
        path: workspacePath,
        pinned: true,
        stats: sbSessionStats(ws, sessionsById),
        sessions,
      })
    }
    return list
  }

  // 最近会话：跨工作区按 updatedAt 倒序（排除空白草稿、子代理、已归档），最多 RECENTS_LIMIT 条。
  const buildRecents = (data, byId) => {
    if (!Array.isArray(data.sessionIds) || !data.sessionsById) return []
    const archived = new Set(data.archivedSessionIds || [])
    const pinnedSessions = new Set(data.pinnedSessionIds || [])
    const owner = new Map()
    for (const ws of byId.values()) for (const id of ws.sessionIds || []) if (!owner.has(id)) owner.set(id, ws)
    const rows = []
    for (const id of data.sessionIds) {
      const summary = data.sessionsById[id]
      if (!summary || summary.blank || summary.origin === "subagent") continue
      if (archived.has(id)) continue
      const ws = owner.get(id)
      rows.push({
        id,
        title: summary.displayTitle || summary.title || (ws && ws.title) || String(id),
        updatedAt: Number(summary.updatedAt) || 0,
        running: Boolean(summary.running),
        workspaceTitle: ws ? ws.title : "",
        pinned: pinnedSessions.has(id),
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.title < b.title ? -1 : 1))
    return { rows: rows.slice(0, RECENTS_LIMIT), total: rows.length }
  }

  const sectionHeadHtml = (kind, label, count, collapsed) => {
    return '<div class="dshsci-section-head">'
      + '<button type="button" class="dshsci-section-head-btn" data-dshsci-act="toggle-section"'
      + ' data-dshsci-section-kind="' + kind + '" aria-expanded="' + (collapsed ? "false" : "true") + '"'
      + ' title="' + (collapsed ? "展开" + label : "收起" + label) + '">'
      + '<span class="dshsci-section-caret">' + sbIcon("caret") + "</span><span>" + sbEscapeHtml(label) + "</span>"
      + "</button>"
      + (count === "" || count === undefined ? "" : '<span class="dshsci-section-count">' + count + "</span>")
      + "</div>"
  }

  const pinnedSessionRowHtml = (session) => {
    return '<div class="dshsci-pinned-session" role="treeitem" tabindex="0"'
      + ' data-dshsci-session="' + sbEscapeHtml(session.id) + '"'
      + ' title="' + sbEscapeHtml(session.title) + '">'
      + '<span class="dshsci-session-slot">' + (session.running ? '<span class="dshsci-session-dot" title="运行中"></span>' : "") + "</span>"
      + '<span class="dshsci-recent-title">' + sbEscapeHtml(session.title) + "</span>"
      + '<span class="dshsci-recent-time">' + sbEscapeHtml(session.updatedAt ? sbRelativeTime(session.updatedAt) : "") + "</span>"
      + "</div>"
  }

  const pinnedSessionsHtml = (item) => {
    const all = item.sessions
    if (all.length === 0) return ""
    const watermark = state.pinnedWatermark.get(item.workspaceId) || PINNED_SESSION_WATERMARK
    const expanded = watermark >= all.length
    const visible = expanded ? all : all.slice(0, watermark)
    const hidden = all.length - visible.length
    let html = visible.map(pinnedSessionRowHtml).join("")
    if (hidden > 0) {
      html += '<button type="button" class="dshsci-pinned-more-sessions" data-dshsci-act="pinned-more-sessions" data-dshsci-ws="'
        + sbEscapeHtml(item.workspaceId) + '">展开其余 ' + hidden + " 个会话</button>"
    } else if (all.length > PINNED_SESSION_WATERMARK) {
      html += '<button type="button" class="dshsci-pinned-more-sessions" data-dshsci-act="pinned-collapse-sessions" data-dshsci-ws="'
        + sbEscapeHtml(item.workspaceId) + '">收起会话</button>'
    }
    return html
  }

  const pinnedRowsHtml = (pinnedList) => pinnedList.map((item) => {
    const open = state.pinnedExpanded.has(item.workspaceId)
    const row = '<div class="' + SIDEBAR_PINNED_CLS + (open ? " is-open" : "") + '" role="treeitem" tabindex="0"'
      + ' data-dshsci-ws="' + sbEscapeHtml(item.workspaceId) + '"'
      + ' aria-expanded="' + (open ? "true" : "false") + '"'
      + ' title="' + sbEscapeHtml(item.path || item.title) + '">'
      + '<button type="button" class="dshsci-pinned-caret" data-dshsci-act="toggle-pinned" data-dshsci-ws="' + sbEscapeHtml(item.workspaceId) + '"'
      + ' aria-label="' + (open ? "收起会话" : "展开会话") + '" aria-expanded="' + (open ? "true" : "false") + '">'
      + '<span class="dshsci-section-caret">' + sbIcon("caret") + "</span></button>"
      + '<span class="dshsci-pin-ico">' + sbIcon("folder") + "</span>"
      + '<span class="dshsci-pinned-name">' + sbEscapeHtml(item.title) + "</span>"
      + '<span class="dshsci-row-pin" title="已置顶" aria-label="已置顶">' + sbIcon("pin") + "</span>"
      + '<button type="button" class="dshsci-pinned-more" data-dshsci-act="more" data-dshsci-ws="' + sbEscapeHtml(item.workspaceId) + '" title="项目操作" aria-label="项目操作">' + sbIcon("ellipsis") + "</button>"
      + '<button type="button" class="dshsci-pinned-new" data-dshsci-act="new" data-dshsci-ws="' + sbEscapeHtml(item.workspaceId) + '" title="新建会话" aria-label="新建会话">' + sbIcon("plus") + "</button>"
      + "</div>"
    if (!open) return row
    return row + pinnedSessionsHtml(item)
  }).join("")

  const recentsRowsHtml = (recents) => recents.map((item) => {
    const title = item.title + (item.workspaceTitle ? " · " + item.workspaceTitle : "")
    return '<div class="dshsci-recent-row" role="treeitem" tabindex="0"'
      + ' data-dshsci-session="' + sbEscapeHtml(item.id) + '"'
      + ' title="' + sbEscapeHtml(title) + '">'
      + '<span class="dshsci-recent-ico">' + sbIcon("chat") + "</span>"
      + '<span class="dshsci-recent-title">' + sbEscapeHtml(item.title) + "</span>"
      + (item.running ? '<span class="dshsci-recent-dot" title="运行中"></span>' : "")
      + '<span class="dshsci-recent-time">' + sbEscapeHtml(item.updatedAt ? sbRelativeTime(item.updatedAt) : "") + "</span>"
      + "</div>"
  }).join("")

  const renderSections = (pinnedList, recents, recentsTotal) => {
    const pinnedEl = state.pinnedEl
    const recentsEl = state.recentsEl
    if (pinnedEl) {
      const body = pinnedList.length > 0
        ? pinnedRowsHtml(pinnedList)
        : '<div class="dshsci-section-empty">右键工作区 →「置顶项目」把项目固定到这里</div>'
      const html = sectionHeadHtml("pinned", "置顶", pinnedList.length, state.pinnedCollapsed)
        + '<div class="dshsci-section-body">' + body + "</div>"
      pinnedEl.classList.toggle("is-collapsed", state.pinnedCollapsed)
      if (pinnedEl.innerHTML !== html) pinnedEl.innerHTML = html
      pinnedEl.classList.remove("is-hidden")
    }
    if (recentsEl) {
      if (recents.length === 0) {
        recentsEl.classList.add("is-hidden")
      } else {
        const html = sectionHeadHtml("recents", "最近", "", state.recentsCollapsed)
          + '<div class="dshsci-section-body">' + recentsRowsHtml(recents) + "</div>"
        recentsEl.classList.toggle("is-collapsed", state.recentsCollapsed)
        if (recentsEl.innerHTML !== html) recentsEl.innerHTML = html
        recentsEl.classList.remove("is-hidden")
      }
    }
  }

  const decorateRows = (view) => {
    const rows = document.querySelectorAll(SIDEBAR_ROW_SEL)
    for (const row of rows) {
      const key = String(row.getAttribute("data-row-key") || "")
      const info = view.get(key.slice(SIDEBAR_ROW_PREFIX.length))
      const pinned = Boolean(info && info.pinned)
      const badge = row.querySelector(":scope > .dshsci-row-pin")
      if (pinned && !badge) {
        const badgeEl = document.createElement("span")
        badgeEl.className = "dshsci-row-pin"
        badgeEl.title = "已置顶"
        badgeEl.setAttribute("aria-label", "已置顶")
        badgeEl.innerHTML = sbIcon("pin")
        row.appendChild(badgeEl)
      } else if (!pinned && badge) {
        badge.remove()
      }
    }
  }

  const sync = () => {
    if (state.disposed) return
    const rows = Array.from(document.querySelectorAll(SIDEBAR_ROW_SEL))
    const root = rows.length > 0 ? findBrowserRoot(rows[0]) : null
    // 侧栏收起为 56px rail / 搜索视图替换列表时没有工作区行：隐藏两个注入区，
    // 等列表恢复后由 MutationObserver 再同步。
    if (!ensureSections(root) || !root) { state.sig = ""; return }
    const data = readData()
    const { byId, view } = buildView(rows, data.workspaces, data.sessionsById)
    state.view = view
    const pinnedList = buildPinnedList(byId, view, data)
    state.pinnedItems = pinnedList
    const recentsResult = buildRecents(data, byId)
    const recents = recentsResult.rows
    const recentsTotal = recentsResult.total
    const minute = Math.floor(Date.now() / 60000)
    const sig = JSON.stringify([
      state.pins.map((pin) => pin.workspaceId),
      rows.map((row) => [row.getAttribute("data-row-key"), String(row.textContent || "").trim()]),
      pinnedList.map((item) => [item.workspaceId, item.title, item.path, item.stats ? item.stats.count : -1, item.stats ? item.stats.lastActive : 0,
        state.pinnedExpanded.has(item.workspaceId) ? item.sessions.map((s) => [s.id, s.title, s.updatedAt, s.running]) : null,
        state.pinnedWatermark.get(item.workspaceId) || PINNED_SESSION_WATERMARK]),
      state.pinnedCollapsed,
      state.recentsCollapsed,
      recents.map((item) => [item.id, item.title, item.updatedAt, item.running, item.workspaceTitle]),
      minute,
    ])
    if (sig !== state.sig) {
      state.sig = sig
      renderSections(pinnedList, recents, recentsTotal)
    }
    // 行级置顶徽标每次同步都校正：React 重挂载工作区行会丢掉我们追加的子节点，
    // 而数据签名可能不变（行 key/文本相同），只靠签名会漏补。
    decorateRows(view)
  }

  let pending = false
  function scheduleSync() {
    if (state.disposed || pending) return
    pending = true
    state.syncTimer = setTimeout(() => { pending = false; state.syncTimer = 0; sync() }, 120)
  }

  const resolveInfo = (workspaceId) => {
    const info = state.view.get(workspaceId)
    if (info) return info
    const pin = state.pins.find((item) => item.workspaceId === workspaceId)
    if (!pin) return null
    return { workspaceId, title: pin.title || pin.workspaceId, path: pin.path || "", pinned: true, stats: null }
  }

  // ── toast ──
  const showToast = (message, isError) => {
    if (state.toast) state.toast.remove()
    const toast = document.createElement("div")
    toast.className = "dshsci-toast" + (isError ? " is-error" : "")
    toast.setAttribute("role", "status")
    toast.textContent = String(message || "")
    document.body.appendChild(toast)
    state.toast = toast
    state.toastTimer = setTimeout(() => {
      if (state.toast === toast) { toast.remove(); state.toast = null }
    }, isError ? 4200 : 2200)
  }

  // ── 右键菜单 ──
  const closeMenu = () => {
    if (state.menu) { state.menu.remove(); state.menu = null }
  }

  const openMenu = (x, y, info, fromPinned) => {
    closeMenu()
    closePop()
    clearTimeout(state.hideTimer)
    clearTimeout(state.hoverTimer)
    state.hoverRow = null
    const menu = document.createElement("div")
    menu.className = "dshsci-menu"
    menu.setAttribute("role", "menu")
    menu.setAttribute("aria-label", "项目操作")
    const items = sbMenuModel({ ...info, platform: state.platform })
    const itemHtml = items.map((item) => item.sep
      ? '<div class="dshsci-menu-sep" role="separator"></div>'
      : '<button type="button" class="dshsci-menu-item' + (item.act === "unpin" ? "" : "") + '" role="menuitem" tabindex="-1" data-dshsci-act="' + sbEscapeHtml(item.act) + '">'
        + sbIcon(item.icon) + "<span>" + sbEscapeHtml(item.label) + "</span></button>").join("")
    menu.innerHTML = '<div class="dshsci-menu-head">'
      + '<span class="dshsci-menu-title">' + sbEscapeHtml(info.title) + "</span>"
      + (info.path ? '<span class="dshsci-menu-path">' + sbEscapeHtml(info.path) + "</span>" : "")
      + "</div>" + itemHtml
    menu.__dshsciInfo = info
    menu.__dshsciFromPinned = Boolean(fromPinned)
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    const pos = sbClampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight)
    menu.style.left = pos.left + "px"
    menu.style.top = pos.top + "px"
    state.menu = menu
    const first = menu.querySelector('[role="menuitem"]')
    if (first) first.focus()
  }

  const menuKeydown = (event) => {
    if (!state.menu) return
    const items = Array.from(state.menu.querySelectorAll('[role="menuitem"]'))
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement)
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); return }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      const next = items[(index + step + items.length) % items.length]
      if (next) next.focus()
    }
  }

  // ── 悬停信息 ──
  const closePop = () => {
    if (state.pop) { state.pop.remove(); state.pop = null }
  }

  const scheduleHidePop = () => {
    clearTimeout(state.hideTimer)
    state.hideTimer = setTimeout(closePop, 180)
  }

  const hoverStatsHtml = (info) => {
    const stats = info.stats || { count: 0, running: 0, lastActive: 0 }
    const parts = []
    parts.push("<span><b>" + stats.count + "</b> 个会话</span>")
    if (stats.running > 0) parts.push("<span>· 运行中 " + stats.running + "</span>")
    if (stats.lastActive > 0) parts.push("<span>· 最近活跃 " + sbEscapeHtml(sbRelativeTime(stats.lastActive)) + "</span>")
    return '<div class="dshsci-hover-stats">' + parts.join("")
      + (info.pinned ? '<span class="dshsci-hover-chip">已置顶</span>' : "") + "</div>"
  }

  const showPinnedCard = (anchor, info) => {
    closePop()
    clearTimeout(state.hideTimer)
    const pop = document.createElement("div")
    pop.className = "dshsci-pop"
    pop.innerHTML = '<div class="dshsci-pop-title">' + sbEscapeHtml(info.title) + "</div>"
      + '<div class="dshsci-pop-path">' + sbEscapeHtml(info.path || "") + "</div>"
      + '<div class="dshsci-hover-extra">' + hoverStatsHtml(info) + "</div>"
    pop.addEventListener("mouseenter", () => clearTimeout(state.hideTimer))
    pop.addEventListener("mouseleave", scheduleHidePop)
    document.body.appendChild(pop)
    const rect = anchor.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const left = rect.right + 8 + popRect.width > window.innerWidth ? Math.max(8, rect.left - popRect.width - 8) : rect.right + 8
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - popRect.height - 8))
    pop.style.left = Math.round(left) + "px"
    pop.style.top = Math.round(top) + "px"
    state.pop = pop
  }

  // 原生悬停卡由 ui-workspace 在 800ms 后 portal 到 body；等它出现后追加统计行与操作。
  const stopNativeCardWatch = () => {
    if (state.nativeCardObserver) { state.nativeCardObserver.disconnect(); state.nativeCardObserver = null }
    clearTimeout(state.hoverRestoreTimer)
  }

  const augmentNativeCard = (workspaceId) => {
    const info = resolveInfo(workspaceId)
    if (!info) return
    const cards = document.querySelectorAll(NATIVE_CARD_SEL)
    for (const card of cards) {
      const content = card.querySelector('[class*="_hoverContent"]')
      if (!content) continue
      if (content.querySelector("." + HOVER_EXTRA_CLS)) continue
      const aria = String(card.getAttribute("aria-label") || "")
      const cardPath = aria.replace(/^Copy:\s*/, "")
      if (info.path && cardPath && cardPath !== info.path) continue
      const extra = document.createElement("div")
      extra.className = HOVER_EXTRA_CLS
      extra.innerHTML = hoverStatsHtml(info)
      content.appendChild(extra)
    }
  }

  const hasNativeCardFor = (info) => {
    for (const card of document.querySelectorAll(NATIVE_CARD_SEL)) {
      const aria = String(card.getAttribute("aria-label") || "").replace(/^Copy:\s*/, "")
      if (!info.path || !aria || aria === info.path) return true
    }
    return false
  }

  const watchNativeCard = (workspaceId) => {
    stopNativeCardWatch()
    const observer = new MutationObserver(() => { if (state.hoverRow) augmentNativeCard(workspaceId) })
    observer.observe(document.body, { childList: true })
    state.nativeCardObserver = observer
    // 原生卡片 800ms 后出现；再兜底扫一次，避免 observer 注册晚于卡片插入。
    state.hoverRestoreTimer = setTimeout(() => {
      if (state.hoverRow) augmentNativeCard(workspaceId)
      // DSH 改版后原生悬停卡锚点不存在时，退回自己渲染项目卡（不阻塞其它功能）。
      const info = resolveInfo(workspaceId)
      if (info && !hasNativeCardFor(info) && state.hoverRow) showPinnedCard(state.hoverRow, info)
    }, 1100)
  }

  const clearHover = () => {
    clearTimeout(state.hoverTimer)
    stopNativeCardWatch()
    scheduleHidePop()
    state.hoverRow = null
  }

  const setHover = (target, workspaceId) => {
    if (state.menu) return
    if (state.hoverRow === target) return
    clearHover()
    state.hoverRow = target
    state.hoverTimer = setTimeout(() => {
      if (state.hoverRow !== target || state.menu) return
      if (target.classList.contains(SIDEBAR_PINNED_CLS)) {
        const info = resolveInfo(workspaceId)
        if (info) showPinnedCard(target, info)
      } else {
        watchNativeCard(workspaceId)
      }
    }, HOVER_DELAY_MS)
  }

  // ── 原生「…」菜单扩展：动作放进菜单按钮，悬停卡只展示项目状态 ──
  const closeNativeMenus = () => {
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    }
  }

  const clearPendingNativeMenu = () => {
    state.pendingNativeMenu = ""
    clearTimeout(state.nativeMenuTimer)
    clearTimeout(state.nativeMenuFallback)
    if (state.nativeMenuObserver) { state.nativeMenuObserver.disconnect(); state.nativeMenuObserver = null }
  }

  const augmentNativeMenu = () => {
    const workspaceId = state.pendingNativeMenu
    if (!workspaceId) return
    const info = resolveInfo(workspaceId)
    if (!info) { clearPendingNativeMenu(); return }
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (menu.closest(".dshsci-menu") || menu.closest("[data-dshsci-section]")) continue
      if (menu.getAttribute("data-dshsci-native") === workspaceId) continue
      const viewport = menu.querySelector('[role="presentation"]') || menu
      const template = viewport.querySelector(":scope > div")
      if (!template || !template.querySelector('button[role="menuitem"]')) continue
      const fragment = document.createDocumentFragment()
      for (const item of sbMenuModel({ ...info, platform: state.platform })) {
        if (item.sep) continue
        const wrap = template.cloneNode(true)
        const button = wrap.querySelector('button[role="menuitem"]')
        if (!button) continue
        button.className = button.className.replace(/\s*\S*_danger\S*/g, "")
        button.setAttribute("data-dshsci-act", item.act)
        button.setAttribute("data-dshsci-ws", workspaceId)
        button.setAttribute("data-dshsci-native-item", "1")
        const icon = wrap.querySelector("svg")
        if (icon) icon.outerHTML = sbIcon(item.icon)
        const label = wrap.querySelector('[class*="itemLabel"]')
        if (label) label.textContent = item.label
        fragment.appendChild(wrap)
      }
      const separator = document.createElement("div")
      separator.setAttribute("aria-hidden", "true")
      separator.style.cssText = "height:1px;margin:4px 8px;background:var(--dsw-alias-border-l2)"
      fragment.appendChild(separator)
      viewport.insertBefore(fragment, viewport.firstChild)
      menu.setAttribute("data-dshsci-native", workspaceId)
      clearPendingNativeMenu()
      return
    }
  }

  const watchNativeMenu = (workspaceId) => {
    clearPendingNativeMenu()
    state.pendingNativeMenu = workspaceId
    state.nativeMenuTimer = setTimeout(augmentNativeMenu, 30)
    if (!state.nativeMenuObserver) {
      const observer = new MutationObserver(() => { if (state.pendingNativeMenu) augmentNativeMenu() })
      observer.observe(document.body, { childList: true })
      state.nativeMenuObserver = observer
    }
    state.nativeMenuFallback = setTimeout(() => { augmentNativeMenu(); clearPendingNativeMenu() }, 900)
  }

  // ── 动作 ──
  const findNativeRow = (workspaceId) => document.querySelector('[data-row-key="workspace:' + workspaceId + '"]')

  const clickNativeRowButton = (workspaceId, which) => {
    const row = findNativeRow(workspaceId)
    if (!row) return false
    if (which === "toggle") { row.click(); return true }
    const buttons = row.querySelectorAll("button")
    if (buttons.length === 0) return false
    buttons[buttons.length - 1].click()
    return true
  }

  const changePinnedWatermark = (workspaceId, step, collapse) => {
    if (!workspaceId) return
    if (collapse) {
      state.pinnedWatermark.set(workspaceId, PINNED_SESSION_WATERMARK)
    } else {
      const item = state.pinnedItems.find((entry) => entry.workspaceId === workspaceId)
      const total = item ? item.sessions.length : 0
      const current = state.pinnedWatermark.get(workspaceId) || PINNED_SESSION_WATERMARK
      const remaining = total - current
      state.pinnedWatermark.set(workspaceId, remaining <= PINNED_SESSION_WATERMARK ? Infinity : current + PINNED_SESSION_WATERMARK)
    }
    state.sig = ""
    sync()
  }

  const togglePinned = (workspaceId) => {
    if (!workspaceId) return
    if (state.pinnedExpanded.has(workspaceId)) state.pinnedExpanded.delete(workspaceId)
    else state.pinnedExpanded.add(workspaceId)
    try { window.localStorage.setItem(PINNED_EXPANDED_KEY, JSON.stringify([...state.pinnedExpanded])) } catch { /* ignore */ }
    state.sig = ""
    sync()
  }

  const toggleWorkspaces = () => {
    state.workspacesCollapsed = !state.workspacesCollapsed
    try { window.localStorage.setItem(WORKSPACES_COLLAPSED_KEY, state.workspacesCollapsed ? "1" : "0") } catch { /* ignore */ }
    state.sig = ""
    sync()
  }

  const toggleSection = (kind) => {
    if (kind === "pinned") {
      state.pinnedCollapsed = !state.pinnedCollapsed
      try { window.localStorage.setItem(PINNED_COLLAPSED_KEY, state.pinnedCollapsed ? "1" : "0") } catch { /* ignore */ }
    } else if (kind === "recents") {
      state.recentsCollapsed = !state.recentsCollapsed
      try { window.localStorage.setItem(RECENTS_COLLAPSED_KEY, state.recentsCollapsed ? "1" : "0") } catch { /* ignore */ }
    } else {
      return
    }
    state.sig = ""
    sync()
  }

  // 打开最近会话：优先用 ui-workspace 的导航服务；不可用时退回点击原生行
  // （必要时先展开所属工作区，等 React 渲染出会话行后再点）。
  const openSessionById = (sessionId) => {
    if (!sessionId) return
    try {
      const ui = safeGet("uiWorkspace")
      if (ui && typeof ui.openSession === "function") { ui.openSession(sessionId); return }
    } catch { /* fall through */ }
    const direct = document.querySelector('[data-row-key="session:' + sessionId + '"]')
    if (direct) { direct.click(); direct.scrollIntoView({ block: "nearest" }); return }
    const data = readData()
    const owner = (data.workspaces || []).find((ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId))
    const workspaceId = owner ? String(owner.workspaceId) : ""
    const workspaceRow = workspaceId ? findNativeRow(workspaceId) : null
    if (!workspaceRow) { showToast("没有找到该会话所在的工作区", true); return }
    if (workspaceRow.getAttribute("aria-expanded") !== "true") workspaceRow.click()
    setTimeout(() => {
      const target = document.querySelector('[data-row-key="session:' + sessionId + '"]')
      if (target) { target.click(); target.scrollIntoView({ block: "nearest" }) }
      else showToast("会话不在当前列表可见范围内", true)
    }, 160)
  }

  const doPin = async (info) => {
    const payload = { workspaceId: info.workspaceId, path: info.path || "", title: info.title || "" }
    const result = await sbApi(info.pinned ? "unpin" : "pin", info.pinned ? { workspaceId: info.workspaceId } : payload)
    if (result && result.ok === false) throw new Error(result.error || "置顶失败")
    if (info.pinned) state.pins = state.pins.filter((pin) => pin.workspaceId !== info.workspaceId)
    else state.pins = sbNormalizePins([{ ...payload, pinnedAt: new Date().toISOString() }, ...state.pins])
    state.sig = ""
    closeMenu()
    scheduleSync()
    showToast(info.pinned ? "已取消置顶「" + info.title + "」" : "已置顶「" + info.title + "」")
  }

  const doReveal = async (info) => {
    if (!info.path) throw new Error("该项目没有目录路径")
    const result = await sbApi("reveal", { path: info.path })
    if (result && result.ok === false) throw new Error(result.error || "打开失败")
    closeMenu()
    showToast("已在文件管理器中显示：" + info.path)
  }

  const doOpen = async (info) => {
    if (!info.path) throw new Error("该项目没有目录路径")
    const result = await sbApi("open", { path: info.path })
    if (result && result.ok === false) throw new Error(result.error || "打开失败")
    closeMenu()
    showToast("已打开项目目录：" + info.path)
  }

  const doCopy = async (info) => {
    if (!info.path) throw new Error("该项目没有目录路径")
    const text = info.path
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text)
    } else {
      const input = document.createElement("textarea")
      input.value = text
      input.style.position = "fixed"
      input.style.opacity = "0"
      document.body.appendChild(input)
      input.select()
      try { document.execCommand("copy") } finally { input.remove() }
    }
    closeMenu()
    showToast("已复制项目路径")
  }

  const doAction = async (act, info) => {
    if (!info) return
    try {
      if (act === "pin" || act === "unpin") return await doPin(info)
      if (act === "reveal") return await doReveal(info)
      if (act === "open") return await doOpen(info)
      if (act === "copy") return await doCopy(info)
      if (act === "new") { closeMenu(); clickNativeRowButton(info.workspaceId, "new"); return }
      if (act === "toggle") {
        const fromPinned = Boolean(state.menu && state.menu.__dshsciFromPinned)
        closeMenu()
        if (fromPinned) togglePinned(info.workspaceId)
        else clickNativeRowButton(info.workspaceId, "toggle")
        return
      }
    } catch (error) {
      showToast(String(error && error.message ? error.message : error), true)
    }
  }

  // ── 事件 ──
  const onContextMenu = (event) => {
    const target = event.target
    if (!target || typeof target.closest !== "function") return
    const row = target.closest(SIDEBAR_ROW_SEL)
    const pinnedRow = row ? null : target.closest("." + SIDEBAR_PINNED_CLS)
    if (!row && !pinnedRow) return
    const workspaceId = row
      ? String(row.getAttribute("data-row-key") || "").slice(SIDEBAR_ROW_PREFIX.length)
      : String(pinnedRow.getAttribute("data-dshsci-ws") || "")
    const info = resolveInfo(workspaceId)
    if (!info) return
    event.preventDefault()
    event.stopPropagation()
    openMenu(event.clientX, event.clientY, info, Boolean(pinnedRow))
  }

  const onDocumentClick = (event) => {
    const target = event.target
    if (!target || typeof target.closest !== "function") return
    // 工作区行「…」按钮打开的原生菜单：等 portal 出现后把项目级动作插进菜单顶部。
    const actionRow = target.closest(SIDEBAR_ROW_SEL)
    if (actionRow) {
      const button = target.closest("button")
      const buttons = actionRow.querySelectorAll("button")
      if (button && buttons.length > 0 && buttons[0] === button) {
        const workspaceId = String(actionRow.getAttribute("data-row-key") || "").slice(SIDEBAR_ROW_PREFIX.length)
        if (workspaceId) watchNativeMenu(workspaceId)
      }
    }
    const actEl = target.closest("[data-dshsci-act]")
    if (actEl) {
      const act = String(actEl.getAttribute("data-dshsci-act") || "")
      if (act === "pinned-more-sessions" || act === "pinned-collapse-sessions") {
        event.preventDefault()
        event.stopPropagation()
        changePinnedWatermark(String(actEl.getAttribute("data-dshsci-ws") || ""), 0, act === "pinned-collapse-sessions")
        return
      }
      if (act === "more") {
        event.preventDefault()
        event.stopPropagation()
        const rect = actEl.getBoundingClientRect()
        const info = resolveInfo(String(actEl.getAttribute("data-dshsci-ws") || ""))
        if (info) openMenu(rect.left, rect.bottom + 4, info, true)
        return
      }
      if (act === "toggle-pinned") {
        event.preventDefault()
        event.stopPropagation()
        togglePinned(String(actEl.getAttribute("data-dshsci-ws") || ""))
        return
      }
      if (act === "toggle-workspaces") {
        event.preventDefault()
        event.stopPropagation()
        toggleWorkspaces()
        return
      }
      if (act === "toggle-section") {
        event.preventDefault()
        event.stopPropagation()
        toggleSection(String(actEl.getAttribute("data-dshsci-section-kind") || ""))
        return
      }
      const wsAttr = String(actEl.getAttribute("data-dshsci-ws") || "")
      const menuInfo = state.menu && state.menu.contains(actEl) ? state.menu.__dshsciInfo : null
      const info = wsAttr ? resolveInfo(wsAttr) : menuInfo
      if (info) {
        event.preventDefault()
        event.stopPropagation()
        const fromNativeMenu = Boolean(actEl.closest('[data-dshsci-native-item]'))
        void doAction(act, info)
        if (fromNativeMenu) closeNativeMenus()
        return
      }
    }
    const recentRow = target.closest("[data-dshsci-session]")
    if (recentRow) {
      event.preventDefault()
      event.stopPropagation()
      openSessionById(String(recentRow.getAttribute("data-dshsci-session") || ""))
      return
    }
    const workspacesHeader = target.closest('[class*="_sectionHeader"]')
    if (workspacesHeader && !target.closest("button") && workspacesHeader.parentElement
      && workspacesHeader.parentElement.hasAttribute("data-dshsci-workspaces")) {
      event.preventDefault()
      event.stopPropagation()
      toggleWorkspaces()
      return
    }
    if (state.menu && !state.menu.contains(target)) closeMenu()
    if (state.pop && !state.pop.contains(target)) closePop()
    const pinnedRow = target.closest("." + SIDEBAR_PINNED_CLS)
    if (pinnedRow) {
      togglePinned(String(pinnedRow.getAttribute("data-dshsci-ws") || ""))
    }
  }

  const onPinnedKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    const target = event.target
    if (!target || typeof target.closest !== "function") return
    if (target.closest("button")) return
    const recentRow = target.closest("[data-dshsci-session]")
    if (recentRow) {
      event.preventDefault()
      openSessionById(String(recentRow.getAttribute("data-dshsci-session") || ""))
      return
    }
    const pinnedRow = target.closest("." + SIDEBAR_PINNED_CLS)
    if (!pinnedRow) return
    event.preventDefault()
    togglePinned(String(pinnedRow.getAttribute("data-dshsci-ws") || ""))
  }

  const onMouseOver = (event) => {
    const target = event.target
    if (!target || typeof target.closest !== "function") return
    const row = target.closest(SIDEBAR_ROW_SEL)
    const pinnedRow = row ? null : target.closest("." + SIDEBAR_PINNED_CLS)
    if (!row && !pinnedRow) return
    const workspaceId = row
      ? String(row.getAttribute("data-row-key") || "").slice(SIDEBAR_ROW_PREFIX.length)
      : String(pinnedRow.getAttribute("data-dshsci-ws") || "")
    setHover(row || pinnedRow, workspaceId)
  }

  const onMouseOut = (event) => {
    if (!state.hoverRow) return
    const related = event.relatedTarget
    if (related && (state.hoverRow.contains(related) || (state.pop && state.pop.contains(related)))) return
    clearHover()
  }

  const onScrollOrResize = () => {
    closeMenu()
    if (state.pop) {
      const anchor = state.hoverRow
      if (anchor && anchor.isConnected) {
        const rect = anchor.getBoundingClientRect()
        const popRect = state.pop.getBoundingClientRect()
        const left = rect.right + 8 + popRect.width > window.innerWidth ? Math.max(8, rect.left - popRect.width - 8) : rect.right + 8
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - popRect.height - 8))
        state.pop.style.left = Math.round(left) + "px"
        state.pop.style.top = Math.round(top) + "px"
      } else {
        closePop()
      }
    }
  }

  document.addEventListener("contextmenu", onContextMenu, true)
  document.addEventListener("click", onDocumentClick, true)
  document.addEventListener("mouseover", onMouseOver, true)
  document.addEventListener("mouseout", onMouseOut, true)
  document.addEventListener("keydown", menuKeydown, true)
  document.addEventListener("keydown", onPinnedKeydown, true)
  window.addEventListener("resize", onScrollOrResize)
  document.addEventListener("scroll", onScrollOrResize, true)
  // 只有「可能影响侧栏浏览区」的 DOM 变更才触发重同步：会话消息流式渲染会造成大量
  // body 级 childList 变更，若每次都扫侧栏会浪费主线程。我们的注入节点自身变更也跳过。
  const isRelevantNode = (node) => {
    if (!node || node.nodeType !== 1) return false
    // 注入区被 React 重渲染移出时需要重新安放；注入区内部更新则跳过（避免自触发循环）。
    if (node === state.pinnedEl || node === state.recentsEl) return true
    if (node.closest && node.closest("[data-dshsci-section],.dshsci-menu,.dshsci-pop,.dshsci-toast")) return false
    if (node.matches && node.matches(SIDEBAR_ROW_SEL)) return true
    if (node.querySelector && node.querySelector(SIDEBAR_ROW_SEL)) return true
    const cls = typeof node.className === "string" ? node.className : ""
    return cls.includes("_listArea") || cls.includes("_sectionHeader")
  }
  const bodyObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (isRelevantNode(record.target)) return scheduleSync()
      for (const node of record.addedNodes || []) if (isRelevantNode(node)) return scheduleSync()
      for (const node of record.removedNodes || []) if (isRelevantNode(node)) return scheduleSync()
    }
  })
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  state.observers.push(bodyObserver)

  state.intervals.push(setInterval(() => {
    if (state.disposed) return
    if (!state.servicesReady) {
      state.servicesReady = bindServices()
      if (state.servicesReady) scheduleSync()
    }
  }, 500))

  // 启动顺序：先拿宿主置顶状态与平台，再首屏同步；宿主不可用时保持空置顶区（不阻塞原生侧栏）。
  sbApi("config")
    .then((result) => { if (result && result.ok !== false && typeof result.platform === "string") state.platform = result.platform })
    .catch(() => { /* ignore */ })
    .then(() => sbApi("pins"))
    .then((result) => {
      if (result && result.ok !== false) {
        state.pins = sbNormalizePins(result.pins)
        state.sig = ""
        scheduleSync()
      }
    })
    .catch(() => { /* 宿主未安装 sidebar-ui 时静默降级 */ })

  state.servicesReady = bindServices()
  scheduleSync()

  const cleanup = () => {
    if (state.disposed) return
    state.disposed = true
    document.removeEventListener("contextmenu", onContextMenu, true)
    document.removeEventListener("click", onDocumentClick, true)
    document.removeEventListener("mouseover", onMouseOver, true)
    document.removeEventListener("mouseout", onMouseOut, true)
    document.removeEventListener("keydown", menuKeydown, true)
    document.removeEventListener("keydown", onPinnedKeydown, true)
    window.removeEventListener("resize", onScrollOrResize)
    document.removeEventListener("scroll", onScrollOrResize, true)
    while (state.observers.length) state.observers.pop().disconnect()
    while (state.intervals.length) clearInterval(state.intervals.pop())
    while (state.unsubs.length) { try { state.unsubs.pop()() } catch { /* ignore */ } }
    clearTimeout(state.syncTimer)
    stopNativeCardWatch()
    clearPendingNativeMenu()
    clearTimeout(state.hoverTimer)
    clearTimeout(state.hideTimer)
    clearTimeout(state.toastTimer)
    closeMenu(); closePop()
    if (state.toast) { state.toast.remove(); state.toast = null }
    for (const toggle of document.querySelectorAll(".dshsci-workspaces-toggle")) toggle.remove()
    for (const root of document.querySelectorAll("[data-dshsci-workspaces]")) root.removeAttribute("data-dshsci-workspaces")
    resetScrollMarkers()
    if (state.pinnedEl) { state.pinnedEl.remove(); state.pinnedEl = null }
    if (state.recentsEl) { state.recentsEl.remove(); state.recentsEl = null }
    if (cssTag && cssTag.parentElement) cssTag.remove()
  }

  try {
    if (typeof ctx.effect === "function") ctx.effect(() => cleanup)
    else if (typeof ctx.on === "function") ctx.on("dispose", cleanup)
  } catch { /* ignore */ }
}

// 供 test/sidebar-client.test.mjs 通过 bundle 的 plugin._sidebarTest 调用的纯函数表。
const sbTest = {
  sbEscapeHtml,
  sbRelativeTime,
  sbRevealLabel,
  sbMenuModel,
  sbClampMenuPosition,
  sbSessionStats,
  sbNormalizePins,
}
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
// dsh-science 技术路线图画布 —— Client 源码（打包进 remote-hosts-ui 同一 client bundle）
//
// 说明：DSH 的 client-modules 按包名只解析一个 exports["./client"]/dsh.client 声明，因此本
// 画布与「远程主机」「科研工作台」两个设置页共用同一个 client bundle
// （scripts/build-client-bundle.mjs 把本文件与 src/index.js 按顺序拼接成同一个 factory
// 作用域，共享 React / h / 主题变量）。所有顶层名统一加 rd 前缀避免跨文件冲突。
//
// 数据通过 fetch 调用宿主侧 webServer 路由 /dsh-science/roadmap/<method>
// （engines/roadmap-ui.mjs），落同一份 <项目根>/.dsh/roadmap.json。
//
// 能力：
//   - SVG 画布：拖拽平移、滚轮缩放（以光标为锚点）、首次载入/布局后自动适应窗口、网格背景
//   - 自动布局样式可切换（紧凑蛇形 / 横向泳道 / 纵向阶段），随文档保存
//   - 节点 IO 契约：inputs / outputs / tool / command 写进节点，「数据流」页汇总产物传递与工具；
//     边标签在无自定义文字时直接显示传递的产物名
//   - 节点：拖动改位置、多选（Shift/⌘/Ctrl+点击、Shift+拖动框选、全选）后整体拖动、
//     右侧面板可收起（画布占满宽度，便于整图一屏查看）、
//     自定义颜色与形状、右下角手柄缩放尺寸
//   - 关系：串联/并联/反馈/循环四类边，点击连线模式建边，点边可改类型/标签/删除
//   - 版本：节点属性面板 + 版本历史（含变更字段）与一键回滚（append-only）
//   - AI：宿主侧模型生成／复制提示词到会话／粘贴 JSON 规格导入
//   - 导出：一键复制 Mermaid（可直接粘进 README/论文）

const rdCSS = `
.rd{font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px;padding:4px 2px 16px}
.rd-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rd-title{font-size:16px;font-weight:500;line-height:24px}
.rd-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Menlo,monospace}
.rd-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap}
.rd-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.rd-busy{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rd-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
.rd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rd-btn:disabled{opacity:.5;cursor:default}
.rd-btn-on{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.rd-btn-danger{color:var(--dsw-alias-state-error-primary)}
.rd-input,.rd-select,.rd-textarea{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit}
.rd-textarea{min-height:56px;resize:vertical;font-family:ui-monospace,Menlo,monospace;line-height:1.5}
.rd-body{display:flex;gap:10px;align-items:stretch;min-height:clamp(520px,68vh,920px);flex-wrap:wrap}
.rd-canvas{position:relative;flex:1 1 480px;min-width:320px;height:clamp(520px,68vh,920px);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-module-platform)}
.rd-canvas svg{display:block;width:100%;height:100%;cursor:grab;touch-action:none;user-select:none}
.rd-marquee{position:absolute;pointer-events:none;border:1.5px dashed var(--dsw-alias-brand-primary);background:rgba(79,142,247,.12);border-radius:4px}
.rd-canvas svg.rd-panning{cursor:grabbing}
.rd-node{cursor:move}
.rd-node.rd-sel .rd-shape{stroke:var(--dsw-alias-brand-primary);stroke-width:3}
.rd-shape{stroke-width:1.5}
.rd-node-label{font-size:12px;pointer-events:none;user-select:none}
.rd-node-sub{font-size:10px;pointer-events:none;user-select:none;opacity:.85}
.rd-edge-hit{cursor:pointer}
.rd-edge.rd-sel{stroke-width:4}
.rd-edge-label{font-size:10px;pointer-events:none;user-select:none}
.rd-hud{position:absolute;left:8px;bottom:8px;display:flex;gap:6px;align-items:center;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:3px 6px}
.rd-hud button{border:0;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;width:20px;height:20px;line-height:1}
.rd-hud-k{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:34px;text-align:center}
.rd-tip{position:absolute;left:8px;top:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rd-side{width:320px;flex:1 1 320px;max-width:380px;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;overflow:auto;max-height:clamp(520px,68vh,920px)}
.rd-tabs{display:flex;gap:6px}
.rd-tab{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;background:0 0;color:var(--dsw-alias-label-secondary)}
.rd-tab.rd-tab-on{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.rd-field{display:flex;flex-direction:column;gap:3px;margin-top:6px}
.rd-label{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rd-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rd-swatches{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.rd-swatch{width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);cursor:pointer;padding:0}
.rd-swatch.rd-swatch-on{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.rd-ver{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:3px}
.rd-meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rd-empty{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:8px 0}
.rd-pre{font-size:11px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}
.rd-count{font-size:11px;padding:0 8px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`

const rdApi = (method, body) =>
  fetch("/dsh-science/roadmap/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json())

const rdKindLabel = { step: "步骤", issue: "issue", milestone: "里程碑" }
const rdStatusLabel = { planned: "计划", running: "进行中", blocked: "受阻", done: "完成", dropped: "放弃" }
const rdStatusColor = { planned: "#94a3b8", running: "#3b82f6", blocked: "#ef4444", done: "#22c55e", dropped: "#a1a1aa" }
const rdEdgeLabel = { serial: "串联", parallel: "并联", feedback: "反馈", loop: "循环" }
const rdEdgeColor = { serial: "#64748b", parallel: "#0ea5e9", feedback: "#ef4444", loop: "#a855f7" }
const rdShapes = ["box", "round", "pill", "diamond", "hexagon", "circle", "note"]
const rdShapeLabel = { box: "矩形", round: "圆角", pill: "胶囊", diamond: "菱形", hexagon: "六边形", circle: "圆形", note: "注释" }
const rdPalette = ["#4f8ef7", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#64748b", "#ec4899"]
const rdDefaultSize = { w: 200, h: 68 }
const rdRootKey = "dsh-science.roadmap.root"
const rdStyleKey = "dsh-science.roadmap.layoutStyle"

const rdCut = (s, n) => {
  const t = String(s || "")
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
const rdSizeOf = (n) => (n && n.size ? n.size : rdDefaultSize)
const rdRectOf = (n, pos) => {
  const s = rdSizeOf(n)
  return { x: pos.x, y: pos.y, w: s.w, h: s.h, cx: pos.x + s.w / 2, cy: pos.y + s.h / 2 }
}
const rdFillOf = (n) => n.color || rdStatusColor[n.status] || "#94a3b8"

// 从矩形 a 的中心指向 b 的中心，取与 a 边框的交点作为连线锚点
function rdAnchor(a, b) {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  if (!dx && !dy) return { x: a.cx, y: a.cy }
  const sx = dx ? a.w / 2 / Math.abs(dx) : Infinity
  const sy = dy ? a.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: a.cx + dx * s, y: a.cy + dy * s }
}

// 形状：返回 SVG 元素（矩形/圆角/胶囊/菱形/六边形/圆形/注释）
// 注意：这里必须把高度解构成 hh —— `h` 在本 bundle 里是 React.createElement 的别名，
// 若写 `const { x, y, w, h }` 会把创建函数遮住，整块画布都会崩（渲染测试已覆盖）。
function rdShapeEl(shape, r, attrs) {
  const { x, y, w, h: hh } = r
  const common = { ...attrs }
  switch (shape) {
    case "round": return h("rect", { ...common, x, y, width: w, height: hh, rx: 18, ry: 18 })
    case "pill": return h("rect", { ...common, x, y, width: w, height: hh, rx: hh / 2, ry: hh / 2 })
    case "diamond": return h("polygon", { ...common, points: `${x + w / 2},${y} ${x + w},${y + hh / 2} ${x + w / 2},${y + hh} ${x},${y + hh / 2}` })
    case "hexagon": {
      const c = Math.min(24, w / 4)
      return h("polygon", { ...common, points: `${x + c},${y} ${x + w - c},${y} ${x + w},${y + hh / 2} ${x + w - c},${y + hh} ${x + c},${y + hh} ${x},${y + hh / 2}` })
    }
    case "circle": return h("ellipse", { ...common, cx: x + w / 2, cy: y + hh / 2, rx: w / 2, ry: hh / 2 })
    case "note": {
      const f = Math.min(20, w / 4)
      return h("polygon", { ...common, points: `${x},${y} ${x + w - f},${y} ${x + w},${y + f} ${x + w},${y + hh} ${x},${y + hh}` })
    }
    default: return h("rect", { ...common, x, y, width: w, height: hh, rx: 6, ry: 6 })
  }
}

// 技术路线图跟随项目：项目根 = 当前会话所属 Workspace 的目录。`conversation.view` 的
// 标准 props 自带全局 useWorkspaces（WorkspaceSnapshot.items），会话 → Workspace 的归属
// 由 WorkspaceView.sessionIds 提供；同一项目下的所有会话共享
// `<项目根>/.dsh/roadmap.json`，切换会话不换数据。

// ── 自动布局样式（客户端侧）────────────────────────────────────────────────
// 面板在「旧宿主进程」上也能切换布局：位置完全由这里算出，再用 mode=manual 一次性落盘，
// 不依赖宿主是否已重启加载新引擎。几何参数与 engines/roadmap.mjs 的 DEFAULT_LAYOUT 保持一致，
// test/roadmap.test.mjs 会逐样式对比两端坐标，防止实现漂移。
const rdLayoutConf = { colGap: 250, rowGap: 96, marginX: 60, marginY: 60, trackGap: 118, bandGap: 84 }
const rdLayoutViewport = { w: 1400, h: 820 }
const rdLayoutStyleIds = ["compact", "horizontal", "vertical"]
const rdStyleOf = (rm) => (rm && rdLayoutStyleIds.indexOf(rm.layoutStyle) >= 0 ? rm.layoutStyle : "compact")

function rdLayoutPositions(rm, style) {
  const nodes = (rm && rm.nodes) || []
  if (!nodes.length) return {}
  const st = rdLayoutStyleIds.indexOf(style) >= 0 ? style : "compact"
  const conf = rdLayoutConf
  const tracks = (rm && Array.isArray(rm.tracks)) ? rm.tracks : []
  const depthOf = (n) => (Number.isFinite(n.depth) ? n.depth : 0)
  const sizeOf = (n) => (n && n.size ? n.size : { w: 200, h: 68 })
  const byTrack = {}
  for (const n of nodes) byTrack[n.track || "主线"] = true
  const trackIdx = {}
  for (const t of tracks) trackIdx[t] = Object.keys(trackIdx).length
  // 未出现在 tracks 里的泳道追加到末尾，保证确定性
  for (const t of Object.keys(byTrack)) if (trackIdx[t] === undefined) trackIdx[t] = Object.keys(trackIdx).length

  if (st === "horizontal") {
    const used = {}
    const out = {}
    for (const n of nodes) {
      const d = depthOf(n)
      const t = n.track || "主线"
      const key = t + "|" + d
      const stack = used[key] || 0
      used[key] = stack + 1
      out[n.id] = { x: conf.marginX + d * conf.colGap, y: conf.marginY + (trackIdx[t] || 0) * conf.trackGap + stack * conf.rowGap }
    }
    return out
  }
  if (st === "vertical") {
    const pitchY = 68 + 44
    const used = {}
    const out = {}
    for (const n of nodes) {
      const d = depthOf(n)
      const t = n.track || "主线"
      const key = t + "|" + d
      const stack = used[key] || 0
      used[key] = stack + 1
      out[n.id] = { x: conf.marginX + (trackIdx[t] || 0) * conf.colGap, y: conf.marginY + d * pitchY + stack * (68 + 24) }
    }
    return out
  }

  // compact：深度分列 + 蛇形换行 + 带内泳道区间装箱
  const depthMax = nodes.reduce((m, n) => Math.max(m, depthOf(n)), 0)
  const layoutForWrap = (perRow) => {
    const rows = Math.ceil((depthMax + 1) / perRow)
    const pos = {}
    const used = {}
    let y = conf.marginY
    for (let row = 0; row < rows; row++) {
      const rowNodes = nodes.filter((n) => Math.floor(depthOf(n) / perRow) === row)
      if (!rowNodes.length) continue
      const span = new Map()
      for (const n of rowNodes) {
        const t = n.track || "主线"
        const d = depthOf(n)
        const sp = span.get(t) || { min: d, max: d }
        sp.min = Math.min(sp.min, d)
        sp.max = Math.max(sp.max, d)
        span.set(t, sp)
      }
      const laneOf = new Map()
      const lanes = []
      for (const t of Object.keys(byTrack)) {
        const sp = span.get(t)
        if (!sp) continue
        let lane = lanes.findIndex((ranges) => ranges.every(([a, b]) => sp.max < a || sp.min > b))
        if (lane === -1) { lanes.push([]); lane = lanes.length - 1 }
        lanes[lane].push([sp.min, sp.max])
        laneOf.set(t, lane)
      }
      const laneCount = Math.max(1, lanes.length)
      for (const n of rowNodes) {
        const d = depthOf(n)
        const col = d % perRow
        const xCol = row % 2 === 1 ? perRow - 1 - col : col
        const lane = laneOf.get(n.track || "主线") || 0
        const key = row + "|" + col + "|" + lane
        const stack = used[key] || 0
        used[key] = stack + 1
        pos[n.id] = { x: conf.marginX + xCol * conf.colGap, y: y + lane * conf.trackGap + stack * conf.rowGap }
      }
      y += laneCount * conf.trackGap + conf.bandGap
    }
    return pos
  }
  const bounds = (pos) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      const p = pos[n.id]
      if (!p) continue
      const sz = sizeOf(n)
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + sz.w); maxY = Math.max(maxY, p.y + sz.h)
    }
    if (!Number.isFinite(minX)) return { w: 0, h: 0 }
    return { w: maxX - minX, h: maxY - minY }
  }
  const D = depthMax + 1
  const candidates = []
  if (D > 5) for (let p = 3; p <= Math.min(D, 10); p++) candidates.push(p)
  if (candidates.indexOf(D) < 0) candidates.push(D)
  let best = null
  for (const perRow of candidates) {
    const pos = layoutForWrap(perRow)
    const b = bounds(pos)
    const scale = Math.min(rdLayoutViewport.w / Math.max(1, b.w), rdLayoutViewport.h / Math.max(1, b.h))
    const penalty = Math.abs(b.w / Math.max(1, b.h) - rdLayoutViewport.w / rdLayoutViewport.h) * 0.015
    const score = scale - penalty
    if (best === null || score > best.score + 1e-9) best = { pos, score }
  }
  return best.pos
}

function rdProjectOf(items, sessionId) {
  if (!Array.isArray(items) || !sessionId) return null
  for (const item of items) {
    if (item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) >= 0) return item
  }
  return null
}

function RdPage(props) {
  // 只在宿主真的提供该 hook 时调用（无会话上下文的渲染没有它，回落到手动根目录）。
  const useWorkspaces = props && typeof props.useWorkspaces === "function" ? props.useWorkspaces : null
  const wsItems = useWorkspaces ? useWorkspaces((snapshot) => snapshot.items) : null
  const project = rdProjectOf(wsItems, props && props.sessionId)
  const wsRoot = project && project.path ? project.path : ""
  const [cfg, setCfg] = React.useState(null)
  const [root, setRoot] = React.useState("")
  const [rm, setRm] = React.useState(null)
  const [err, setErr] = React.useState("")
  const [okMsg, setOkMsg] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [tab, setTab] = React.useState("props")
  const [sel, setSel] = React.useState([])
  const [selEdge, setSelEdge] = React.useState("")
  const [linkFrom, setLinkFrom] = React.useState("")
  const [linkType, setLinkType] = React.useState("serial")
  const [view, setView] = React.useState({ x: 40, y: 40, k: 1 })
  const [positions, setPositions] = React.useState({})
  const [draft, setDraft] = React.useState(null)
  const [versions, setVersions] = React.useState(null)
  const [aiGoal, setAiGoal] = React.useState("")
  const [aiSpec, setAiSpec] = React.useState("")
  const [aiPrompt, setAiPrompt] = React.useState("")
  const [aiMode, setAiMode] = React.useState("merge")
  const [panning, setPanning] = React.useState(false)
  const [sizes, setSizes] = React.useState({})
  const [fitTick, setFitTick] = React.useState(0)
  // 框选矩形（屏幕坐标，相对画布左上角）与「框选模式」开关
  const [marquee, setMarquee] = React.useState(null)
  const [boxMode, setBoxMode] = React.useState(false)
  // 右侧属性面板是否展开（收起后画布占满整个宽度，整图更容易一屏看全）
  const [sideOpen, setSideOpen] = React.useState(true)
  // 自动布局样式：compact 紧凑蛇形 / horizontal 横向泳道 / vertical 纵向阶段
  const [layoutStyle, setLayoutStyle] = React.useState("compact")

  const canvasRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const viewRef = React.useRef(view)
  const posRef = React.useRef(positions)
  const rootRef = React.useRef(root)
  const sizeRef = React.useRef(sizes)
  const skipViewport = React.useRef(true)
  const needFit = React.useRef(false)
  const rmRef = React.useRef(null)
  viewRef.current = view
  posRef.current = positions
  rootRef.current = root
  sizeRef.current = sizes
  rmRef.current = rm

  // 尺寸预览（拖拽时本地态）：同步写 ref，供 pointerup 立即读到最新尺寸
  const patchNodeLocalSize = (id, w, hh) => {
    const next = { ...sizeRef.current, [id]: { w, h: hh } }
    sizeRef.current = next
    setSizes(next)
    setRm((m) => m && { ...m, nodes: m.nodes.map((n) => (n.id === id ? { ...n, size: { w, h: hh } } : n)) })
  }

  const nodeById = React.useMemo(() => {
    const m = {}
    for (const n of (rm && rm.nodes) || []) m[n.id] = n
    return m
  }, [rm])

  const posOf = React.useCallback((id) => {
    const p = positions[id]
    if (p) return p
    const n = nodeById[id]
    return (n && n.pos) || { x: 0, y: 0 }
  }, [positions, nodeById])

  // ── 载入 ──
  const load = React.useCallback(async (target) => {
    if (!target) { setRm(null); return }
    setBusy("加载中…"); setErr(""); setOkMsg("")
    try {
      const r = await rdApi("show", { root: target })
      if (r && r.ok === false) throw new Error(r.error)
      if (!r.initialized) { setRm(null); return }
      setRm(r.roadmap)
      if (r.roadmap.layoutStyle) setLayoutStyle(r.roadmap.layoutStyle)
      else {
        try {
          const saved = window.localStorage.getItem(rdStyleKey)
          if (rdLayoutStyleIds.indexOf(saved) >= 0) setLayoutStyle(saved)
        } catch { /* 忽略 */ }
      }
      const p = {}
      for (const n of r.roadmap.nodes) p[n.id] = { x: n.pos.x, y: n.pos.y }
      setPositions(p)
      needFit.current = true
      if (r.roadmap.viewport && skipViewport.current) {
        setView({ x: r.roadmap.viewport.x || 0, y: r.roadmap.viewport.y || 0, k: r.roadmap.viewport.k || 1 })
      }
      skipViewport.current = false
      try { window.localStorage.setItem(rdRootKey, target) } catch { /* 忽略 */ }
    } catch (e) { setErr(String(e.message)) } finally { setBusy("") }
  }, [])

  // 载入优先级：当前会话所属项目（跟随项目）→ 上次手动根目录 → 插件配置 roadmapRoot。
  React.useEffect(() => {
    let cancelled = false
    rdApi("config").then((c) => {
      if (cancelled || !c || c.ok === false) return
      setCfg(c)
      if (wsRoot) return // 跟随项目时不读 localStorage 之类的旧根目录
      let saved = ""
      try { saved = window.localStorage.getItem(rdRootKey) || "" } catch { /* 忽略 */ }
      const target = saved || c.defaultRoot || c.cwd || ""
      setRoot(target)
      if (target) load(target)
    }).catch((e) => setErr(String(e.message)))
    if (wsRoot) {
      setRoot(wsRoot)
      load(wsRoot)
    }
    return () => { cancelled = true }
  }, [wsRoot, load])

  // ── 滚轮缩放（原生非 passive 监听，才能 preventDefault）──
  React.useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView((v) => {
        const k = Math.min(3, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
        const wx = (mx - v.x) / v.k
        const wy = (my - v.y) / v.k
        return { k, x: mx - wx * k, y: my - wy * k }
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [rm !== null])

  // ── 全局指针移动/抬起：拖节点、拖画布 ──
  React.useEffect(() => {
    const move = (e) => {
      const d = dragRef.current
      if (!d) return
      if (d.type === "pan") {
        setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }))
        return
      }
      if (d.type === "marquee") {
        d.ex = e.clientX
        d.ey = e.clientY
        const r = d.rect
        setMarquee({
          x0: d.sx - r.left, y0: d.sy - r.top,
          x1: e.clientX - r.left, y1: e.clientY - r.top,
        })
        return
      }
      const k = viewRef.current.k || 1
      const dx = (e.clientX - d.sx) / k
      const dy = (e.clientY - d.sy) / k
      const next = { ...posRef.current }
      for (const o of d.orig) next[o.id] = { x: Math.round(o.pos.x + dx), y: Math.round(o.pos.y + dy) }
      setPositions(next)
    }
    const up = () => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      setPanning(false)
      if (d.type === "marquee") {
        // 框选：把屏幕矩形换算到图坐标，命中的节点整体选中（可接着整体拖动）。
        setMarquee(null)
        const doc = rmRef.current
        if (!doc || !doc.nodes) return
        const ex = d.ex === undefined ? d.sx : d.ex
        const ey = d.ey === undefined ? d.sy : d.ey
        if (Math.abs(ex - d.sx) < 4 && Math.abs(ey - d.sy) < 4) { setSel([]); setSelEdge(""); return }
        const k = viewRef.current.k || 1
        const vx = viewRef.current.x
        const vy = viewRef.current.y
        const r = d.rect
        const ax = (Math.min(d.sx, ex) - r.left - vx) / k
        const ay = (Math.min(d.sy, ey) - r.top - vy) / k
        const bx = (Math.max(d.sx, ex) - r.left - vx) / k
        const by = (Math.max(d.sy, ey) - r.top - vy) / k
        const hit = []
        for (const n of doc.nodes) {
          const p = posRef.current[n.id] || n.pos || { x: 0, y: 0 }
          const sz = rdSizeOf(n)
          if (p.x + sz.w < ax || p.x > bx || p.y + sz.h < ay || p.y > by) continue
          hit.push(n.id)
        }
        setSel(hit)
        setSelEdge("")
        return
      }
      if (d.type !== "node") return
      const moved = {}
      for (const o of d.orig) if (posRef.current[o.id]) moved[o.id] = posRef.current[o.id]
      if (!Object.keys(moved).length) return
      rdApi("layout", { root: rootRef.current, mode: "manual", positions: moved })
        .then((r) => { if (r && r.ok === false) setErr(r.error) })
        .catch((e) => setErr(String(e.message)))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
  }, [])

  // ── 视口持久化（防抖）──
  React.useEffect(() => {
    if (!root || !rm || skipViewport.current) return
    const t = setTimeout(() => {
      rdApi("viewport", { root, viewport: view }).catch(() => {})
    }, 700)
    return () => clearTimeout(t)
  }, [view, root, rm])

  // ── 选中节点 → 属性草稿 ──
  const selNode = sel.length === 1 ? nodeById[sel[0]] : null
  React.useEffect(() => {
    if (!selNode) { setDraft(null); setVersions(null); return }
    setDraft({
      title: selNode.title || "",
      kind: selNode.kind || "step",
      status: selNode.status || "planned",
      track: selNode.track || "",
      summary: selNode.summary || "",
      strategy: selNode.strategy || "",
      params: JSON.stringify(selNode.params || {}, null, 2),
      tests: (selNode.tests || []).join("\n"),
      tags: (selNode.tags || []).join(", "),
      refs: JSON.stringify(selNode.refs || {}, null, 2),
      owner: selNode.owner || "",
      inputs: (selNode.inputs || []).join("\n"),
      outputs: (selNode.outputs || []).join("\n"),
      tool: selNode.tool || "",
      command: selNode.command || "",
      note: "",
    })
    setVersions(null)
    setTab("props")
  }, [sel.length === 1 ? sel[0] : "", selNode ? selNode.version : 0])

  const wrap = async (label, fn) => {
    setBusy(label); setErr(""); setOkMsg("")
    try {
      const r = await fn()
      if (r && r.ok === false) throw new Error(r.error)
      return r
    } catch (e) { setErr(String(e.message)); return null } finally { setBusy("") }
  }

  const refresh = async () => {
    if (!root) return
    const r = await wrap("刷新中…", () => rdApi("show", { root }))
    if (r) {
      if (!r.initialized) { setRm(null); return }
      setRm(r.roadmap)
      const p = {}
      for (const n of r.roadmap.nodes) p[n.id] = { x: n.pos.x, y: n.pos.y }
      setPositions(p)
    }
  }

  const patchNode = async (id, patch, note) => {
    const r = await wrap("保存中…", () => rdApi("node-update", { root, node: id, patch, note: note || "" }))
    if (r) { await refresh(); setOkMsg(`已保存（v${r.node.version}）`) }
    return r
  }

  const quickPatch = (id, patch) => patchNode(id, patch)

  const addNode = async () => {
    const el = canvasRef.current
    const rect = el ? el.getBoundingClientRect() : { width: 800, height: 560 }
    const pos = { x: Math.round((rect.width / 2 - view.x) / view.k - 100), y: Math.round((rect.height / 2 - view.y) / view.k - 34) }
    const r = await wrap("新增中…", () => rdApi("node-add", { root, title: "新步骤", kind: "step", status: "planned", pos }))
    if (r) { await refresh(); setSel([r.node.id]); setOkMsg(`已新增 ${r.node.id}`) }
  }

  const removeNode = async (id) => {
    if (!window.confirm(`删除节点 ${id}（含其全部关系）？节点版本历史会随节点移除。`)) return
    const r = await wrap("删除中…", () => rdApi("node-remove", { root, node: id }))
    if (r) { setSel([]); await refresh(); setOkMsg("已删除") }
  }

  const createLink = async (from, to) => {
    const r = await wrap("连线中…", () => rdApi("link", { root, action: "add", from, to, type: linkType }))
    if (r) { await refresh(); setOkMsg(`${from} —[${rdEdgeLabel[linkType]}]→ ${to}`) }
    return r
  }

  const updateLink = async (id, patch) => {
    const r = await wrap("保存关系…", () => rdApi("link", { root, action: "update", id, ...patch }))
    if (r) await refresh()
  }

  const removeLink = async (id) => {
    const r = await wrap("删除关系…", () => rdApi("link", { root, action: "remove", id }))
    if (r) { setSelEdge(""); await refresh() }
  }

  const RD_STYLE_FALLBACK = [
    { id: "compact", label: "紧凑蛇形" },
    { id: "horizontal", label: "横向泳道" },
    { id: "vertical", label: "纵向阶段" },
  ]
  const styleList = () => (cfg && Array.isArray(cfg.layoutStyles) && cfg.layoutStyles.length ? cfg.layoutStyles : RD_STYLE_FALLBACK)
  const styleLabel = (id) => {
    const hit = styleList().find((x) => x.id === id)
    return hit ? hit.label : id
  }

  // 客户端算坐标 → mode=manual 一次性落盘：即使宿主进程还是旧引擎（未重启），切换样式也能生效。
  const autoLayout = async (styleArg) => {
    const style = rdLayoutStyleIds.indexOf(styleArg) >= 0 ? styleArg : layoutStyle
    if (!rm || !rm.nodes.length) return
    const pos = rdLayoutPositions(rm, style)
    if (!Object.keys(pos).length) return
    setLayoutStyle(style)
    try { window.localStorage.setItem(rdStyleKey, style) } catch { /* 忽略 */ }
    const next = { ...positions }
    for (const id of Object.keys(pos)) next[id] = pos[id]
    setPositions(next) // 先本地重绘，再落盘
    const r = await wrap("自动布局…", () => rdApi("layout", { root, mode: "manual", positions: pos, style, note: "面板布局：" + styleLabel(style) }))
    if (r) {
      await refresh()
      setFitTick((t) => t + 1)
      setOkMsg("已按「" + styleLabel(style) + "」重排并适应窗口")
    }
  }

  // 计算「整图适配当前画布」的视口（含 40px 内边距）；内容为空返回 null。
  const computeFit = () => {
    const el = canvasRef.current
    if (!el || !rm || !rm.nodes.length) return null
    const rect = el.getBoundingClientRect()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of rm.nodes) {
      const p = posOf(n.id)
      const s = rdSizeOf(n)
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h)
    }
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = Math.min(1.6, Math.max(0.2, Math.min((rect.width - 80) / bw, (rect.height - 80) / bh)))
    return { k, x: 40 - minX * k, y: 40 - minY * k }
  }
  const fitView = () => { const v = computeFit(); if (v) setView(v) }

  // 自动布局后等 rm/positions 重渲染完成再适应窗口（否则会按旧坐标算 bbox）
  React.useEffect(() => { if (fitTick > 0) fitView() }, [fitTick])

  // 首次载入该图时自动适应窗口（用户曾明显放大过则尊重其视口）。
  React.useEffect(() => {
    if (!rm || !needFit.current) return
    needFit.current = false
    const t = setTimeout(() => {
      const stored = rm.viewport
      const fit = computeFit()
      // 尊重用户上一次的视口：只有在「和适配比例接近」的区间内才保留，避免打开就是
      // 过度缩小（看不清）或放大到只剩局部（看不到全图）。
      if (stored && fit && Number(stored.k) > 0) {
        const k = Number(stored.k)
        if (k >= fit.k * 0.85 && k <= fit.k * 1.8) return
      }
      if (fit) setView(fit)
    }, 0)
    return () => clearTimeout(t)
  }, [rm, positions])

  const revert = async (version) => {
    if (!selNode) return
    const r = await wrap("回滚中…", () => rdApi("node-revert", { root, node: selNode.id, version, note: `面板回滚到 v${version}` }))
    if (r) { await refresh(); setOkMsg(`已回滚到 v${version}（新版本 v${r.node.version}）`); setVersions(null); setTab("props") }
  }

  const loadVersions = async () => {
    if (!selNode) return
    const r = await wrap("读取版本…", () => rdApi("node-history", { root, node: selNode.id }))
    if (r) { setVersions(r.versions || []); setTab("ver") }
  }

  const saveDraft = async () => {
    if (!selNode || !draft) return
    const patch = { note: draft.note || "" }
    if (draft.title !== selNode.title) patch.title = draft.title
    if (draft.kind !== selNode.kind) patch.kind = draft.kind
    if (draft.status !== selNode.status) patch.status = draft.status
    if ((draft.track || "") !== (selNode.track || "")) patch.track = draft.track
    if ((draft.summary || "") !== (selNode.summary || "")) patch.summary = draft.summary
    if ((draft.strategy || "") !== (selNode.strategy || "")) patch.strategy = draft.strategy
    if ((draft.owner || "") !== (selNode.owner || "")) patch.owner = draft.owner
    const parseJson = (s, label) => {
      if (!String(s || "").trim()) return {}
      try { return JSON.parse(s) } catch { throw new Error(`${label} 不是合法 JSON`) }
    }
    try {
      const params = parseJson(draft.params, "超参(params)")
      if (JSON.stringify(params) !== JSON.stringify(selNode.params || {})) patch.params = params
      const refs = parseJson(draft.refs, "关联(refs)")
      if (JSON.stringify(refs) !== JSON.stringify(selNode.refs || {})) patch.refs = refs
    } catch (e) { setErr(String(e.message)); return }
    const tests = String(draft.tests || "").split("\n").map((x) => x.trim()).filter(Boolean)
    if (JSON.stringify(tests) !== JSON.stringify(selNode.tests || [])) patch.tests = tests
    const toList = (v) => String(v || "").split("\n").map((x) => x.trim()).filter(Boolean)
    const inputs = toList(draft.inputs)
    if (JSON.stringify(inputs) !== JSON.stringify(selNode.inputs || [])) patch.inputs = inputs
    const outputs = toList(draft.outputs)
    if (JSON.stringify(outputs) !== JSON.stringify(selNode.outputs || [])) patch.outputs = outputs
    if ((draft.tool || "") !== (selNode.tool || "")) patch.tool = draft.tool || ""
    if ((draft.command || "") !== (selNode.command || "")) patch.command = draft.command || ""
    const tags = String(draft.tags || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean)
    if (JSON.stringify(tags) !== JSON.stringify(selNode.tags || [])) patch.tags = tags
    if (Object.keys(patch).length <= 1) { setOkMsg("没有改动"); return }
    await patchNode(selNode.id, patch, draft.note)
  }

  const aiGenerate = async () => {
    if (!aiGoal.trim()) { setErr("请先填写研究目标"); return }
    const r = await wrap("AI 生成中…", () => rdApi("generate", { root, goal: aiGoal, mode: aiMode }))
    if (r) {
      if (r.roadmap) { setRm(r.roadmap); const p = {}; for (const n of r.roadmap.nodes) p[n.id] = { x: n.pos.x, y: n.pos.y }; setPositions(p) }
      setOkMsg(`已生成：新建 ${r.result.created.length} / 更新 ${r.result.updated.length} 节点，新增 ${r.result.edgesAdded.length} 关系（模型 ${r.model.provider}/${r.model.model}）`)
    }
  }

  const aiMakePrompt = async () => {
    if (!aiGoal.trim()) { setErr("请先填写研究目标"); return }
    const r = await wrap("生成提示词…", () => rdApi("prompt", { root, goal: aiGoal }))
    if (r) {
      setAiPrompt(r.prompt)
      try { await navigator.clipboard.writeText(r.prompt); setOkMsg("提示词已复制，粘贴到 DSH 会话即可让 agent 调用 roadmap_apply") } catch { setOkMsg("提示词已生成（浏览器未授权剪贴板，请手动复制）") }
    }
  }

  const aiImport = async () => {
    if (!aiSpec.trim()) { setErr("请粘贴路线图 JSON 规格"); return }
    const r = await wrap("导入中…", () => rdApi("apply", { root, specJson: aiSpec, mode: aiMode, author: "human", note: "面板导入" }))
    if (r) {
      setRm(r.roadmap); const p = {}; for (const n of r.roadmap.nodes) p[n.id] = { x: n.pos.x, y: n.pos.y }; setPositions(p)
      setOkMsg(`已导入：新建 ${r.result.created.length} / 更新 ${r.result.updated.length}`)
    }
  }

  const copyMermaid = async () => {
    const r = await wrap("渲染中…", () => rdApi("render", { root, format: "mermaid" }))
    if (r) {
      try { await navigator.clipboard.writeText(r.text); setOkMsg("Mermaid 已复制到剪贴板") } catch { setAiPrompt(r.text); setOkMsg("已渲染（剪贴板不可用，见下方文本框）") }
    }
  }

  const initRoadmap = async () => {
    const r = await wrap("初始化…", () => rdApi("init", { root, title: "技术路线图" }))
    if (r) { setRm(r.roadmap); setPositions({}); setOkMsg("已初始化") }
  }

  // ── 画布交互 ──
  const onCanvasDown = (e) => {
    if (e.target !== e.currentTarget && e.target.getAttribute?.("data-rd-bg") !== "1") return
    if (e.button !== undefined && e.button !== 0) return
    if (e.shiftKey || boxMode) {
      const r = canvasRef.current ? canvasRef.current.getBoundingClientRect() : { left: 0, top: 0 }
      dragRef.current = { type: "marquee", sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY, rect: r }
      setMarquee({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top })
      return
    }
    dragRef.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
    setPanning(true)
  }
  const onNodeDown = (e, id) => {
    e.stopPropagation()
    const multi = e.shiftKey || e.metaKey || e.ctrlKey
    let next = sel
    if (multi) next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
    else if (!sel.includes(id)) next = [id]
    setSel(next)
    setSelEdge("")
    if (linkFrom) return
    const ids = next.includes(id) ? next : [id]
    dragRef.current = { type: "node", sx: e.clientX, sy: e.clientY, orig: ids.map((x) => ({ id: x, pos: { ...posOf(x) } })) }
  }
  const onNodeClick = (e, id) => {
    e.stopPropagation()
    if (!linkFrom) return
    if (linkFrom === id && linkType !== "loop" && linkType !== "feedback") { setErr("自环只允许「循环/反馈」（自反馈）"); return }
    createLink(linkFrom, id)
    setLinkFrom("")
  }
  // 只有点到画布空白（svg 本体或背景 rect）才清空选择，避免节点/连线的点击被冒泡清掉
  const onCanvasClick = (e) => {
    const isBg = e.target === e.currentTarget || e.target.getAttribute?.("data-rd-bg") === "1"
    if (!isBg) return
    if (linkFrom) return
    setSel([])
    setSelEdge("")
  }

  // ── 渲染 ──
  const nodes = (rm && rm.nodes) || []
  const edges = (rm && rm.edges) || []
  const rects = {}
  for (const n of nodes) rects[n.id] = rdRectOf(n, posOf(n.id))

  const edgePath = (e) => {
    const a = rects[e.from]
    const b = rects[e.to]
    if (!a || !b) return ""
    if (e.from === e.to) {
      const x = a.x + a.w
      const y = a.y
      return `M ${x - 10} ${y} C ${x + 60} ${y - 60}, ${x + 60} ${y + 40}, ${x - 10} ${y + 12}`
    }
    const p1 = rdAnchor(a, b)
    const p2 = rdAnchor(b, a)
    if (e.type === "serial" || e.type === "parallel") {
      return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`
    }
    // 反馈 / 循环：带法向偏移的曲线，视觉上"绕回去"
    const mx = (p1.x + p2.x) / 2
    const my = (p1.y + p2.y) / 2
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const off = 46
    const cx = mx - (dy / len) * off
    const cy = my + (dx / len) * off
    return `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`
  }

  const selEdgeObj = edges.find((e) => e.id === selEdge) || null
  const stats = (rm && rm.stats) || null
  const io = (rm && rm.io) || null
  const transferByEdge = new Map(((io && io.transfers) || []).map((t) => [t.edge, t.artifacts]))

  const toolbar = h("div", { className: "rd-head" },
    h("span", { className: "rd-title" }, "技术路线图"),
    rm ? h("span", { className: "rd-count" }, nodes.length + " 节点 / " + edges.length + " 关系" + (io ? " / " + io.artifacts.length + " 产物" : "")) : null,
    stats && stats.cycleCount ? h("span", { className: "rd-count", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "回路 " + stats.cycleCount) : null,
    busy ? h("span", { className: "rd-busy" }, busy) : null,
    h("div", { style: { flex: 1 } }),
    rm ? h("button", { className: "rd-btn", disabled: !!busy, onClick: addNode }, "＋ 节点") : null,
    rm ? h("span", { className: "rd-label", style: { marginLeft: 2 }, title: "自动布局样式" }, "布局") : null,
    rm ? h("select", {
      className: "rd-select", value: layoutStyle, disabled: !!busy,
      title: "自动布局样式：选中立即重排（紧凑蛇形=一屏总览 / 横向泳道=层级清晰、较长 / 纵向阶段=自上而下）",
      onChange: (e) => { const s2 = e.target.value; setLayoutStyle(s2); autoLayout(s2) },
    }, styleList().map((st) => h("option", { value: st.id, key: st.id, title: st.hint || "" }, st.label))) : null,
    rm ? h("button", { className: "rd-btn", disabled: !!busy, onClick: () => autoLayout(), title: "按选中样式重排（会覆盖现有坐标），并自动适应窗口" }, "自动布局") : null,
    rm ? h("button", { className: "rd-btn", disabled: !!busy, onClick: fitView }, "适应窗口") : null,
    rm ? h("button", {
      className: "rd-btn" + (boxMode ? " rd-btn-on" : ""),
      title: "框选模式：在空白处拖动画框选中多个节点（也可直接 Shift+拖动）",
      onClick: () => { setBoxMode((v) => !v); setMarquee(null) },
    }, "框选") : null,
    rm ? h("button", {
      className: "rd-btn", disabled: !!busy || !nodes.length, title: "选中全部节点，可整体拖动",
      onClick: () => { setSel(nodes.map((n) => n.id)); setSelEdge(""); setOkMsg("已全选 " + nodes.length + " 个节点，拖动任一节点即可整体移动") },
    }, "全选") : null,
    rm ? h("button", {
      className: "rd-btn" + (sideOpen ? "" : " rd-btn-on"),
      title: "收起/展开右侧属性面板，让画布占满宽度（收起后自动重新适应窗口）",
      onClick: () => { setSideOpen((v) => !v); setFitTick((t) => t + 1) },
    }, sideOpen ? "收起侧栏" : "展开侧栏") : null,
    rm ? h("button", { className: "rd-btn", disabled: !!busy, onClick: copyMermaid }, "复制 Mermaid") : null,
    h("button", { className: "rd-btn", disabled: !!busy || !root, onClick: refresh }, "刷新"),
  )

  const linkBar = rm ? h("div", { className: "rd-row" },
    h("span", { className: "rd-label" }, "连线模式"),
    h("select", { className: "rd-select", value: linkType, onChange: (e) => setLinkType(e.target.value) },
      Object.keys(rdEdgeLabel).map((t) => h("option", { value: t, key: t }, rdEdgeLabel[t]))),
    h("button", {
      className: "rd-btn" + (linkFrom ? " rd-btn-on" : ""), disabled: !!busy,
      onClick: () => setLinkFrom(linkFrom ? "" : (sel[0] || "")),
      title: "先选中起点节点，再点此进入连线模式，然后点终点节点",
    }, linkFrom ? "选择终点…（取消）" : "从选中节点连线"),
    linkFrom ? h("span", { className: "rd-hint" }, "起点 " + linkFrom + " → 点目标节点") : h("span", { className: "rd-meta" }, sel.length > 1 ? "已选 " + sel.length + " 个节点：拖动任一节点可整体移动" : "Shift / ⌘+点击多选，或空白处 Shift+拖动框选"),
  ) : null

  const canvas = h("div", { className: "rd-canvas", ref: canvasRef },
    h("svg", {
      className: panning ? "rd-panning" : "",
      onPointerDown: onCanvasDown,
      onClick: onCanvasClick,
    },
      h("defs", null,
        h("marker", { id: "rd-a-serial", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
          h("path", { d: "M0,0 L10,5 L0,10 z", fill: rdEdgeColor.serial })),
        h("marker", { id: "rd-a-parallel", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
          h("path", { d: "M0,0 L10,5 L0,10 z", fill: rdEdgeColor.parallel })),
        h("marker", { id: "rd-a-feedback", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
          h("path", { d: "M0,0 L10,5 L0,10 z", fill: rdEdgeColor.feedback })),
        h("marker", { id: "rd-a-loop", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
          h("path", { d: "M0,0 L10,5 L0,10 z", fill: rdEdgeColor.loop })),
      ),
      h("rect", { "data-rd-bg": "1", x: 0, y: 0, width: "100%", height: "100%", fill: "transparent" }),
      h("g", { transform: `translate(${view.x},${view.y}) scale(${view.k})` },
        // 换行带标记：蛇形布局下用「① → / ② ←」提示每一带的阅读方向（手动布局也有行号）
        (() => {
          if (!nodes.length) return null
          const sorted = nodes.slice().sort((a, b) => rects[a.id].y - rects[b.id].y)
          const bands = []
          for (const n of sorted) {
            const r = rects[n.id]
            const b = bands[bands.length - 1]
            if (!b || r.y - b.maxY > 120) {
              bands.push({ minX: r.x, minY: r.y, maxY: r.y + r.h, list: [n] })
            } else {
              b.minX = Math.min(b.minX, r.x)
              b.maxY = Math.max(b.maxY, r.y + r.h)
              b.list.push(n)
            }
          }
          if (bands.length < 2) return null
          const gx = Math.min(...bands.map((b) => b.minX)) - 46
          const nums = "①②③④⑤⑥⑦⑧⑨⑩"
          return h("g", null,
            bands.map((b, i) => {
              const byDepth = b.list.slice().sort((a, c) => (a.depth ?? 0) - (c.depth ?? 0))
              const first = rects[byDepth[0].id]
              const last = rects[byDepth[byDepth.length - 1].id]
              const dir = last.cx >= first.cx ? "→" : "←"
              return h("text", {
                key: "band" + i, x: gx, y: b.minY + 4,
                className: "rd-node-sub", fill: "var(--dsw-alias-label-tertiary)", fontSize: 13,
              }, (nums[i] || String(i + 1)) + " " + dir)
            }),
          )
        })(),
        // 泳道底纹：同一 track 若因自动换行被拆到多条「带」，按纵向空隙切成多个簇分别描底，
        // 避免一个横跨多带的巨大底色块压住别的泳道。
        (() => {
          const tracks = (rm && rm.tracks) || []
          if (!tracks.length || !nodes.length) return null
          const byTrack = {}
          for (const n of nodes) byTrack[n.track || "主线"] = (byTrack[n.track || "主线"] || []).concat([n])
          const clustersOf = (list) => {
            const sorted = list.slice().sort((a, b) => rects[a.id].y - rects[b.id].y)
            const out = []
            for (const n of sorted) {
              const r = rects[n.id]
              const c = out[out.length - 1]
              if (!c || r.y - c.maxY > 90) {
                out.push({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h })
              } else {
                c.minX = Math.min(c.minX, r.x); c.minY = Math.min(c.minY, r.y)
                c.maxX = Math.max(c.maxX, r.x + r.w); c.maxY = Math.max(c.maxY, r.y + r.h)
              }
            }
            return out
          }
          return tracks.map((t, i) => {
            const list = byTrack[t] || []
            if (!list.length) return null
            return h("g", { key: "lane" + i },
              clustersOf(list).map((c, ci) => h("g", { key: "c" + ci },
                h("rect", { "data-rd-bg": "1", x: c.minX - 24, y: c.minY - 18, width: c.maxX - c.minX + 48, height: c.maxY - c.minY + 36, rx: 14, fill: "var(--dsw-alias-bg-layer-2)", opacity: 0.5 }),
                h("text", { x: c.minX - 18, y: c.minY - 24, className: "rd-node-sub", fill: "var(--dsw-alias-label-tertiary)" }, t),
              )),
            )
          })
        })(),
        // 边
        edges.map((e) => {
          const d = edgePath(e)
          const color = e.color || rdEdgeColor[e.type] || "#64748b"
          const dashed = e.type === "feedback" || e.type === "loop" || e.style === "dashed"
          const isSel = e.id === selEdge
          return h("g", { key: e.id },
            h("path", {
              className: "rd-edge-hit", d, fill: "none", stroke: "transparent", strokeWidth: 16,
              onPointerDown: (ev) => ev.stopPropagation(),
              onClick: (ev) => { ev.stopPropagation(); setSelEdge(e.id); setSel([]) },
            }),
            h("path", {
              className: "rd-edge" + (isSel ? " rd-sel" : ""), d, fill: "none",
              stroke: color, strokeWidth: isSel ? 4 : 2,
              strokeDasharray: dashed ? "7 5" : undefined,
              markerEnd: e.type === "parallel" ? undefined : `url(#rd-a-${e.type})`,
              opacity: e.type === "parallel" ? 0.75 : 1,
            }),
            (() => {
              // 缩得太小时只保留选中/反馈/循环的标签，避免 20+ 条标签糊满画布
              const showLabel = view.k >= 0.55 || isSel || (view.k >= 0.42 && (e.type === "feedback" || e.type === "loop"))
              if (!showLabel) return null
              const a = rects[e.from]
              const b = rects[e.to]
              if (!a || !b) return null
              const lx = e.from === e.to ? a.x + a.w + 20 : (a.cx + b.cx) / 2
              const ly = e.from === e.to ? a.y - 26 : (a.cy + b.cy) / 2
              const passed = transferByEdge.get(e.id)
              const mark = e.type === "parallel" ? " ∥" : ""
              // 有 IO 传递时把「产物名」放在第一行（这是用户要看的 IO 关系），自定义语义 label 降为第二行
              if (passed && passed.length && e.label) {
                return h("text", { className: "rd-edge-label", x: lx, y: ly, textAnchor: "middle", fill: color }, [
                  h("tspan", { key: "io", x: lx, dy: 0 }, rdCut(passed.join(" / "), 26)),
                  h("tspan", { key: "lbl", x: lx, dy: 11, opacity: 0.7 }, rdCut(e.label, 22)),
                ])
              }
              const label = passed && passed.length
                ? passed.join(" / ") + " · " + rdEdgeLabel[e.type]
                : (e.label || rdEdgeLabel[e.type]) + mark
              return h("text", { className: "rd-edge-label", x: lx, y: ly, textAnchor: "middle", fill: color }, label)
            })(),
          )
        }),
        // 节点
        nodes.map((n) => {
          const r = rects[n.id]
          const fill = rdFillOf(n)
          const isSel = sel.includes(n.id)
          const isLinkSrc = linkFrom === n.id
          return h("g", {
            key: n.id,
            className: "rd-node" + (isSel || isLinkSrc ? " rd-sel" : ""),
            onPointerDown: (e) => onNodeDown(e, n.id),
            onClick: (e) => onNodeClick(e, n.id),
            onDoubleClick: (e) => { e.stopPropagation(); setSel([n.id]); setTab("props") },
          },
            rdShapeEl(n.shape, r, {
              className: "rd-shape", fill, stroke: isLinkSrc ? "#fff" : "rgba(0,0,0,.25)",
              opacity: n.status === "dropped" ? 0.5 : 1,
            }),
            n.kind === "milestone" ? h("text", { className: "rd-node-sub", x: r.x + 6, y: r.y + 12, fill: "#fff", opacity: 0.9 }, "◆") : null,
            n.inCycle ? h("text", { className: "rd-node-sub", x: r.x + r.w - 14, y: r.y + 13, fill: "#fff", opacity: 0.9 }, "↻") : null,
            h("text", { className: "rd-node-label", x: r.cx, y: r.cy - 2, textAnchor: "middle", fill: "#fff" }, rdCut(n.title, 18)),
            view.k >= 0.42 ? h("text", { className: "rd-node-sub", x: r.cx, y: r.cy + 15, textAnchor: "middle", fill: "#fff" },
              (rdKindLabel[n.kind] || n.kind) + " · " + (rdStatusLabel[n.status] || n.status) + (n.track ? " · " + rdCut(n.track, 8) : "")) : null,
            view.k >= 0.35 ? h("text", { className: "rd-node-sub", x: r.x + r.w - 6, y: r.y + r.h - 5, textAnchor: "end", fill: "#fff", opacity: 0.7 }, "v" + n.version) : null,
            view.k >= 0.5 && n.tool ? h("text", { className: "rd-node-sub", x: r.x + 6, y: r.y + r.h - 5, textAnchor: "start", fill: "#fff", opacity: 0.9 }, "⚙ " + rdCut(n.tool, 9)) : null,
            // 尺寸手柄
            isSel && sel.length === 1 ? h("rect", {
              x: r.x + r.w - 7, y: r.y + r.h - 7, width: 12, height: 12, rx: 3,
              fill: "var(--dsw-alias-brand-primary)", stroke: "#fff", strokeWidth: 1,
              style: { cursor: "nwse-resize" },
              onPointerDown: (ev) => {
                ev.stopPropagation()
                const start = { x: ev.clientX, y: ev.clientY, w: rdSizeOf(n).w, h: rdSizeOf(n).h }
                const onMove = (me) => {
                  const k = viewRef.current.k || 1
                  const w = Math.max(80, Math.round(start.w + (me.clientX - start.x) / k))
                  const hh = Math.max(40, Math.round(start.h + (me.clientY - start.y) / k))
                  patchNodeLocalSize(n.id, w, hh)
                }
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove)
                  window.removeEventListener("pointerup", onUp)
                  const s = sizeRef.current[n.id]
                  if (s) rdApi("node-update", { root: rootRef.current, node: n.id, patch: { size: s } }).then(() => {})
                }
                window.addEventListener("pointermove", onMove)
                window.addEventListener("pointerup", onUp)
              },
            }) : null,
          )
        }),
      ),
    ),
    marquee ? h("div", {
      className: "rd-marquee",
      style: {
        left: Math.min(marquee.x0, marquee.x1),
        top: Math.min(marquee.y0, marquee.y1),
        width: Math.abs(marquee.x1 - marquee.x0),
        height: Math.abs(marquee.y1 - marquee.y0),
      },
    }) : null,
    h("div", { className: "rd-hud" },
      h("button", { onClick: () => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) })), title: "缩小" }, "−"),
      h("span", { className: "rd-hud-k" }, Math.round(view.k * 100) + "%"),
      h("button", { onClick: () => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) })), title: "放大" }, "＋"),
      h("button", { onClick: fitView, title: "适应窗口", style: { width: "auto", padding: "0 4px" } }, "⤢"),
    ),
    linkFrom ? h("div", { className: "rd-tip" }, "连线模式：" + linkFrom + " → 点目标节点") : null,
  )

  // ── 侧栏 ──
  const sideProps = selNode ? h("div", null,
    h("div", { className: "rd-row" },
      h("span", { className: "rd-label" }, selNode.id + " · v" + selNode.version),
      selNode.inCycle ? h("span", { className: "rd-count" }, "在回路中") : null,
      h("div", { style: { flex: 1 } }),
      h("button", { className: "rd-btn rd-btn-danger", disabled: !!busy, onClick: () => removeNode(selNode.id) }, "删除"),
    ),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "标题"),
      h("input", { className: "rd-input", value: draft ? draft.title : "", onChange: (e) => setDraft({ ...draft, title: e.target.value }) })),
    h("div", { className: "rd-row" },
      h("div", { className: "rd-field", style: { flex: 1 } }, h("span", { className: "rd-label" }, "类型"),
        h("select", { className: "rd-select", value: draft ? draft.kind : "step", onChange: (e) => setDraft({ ...draft, kind: e.target.value }) },
          Object.keys(rdKindLabel).map((k) => h("option", { value: k, key: k }, rdKindLabel[k])))),
      h("div", { className: "rd-field", style: { flex: 1 } }, h("span", { className: "rd-label" }, "状态"),
        h("select", { className: "rd-select", value: draft ? draft.status : "planned", onChange: (e) => setDraft({ ...draft, status: e.target.value }) },
          Object.keys(rdStatusLabel).map((k) => h("option", { value: k, key: k }, rdStatusLabel[k])))),
    ),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "泳道 / 阶段"),
      h("input", { className: "rd-input", value: draft ? draft.track : "", onChange: (e) => setDraft({ ...draft, track: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "颜色（即时生效）"),
      h("div", { className: "rd-swatches" },
        rdPalette.map((c) => h("button", {
          key: c, className: "rd-swatch" + (selNode.color === c ? " rd-swatch-on" : ""),
          style: { background: c }, title: c, onClick: () => quickPatch(selNode.id, { color: c }),
        })),
        h("input", { type: "color", value: /^#/.test(selNode.color) ? selNode.color : "#4f8ef7", onChange: (e) => quickPatch(selNode.id, { color: e.target.value }), style: { width: 26, height: 22, padding: 0, border: 0, background: "0 0" } }),
        h("button", { className: "rd-btn", onClick: () => quickPatch(selNode.id, { color: "" }) }, "默认"),
      )),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "形状（即时生效）"),
      h("select", { className: "rd-select", value: selNode.shape, onChange: (e) => quickPatch(selNode.id, { shape: e.target.value }) },
        rdShapes.map((s) => h("option", { value: s, key: s }, rdShapeLabel[s])))),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "输入 inputs（每行一个产物/数据）"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 48 }, value: draft ? draft.inputs : "", onChange: (e) => setDraft({ ...draft, inputs: e.target.value }), placeholder: "如：raw_reads.fastq\nmanifest.tsv" })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "输出 outputs（每行一个产物/数据）"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 48 }, value: draft ? draft.outputs : "", onChange: (e) => setDraft({ ...draft, outputs: e.target.value }), placeholder: "如：clean_reads.fastq\nqc_report.html" })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "工具 / 软件 tool"),
      h("input", { className: "rd-input", value: draft ? draft.tool : "", onChange: (e) => setDraft({ ...draft, tool: e.target.value }), placeholder: "如：Phrap / GLIMMER / bwa+bcftools" })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "命令 / 程序 command"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 56 }, value: draft ? draft.command : "", onChange: (e) => setDraft({ ...draft, command: e.target.value }), placeholder: "如：phrap reads.fasta -minmatch 30 -penalty -2" })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "摘要"),
      h("textarea", { className: "rd-textarea", value: draft ? draft.summary : "", onChange: (e) => setDraft({ ...draft, summary: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "分析策略"),
      h("textarea", { className: "rd-textarea", value: draft ? draft.strategy : "", onChange: (e) => setDraft({ ...draft, strategy: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "超参 params（JSON）"),
      h("textarea", { className: "rd-textarea", value: draft ? draft.params : "", onChange: (e) => setDraft({ ...draft, params: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "测试 tests（每行一条）"),
      h("textarea", { className: "rd-textarea", value: draft ? draft.tests : "", onChange: (e) => setDraft({ ...draft, tests: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "标签 tags（逗号分隔）"),
      h("input", { className: "rd-input", value: draft ? draft.tags : "", onChange: (e) => setDraft({ ...draft, tags: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "关联 refs（JSON：experiment/artifact/hypothesis）"),
      h("textarea", { className: "rd-textarea", value: draft ? draft.refs : "", onChange: (e) => setDraft({ ...draft, refs: e.target.value }) })),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "版本备注（为什么改）"),
      h("input", { className: "rd-input", value: draft ? draft.note : "", onChange: (e) => setDraft({ ...draft, note: e.target.value }), placeholder: "如：换用 bwa-mem2，超参 grid 调整" })),
    h("div", { className: "rd-row", style: { marginTop: 8 } },
      h("button", { className: "rd-btn", disabled: !!busy, onClick: loadVersions }, "版本历史"),
      h("button", { className: "rd-btn rd-btn-on", disabled: !!busy, onClick: saveDraft }, busy ? "保存中…" : "保存（新版本）"),
    ),
    h("div", { className: "rd-meta", style: { marginTop: 6 } }, "上游 " + (selNode.upstream || []).join(",") + " ｜ 下游 " + (selNode.downstream || []).join(",")),
  ) : selEdgeObj ? h("div", null,
    h("div", { className: "rd-row" }, h("span", { className: "rd-label" }, "关系 " + selEdgeObj.id)),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "类型（即时生效）"),
      h("select", { className: "rd-select", value: selEdgeObj.type, onChange: (e) => updateLink(selEdgeObj.id, { type: e.target.value }) },
        Object.keys(rdEdgeLabel).map((t) => h("option", { value: t, key: t }, rdEdgeLabel[t])))),
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "标签"),
      h("input", {
        className: "rd-input", defaultValue: selEdgeObj.label || "", key: selEdgeObj.id,
        onKeyDown: (e) => { if (e.key === "Enter") updateLink(selEdgeObj.id, { label: e.target.value }) },
        onBlur: (e) => { if ((e.target.value || "") !== (selEdgeObj.label || "")) updateLink(selEdgeObj.id, { label: e.target.value }) },
      })),
    h("div", { className: "rd-meta", style: { marginTop: 6 } }, selEdgeObj.from + " → " + selEdgeObj.to + "（回车或失焦保存标签）"),
    h("div", { className: "rd-row", style: { marginTop: 8 } },
      h("button", { className: "rd-btn rd-btn-danger", disabled: !!busy, onClick: () => removeLink(selEdgeObj.id) }, "删除关系")),
  ) : sel.length > 1 ? h("div", null,
    h("div", { className: "rd-row" },
      h("span", { className: "rd-label" }, "已选 " + sel.length + " 个节点"),
      h("span", { className: "rd-count" }, "可整体拖动"),
    ),
    h("div", { className: "rd-meta", style: { marginTop: 6 } },
      "按住任一选中节点拖动即可整体移动；Shift / ⌘ / Ctrl + 点击加选或减选；在画布空白处 Shift+拖动（或点上方「框选」）框选多个节点。"),
    h("div", { className: "rd-row", style: { marginTop: 8 } },
      h("button", { className: "rd-btn", onClick: () => { setSel(nodes.map((n) => n.id)); setSelEdge("") } }, "全选"),
      h("button", { className: "rd-btn", onClick: () => setSel([]) }, "清空选择"),
    ),
  )
    : h("div", { className: "rd-empty" }, "点选节点看属性/版本；点选连线可改类型；Shift / ⌘ + 点击多选，或空白处 Shift+拖动框选（点上方「框选」可免按 Shift）。")

  const sideVer = h("div", null,
    versions === null ? h("div", { className: "rd-empty" }, "点「版本历史」读取。")
      : versions.length === 0 ? h("div", { className: "rd-empty" }, "暂无版本。")
        : versions.slice().reverse().map((v) => h("div", { className: "rd-ver", key: v.version, style: { marginTop: 6 } },
          h("div", { className: "rd-row" },
            h("span", { className: "rd-label" }, "v" + v.version + " · " + (v.change === "create" ? "新建" : v.change === "revert" ? "回滚" : "更新")),
            h("div", { style: { flex: 1 } }),
            selNode && v.version !== selNode.version ? h("button", { className: "rd-btn", disabled: !!busy, onClick: () => revert(v.version) }, "回滚到此版") : h("span", { className: "rd-meta" }, "当前"),
          ),
          h("div", { className: "rd-meta" }, (v.at || "").slice(0, 19).replace("T", " ") + " · " + (v.author || "")),
          v.note ? h("div", { className: "rd-meta" }, "备注：" + v.note) : null,
          v.changed && v.changed.length ? h("div", { className: "rd-meta" }, "变更：" + v.changed.join(", ")) : null,
        )),
  )

  const sideAi = h("div", null,
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "研究目标（AI 据此拆解路线图）"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 72 }, value: aiGoal, onChange: (e) => setAiGoal(e.target.value), placeholder: "如：从 Illumina 原始 reads 到耐药基因分型，需要比较两套组装策略并做超参搜索" })),
    h("div", { className: "rd-row", style: { marginTop: 6 } },
      h("select", { className: "rd-select", value: aiMode, onChange: (e) => setAiMode(e.target.value) },
        h("option", { value: "merge" }, "合并（增量，推荐）"),
        h("option", { value: "replace" }, "重建（清空后生成）")),
      cfg && cfg.ai ? h("span", { className: "rd-meta" }, cfg.ai.configured
        ? "AI 模型：" + cfg.ai.provider + "/" + cfg.ai.model + (cfg.ai.reachable === false ? "（provider 未注册，请改用「复制提示词给会话」）" : "")
        : "未配置 ai.model，AI 生成会回落全局默认模型") : null,
    ),
    h("div", { className: "rd-row", style: { marginTop: 6 } },
      h("button", { className: "rd-btn rd-btn-on", disabled: !!busy, onClick: aiGenerate }, "AI 生成"),
      h("button", { className: "rd-btn", disabled: !!busy, onClick: aiMakePrompt }, "复制提示词给会话"),
    ),
    aiPrompt ? h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "提示词（粘贴到 DSH 会话让 agent 调 roadmap_apply）"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 120 }, value: aiPrompt, readOnly: true })) : null,
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "粘贴路线图 JSON 规格导入"),
      h("textarea", { className: "rd-textarea", style: { minHeight: 100 }, value: aiSpec, onChange: (e) => setAiSpec(e.target.value), placeholder: '{"nodes":[{"ref":"qc","title":"质控"}],"edges":[]}' })),
    h("div", { className: "rd-row", style: { marginTop: 6 } },
      h("button", { className: "rd-btn", disabled: !!busy, onClick: aiImport }, "导入规格"),
      h("button", { className: "rd-btn", disabled: !!busy || !rm, onClick: copyMermaid }, "复制 Mermaid"),
    ),
    rm && rm.history && rm.history.length ? h("div", { className: "rd-field" },
      h("span", { className: "rd-label" }, "最近操作（rev " + rm.rev + "）"),
      h("div", { className: "rd-pre" }, rm.history.slice(0, 8).map((x) => `#${x.rev} ${x.op} ${x.target} ${x.note || ""}`).join("\n")),
    ) : null,
  )

  const sideIo = h("div", null,
    h("div", { className: "rd-meta" }, "IO 传递：节点的 outputs 与下游 inputs 同名时，自动成为这条边上的产物；「属性」页可编辑 inputs/outputs/tool/command。"),
    !io ? h("div", { className: "rd-empty" }, "宿主未返回 IO 汇总（需要重启 DSH 载入新引擎）。")
      : h("div", null,
        h("div", { className: "rd-label", style: { marginTop: 8 } }, "产物传递（" + io.transfers.length + " 条）"),
        io.transfers.length ? io.transfers.map((t) => h("div", { className: "rd-ver", key: "io" + t.edge },
          h("div", { className: "rd-meta" }, t.from + " → " + t.to + "（" + (rdEdgeLabel[t.type] || t.type) + "）"),
          h("div", { className: "rd-node-label", style: { color: "var(--dsw-alias-label-primary)", fontSize: 12, textAlign: "left" } }, t.artifacts.join(" / ")),
        )) : h("div", { className: "rd-empty" }, "暂无同名 inputs/outputs 匹配；在节点属性里补齐输入/输出后自动出现。"),
        h("div", { className: "rd-label", style: { marginTop: 8 } }, "工具 / 软件"),
        nodes.filter((n) => n.tool).length
          ? nodes.filter((n) => n.tool).map((n) => h("div", { className: "rd-row", key: "tool" + n.id },
            h("span", { className: "rd-count" }, n.id),
            h("span", { className: "rd-node-label", style: { fontSize: 12, textAlign: "left" } }, "⚙ " + n.tool),
            n.command ? h("span", { className: "rd-meta", title: n.command }, "命令") : null,
          ))
          : h("div", { className: "rd-empty" }, "尚未登记工具。"),
        h("div", { className: "rd-label", style: { marginTop: 8 } }, "产物清单（" + io.artifacts.length + "）"),
        io.artifacts.length ? io.artifacts.map((a) => h("div", { className: "rd-meta", key: "art" + a.name, style: { wordBreak: "break-all" } },
          a.name + "｜产出 " + (a.producedBy.join(",") || "—") + " → 消费 " + (a.consumedBy.join(",") || "—"))) : h("div", { className: "rd-empty" }, "还没有输入/输出登记。"),
        (io.orphanOutputs.length || io.missingInputs.length)
          ? h("div", { className: "rd-meta", style: { marginTop: 6, color: "var(--dsw-alias-state-warn-primary)" } },
            [io.orphanOutputs.length ? "无消费者：" + io.orphanOutputs.join(", ") : "", io.missingInputs.length ? "无生产者：" + io.missingInputs.join(", ") : ""].filter(Boolean).join(" ｜ "))
          : null,
      ),
  )

  const side = h("div", { className: "rd-side" },
    h("div", { className: "rd-tabs" },
      h("button", { className: "rd-tab" + (tab === "props" ? " rd-tab-on" : ""), onClick: () => setTab("props") }, "属性"),
      h("button", { className: "rd-tab" + (tab === "ver" ? " rd-tab-on" : ""), onClick: () => { setTab("ver"); if (selNode && versions === null) loadVersions() } }, "版本"),
      h("button", { className: "rd-tab" + (tab === "io" ? " rd-tab-on" : ""), onClick: () => setTab("io") }, "数据流"),
      h("button", { className: "rd-tab" + (tab === "ai" ? " rd-tab-on" : ""), onClick: () => setTab("ai") }, "AI 生成"),
    ),
    tab === "props" ? sideProps : tab === "ver" ? sideVer : tab === "io" ? sideIo : sideAi,
  )

  return h("div", { className: "rd" },
    toolbar,
    h("div", { className: "rd-row" },
      h("input", { className: "rd-input", style: { flex: 1 }, value: root, readOnly: !!wsRoot, onChange: (e) => setRoot(e.target.value), placeholder: "项目根目录（含 .dsh/，如 /Users/me/projA）" }),
      wsRoot
        ? h("span", { className: "rd-meta", title: "路线图跟随当前会话所属项目，同一项目的所有会话共用一份" }, "跟随项目：" + (project.title || project.path))
        : null,
      h("button", { className: "rd-btn", disabled: !!busy || !root, onClick: () => load(root) }, "刷新"),
      !rm ? h("button", { className: "rd-btn rd-btn-on", disabled: !!busy || !root, onClick: initRoadmap }, "初始化路线图") : null,
    ),
    rm && rm.file ? h("div", { className: "rd-hint" }, "数据文件：" + rm.file + "（AI 用 roadmap_* 工具改的就是这份；拖拽/连线即时落盘）") : null,
    err ? h("div", { className: "rd-err" }, err) : null,
    okMsg ? h("div", { className: "rd-ok" }, okMsg) : null,
    busy ? h("div", { className: "rd-busy" }, busy) : null,
    linkBar,
    h("div", { className: "rd-body" },
      root && rm === null && !busy
        ? h("div", { className: "rd-canvas", style: { display: "flex", alignItems: "center", justifyContent: "center" } },
            h("div", { className: "rd-empty" }, root
              ? "该目录还没有路线图：点「初始化路线图」，或在「AI 生成」里让模型直接生成一版。"
              : "当前会话还没有关联项目目录：新建会话时选一个工作区，或在顶部手动填写项目根目录。"))
        : canvas,
      sideOpen ? side : null,
    ),
    stats ? h("div", { className: "rd-row" },
      h("span", { className: "rd-count" }, "步骤 " + (stats.byKind.step || 0)),
      h("span", { className: "rd-count" }, "issue " + (stats.byKind.issue || 0)),
      h("span", { className: "rd-count" }, "里程碑 " + (stats.byKind.milestone || 0)),
      h("span", { className: "rd-count" }, "串联 " + (stats.byType.serial || 0)),
      h("span", { className: "rd-count" }, "并联 " + (stats.byType.parallel || 0)),
      h("span", { className: "rd-count" }, "反馈 " + (stats.byType.feedback || 0)),
      h("span", { className: "rd-count" }, "循环 " + (stats.byType.loop || 0)),
      stats.criticalPath && stats.criticalPath.length > 1 ? h("span", { className: "rd-meta" }, "关键路径：" + stats.criticalPath.join(" → ")) : null,
      stats.cycles && stats.cycles.length ? h("span", { className: "rd-meta", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "回路：" + stats.cycles.map((c) => "[" + c.join(",") + "]").join(" ")) : null,
    ) : null,
  )
}

function applyRoadmap(ctx) {
  const slots = ctx.get("slots")
  if (slots === undefined) return
  const tagId = "dsh-science/roadmap-ui.css"
  if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
    const tag = document.createElement("style")
    tag.dataset.plugin = "dsh-science"
    tag.dataset.pluginCss = tagId
    tag.textContent = rdCSS
    document.head.appendChild(tag)
  }
  // 顶层会话视图：与「会话」「轨迹」并列（conversation.view），跟随会话所属项目。
  // order 20 排在「轨迹」(10) 之后；不设 children（本视图没有子槽位）。
  slots.inject("conversation.view", () => slots.register(
    { name: "conversation.view", id: "roadmap", order: 20, label: "技术路线图" },
    RdPage,
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
  // 侧栏增强（Codex 式置顶项目 / 右键菜单 / 悬停信息）走 DOM 层，不依赖 slots：
  // DSH 的 `sidebar.workspaces` 是 single slot，原生浏览区已占用，插件无法再注册。
  applySidebar(ctx)
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
  // 技术路线图画布（节点/关系/版本管理），来自同一 bundle 的 roadmap.js（拼接注入）
  applyRoadmap(ctx)
}

// 构建脚本会把 `module.exports = plugin` 追加到包装末尾（factory 内导出）。
const plugin = { name: "remote-hosts-ui", inject: ["slots"], apply }
// 侧栏增强的纯函数（无 DOM）暴露给 Node 侧单测：test/sidebar-client.test.mjs
plugin._sidebarTest = sbTest
		//#endregion
		module.exports = plugin;
		return module.exports;
	}
});
