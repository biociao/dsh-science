// science-remote-hosts-ui —— 远程主机配置 UI 的宿主侧（webServer REST API）
//
// 对应 Claude Science 的 Settings > Compute > SSH hosts。浏览器侧 UI 通过
// fetch 调用本插件注册的 HTTP 路由，读写与 remote-compute 引擎同一套数据：
//   主机注册表 $DSH_HOME/remotes/hosts.json（全机）
//   白名单 / 作业 <项目根>/.dsh/remotes/allowlist.json、jobs.json（按项目）
// 并支持真实 ssh 只读探测（CPU/GPU/CUDA/conda/sbatch/SLURM 分区）。
//
// 零第三方依赖（node 内置模块 + 系统 OpenSSH）。作为 bundle 行挂载于 profile
// （cordis.patch.yml），不进入 agent preset（设置页是 profile 级 UI）。
//
// v0.2.0 新增。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export const name = "science-remote-hosts-ui";
export const inject = ["webServer"];

const HOSTS_DIR = (() => {
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "remotes");
})();

function hostsFilePath() {
  return path.join(HOSTS_DIR, "hosts.json");
}

async function readJson(abs, fallback) {
  try {
    return JSON.parse(await fsp.readFile(abs, "utf8"));
  } catch (e) {
    return fallback;
  }
}

async function writeJson(abs, obj) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function loadHosts() {
  const p = hostsFilePath();
  const d = await readJson(p, { hosts: [] });
  return { p, hosts: Array.isArray(d.hosts) ? d.hosts : [] };
}

async function saveHosts(p, hosts) {
  await writeJson(p, { schema: 1, hosts, updatedAt: new Date().toISOString() });
}

// ── 只读探测（与 remote-compute 引擎同一脚本与解析格式）──────────────────

const PROBE = [
  'echo "UNAME|$(uname -srm)"',
  'echo "CPUS|$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"',
  'm=$(free -b 2>/dev/null | awk \'NR==2{print $2}\'); [ -z "$m" ] && m=$(sysctl -n hw.memsize 2>/dev/null); echo "MEMB|$m"',
  'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed "s/^/GPU|/"; nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | sed "s/^/CUDA|/"; else echo "GPU|none"; echo "CUDA|none"; fi',
  'for t in conda mamba module apptainer singularity sbatch squeue sacct scancel; do if command -v "$t" >/dev/null 2>&1; then echo "TOOL|$t=yes"; else echo "TOOL|$t=no"; fi; done',
  'if command -v sbatch >/dev/null 2>&1; then echo "SLURM|$(sbatch --version 2>&1 | head -1)"; sinfo -o "%P|%a|%D|%t" 2>/dev/null | sed "s/^/PART|/"; else echo "SLURM|none"; fi',
].join("\n");

function parseProbe(text) {
  const p = { os: "", cpus: 0, memBytes: 0, gpus: [], cudaDriver: "", conda: false, mamba: false, module: false, apptainer: false, singularity: false, sbatch: false, squeue: false, sacct: false, scancel: false, scratchDirs: [], slurmVersion: null, partitions: [] };
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("|");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (!v) continue;
    if (k === "UNAME") p.os = v;
    else if (k === "CPUS") p.cpus = Number(v) || 0;
    else if (k === "MEMB") p.memBytes = Number(v) || 0;
    else if (k === "GPU") p.gpus.push(v);
    else if (k === "CUDA") p.cudaDriver = v;
    else if (k === "SLURM") p.slurmVersion = v === "none" ? null : v;
    else if (k === "PART") { const s = v.split("|"); p.partitions.push({ name: s[0], avail: s[1], nodes: s[2], state: s[3] }); }
    else if (k === "TOOL") { const nv = v.split("="); if (nv[0] in p) p[nv[0]] = nv[1] === "yes"; }
  }
  return p;
}

function probeCommand(host) {
  const b = Buffer.from(PROBE, "utf8").toString("base64");
  if (host.transport === "local") return `bash -c "echo ${b} | base64 -d | bash"`;
  const a = ["ssh", "-o", "ConnectTimeout=15"];
  if (host.batchMode !== false) a.push("-o", "BatchMode=yes");
  if (host.port) a.push("-p", String(host.port));
  if (host.identityFile) a.push("-i", host.identityFile);
  a.push(host.alias || host.id);
  const safe = (s) => (/^[A-Za-z0-9_\-.\/@:]+$/.test(s) ? s : `'${s}'`);
  return `${a.map(safe).join(" ")} "echo ${b} | base64 -d | bash"`;
}

function runCommand(argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function runProbe(host) {
  try {
    const res = await runCommand(["sh", "-c", probeCommand(host)], { timeoutMs: 30000 });
    if (res.code !== 0) return { ok: false, error: `探测失败(exit ${res.code})：${res.stderr.trim().slice(0, 200) || res.stdout.trim().slice(0, 200)}` };
    return { ok: true, probe: parseProbe(res.stdout) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  }
}

// ── HTTP 辅助 ─────────────────────────────────────────────────────────────

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(buf ? JSON.parse(buf) : {}));
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

// 同源校验：只接受浏览器同源请求（防止跨站调用本地服务）
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // 非浏览器（curl 等）拒绝
  const host = req.headers.host;
  if (!host) return false;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch (e) {
    return false;
  }
}

const fail = (msg) => ({ ok: false, error: String(msg && msg.message || msg).slice(0, 400) });
const projFile = (root, name) => `${root}/.dsh/remotes/${name}.json`;

function makeHandlers(ctx) {
  return {
    async config() {
      return { ok: true, dshHome: HOSTS_DIR.replace(/\/remotes$/, ""), hostsFile: hostsFilePath() };
    },
    async list() {
      const { p, hosts } = await loadHosts();
      return { ok: true, hostsFile: p, hosts };
    },
    async addHost(a) {
      const { p, hosts } = await loadHosts();
      const id = String(a.host || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
      if (!id) return fail("host id 不能为空");
      if (hosts.some((x) => x.id === id)) return fail(`主机 ${id} 已存在`);
      const t = a.transport === "local" ? "local" : "ssh";
      const e = {
        id, transport: t, alias: t === "local" ? "local" : String(a.alias || id),
        notes: String(a.notes || ""), scratch: String(a.scratch || "~/dsh-scratch"),
        maxConcurrent: Number(a.maxConcurrent) || 100, timeoutMinutes: Number(a.timeoutMinutes) || 30,
        port: a.port ? Number(a.port) : undefined, identityFile: a.identityFile ? String(a.identityFile) : undefined,
        batchMode: a.batchMode !== false, probe: null, probeError: null, probedAt: null,
        addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      if (a.probe !== false) {
        const r = await runProbe(e);
        if (r.ok) { e.probe = r.probe; e.probedAt = new Date().toISOString(); }
        else e.probeError = r.error;
      }
      hosts.push(e);
      await saveHosts(p, hosts);
      return { ok: true, host: e };
    },
    async updateHost(a) {
      const { p, hosts } = await loadHosts();
      const h = hosts.find((x) => x.id === a.host);
      if (!h) return fail(`主机 ${a.host} 未注册`);
      const p2 = a.patch || {};
      if ("notes" in p2) h.notes = String(p2.notes);
      if ("scratch" in p2) h.scratch = String(p2.scratch);
      if ("maxConcurrent" in p2) h.maxConcurrent = Number(p2.maxConcurrent) || h.maxConcurrent;
      if ("timeoutMinutes" in p2) h.timeoutMinutes = Number(p2.timeoutMinutes) || h.timeoutMinutes;
      if ("port" in p2) h.port = p2.port ? Number(p2.port) : undefined;
      if ("identityFile" in p2) h.identityFile = p2.identityFile ? String(p2.identityFile) : undefined;
      if ("batchMode" in p2) h.batchMode = p2.batchMode !== false;
      if (p2.alias) h.alias = String(p2.alias);
      h.updatedAt = new Date().toISOString();
      await saveHosts(p, hosts);
      return { ok: true, host: h };
    },
    async removeHost(a) {
      const { p, hosts } = await loadHosts();
      const n = hosts.length;
      const rest = hosts.filter((x) => x.id !== a.host);
      if (rest.length === n) return fail(`主机 ${a.host} 未注册`);
      await saveHosts(p, rest);
      return { ok: true };
    },
    async probeHost(a) {
      const { p, hosts } = await loadHosts();
      const h = hosts.find((x) => x.id === a.host);
      if (!h) return fail(`主机 ${a.host} 未注册`);
      const r = await runProbe(h);
      if (r.ok) { h.probe = r.probe; h.probeError = null; h.probedAt = new Date().toISOString(); }
      else h.probeError = r.error;
      h.updatedAt = new Date().toISOString();
      await saveHosts(p, hosts);
      return { ok: true, probe: h.probe, probeError: h.probeError, probedAt: h.probedAt };
    },
    async projectInfo(a) {
      const root = String(a.root || "");
      if (!root) return { ok: true, allowlist: [], jobs: [], counts: {}, allowlistFile: null, jobsFile: null };
      const aw = await readJson(projFile(root, "allowlist"), { hosts: [] });
      const jb = await readJson(projFile(root, "jobs"), { jobs: [] });
      const jobs = Array.isArray(jb.jobs) ? jb.jobs : [];
      const counts = {};
      for (const j of jobs) counts[j.state] = (counts[j.state] || 0) + 1;
      return {
        ok: true,
        allowlist: Array.isArray(aw.hosts) ? aw.hosts : [],
        jobs: jobs.slice(-15).reverse().map((j) => ({ id: j.id, host: j.host, title: j.title, state: j.state, exitCode: j.exitCode })),
        counts,
        allowlistFile: projFile(root, "allowlist"),
        jobsFile: projFile(root, "jobs"),
      };
    },
    async revoke(a) {
      const root = String(a.root || "");
      if (!root) return fail("缺少 root");
      const f = projFile(root, "allowlist");
      const d = await readJson(f, { hosts: [] });
      d.hosts = (d.hosts || []).filter((x) => x.host !== a.host);
      await writeJson(f, d);
      return { ok: true };
    },
  };
}

const METHODS = ["config", "list", "add-host", "update-host", "remove-host", "probe-host", "project-info", "revoke"];

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (!webServer) return;
  const handlers = makeHandlers(ctx);
  const byName = {
    config: handlers.config,
    list: handlers.list,
    "add-host": handlers.addHost,
    "update-host": handlers.updateHost,
    "remove-host": handlers.removeHost,
    "probe-host": handlers.probeHost,
    "project-info": handlers.projectInfo,
    revoke: handlers.revoke,
  };
  const disposer = webServer.register({
    kind: "prefix",
    path: "/dsh-science/remote-hosts",
    async handler(req, res) {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "仅支持 POST" });
      if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "非浏览器同源请求被拒绝（缺少/不匹配 Origin）" });
      const name = (req.url || "").replace(/^\/dsh-science\/remote-hosts\/?/, "").split("/")[0];
      if (!name || !METHODS.includes(name)) return send(res, 404, { ok: false, error: `未知方法 ${name}` });
      try {
        const body = await readBody(req);
        const result = await byName[name](body || {});
        send(res, 200, result);
      } catch (e) {
        send(res, 400, fail(e));
      }
    },
  });
  ctx.on("dispose", disposer);
}

export { apply };
