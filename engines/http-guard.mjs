// http-guard —— 面板 REST 路由的「来源」校验（零依赖，host 侧）
//
// 四条 webServer 前缀路由（/dsh-science/roadmap、/dsh-science/workbench、
// /dsh-science/remote-hosts、/dsh-model-tier）都在本机 Host 上直接读写用户文件，
// 因此需要挡住来自浏览器的跨站调用。旧实现要求每个请求都带 Origin 且 Origin 的
// authority 必须等于 Host，否则 403 —— 这在「浏览器直连 http://127.0.0.1:<port>」
// 下成立，但在 DSH 桌面端（Electron 外壳）会误伤：
//
//   桌面端渲染进程的页面 origin 是自定义特权 scheme `dsh-app://app/`，页面中的
//   fetch("/dsh-science/roadmap/show") 被主进程 protocol.handle("dsh-app") 接管，
//   交给 forwardWebRequest() 转发到本机 Host。转发时它显式删除
//   origin / sec-fetch-site / host，再补上 Host 认证 cookie，于是到达插件的请求
//   只有 `Host: 127.0.0.1:<port>`，没有 Origin —— 旧实现一律 403，桌面端所有
//   面板（技术路线图 / 科研工作台 / 远程主机 / 智能分档）打开即报
//   「非浏览器同源请求被拒绝（缺少/不匹配 Origin）」。
//
// 现在的判定与 DSH 自身 /api 的 Host/Origin 围栏（dsh-client-connection 的
// isTrustedApiRequest）保持一致：
//   1. 有 Origin：必须与 Host 是同一个 http(s) authority，否则 403；
//   2. 无 Origin：只有 Host 是本机回环地址才放行（桌面壳转发、curl、脚本调试），
//      非回环 Host 上一律 403；
//   3. 任意情况下 `Sec-Fetch-Site: cross-site` 直接 403（浏览器跨站标记，双保险）。
//
// 安全性：浏览器发出的跨站 POST（fetch / no-cors / 表单提交）一定带 Origin 与
// Sec-Fetch-Site，无法伪造成「缺失 Origin」，所以 (1)(3) 才是 CSRF 防线；(2) 的
// 放开面是本机回环地址，与 DSH 平台对 /api 的信任模型相同（本机进程本来就能直接
// 读写同一批文件，非浏览器客户端此前也能靠伪造 Origin 绕过旧校验）。

/** IPv4 回环：127.0.0.0/8。 */
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** 取 authority 的主机名（去端口、去 IPv6 方括号）；解析失败返回空串。 */
function hostnameOf(authority) {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Host authority 是否指向本机回环地址。
 * 接受 `127.0.0.1:3080`、`[::1]:3080`、`localhost:3080` 以及不带端口的写法。
 * @param {string} authority - 请求的 Host 头原文。
 * @returns {boolean}
 */
export function isLoopbackAuthority(authority) {
  const host = hostnameOf(authority);
  if (host === "") return false;
  return host === "localhost" || host === "::1" || LOOPBACK_V4.test(host);
}

/**
 * 面板路由的来源校验：只放行「同源浏览器」与「本机回环上的非浏览器请求」。
 * @param {import("node:http").IncomingMessage} req - 进入 webServer 路由的请求。
 * @returns {boolean} true 表示可以继续处理。
 */
export function isTrustedLocalRequest(req) {
  const headers = (req && req.headers) || {};
  const host = headers.host;
  if (typeof host !== "string" || host === "") return false;
  if (String(headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;

  const origin = headers.origin;
  // 桌面壳转发 / curl / 本地脚本：无 Origin，只信任回环 Host。
  if (origin === undefined || origin === "") return isLoopbackAuthority(host);

  let originUrl;
  try {
    originUrl = new URL(String(origin));
  } catch {
    return false; // Origin: null（sandboxed / 不透传页面）等
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;
  // 用 Origin 的 scheme 解析 Host，让 80/443 默认端口归一化（反代场景）。
  try {
    return originUrl.host === new URL(`${originUrl.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
