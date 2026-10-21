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
   避免展开大量会话时把「工作区 / 最近」挤掉。overflow 必须 !important：原生
   regionArea 的 overflow:hidden 与属性选择器同权重且加载更晚，不加 !important
   会被覆盖成 hidden（内容被裁切、鼠标滚轮无法滚动）。 */
[data-dshsci-scroll="1"]{overflow-y:auto!important;overflow-x:hidden!important;min-height:0}
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
