// http-guard —— model-tier 设置页 REST 路由的来源校验（零依赖，host 侧）
//
// 与 dsh-science/engines/http-guard.mjs 同一份逻辑（本包可独立发布，故不跨包引用）。
// 背景：DSH 桌面端（Electron）把页面放在自定义特权 scheme `dsh-app://app/`，主进程
// forwardWebRequest() 转发到本机 Host 时会删除 origin / sec-fetch-site / host，
// 只补 Host 认证 cookie。旧实现要求必须有 Origin，桌面端因此一律 403
// （「非浏览器同源请求被拒绝（缺少/不匹配 Origin）」）。
//
// 判定与 DSH 自身 /api 的 Host/Origin 围栏一致：
//   1. 有 Origin：必须与 Host 同一 http(s) authority；
//   2. 无 Origin：只有 Host 为回环地址才放行（桌面壳转发 / 本地 curl）；
//   3. `Sec-Fetch-Site: cross-site` 一律拒绝。
// 浏览器跨站 POST 必带 Origin 与 Sec-Fetch-Site，无法伪造成「缺失 Origin」。

/** IPv4 回环：127.0.0.0/8。 */
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function hostnameOf(authority) {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Host authority 是否指向本机回环地址。
 * @param {string} authority - 请求的 Host 头原文。
 * @returns {boolean}
 */
export function isLoopbackAuthority(authority) {
  const host = hostnameOf(authority);
  if (host === "") return false;
  return host === "localhost" || host === "::1" || LOOPBACK_V4.test(host);
}

/**
 * 只放行「同源浏览器」与「本机回环上的非浏览器请求」。
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isTrustedLocalRequest(req) {
  const headers = (req && req.headers) || {};
  const host = headers.host;
  if (typeof host !== "string" || host === "") return false;
  if (String(headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;

  const origin = headers.origin;
  if (origin === undefined || origin === "") return isLoopbackAuthority(host);

  let originUrl;
  try {
    originUrl = new URL(String(origin));
  } catch {
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;
  try {
    return originUrl.host === new URL(`${originUrl.protocol}//${host}`).host;
  } catch {
    return false;
  }
}
