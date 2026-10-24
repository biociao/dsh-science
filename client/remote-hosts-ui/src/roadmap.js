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
.rd-overall{display:flex;align-items:center;gap:8px;min-width:190px}
.rd-bar{position:relative;flex:1;height:8px;min-width:70px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.rd-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.rd-bar-fill.rd-bar-done{background:var(--dsw-alias-state-success-primary)}
.rd-progress-big{font-size:24px;font-weight:600;line-height:30px}
.rd-prog-row{display:flex;flex-direction:column;gap:3px;margin-top:7px}
.rd-prog-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.rd-prog-node{display:flex;align-items:center;gap:8px;padding:2px 0;cursor:pointer;border-radius:6px}
.rd-prog-node:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rd-prog-node .rd-bar{min-width:56px;height:6px}
.rd-prog-name{font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rd-prog-pct{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:34px;text-align:right}
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

// 完成进度：显式 percent > done/total > 状态推导（done=100 / dropped=0 / 其余未知=null）。
// 优先用宿主算好的 n.percent；旧宿主没有该字段时在这里兜底推导，保证画布行为一致。
function rdPercentOf(n) {
  if (!n) return null
  if (typeof n.percent === "number" && Number.isFinite(n.percent)) return Math.max(0, Math.min(100, Math.round(n.percent)))
  const p = n.progress
  if (p && typeof p === "object") {
    if (Number.isFinite(Number(p.percent))) return Math.max(0, Math.min(100, Math.round(Number(p.percent))))
    if (Number.isFinite(Number(p.done)) && Number.isFinite(Number(p.total)) && Number(p.total) > 0) {
      return Math.max(0, Math.min(100, Math.round((Number(p.done) / Number(p.total)) * 100)))
    }
  }
  if (n.status === "done") return 100
  if (n.status === "dropped") return 0
  return null
}

function rdProgressTextOf(n) {
  const p = n && n.progress
  const pct = rdPercentOf(n)
  if (p && Number.isFinite(Number(p.done)) && Number.isFinite(Number(p.total))) {
    return `${p.done}/${p.total}${p.unit ? " " + p.unit : ""}${pct !== null ? "（" + pct + "%）" : ""}`
  }
  return pct !== null ? pct + "%" : ""
}

// 汇总进度（总进度 / 分泳道 / 分类型 / 样本合计）——客户端自算，旧宿主也能显示
function rdProgressOf(rm) {
  const nodes = (rm && rm.nodes) || []
  const known = []
  const samples = { done: 0, total: 0 }
  const bag = () => ({ nodes: 0, known: 0, sum: 0, percent: null, done: 0, total: 0 })
  const byTrack = {}
  const byKind = {}
  const bump = (m, key, n, pct) => {
    const k = key || "（未分类）"
    const slot = m[k] || (m[k] = bag())
    slot.nodes += 1
    if (pct !== null) { slot.known += 1; slot.sum += pct }
    const p = n.progress
    if (p && Number.isFinite(Number(p.done))) slot.done += Number(p.done)
    if (p && Number.isFinite(Number(p.total))) slot.total += Number(p.total)
  }
  for (const n of nodes) {
    const pct = rdPercentOf(n)
    if (pct !== null) known.push(pct)
    const p = n.progress
    if (p && Number.isFinite(Number(p.done))) samples.done += Number(p.done)
    if (p && Number.isFinite(Number(p.total))) samples.total += Number(p.total)
    bump(byTrack, n.track, n, pct)
    bump(byKind, n.kind, n, pct)
  }
  for (const m of [byTrack, byKind]) for (const k of Object.keys(m)) m[k].percent = m[k].known ? Math.round(m[k].sum / m[k].known) : null
  const doneNodes = nodes.filter((n) => n.status === "done").length
  return {
    overall: known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
    known: known.length,
    unknown: nodes.length - known.length,
    nodes: nodes.length,
    doneNodes,
    samples: { done: samples.done, total: samples.total, percent: samples.total > 0 ? Math.round((samples.done / samples.total) * 100) : null },
    byTrack,
    byKind,
  }
}

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
  const [tab, setTab] = React.useState("prog")
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
      // 进度输入（保存走「样本数」按钮；百分比按钮即时生效）
      progDone: selNode.progress && Number.isFinite(Number(selNode.progress.done)) ? String(selNode.progress.done) : "",
      progTotal: selNode.progress && Number.isFinite(Number(selNode.progress.total)) ? String(selNode.progress.total) : "",
      progUnit: (selNode.progress && selNode.progress.unit) || "样本",
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
  const prog = rm ? rdProgressOf(rm) : null
  const transferByEdge = new Map(((io && io.transfers) || []).map((t) => [t.edge, t.artifacts]))

  const toolbar = h("div", { className: "rd-head" },
    h("span", { className: "rd-title" }, "技术路线图"),
    rm ? h("span", { className: "rd-count" }, nodes.length + " 节点 / " + edges.length + " 关系" + (io ? " / " + io.artifacts.length + " 产物" : "")) : null,
    stats && stats.cycleCount ? h("span", { className: "rd-count", style: { color: "var(--dsw-alias-state-warn-primary)" } }, "回路 " + stats.cycleCount) : null,
    // 总进度：所有"已知进度"节点的平均值（未记录进度的不计入），鼠标悬停看样本合计
    prog && prog.overall !== null ? h("div", {
      className: "rd-overall",
      title: "总体完成进度：" + prog.overall + "%（" + prog.known + "/" + prog.nodes + " 个节点有进度记录）" + (prog.samples.total > 0 ? "；样本 " + prog.samples.done + "/" + prog.samples.total : ""),
    },
      h("span", { className: "rd-label" }, "总进度"),
      h("div", { className: "rd-bar" }, h("div", { className: "rd-bar-fill" + (prog.overall >= 100 ? " rd-bar-done" : ""), style: { width: Math.max(0, Math.min(100, prog.overall)) + "%" } })),
      h("span", { className: "rd-meta" }, prog.overall + "%" + (prog.samples.total > 0 ? " · " + prog.samples.done + "/" + prog.samples.total : "")),
    ) : null,
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
        // 每个节点一份裁剪路径：进度填充被裁进节点形状里（菱形/六边形/圆形同样成立）
        nodes.map((n) => h("clipPath", { id: "rd-clip-" + n.id, key: "clip-" + n.id },
          rdShapeEl(n.shape, rects[n.id], {}))),
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
            // 完成进度：按百分比从左向右填充节点形状（裁剪到形状内部），并在填充前沿画一条亮线。
            // 未记录进度（percent=null）的节点不画填充，避免把"没数据"误读成 0%。
            (() => {
              const pct = rdPercentOf(n)
              if (pct === null || pct <= 0) return null
              const edgeX = r.x + (r.w * pct) / 100
              return h("g", { clipPath: "url(#rd-clip-" + n.id + ")", style: { pointerEvents: "none" } },
                h("rect", { x: r.x, y: r.y, width: Math.max(0.5, r.w * pct / 100), height: r.h, fill: "#fff", opacity: 0.3 }),
                h("line", { x1: edgeX, y1: r.y, x2: edgeX, y2: r.y + r.h, stroke: "#fff", strokeWidth: 1.5, opacity: 0.6 }),
              )
            })(),
            n.kind === "milestone" ? h("text", { className: "rd-node-sub", x: r.x + 6, y: r.y + 12, fill: "#fff", opacity: 0.9 }, "◆") : null,
            n.inCycle ? h("text", { className: "rd-node-sub", x: r.x + r.w - 14, y: r.y + 13, fill: "#fff", opacity: 0.9 }, "↻") : null,
            h("text", { className: "rd-node-label", x: r.cx, y: r.cy - 2, textAnchor: "middle", fill: "#fff" }, rdCut(n.title, 18)),
            view.k >= 0.42 ? h("text", { className: "rd-node-sub", x: r.cx, y: r.cy + 15, textAnchor: "middle", fill: "#fff" },
              (rdKindLabel[n.kind] || n.kind) + " · " + (rdStatusLabel[n.status] || n.status) + (n.track ? " · " + rdCut(n.track, 8) : "")) : null,
            view.k >= 0.35 ? h("text", { className: "rd-node-sub", x: r.x + r.w - 6, y: r.y + r.h - 5, textAnchor: "end", fill: "#fff", opacity: 0.75 },
              "v" + n.version + (rdPercentOf(n) !== null ? " · " + rdPercentOf(n) + "%" : "")) : null,
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
    // 完成进度：百分比按钮即时生效（画布节点图形块按比例填充），也可按「完成/总数」记录样本数
    h("div", { className: "rd-field" }, h("span", { className: "rd-label" }, "完成进度（即时生效）"),
      h("div", { className: "rd-row" },
        [0, 25, 50, 75, 100].map((p) => h("button", {
          key: "p" + p, className: "rd-btn", disabled: !!busy,
          onClick: () => patchNode(selNode.id, { progress: p }, "进度设为 " + p + "%"),
        }, p + "%")),
        rdPercentOf(selNode) !== null ? h("span", { className: "rd-count" }, "当前 " + rdPercentOf(selNode) + "%") : h("span", { className: "rd-meta" }, "未记录"),
      ),
      h("div", { className: "rd-row", style: { marginTop: 4 } },
        h("input", { className: "rd-input", style: { width: 62 }, type: "number", min: 0, placeholder: "完成", value: draft ? draft.progDone : "", onChange: (e) => setDraft({ ...draft, progDone: e.target.value }) }),
        h("span", { className: "rd-meta" }, "/"),
        h("input", { className: "rd-input", style: { width: 62 }, type: "number", min: 1, placeholder: "总数", value: draft ? draft.progTotal : "", onChange: (e) => setDraft({ ...draft, progTotal: e.target.value }) }),
        h("input", { className: "rd-input", style: { width: 58 }, placeholder: "单位", value: draft ? draft.progUnit : "", onChange: (e) => setDraft({ ...draft, progUnit: e.target.value }) }),
        h("button", {
          className: "rd-btn", disabled: !!busy || !draft || !draft.progTotal,
          onClick: () => patchNode(selNode.id, {
            progress: { done: Number(draft.progDone) || 0, total: Number(draft.progTotal), unit: draft.progUnit || undefined },
          }, "样本 " + (Number(draft.progDone) || 0) + "/" + Number(draft.progTotal)),
        }, "保存样本数"),
        selNode.progress ? h("button", { className: "rd-btn rd-btn-danger", disabled: !!busy, onClick: () => patchNode(selNode.id, { progress: null }, "清除进度") }, "清除") : null,
      ),
      selNode.progress && selNode.progress.note ? h("div", { className: "rd-meta" }, "备注：" + selNode.progress.note) : null,
    ),
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

  // ── 进度面板：总体完成度 + 分泳道/分类型 + 逐步进度（点行定位到节点）──
  const progRow = (label, slot, nodeId) => h("div", {
    className: "rd-prog-row" + (nodeId ? " rd-prog-node" : ""),
    key: (nodeId || "g") + ":" + label,
    onClick: nodeId ? () => { setSel([nodeId]); setSelEdge(""); setTab("props") } : undefined,
    title: nodeId ? "点击定位该步骤" : undefined,
  },
    h("div", { className: "rd-prog-head" },
      h("span", { className: "rd-prog-name" }, label),
      h("span", { className: "rd-prog-pct" },
        slot && slot.total
          ? (slot.done || 0) + "/" + slot.total
          : slot && slot.percent !== null && slot.percent !== undefined ? slot.percent + "%" : "—"),
    ),
    h("div", { className: "rd-bar" },
      h("div", {
        className: "rd-bar-fill" + (slot && slot.percent >= 100 ? " rd-bar-done" : ""),
        style: { width: Math.max(0, Math.min(100, (slot && slot.percent) || 0)) + "%" },
      })),
  )

  const sideProg = h("div", null,
    h("div", { className: "rd-row" },
      h("div", { className: "rd-progress-big" }, prog && prog.overall !== null ? prog.overall + "%" : "—"),
      h("div", { style: { flex: 1 } }),
      h("span", { className: "rd-meta" }, prog ? prog.doneNodes + "/" + prog.nodes + " 步骤完成" : ""),
    ),
    h("div", { className: "rd-bar", style: { height: 10, marginTop: 6 } },
      h("div", { className: "rd-bar-fill" + (prog && prog.overall >= 100 ? " rd-bar-done" : ""), style: { width: Math.max(0, Math.min(100, (prog && prog.overall) || 0)) + "%" } })),
    h("div", { className: "rd-meta", style: { marginTop: 5 } },
      prog
        ? "有进度记录 " + prog.known + "/" + prog.nodes + " 个节点" + (prog.unknown ? "（未记录 " + prog.unknown + " 个不计入平均）" : "") + (prog.samples.total > 0 ? " ｜ 样本 " + prog.samples.done + "/" + prog.samples.total + "（" + prog.samples.percent + "%）" : "")
        : ""),
    h("div", { className: "rd-label", style: { marginTop: 12 } }, "按泳道"),
    prog ? Object.keys(prog.byTrack).map((k) => progRow(k, prog.byTrack[k], null)) : h("div", { className: "rd-empty" }, "暂无数据。"),
    h("div", { className: "rd-label", style: { marginTop: 12 } }, "按类型"),
    prog ? Object.keys(prog.byKind).map((k) => progRow(rdKindLabel[k] || k, prog.byKind[k], null)) : null,
    h("div", { className: "rd-label", style: { marginTop: 12 } }, "逐步进度（点击定位）"),
    nodes.length
      ? nodes.map((n) => progRow(rdCut(n.title, 18), { percent: rdPercentOf(n), done: n.progress && n.progress.done, total: n.progress && n.progress.total }, n.id))
      : h("div", { className: "rd-empty" }, "还没有步骤。"),
  )

  const side = h("div", { className: "rd-side" },
    h("div", { className: "rd-tabs" },
      h("button", { className: "rd-tab" + (tab === "props" ? " rd-tab-on" : ""), onClick: () => setTab("props") }, "属性"),
      h("button", { className: "rd-tab" + (tab === "prog" ? " rd-tab-on" : ""), onClick: () => setTab("prog") }, "进度"),
      h("button", { className: "rd-tab" + (tab === "ver" ? " rd-tab-on" : ""), onClick: () => { setTab("ver"); if (selNode && versions === null) loadVersions() } }, "版本"),
      h("button", { className: "rd-tab" + (tab === "io" ? " rd-tab-on" : ""), onClick: () => setTab("io") }, "数据流"),
      h("button", { className: "rd-tab" + (tab === "ai" ? " rd-tab-on" : ""), onClick: () => setTab("ai") }, "AI 生成"),
    ),
    tab === "props" ? sideProps : tab === "prog" ? sideProg : tab === "ver" ? sideVer : tab === "io" ? sideIo : sideAi,
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

// ── 按项目显隐「技术路线图」标签页 ───────────────────────────────────────────
// conversation.view 的 tab 列表由 slots.entries() 全局生成（shell 没有"按会话过滤"的钩子，
// 唯一内建特例是 developerTools 关闭时隐藏 trajectory），所以「项目没有路线图就不显示这个
// 标签页」只能这样做：**只在当前项目有 .dsh/roadmap.json 时才把入口注册进去，否则 dispose**。
//
// 当前项目 = 当前会话所属 Workspace 的 path：
//   workspaces.list.getSnapshot().items 里有 { workspaceId, path, sessionIds[] }，
//   uiWorkspace.mainReference.sessionId 是当前会话 id（与 shell 新建会话时的推导方式一致）。
// 工作区变化时重新判定；隐藏期间每 5s 轻量复查一次（本地 HTTP，开销可忽略），
// 这样 AI 在会话里 roadmap_init 后，标签页最多 5s 内自动出现。

const RD_VIEW_META = { name: "conversation.view", id: "roadmap", order: 20, label: "技术路线图" }
const RD_RECHECK_HIDDEN_MS = 5000

function rdCurrentProjectRoot(ctx) {
  try {
    const ws = ctx.get("workspaces")
    const store = ws && ws.list
    if (!store || typeof store.getSnapshot !== "function") return { supported: false, root: null }
    const snap = store.getSnapshot() || {}
    const items = Array.isArray(snap.items) ? snap.items : []
    const ui = ctx.get("uiWorkspace")
    const ref = ui && ui.mainReference
    const sessionId = ref && ref.sessionId
    const project = rdProjectOf(items, sessionId)
    const root = project && typeof project.path === "string" && project.path ? project.path : null
    return { supported: true, root }
  } catch {
    return { supported: false, root: null }
  }
}

function rdMountView(ctx, slots) {
  let slotReady = false
  let entry = null
  let want = false
  let lastRoot = null
  let lastProbeAt = 0
  let probing = false
  let timer = null

  const sync = () => {
    if (!slotReady) return
    if (want && !entry) {
      entry = slots.register(RD_VIEW_META, RdPage) || null
    } else if (!want && entry) {
      try { entry() } catch { /* 忽略 */ }
      entry = null
    }
  }

  const probe = async (root) => {
    if (probing) return
    probing = true
    lastProbeAt = Date.now()
    try {
      const r = await rdApi("show", { root })
      want = Boolean(r && r.ok !== false && r.initialized)
      lastRoot = root
      sync()
    } catch {
      /* 宿主不可用 / 尚未重启加载本引擎：保持现状，不误隐藏 */
    } finally {
      probing = false
    }
  }

  const recheck = (force) => {
    const cur = rdCurrentProjectRoot(ctx)
    // 宿主没提供 workspaces 服务（旧版本/受限宿主）→ 退回旧行为：始终显示，不误隐藏
    if (!cur.supported) { want = true; sync(); return }
    // 有服务但没有当前项目（欢迎页/未选会话）→ 不显示
    if (!cur.root) { want = false; sync(); return }
    const root = cur.root
    if (!force && root === lastRoot) {
      if (want) return                                              // 已显示且项目没变 → 不用再查
      if (Date.now() - lastProbeAt < RD_RECHECK_HIDDEN_MS) return    // 隐藏中 → 限流复查
    }
    probe(root)
  }

  // 槽位就绪后先判定一次：默认不注册，避免"没有路线图的项目"闪一下标签页
  slots.inject("conversation.view", () => {
    slotReady = true
    recheck(true)
    return () => {
      slotReady = false
      if (entry) {
        try { entry() } catch { /* 忽略 */ }
        entry = null
      }
    }
  })

  // 工作区列表变化（新建/切换/删除工作区）→ 重新判定
  try {
    const ws = ctx.get("workspaces")
    const store = ws && ws.list
    if (store && typeof store.subscribe === "function" && typeof ctx.effect === "function") {
      ctx.effect(() => store.subscribe(() => recheck(false)))
    }
  } catch {
    /* 无 workspaces 服务时靠轮询兜底 */
  }
  // 会话切换（同一工作区内换项目）与"隐藏期间 AI 新建了路线图"两件事都靠轮询兜底。
  // Node 下 unref，避免测试/无浏览器环境因定时器挂住进程；浏览器里返回数字，无此方法。
  timer = setInterval(() => recheck(false), 3000)
  if (timer && typeof timer.unref === "function") timer.unref()

  return () => {
    if (timer) { clearInterval(timer); timer = null }
    if (entry) {
      try { entry() } catch { /* 忽略 */ }
      entry = null
    }
  }
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
  // 顶层会话视图：与「会话」「轨迹」并列（conversation.view），跟随会话所属项目，
  // 且**项目没有路线图时不注册**——标签页因此不出现。
  const teardown = rdMountView(ctx, slots)
  if (typeof ctx.effect === "function") ctx.effect(() => () => { if (typeof teardown === "function") teardown() })
}
