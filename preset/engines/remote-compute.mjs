// science-remote-compute —— 远程计算引擎（Remote Compute），对应 Claude Science 的
// "Remote compute clusters"（SSH 连接目标服务器、在服务器上跑生信分析、监控长时任务）。
//
// 工作机制（对照 Claude Science 官方文档《Remote compute clusters》）：
//   A 主机注册：读取用户 ~/.ssh/config 的别名（alias），或显式 user@host；可选覆盖
//     User / Port / IdentityFile；添加时做只读探测（CPU/内存/GPU/CUDA/conda/module/
//     Apptainer/sbatch/scratch 目录/SLURM 分区），结果存档并可随时重探测。
//   B 作业提交：工作站以 detached 进程运行（nohup + setsid，断连不杀，作业目录在 scratch 下），
//     SLURM 集群经 sbatch 提交；提交前默认要求审批（等价于 Claude Science 的
//     "Run this job on <host>?" 审批卡）；默认作业超时 30 分钟（可在 wrapper 内用 timeout 包装）。
//   C 监控与反应：remote_status 批量探测（ps / squeue+sacct / done+exitcode 标记），
//     状态自动迁移 running → succeeded/failed/killed；remote_logs 尾随日志；
//     remote_pull 把输出拉回本地（超过阈值的大文件留在主机并记录路径，默认 100MB）。
//   D 主机备注：host.notes 是可编辑的"Details 文档"，模型可读写（环境激活方式、分区、
//     账号、约定等），随 remote_host_show/remote_host_notes 使用。
//   E 项目级访问白名单（v0.2.0 新增）：<项目根>/.dsh/remotes/allowlist.json 记录本项目
//     允许访问的服务器；首次使用某主机（注册探测 / probe / exec / run）默认弹审批，
//     批准后按项目持久化授权（等价于 Claude Science 审批卡的 "This project" 作用域），
//     remote_host_allowlist 查看、remote_host_allow/revoke 管理；无人值守可设
//     requireHostAccess:false 关闭。
//   F 按 project 隔离（v0.2.0 强化）：项目根按优先级探测
//     research-manifest.json（研究项目）→ .dsh（工作区）→ .git（仓库）→ 会话工作目录；
//     白名单与作业注册表都挂在项目根下，同一工作区里的多个研究项目各自独立；
//     授权/作业路径在拿不到会话工作目录时 fail-closed（绝不回退进程 cwd 造成跨项目共享）。
//
// 实现约束：零第三方依赖（只用 node 内置模块 + 系统 OpenSSH 二进制：ssh / scp）。
// 主机注册表存 $DSH_HOME/remotes/hosts.json（默认 ~/.dsh/remotes，可 config.hostsDir 覆盖）；
// 作业注册表存 <项目根>/.dsh/remotes/jobs.json（随项目走，跨会话持续）。
// transport=local 时经本地 bash 执行（用于本机演练/CI 测试，行为与 ssh 完全一致）。
//
// v0.2.0 新增。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import * as core from "./core.mjs";

export const name = "science-remote-compute";
export const inject = ["tools"];

// ── 常量 ────────────────────────────────────────────────────────────────────

const SCHEMA = 1;
const HOST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/; // 主机 id（作业 id 等标识符）
// 远程路径允许的字符子集：禁止引号/空白/重定向/管道等 shell 元字符，防注入。
const SAFE_PATH_RE = /^[A-Za-z0-9_\-./@:=+,%]+$/;
const DEFAULT_BIG_FILE_BYTES = 100 * 1024 ** 2; // 100 MB（与 Claude Science 默认一致）
const DEFAULT_TIMEOUT_MIN = 30;
const DEFAULT_MAX_CONCURRENT = 100;
const MAX_OUT_BYTES = 256 * 1024; // 单次捕获 stdout/stderr 上限，防止撑爆内存
const CONTROL_FILES = new Set(["script.sh", "run.sh", "env.sh", "pid", "done", "exitcode"]);
const SLURM_FINAL = new Map([
  ["COMPLETED", "succeeded"],
  ["FAILED", "failed"],
  ["CANCELLED", "killed"],
  ["TIMEOUT", "failed"],
  ["OUT_OF_MEMORY", "failed"],
  ["NODE_FAIL", "failed"],
]);

function safePath(p, what) {
  if (typeof p !== "string" || !p.trim()) {
    throw core.sciErr("ERR_VALIDATION", `${what} 不能为空`);
  }
  const s = p.trim();
  // 允许开头的 ~/（远程 shell 展开）或精确 "~"；其余字符必须是安全子集
  const body = s === "~" ? "" : s.startsWith("~/") ? s.slice(2) : s;
  if (!SAFE_PATH_RE.test(body)) {
    throw core.sciErr("ERR_VALIDATION", `${what} 含非法字符（允许：字母数字与 -_. /@:=+,% ，开头可 ~/ ；禁止引号/空白/元字符）：${s}`);
  }
  return s;
}

// 单引号包裹（用于安全字符集内的路径）。注意：~/ 开头的路径不能加引号，否则 tilde 不展开。
const sq = (s) => (s === "~" || s.startsWith("~/")) ? s : `'${s}'`;

// 本地传输时把 ~/ 展开成绝对路径（node fs 不做 tilde 展开）
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function hostsDirPath(config) {
  const base = config.hostsDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "remotes");
  return base;
}

async function loadHosts(config) {
  const p = path.join(hostsDirPath(config), "hosts.json");
  const raw = await core.readJson(p, { schema: SCHEMA, hosts: [] });
  return { path: p, hosts: Array.isArray(raw.hosts) ? raw.hosts : [] };
}

async function saveHosts(p, hosts) {
  await core.writeJsonAtomic(p, { schema: SCHEMA, hosts, updatedAt: core.nowISO() });
}

function findHost(hosts, id) {
  const h = hosts.find((x) => x.id === id);
  if (!h) {
    throw core.sciErr(
      "ERR_HOST",
      `主机 ${id} 未注册。用 remote_host_add 添加（可用 remote_host_list 查看现有主机）。`
    );
  }
  return h;
}

function jobsPath(root) {
  return path.join(root, ".dsh", "remotes", "jobs.json");
}

async function loadJobs(root) {
  return core.readJson(jobsPath(root), { schema: SCHEMA, jobs: [] });
}

async function saveJobs(root, data) {
  await fsp.mkdir(path.dirname(jobsPath(root)), { recursive: true });
  await core.writeJsonAtomic(jobsPath(root), data);
}

// ── 项目级主机访问白名单（允许访问的服务器列表）────────────────────────────
// <项目根>/.dsh/remotes/allowlist.json：只有白名单内（或本次审批刚授权）的主机，
// 才允许被 remote_host_add(探测)/remote_host_probe/remote_exec/remote_run 连接。
// 相当于 Claude Science 审批卡的 "This project" 作用域：首次使用弹审批，
// 批准后按项目持久化；remote_host_allowlist 查看、remote_host_allow/revoke 管理。

function allowlistPath(root) {
  return path.join(root, ".dsh", "remotes", "allowlist.json");
}

async function loadAllowlist(root) {
  return core.readJson(allowlistPath(root), { schema: SCHEMA, hosts: [] });
}

async function saveAllowlist(root, data) {
  await fsp.mkdir(path.dirname(allowlistPath(root)), { recursive: true });
  await core.writeJsonAtomic(allowlistPath(root), data);
}

async function isHostAllowed(root, hostId) {
  const list = await loadAllowlist(root);
  return list.hosts.some((h) => h.host === hostId);
}

// 授权检查：未授权的主机 → 弹审批（理由含将要执行的操作）→ 批准则按项目持久化。
// 返回 { created: boolean }（created=true 表示本次刚完成授权）。
// config.requireHostAccess=false 时跳过（无人值守场景，等效于全量授权）。
async function ensureHostAccess(ctx, exec, root, hostId, reason, config) {
  if (config.requireHostAccess === false) return { created: false, skipped: true };
  if (await isHostAllowed(root, hostId)) return { created: false, granted: true };
  const approval = ctx?.get?.("approval");
  if (!approval || !exec?.agent) {
    throw core.sciErr(
      "ERR_ACCESS",
      `主机 ${hostId} 未在本项目授权，且无法请求审批（approval 服务或 agent 上下文不可用）。` +
        `授权方式：在 GUI 审批弹窗批准，或用 remote_host_allow 添加（同样需审批），或手动编辑 ${allowlistPath(root)}；` +
        `无人值守场景可设插件配置 requireHostAccess: false。\n申请内容：${reason}`
    );
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name || "remote",
    callId: exec.callId,
    reason,
    signal: exec.signal,
  });
  if (outcome !== "allowed-once") {
    throw core.sciErr("ERR_ACCESS", `主机 ${hostId} 未被授权用于本项目（${outcome}）。用户拒绝了访问申请：${reason.split("\n")[0]}`);
  }
  await core.withFileLock(
    allowlistPath(root),
    async () => {
      const list = await loadAllowlist(root);
      if (!list.hosts.some((h) => h.host === hostId)) {
        list.hosts.push({ host: hostId, grantedAt: core.nowISO(), grantedBy: exec?.agent?.session?.id ?? "agent", note: "首次使用审批授权" });
      }
      await saveAllowlist(root, list);
    },
    { timeoutMs: 10000, staleMs: 30000 }
  );
  return { created: true, granted: true };
}

// 单个作业记录（缺省字段）
function newJob(jobId, host, title, jobDir) {
  return {
    id: jobId,
    host,
    title,
    state: "submitted", // submitted | running | succeeded | failed | killed | unknown
    mode: null, // direct | slurm
    pid: null,
    slurmJobId: null,
    jobDir,
    scriptPath: null,
    stdoutLog: null,
    stderrLog: null,
    localOutDir: null,
    bigFiles: [],
    timeoutMinutes: null,
    submittedAt: core.nowISO(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    lastCheckedAt: null,
    error: null,
  };
}

// ── 本地命令执行（ssh / scp / bash）────────────────────────────────────────
// 返回 { code, stdout, stderr, timedOut, aborted, truncated }

function captureStream(stream, buf) {
  stream.on("data", (c) => {
    if (buf.len < MAX_OUT_BYTES) {
      buf.data.push(c);
      buf.len += c.length;
      if (buf.len > MAX_OUT_BYTES) buf.truncated = true;
    }
  });
}

function runCommand(argv, opts = {}) {
  return new Promise((resolve) => {
    const { stdin, timeoutMs, signal } = opts;
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const out = { data: [], len: 0, truncated: false };
    const err = { data: [], len: 0, truncated: false };
    captureStream(child.stdout, out);
    captureStream(child.stderr, err);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      child.kill("SIGKILL");
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    signal?.addEventListener("abort", onAbort, { once: true });
    if (stdin !== undefined && stdin !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
    child.on("error", (e) => {
      // spawn 失败（如 ssh 不存在）：当作非零退出
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: 127, stdout: "", stderr: `spawn 失败: ${e.message}`, timedOut, aborted, truncated: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? (aborted ? -1 : 1),
        stdout: Buffer.concat(out.data).toString("utf8"),
        stderr: Buffer.concat(err.data).toString("utf8"),
        timedOut,
        aborted,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}

// ── 传输适配器：ssh（系统 OpenSSH）与 local（本地 bash，用于演练/测试）──────

function sshArgs(host, extra = []) {
  const args = [];
  if (host.batchMode !== false) args.push("-o", "BatchMode=yes");
  args.push("-o", "ConnectTimeout=15");
  if (host.port) args.push("-p", String(host.port));
  if (host.identityFile) args.push("-i", host.identityFile);
  args.push(...extra);
  args.push(host.alias);
  return args;
}

function scpArgs(host, extra = []) {
  const args = [];
  if (host.batchMode !== false) args.push("-o", "BatchMode=yes");
  args.push("-o", "ConnectTimeout=15");
  args.push("-q", "-r");
  if (host.port) args.push("-P", String(host.port));
  if (host.identityFile) args.push("-i", host.identityFile);
  args.push(...extra);
  return args;
}

function remoteExec(host, cmd, opts = {}) {
  if (host.transport === "local") return runCommand(["bash", "-c", cmd], opts);
  return runCommand(["ssh", ...sshArgs(host), cmd], opts);
}

// 传输适配器统一接口：run / writeFile / readFile / mkdir / listTop / rm / copyUp / copyDown
function makeAdapter(host) {
  const local = host.transport === "local";
  return {
    local,
    async run(cmd, opts) {
      return remoteExec(host, cmd, opts);
    },
    async writeFile(rpath, content) {
      if (local) {
        await fsp.mkdir(path.dirname(rpath), { recursive: true });
        await fsp.writeFile(rpath, content, "utf8");
        return;
      }
      const dir = path.posix.dirname(rpath);
      const res = await remoteExec(host, `mkdir -p ${sq(dir)} && cat > ${sq(rpath)}`, { stdin: content });
      if (res.code !== 0) throw sshFail(res, `写入远程文件 ${rpath}`);
    },
    async readFile(rpath, cap = MAX_OUT_BYTES) {
      if (local) {
        const st = await fsp.stat(rpath).catch(() => null);
        if (!st) throw core.sciErr("ERR_NOT_FOUND", `远程文件不存在：${rpath}`);
        return { exists: true, size: st.size, content: st.size > cap ? "" : await fsp.readFile(rpath, "utf8"), truncated: st.size > cap };
      }
      const res = await remoteExec(host, `if [ -f ${sq(rpath)} ]; then cat ${sq(rpath)}; else echo __MISSING__; fi`);
      if (res.code !== 0) throw sshFail(res, `读取远程文件 ${rpath}`);
      const content = res.stdout;
      if (content.startsWith("__MISSING__")) return { exists: false, size: 0, content: "", truncated: false };
      return { exists: true, size: Buffer.byteLength(content), content, truncated: res.truncated };
    },
    async mkdir(rpath) {
      if (local) {
        await fsp.mkdir(rpath, { recursive: true });
        return;
      }
      const res = await remoteExec(host, `mkdir -p ${sq(rpath)}`);
      if (res.code !== 0) throw sshFail(res, `创建远程目录 ${rpath}`);
    },
    // 顶层条目：F|<bytes>|<name>  或 D|<duKB>|<name>
    async listTop(rdir) {
      const script =
        `cd ${sq(rdir)} 2>/dev/null || { echo "__MISSING__"; exit 0; }\n` +
        `for f in * .[!.]*; do\n` +
        `  [ -e "$f" ] || continue\n` +
        `  if [ -d "$f" ]; then\n` +
        `    sz=$(du -sk "$f" 2>/dev/null | awk '{print $1}')\n` +
        `    echo "D|$sz|$f"\n` +
        `  else\n` +
        `    sz=$(wc -c < "$f" 2>/dev/null)\n` +
        `    echo "F|$sz|$f"\n` +
        `  fi\n` +
        `done`;
      if (local) {
        try {
          const entries = await fsp.readdir(rdir, { withFileTypes: true });
          const out = [];
          for (const e of entries) {
            const abs = path.join(rdir, e.name);
            const st = await fsp.stat(abs);
            out.push(e.isDirectory() ? `D|${Math.ceil(st.size / 1024)}|${e.name}` : `F|${st.size}|${e.name}`);
          }
          return parseListTop(out.join("\n"));
        } catch (err) {
          if (err.code === "ENOENT") return { exists: false, entries: [] };
          throw err;
        }
      }
      const res = await remoteExec(host, script);
      if (res.code !== 0) throw sshFail(res, `列出远程目录 ${rdir}`);
      if (res.stdout.includes("__MISSING__")) return { exists: false, entries: [] };
      return parseListTop(res.stdout);
    },
    async rm(rpath) {
      if (local) {
        await fsp.rm(rpath, { recursive: true, force: true });
        return;
      }
      await remoteExec(host, `rm -rf ${sq(rpath)}`);
    },
    async copyUp(localPaths, rdir) {
      if (local) {
        await fsp.mkdir(rdir, { recursive: true });
        for (const lp of localPaths) {
          const st = await fsp.stat(lp);
          if (st.isDirectory()) {
            await copyDir(lp, path.join(rdir, path.basename(lp)));
          } else {
            await fsp.mkdir(path.dirname(path.join(rdir, path.basename(lp))), { recursive: true });
            await fsp.copyFile(lp, path.join(rdir, path.basename(lp)));
          }
        }
        return;
      }
      const res = await runCommand(["scp", ...scpArgs(host), ...localPaths, `${host.alias}:${rdir}/`]);
      if (res.code !== 0) throw sshFail(res, `上传到 ${rdir}`);
    },
    async copyDown(rdir, names, ldir) {
      if (local) {
        await fsp.mkdir(ldir, { recursive: true });
        for (const n of names) {
          await copyDir(path.join(rdir, n), path.join(ldir, n));
        }
        return;
      }
      const targets = names.map((n) => `${host.alias}:${rdir}/${n}`);
      const res = await runCommand(["scp", ...scpArgs(host), ...targets, ldir + "/"]);
      if (res.code !== 0) throw sshFail(res, `拉取到 ${ldir}`);
    },
  };
}

function parseListTop(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const m = /^(D|F)\|(\d+)\|(.*)$/.exec(line);
    if (!m) continue;
    entries.push({
      name: m[3],
      type: m[1] === "D" ? "dir" : "file",
      size: m[1] === "D" ? Number(m[2]) * 1024 : Number(m[2]),
    });
  }
  return { exists: true, entries };
}

async function copyDir(src, dest) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const names = await fsp.readdir(src);
    for (const n of names) await copyDir(path.join(src, n), path.join(dest, n));
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

function sshFail(res, what) {
  return core.sciErr(
    "ERR_SSH",
    `${what} 失败（exit ${res.code}）：${res.stderr.trim().split("\n").slice(-3).join(" | ") || res.stdout.trim().split("\n").slice(-3).join(" | ")}`
  );
}

// ── 主机探测（只读；一次 ssh 会话收集全部信息）──────────────────────────────

function probeScript() {
  return [
    'echo "UNAME|$(uname -srm)"',
    'echo "CPUS|$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"',
    'm=$(free -b 2>/dev/null | awk \'NR==2{print $2}\'); [ -z "$m" ] && m=$(sysctl -n hw.memsize 2>/dev/null); echo "MEMB|$m"',
    'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | sed "s/^/GPU|/"; nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 | sed "s/^/CUDA|/"; else echo "GPU|none"; echo "CUDA|none"; fi',
    'for t in conda mamba module apptainer singularity sbatch squeue sacct scancel; do if command -v "$t" >/dev/null 2>&1; then echo "TOOL|$t=yes"; else echo "TOOL|$t=no"; fi; done',
    'for d in /scratch /scratch2 /tmp "$HOME"; do if [ -d "$d" ]; then echo "SCRATCH|$d"; fi; done',
    'if command -v sbatch >/dev/null 2>&1; then echo "SLURM|$(sbatch --version 2>&1 | head -1)"; sinfo -o "%P|%a|%D|%t" 2>/dev/null | sed "s/^/PART|/"; else echo "SLURM|none"; fi',
  ].join("\n");
}

function parseProbe(text) {
  const p = {
    os: "", cpus: 0, memBytes: 0, gpus: [], cudaDriver: "",
    conda: false, mamba: false, module: false, apptainer: false, singularity: false,
    sbatch: false, squeue: false, sacct: false, scancel: false,
    scratchDirs: [], slurmVersion: null, partitions: [],
  };
  for (const line of text.split("\n")) {
    const [k, ...rest] = line.split("|");
    const v = rest.join("|").trim();
    if (!v) continue;
    switch (k) {
      case "UNAME": p.os = v; break;
      case "CPUS": p.cpus = Number(v) || 0; break;
      case "MEMB": p.memBytes = Number(v) || 0; break;
      case "GPU": p.gpus.push(v); break;
      case "CUDA": p.cudaDriver = v; break;
      case "TOOL": {
        const [name, val] = v.split("=");
        if (name in p) p[name] = val === "yes";
        break;
      }
      case "SCRATCH": p.scratchDirs.push(v); break;
      case "SLURM": p.slurmVersion = v === "none" ? null : v; break;
      case "PART": {
        const [name, avail, nodes, state] = v.split("|");
        p.partitions.push({ name, avail, nodes, state });
        break;
      }
    }
  }
  return p;
}

async function probeHost(host, opts = {}) {
  const res = await remoteExec(host, probeScript(), opts);
  if (res.code !== 0) throw sshFail(res, `探测主机 ${host.id}`);
  return parseProbe(res.stdout);
}

// ── 审批（等价于 Claude Science 的 "Run this job on <host>?" 卡）────────────

async function requireApproval(ctx, exec, reason, config) {
  if (config.requireApproval === false) return;
  const approval = ctx?.get?.("approval");
  if (!approval || !exec?.agent) {
    throw core.sciErr(
      "ERR_APPROVAL",
      `无法请求审批（approval 服务或 agent 上下文不可用）。本工具默认要求审批；无人值守场景请在插件配置中设 requireApproval: false。\n审批内容：${reason}`
    );
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name || "remote_run",
    callId: exec.callId,
    reason,
    signal: exec.signal,
  });
  if (outcome !== "allowed-once") {
    throw core.sciErr("ERR_APPROVAL", `远程作业被拒绝（${outcome}）。用户未批准在 ${reason.split("\n")[0]} 上运行。`);
  }
}

// ── 作业提交 / 状态 / 取消 ──────────────────────────────────────────────────

// 生成 run.sh：可选 timeout 包装；运行 script.sh 后写 exitcode 与 done 标记。
// pid 最先写（启动即留痕，避免刚提交即查状态时误判 unknown）；cd 失败也落终态标记。
function runShContent(jobDir, workdir, timeoutMinutes, mode) {
  const runDir = workdir || jobDir;
  const lines = [
    "#!/bin/sh",
    "echo $$ > pid",
    `if ! cd ${sq(runDir)}; then echo 127 > exitcode; touch done; exit 127; fi`,
    "[ -f env.sh ] && . ./env.sh",
  ];
  if (mode !== "slurm" && timeoutMinutes && timeoutMinutes > 0) {
    lines.push(
      `if command -v timeout >/dev/null 2>&1; then`,
      `  timeout "${Math.floor(timeoutMinutes)}m" bash script.sh`,
      `else`,
      `  bash script.sh`,
      `fi`,
    );
  } else {
    lines.push("bash script.sh");
  }
  lines.push("rc=$?", 'echo "$rc" > exitcode', "touch done");
  return lines.join("\n");
}

// 单台主机的批量状态检查命令（direct + slurm 混合），输出逐行：
//   DIRECT|<jobId>|<jobDir>|running|<pid>|<etimes>
//   DIRECT|<jobId>|<jobDir>|done|<rc>
//   DIRECT|<jobId>|<jobDir>|killed|
//   DIRECT|<jobId>|<jobDir>|unknown|
//   SLURM|<jobId>|<sid>|queued|<state>
//   SLURM|<jobId>|<sid>|done|<sacctState>|<exitCode>
function statusScript(jobs) {
  const lines = [];
  const direct = jobs.filter((j) => j.mode === "direct");
  const slurm = jobs.filter((j) => j.mode === "slurm");
  for (const j of direct) {
    lines.push(
      `d=${sq(j.jobDir)}; pid=$(cat "$d/pid" 2>/dev/null);`,
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then`,
      `  et=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ');`,
      `  echo "DIRECT|${j.id}|$d|running|$pid|$et";`,
      `elif [ -f "$d/done" ]; then`,
      `  rc=$(cat "$d/exitcode" 2>/dev/null || echo 137);`,
      `  echo "DIRECT|${j.id}|$d|done|$rc|";`,
      `elif [ -n "$pid" ]; then`,
      `  echo "DIRECT|${j.id}|$d|killed||";`,
      `else`,
      `  echo "DIRECT|${j.id}|$d|unknown||";`,
      `fi`
    );
  }
  for (const j of slurm) {
    lines.push(
      `s=${sq(j.slurmJobId)};`,
      `st=$(squeue -j "$s" -h -o '%T' 2>/dev/null | head -1);`,
      `if [ -n "$st" ]; then`,
      `  echo "SLURM|${j.id}|$s|queued|$st";`,
      `else`,
      `  st2=$(sacct -j "$s" -X -n -o State -P 2>/dev/null | head -1);`,
      `  rc2=$(sacct -j "$s" -X -n -o ExitCode -P 2>/dev/null | head -1);`,
      `  echo "SLURM|${j.id}|$s|done|$st2|$rc2";`,
      `fi`
    );
  }
  return lines.join("\n");
}

function parseStatus(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|");
    if (parts[0] === "DIRECT") {
      // DIRECT|<jobId>|<jobDir>|running|<pid>|<etimes>  /  done|<rc>|  /  killed|  /  unknown|
      rows.push({ jobId: parts[1], jobDir: parts[2], raw: parts[3], v4: parts[4] || null, v5: parts[5] || null });
    } else if (parts[0] === "SLURM") {
      // SLURM|<jobId>|<sid>|queued|<state>  /  done|<sacctState>|<exitCode>
      rows.push({ jobId: parts[1], sid: parts[2], raw: parts[3], v4: parts[4] || null, v5: parts[5] || null });
    }
  }
  return rows;
}

// 根据探测行把作业状态迁移到终态（succeeded/failed/killed），返回 {job, transitioned}
function applyStatusRow(job, row) {
  const now = core.nowISO();
  job.lastCheckedAt = now;
  if (row.raw === "running" || row.raw === "queued") {
    job.state = "running";
    if (row.v4 && row.v4 !== job.pid) job.pid = row.v4;
    job.startedAt = job.startedAt || now;
    job.error = null;
    return { transitioned: false };
  }
  if (row.raw === "done") {
    let state;
    let exitCode;
    if (row.v4 && SLURM_FINAL.has(row.v4.toUpperCase())) {
      // SLURM：v4=sacct State，v5=ExitCode（如 0:0）
      state = SLURM_FINAL.get(row.v4.toUpperCase());
      const m = /^(\d+)/.exec(row.v5 || "");
      exitCode = m ? Number(m[1]) : null;
    } else {
      // DIRECT：v4=run.sh 写出的 exitcode
      exitCode = row.v4 !== null && row.v4 !== "" ? Number(row.v4) : null;
      state = exitCode === 0 ? "succeeded" : "failed";
    }
    const transitioned = job.state !== state || !job.finishedAt;
    job.state = state;
    job.exitCode = exitCode;
    job.finishedAt = job.finishedAt || now;
    job.error = null;
    return { transitioned };
  }
  if (row.raw === "killed") {
    const transitioned = job.state !== "killed" || !job.finishedAt;
    job.state = "killed";
    job.exitCode = job.exitCode ?? 137;
    job.finishedAt = job.finishedAt || now;
    return { transitioned };
  }
  // unknown（无 pid/done 标记）：刚提交的作业可能还没开始写 pid，宽限 20 秒不降级
  const fresh = job.submittedAt && Date.now() - new Date(job.submittedAt).getTime() < 20_000;
  if (fresh && ["submitted", "running"].includes(job.state)) {
    job.startedAt = job.startedAt || now;
    return { transitioned: false };
  }
  const transitioned = job.state !== "unknown";
  job.state = "unknown";
  return { transitioned };
}

// ── 拉取输出（大文件留主机、记录路径）──────────────────────────────────────

async function pullJobOutputs(host, adapter, job, args, root, config) {
  const threshold = args.thresholdBytes ?? config.bigFileThresholdBytes ?? host.bigFileThresholdBytes ?? DEFAULT_BIG_FILE_BYTES;
  const listing = await adapter.listTop(job.jobDir);
  if (!listing.exists) {
    throw core.sciErr("ERR_REMOTE", `远程作业目录不存在：${job.jobDir}（可能被清理）`);
  }
  const outDir = args.output
    ? path.resolve(root, args.output)
    : job.localOutDir || path.join(root, "analyses", "remote", job.id);
  const candidates = listing.entries.filter((e) => !CONTROL_FILES.has(e.name) && e.name !== "inputs");
  const pulled = [];
  const bigFiles = [];
  for (const e of candidates) {
    if (e.size > threshold) bigFiles.push({ name: e.name, size: e.size, kind: e.type });
    else pulled.push(e.name);
  }
  await fsp.mkdir(outDir, { recursive: true });
  if (pulled.length) await adapter.copyDown(job.jobDir, pulled, outDir);
  const manifest = {
    jobId: job.id,
    host: host.id,
    pulledAt: core.nowISO(),
    remoteJobDir: job.jobDir,
    localOutDir: outDir,
    pulled: pulled.map((n) => ({ name: n, size: listing.entries.find((e) => e.name === n)?.size ?? 0 })),
    leftOnHost: bigFiles,
    thresholdBytes: threshold,
    note: "leftOnHost 中的文件因超过阈值留在主机，路径见 remoteJobDir（可用 remote_exec 查看/按需下载）。",
  };
  const mf = path.join(outDir, "pulled-manifest.json");
  await core.writeJsonAtomic(mf, manifest);
  job.localOutDir = outDir;
  job.bigFiles = bigFiles;
  job.pulledAt = core.nowISO();
  return { manifest, outDir };
}

// ── 工具工厂包装（presentTitle + 审计走项目根 + timeoutMs 透传）─────────────

function sciTool(ctx, config, { name, description, parameters, presentTitle, outputSchema, audit, timeoutMs, execute }) {
  const tool = core.makeTool({
    name,
    description,
    parameters,
    presentTitle,
    outputSchema,
    audit: audit ? async (args, exec) => {
      try {
        return await core.resolveRoot(args, exec, config.markers);
      } catch {
        return undefined;
      }
    } : undefined,
    async execute(args, exec) {
      return execute(args, exec);
    },
  });
  if (timeoutMs) tool.timeoutMs = timeoutMs;
  ctx.tools.register(tool);
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  // 项目根标记：优先"研究项目"（research-manifest.json），其次工作区（.dsh），再其次 git 仓库。
  // 这样同一工作区里的多个研究项目各自持有独立的白名单/作业注册表（按 project 隔离）。
  const markers = Array.isArray(config.markers) && config.markers.length
    ? config.markers
    : ["research-manifest.json", ".dsh", ".git"];
  const lockOpts = {
    timeoutMs: config.lock?.timeoutMs ?? 10000,
    staleMs: config.lock?.staleMs ?? 30000,
  };
  const cfg = {
    markers,
    hostsDir: config.hostsDir,
    requireApproval: config.requireApproval !== false, // 每次 remote_run 提交作业默认要求审批（对齐 Claude Science 的作业审批卡）
    requireHostAccess: config.requireHostAccess !== false, // 首次使用主机默认要求项目级授权（白名单审批）
    bigFileThresholdBytes: config.bigFileThresholdBytes,
    execTimeoutMs: config.execTimeoutMs ?? 120000,
  };

  // 严格项目根：仅当显式 root 或会话携带工作目录时才解析；
  // 否则返回 null（授权/白名单路径 fail-closed，绝不回退到进程级 cwd 造成跨项目共享）。
  const resolveRootStrict = async (args, exec) => {
    if (args?.root || exec?.agent?.session?.cwd) {
      return core.resolveRoot(args, exec, markers);
    }
    return null;
  };
  // 严格解析 + 失败即抛（用于作业注册表等按项目定位的读写路径）
  const resolveRootStrictOrThrow = async (args, exec, what) => {
    const root = await resolveRootStrict(args, exec);
    if (!root) {
      throw core.sciErr(
        "ERR_VALIDATION",
        `无法确定项目根（缺少会话工作目录），无法${what}。请显式传 root=…，或先将会话绑定到工作区。`
      );
    }
    return root;
  };

  const withJobs = async (root, fn) =>
    core.withFileLock(
      jobsPath(root),
      async () => {
        const data = await loadJobs(root);
        const out = await fn(data);
        await saveJobs(root, data);
        return out;
      },
      lockOpts
    );

  const withHosts = async (fn) =>
    core.withFileLock(
      path.join(cfg.hostsDir || hostsDirPath(config), "hosts.json"),
      async () => {
        const { path: p, hosts } = await loadHosts(config);
        const out = await fn(hosts, p);
        await saveHosts(p, hosts);
        return out;
      },
      lockOpts
    );

  // ── remote_host_add：注册主机（ssh config 别名 / user@host / local）＋只读探测 ──
  sciTool(ctx, config, {
    name: "remote_host_add",
    description:
      "注册一台远程计算主机（等价于 Claude Science 的 Add SSH host）：alias 用 ~/.ssh/config 里的别名（或 user@host 形式，ProxyJump 等由 OpenSSH 自动处理），可选覆盖 port/identityFile；transport=local 表示在本机用 bash 执行（演练/测试用）。注册时自动做只读探测（CPU/内存/GPU/CUDA/conda/module/Apptainer/sbatch/scratch/SLURM 分区）并存档。host 是项目内使用的唯一标识。首次连接（注册+探测）默认要求审批，批准后该主机加入本项目白名单（remote_host_allowlist 查看）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机标识 id（字母数字与 -_，如 bio01 / gpu-cluster）" },
        alias: { type: "string", description: "ssh 配置别名或 user@host（默认等于 host）" },
        transport: { type: "string", enum: ["ssh", "local"], description: "传输方式：ssh（默认）/ local（本机演练）" },
        notes: { type: "string", description: "主机备注（Details 文档）：分区/账号/模块加载/环境激活方式等，模型提交作业前会参考" },
        scratch: { type: "string", description: "远程 scratch 根目录（作业目录建在 <scratch>/<jobId> 下；SLURM 须为共享文件系统；默认 ~/dsh-scratch）" },
        maxConcurrent: { type: "integer", description: "并发作业上限（默认 100）" },
        timeoutMinutes: { type: "integer", description: "默认作业超时（分钟，默认 30；超长任务请在提交时说明）" },
        bigFileThresholdBytes: { type: "integer", description: "输出拉回的大小阈值（默认 100MB，超过则留在主机）" },
        port: { type: "integer", description: "可选：覆盖 SSH 端口" },
        identityFile: { type: "string", description: "可选：覆盖私钥路径" },
        batchMode: { type: "boolean", description: "是否禁用交互式密码提示（默认 true，建议配好密钥/ssh-agent）" },
        probe: { type: "boolean", description: "注册时是否执行只读探测（默认 true）" },
        approve: { type: "boolean", description: "是否要求审批（默认按配置 requireHostAccess，通常 true）" },
      },
    },
    presentTitle: "注册远程主机",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        host: { type: "string" },
        alias: { type: "string" },
        transport: { type: "string" },
        probe: { type: "object" },
        probeError: { type: "string" },
        scratch: { type: "string" },
        notes: { type: "string" },
      },
      required: ["host", "alias", "transport"],
    },
    async execute(args, exec) {
      const id = core.slugify(core.requireStr(args, "host"), "host", 32);
      if (!HOST_ID_RE.test(id)) throw core.sciErr("ERR_VALIDATION", `主机 id 非法：${id}`);
      const transport = args.transport ?? "ssh";
      if (!["ssh", "local"].includes(transport)) throw core.sciErr("ERR_VALIDATION", "transport 只能是 ssh 或 local");
      const alias = transport === "local" ? "local" : core.optStr(args, "alias", id);
      if (transport === "ssh") {
        const which = await runCommand(["sh", "-c", "command -v ssh; command -v scp"]);
        if (which.code !== 0) {
          throw core.sciErr("ERR_SSH", "本机缺少 ssh/scp 命令（OpenSSH）。请先安装 OpenSSH 客户端并配置 ~/.ssh/config 与密钥。");
        }
      }
      // 首次连接该主机（注册+只读探测）默认要求审批；批准后按当前项目写入白名单。
      // （探测失败也允许注册：probeError 记录原因，不阻断后续 remote_host_probe）
      if (args.probe !== false && args.approve !== false) {
        const root = await resolveRootStrict(args, exec);
        if (!root) {
          throw core.sciErr(
            "ERR_ACCESS",
            "无法确定项目根（缺少会话工作目录），无法完成项目级授权。请在参数中显式传 root=…，或先将会话绑定到工作区。"
          );
        }
        await ensureHostAccess(ctx, exec, root, id, `注册并连接主机 ${id}（${alias}，${transport}）做只读探测（CPU/GPU/CUDA/conda/sbatch/SLURM 分区）`, cfg);
      }
      const entry = {
        id,
        alias,
        transport,
        notes: core.optStr(args, "notes", ""),
        scratch: args.scratch ? safePath(args.scratch, "scratch") : "~/dsh-scratch",
        maxConcurrent: args.maxConcurrent ? Math.max(1, Math.floor(Number(args.maxConcurrent)) || DEFAULT_MAX_CONCURRENT) : DEFAULT_MAX_CONCURRENT,
        timeoutMinutes: args.timeoutMinutes ? Math.max(1, Math.floor(Number(args.timeoutMinutes)) || DEFAULT_TIMEOUT_MIN) : DEFAULT_TIMEOUT_MIN,
        bigFileThresholdBytes: args.bigFileThresholdBytes ? Number(args.bigFileThresholdBytes) : undefined,
        port: args.port ? Number(args.port) : undefined,
        identityFile: args.identityFile ? String(args.identityFile) : undefined,
        batchMode: args.batchMode !== false,
        probe: null,
        probedAt: null,
        addedAt: core.nowISO(),
        updatedAt: core.nowISO(),
      };
      let probe = null;
      let probeError = null;
      if (args.probe !== false) {
        try {
          probe = await probeHost(entry, { timeoutMs: 60000 });
        } catch (err) {
          probeError = err?.message ?? String(err);
        }
      }
      await withHosts(async (hosts) => {
        if (hosts.some((h) => h.id === id)) {
          throw core.sciErr("ERR_HOST", `主机 ${id} 已存在。用 remote_host_show 查看、remote_host_probe 重探测。`);
        }
        entry.probe = probe;
        entry.probeError = probeError;
        entry.probedAt = probe ? core.nowISO() : null;
        hosts.push(entry);
      });
      entry.probe = probe;
      entry.probeError = probeError;
      entry.probedAt = probe ? core.nowISO() : null;
      return {
        host: id,
        alias,
        transport,
        probe: probe ?? {},
        probeError: probeError ?? "",
        scratch: entry.scratch,
        notes: entry.notes,
        next: `用 remote_run 在该主机上提交作业（host=${id}）；remote_host_notes 可补充主机详情。`,
      };
    },
  });

  // ── remote_host_list ──
  sciTool(ctx, config, {
    name: "remote_host_list",
    description: "列出已注册的远程主机（id、传输、探测摘要：CPU/GPU/conda/sbatch、备注摘要、最近探测时间）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    presentTitle: "列出远程主机",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        hosts: { type: "array" },
        count: { type: "integer" },
      },
      required: ["hosts", "count"],
    },
    async execute(args, exec) {
      const { hosts } = await loadHosts(config);
      const root = await resolveRootStrict(args, exec);
      const jobs = root ? (await loadJobs(root)).jobs : [];
      const view = hosts.map((h) => ({
        id: h.id,
        alias: h.alias,
        transport: h.transport,
        os: h.probe?.os ?? null,
        cpus: h.probe?.cpus ?? 0,
        gpus: h.probe?.gpus ?? [],
        conda: h.probe?.conda ?? false,
        sbatch: h.probe?.sbatch ?? false,
        partitions: h.probe?.partitions?.length ?? 0,
        activeJobs: jobs.filter((j) => j.host === h.id && ["submitted", "running"].includes(j.state)).length,
        notesExcerpt: h.notes ? h.notes.slice(0, 120) : "",
        probedAt: h.probedAt ?? null,
      }));
      return { hosts: view, count: view.length };
    },
  });

  // ── remote_host_show ──
  sciTool(ctx, config, {
    name: "remote_host_show",
    description:
      "查看主机详情：配置、最近探测结果（CPU/内存/GPU/CUDA/conda/module/sbatch/SLURM 分区/scratch 目录）、备注（Details 文档）与该主机的作业数。提交作业前先看这里了解环境。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
      },
    },
    presentTitle: "查看主机详情",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        host: { type: "object" },
        jobs: { type: "array" },
      },
      required: ["host", "jobs"],
    },
    async execute(args, exec) {
      const id = core.requireStr(args, "host");
      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, id);
      const root = await resolveRootStrict(args, exec);
      const jobs = root ? (await loadJobs(root)).jobs.filter((j) => j.host === id) : [];
      return { host: h, jobs: jobs.map(({ id: jid, title, state, mode, exitCode, finishedAt }) => ({ id: jid, title, state, mode, exitCode, finishedAt })) };
    },
  });

  // ── remote_host_probe：重探测 ──
  sciTool(ctx, config, {
    name: "remote_host_probe",
    description: "对主机重新执行只读探测（CPU/内存/GPU/CUDA/conda/module/Apptainer/sbatch/scratch/SLURM 分区），更新存档。适合节点变化/驱动升级后刷新。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
      },
    },
    presentTitle: "重探测主机",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        host: { type: "string" },
        probe: { type: "object" },
        probedAt: { type: "string" },
      },
      required: ["host", "probe", "probedAt"],
    },
    async execute(args, exec) {
      const id = core.requireStr(args, "host");
      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, id);
      const root = await resolveRootStrict(args, exec);
      if (!root) {
        throw core.sciErr(
          "ERR_ACCESS",
          "无法确定项目根（缺少会话工作目录），无法完成项目级授权。请在参数中显式传 root=…，或先将会话绑定到工作区。"
        );
      }
      await ensureHostAccess(ctx, exec, root, id, `重探测主机 ${id}（${h.alias}，${h.transport}）`, cfg);
      const probe = await probeHost(h, { timeoutMs: 60000 });
      await withHosts(async (list) => {
        const e = list.find((x) => x.id === id);
        if (e) {
          e.probe = probe;
          e.probedAt = core.nowISO();
          e.updatedAt = core.nowISO();
        }
      });
      return { host: id, probe, probedAt: core.nowISO() };
    },
  });

  // ── remote_host_notes：更新主机 Details 文档 ──
  sciTool(ctx, config, {
    name: "remote_host_notes",
    description:
      "更新主机备注（等价于 Claude Science 的 Details 文档）：记录环境激活方式、分区/账号、模块加载、数据与软件位置、集群约定等。append=true 时追加，否则整体替换。模型每次在该主机提交作业前都应参考 remote_host_show 的备注。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
        text: { type: "string", description: "备注内容（多行文本）" },
        append: { type: "boolean", description: "是否追加到现有备注（默认 false=整体替换）" },
      },
    },
    presentTitle: "更新主机备注",
    async execute(args) {
      const id = core.requireStr(args, "host");
      const text = core.requireStr(args, "text");
      await withHosts(async (hosts) => {
        const h = findHost(hosts, id);
        h.notes = args.append && h.notes ? h.notes.replace(/\s+$/, "") + "\n\n" + text : text;
        h.updatedAt = core.nowISO();
      });
      return `主机 ${id} 备注已更新${args.append ? "（追加）" : ""}。`;
    },
  });

  // ── remote_host_remove ──
  sciTool(ctx, config, {
    name: "remote_host_remove",
    description: "注销主机（从注册表移除）。该主机有 running/submitted 作业时拒绝（先 remote_cancel）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
      },
    },
    presentTitle: "注销主机",
    async execute(args, exec) {
      const id = core.requireStr(args, "host");
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const active = (await loadJobs(root)).jobs.filter((j) => j.host === id && ["submitted", "running"].includes(j.state));
      if (active.length) {
        throw core.sciErr("ERR_LIMIT", `主机 ${id} 有 ${active.length} 个活动作业（${active.map((j) => j.id).join(", ")}）。先 remote_cancel 再移除。`);
      }
      let removed = false;
      await withHosts(async (hosts) => {
        const i = hosts.findIndex((h) => h.id === id);
        if (i >= 0) {
          hosts.splice(i, 1);
          removed = true;
        }
      });
      if (!removed) throw core.sciErr("ERR_HOST", `主机 ${id} 未注册。`);
      return `主机 ${id} 已注销。`;
    },
  });

  // ── remote_host_allowlist：查看本项目允许访问的服务器列表 ──
  sciTool(ctx, config, {
    name: "remote_host_allowlist",
    description:
      "查看当前项目允许访问的服务器白名单（<项目根>/.dsh/remotes/allowlist.json）：哪些主机已获授权、何时由谁授予。项目根按优先级探测：research-manifest.json（研究项目）→ .dsh（工作区）→ .git → 会话工作目录——同一工作区里的多个研究项目各自独立。未授权的主机在首次使用时（remote_host_add 探测 / remote_exec / remote_run / remote_host_probe）会弹审批，批准后自动加入本列表。开始任何远程工作前建议先查看本列表。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
      },
    },
    presentTitle: "查看主机访问白名单",
    audit: true,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        allowlistPath: { type: "string" },
        hosts: { type: "array" },
        count: { type: "integer" },
        requireHostAccess: { type: "boolean" },
      },
      required: ["allowlistPath", "hosts", "count", "requireHostAccess"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const list = await loadAllowlist(root);
      const { hosts } = await loadHosts(config);
      return {
        allowlistPath: allowlistPath(root),
        hosts: list.hosts.map((e) => ({
          host: e.host,
          grantedAt: e.grantedAt,
          grantedBy: e.grantedBy,
          note: e.note ?? "",
          registered: hosts.some((h) => h.id === e.host),
          alias: hosts.find((h) => h.id === e.host)?.alias ?? null,
        })),
        count: list.hosts.length,
        requireHostAccess: cfg.requireHostAccess,
      };
    },
  });

  // ── remote_host_allow：把主机加入本项目白名单（需审批）──
  sciTool(ctx, config, {
    name: "remote_host_allow",
    description:
      "把主机加入当前项目的允许访问白名单（等价的显式授权操作，默认要求审批；remote_host_revoke 可撤销）。通常不需要手动调用——首次使用主机时审批弹窗会自动授权；本工具用于预先授权（例如先允许服务器再逐个跑分析）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        host: { type: "string", description: "主机 id（需先 remote_host_add 注册）" },
        note: { type: "string", description: "授权备注（可选）" },
        approve: { type: "boolean", description: "是否要求审批（默认 true；false 需配合无人值守配置）" },
      },
    },
    presentTitle: "授权主机访问",
    audit: true,
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const id = core.requireStr(args, "host");
      const { hosts } = await loadHosts(config);
      findHost(hosts, id); // 必须已注册
      if (await isHostAllowed(root, id)) return `主机 ${id} 已在本项目白名单中。`;
      if (args.approve !== false) {
        await requireApproval(ctx, exec, `将主机 ${id}（${hosts.find((h) => h.id === id)?.alias}）加入本项目（${root}）的允许访问白名单`, cfg);
      }
      await core.withFileLock(
        allowlistPath(root),
        async () => {
          const list = await loadAllowlist(root);
          if (!list.hosts.some((h) => h.host === id)) {
            list.hosts.push({ host: id, grantedAt: core.nowISO(), grantedBy: exec?.agent?.session?.id ?? "agent", note: core.optStr(args, "note", "") });
          }
          await saveAllowlist(root, list);
        },
        lockOpts
      );
      return `主机 ${id} 已加入本项目白名单 → ${allowlistPath(root)}`;
    },
  });

  // ── remote_host_revoke：撤销本项目白名单授权 ──
  sciTool(ctx, config, {
    name: "remote_host_revoke",
    description:
      "把主机从当前项目的允许访问白名单中移除（只减少权限、不弹审批）。之后该主机的 remote_host_probe / remote_exec / remote_run 会再次要求审批。已提交的作业不受影响（remote_status / remote_logs / remote_pull / remote_cancel 仍可管理）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        host: { type: "string", description: "主机 id" },
      },
    },
    presentTitle: "撤销主机访问授权",
    audit: true,
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const id = core.requireStr(args, "host");
      let removed = false;
      await core.withFileLock(
        allowlistPath(root),
        async () => {
          const list = await loadAllowlist(root);
          const before = list.hosts.length;
          list.hosts = list.hosts.filter((h) => h.host !== id);
          removed = list.hosts.length < before;
          if (removed) await saveAllowlist(root, list);
        },
        lockOpts
      );
      if (!removed) throw core.sciErr("ERR_HOST", `主机 ${id} 不在本项目白名单中。`);
      return `主机 ${id} 已从本项目白名单移除。`;
    },
  });

  // ── remote_exec：前台短命令（有超时）──
  sciTool(ctx, config, {
    name: "remote_exec",
    description:
      "在主机上执行一条短命令（前台，默认 60 秒超时，最长 600 秒）：适合快速检查（磁盘、GPU、模块、文件存在性等）。注意：命令以连接用户身份在主机上运行、不经过沙箱；请只运行可信命令。长任务请用 remote_run 提交为后台作业。首次使用该主机默认要求审批（批准后加入本项目白名单）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
        command: { type: "string", description: "要执行的 shell 命令" },
        workdir: { type: "string", description: "（可选）远程工作目录" },
        timeoutSeconds: { type: "integer", description: "超时秒数（默认 60，上限 600）" },
      },
    },
    presentTitle: "远程执行命令",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        host: { type: "string" },
        exitCode: { type: "integer" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        elapsedMs: { type: "integer" },
        timedOut: { type: "boolean" },
        truncated: { type: "boolean" },
      },
      required: ["host", "exitCode", "stdout", "stderr", "timedOut"],
    },
    async execute(args, exec) {
      const id = core.requireStr(args, "host");
      const cmd = core.requireStr(args, "command");
      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, id);
      const adapter = makeAdapter(h);
      const timeoutSeconds = Math.min(Math.max(Number(args.timeoutSeconds ?? 60) || 60, 1), 600);
      const wd = args.workdir ? safePath(args.workdir, "workdir") : null;
      const full = wd ? `cd ${sq(h.transport === "local" ? expandHome(wd) : wd)} && ${cmd}` : cmd;
      const root = await resolveRootStrict(args, exec);
      if (!root) {
        throw core.sciErr(
          "ERR_ACCESS",
          "无法确定项目根（缺少会话工作目录），无法完成项目级授权。请在参数中显式传 root=…，或先将会话绑定到工作区。"
        );
      }
      await ensureHostAccess(ctx, exec, root, id, `在主机 ${id}（${h.alias}）执行命令：${cmd.slice(0, 200)}`, cfg);
      const t0 = Date.now();
      const res = await adapter.run(full, { timeoutMs: timeoutSeconds * 1000 });
      return {
        host: id,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        elapsedMs: Date.now() - t0,
        timedOut: res.timedOut,
        truncated: res.truncated,
      };
    },
  });

  // ── remote_run：提交后台作业（detached / sbatch）──
  sciTool(ctx, config, {
    name: "remote_run",
    description:
      "在远程主机提交后台作业（等价于 Claude Science 的 Run job）：把脚本与输入上传到 <scratch>/<jobId>/，工作站以 detached 进程运行（nohup+setsid，断连不杀），SLURM 集群经 sbatch 提交（mode=auto 自动识别）。提交前默认要求审批（首次使用该主机时，授权审批与作业审批合并为一次弹窗，批准后该主机加入本项目白名单）。作业默认超时 30 分钟（timeoutMinutes 可调）。返回 jobId 与远程目录，之后用 remote_status 监控、remote_logs 看日志、remote_pull 拉回输出。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", description: "主机 id" },
        title: { type: "string", description: "作业标题（如：fastp+hisat2 比对 SRR123）" },
        script: { type: "string", description: "脚本内容（与 scriptFile 二选一；内容以 bash 执行，注意 `set -e` 与显式退出码）" },
        scriptFile: { type: "string", description: "项目内脚本文件路径（与 script 二选一，相对项目根）" },
        inputs: { type: "array", items: { type: "string" }, description: "要上传到 <jobDir>/inputs/ 的文件/目录（相对项目根）" },
        workdir: { type: "string", description: "（可选）作业运行的工作目录（默认作业目录）" },
        env: { type: "object", description: "（可选）远程环境变量，如 { CONDA_PREFIX: \"/opt/conda\" }" },
        timeoutMinutes: { type: "integer", description: "作业超时分钟数（默认取主机配置 30；SLURM 下转成 --time）" },
        mode: { type: "string", enum: ["auto", "direct", "slurm"], description: "提交方式：auto（有 sbatch 用 slurm，否则 direct，默认）/ direct（nohup+setsid）/ slurm（sbatch）" },
        scratch: { type: "string", description: "（可选）本次作业的 scratch 根目录（默认取主机配置）" },
        output: { type: "string", description: "（可选）输出拉回的本地目录（相对项目根；默认 analyses/remote/<jobId>）" },
        approve: { type: "boolean", description: "是否要求审批（默认按插件配置 requireApproval，通常 true）" },
      },
    },
    presentTitle: "提交远程作业",
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        jobId: { type: "string" },
        host: { type: "string" },
        state: { type: "string" },
        mode: { type: "string" },
        jobDir: { type: "string" },
        timeoutMinutes: { type: "integer" },
        monitor: { type: "string" },
      },
      required: ["jobId", "host", "state", "mode", "jobDir"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const hostId = core.requireStr(args, "host");
      const title = core.optStr(args, "title", "remote job");

      // 先做纯参数校验（不依赖主机注册与否），再查主机
      const script = args.script !== undefined ? String(args.script) : null;
      let scriptFileAbs = null;
      if (args.scriptFile) {
        scriptFileAbs = path.resolve(root, args.scriptFile);
        if (!scriptFileAbs.startsWith(path.resolve(root) + path.sep) && scriptFileAbs !== path.resolve(root)) {
          throw core.sciErr("ERR_PATH", `scriptFile 越出项目根：${args.scriptFile}`);
        }
        if (!existsSync(scriptFileAbs)) throw core.sciErr("ERR_NOT_FOUND", `scriptFile 不存在：${args.scriptFile}`);
      }
      if ((script === null) === (scriptFileAbs === null)) {
        throw core.sciErr("ERR_VALIDATION", "script 与 scriptFile 必须且只能提供一个");
      }
      const scriptContent = script !== null ? script : await fsp.readFile(scriptFileAbs, "utf8");
      if (!scriptContent.trim()) throw core.sciErr("ERR_VALIDATION", "脚本内容为空");

      const inputs = core.asList(args.inputs).map((p) => {
        const abs = path.resolve(root, p);
        if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
          throw core.sciErr("ERR_PATH", `input 越出项目根：${p}`);
        }
        if (!existsSync(abs)) throw core.sciErr("ERR_NOT_FOUND", `input 不存在：${p}`);
        return abs;
      });

      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, hostId);
      const adapter = makeAdapter(h);
      const timeoutMinutes = args.timeoutMinutes !== undefined ? Number(args.timeoutMinutes) : (h.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN);
      if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 10080) {
        throw core.sciErr("ERR_VALIDATION", `timeoutMinutes 必须是 1–10080 的整数（当前 ${args.timeoutMinutes}）`);
      }
      const scratchRaw = args.scratch ? safePath(args.scratch, "scratch") : (h.scratch || "~/dsh-scratch");
      // local 传输下 node fs 不展开 ~，这里提前展开成绝对路径
      const scratch = h.transport === "local" ? expandHome(scratchRaw) : scratchRaw;

      const reason = [
        `主机 ${hostId}（${h.alias}，${h.transport}）`,
        `作业：${title}`,
        `模式：${args.mode ?? "auto"} ｜ 超时：${timeoutMinutes} 分钟`,
        `远程目录：${scratch}/<jobId>`,
        "脚本首行：",
        ...scriptContent.split("\n").slice(0, 8).map((l) => "  " + l),
      ].join("\n");

      // 审批（等价于 Claude Science 的 "Run this job on <host>?" 卡）
      // 生效规则：approve:true 强制要求；approve:false 显式跳过；缺省按 config.requireApproval（默认要求）。
      // 首次使用该主机时，授权审批（项目白名单）与本次作业审批合并为一次弹窗（grantNow=true 则不再弹第二次）。
      const grantNow = await ensureHostAccess(ctx, exec, root, hostId, `首次在本项目使用主机 ${hostId}（${h.alias}）并提交作业：\n${reason}`, cfg);
      const wantApproval = args.approve === true || (args.approve !== false && cfg.requireApproval);
      if (wantApproval && !grantNow.created) {
        await requireApproval(ctx, exec, reason, { requireApproval: true });
      }

      return withJobs(root, async (data) => {
        const jobs = data.jobs;
        const activeCount = jobs.filter((j) => j.host === hostId && ["submitted", "running"].includes(j.state)).length;
        if (activeCount >= (h.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
          throw core.sciErr("ERR_LIMIT", `主机 ${hostId} 并发作业已达上限 ${h.maxConcurrent}（当前 ${activeCount} 个活动）。等前面的作业结束或调高 maxConcurrent。`);
        }
        const jobId = core.nextSeqId(jobs, "J", 2);
        const jobDir = `${scratch.replace(/\/$/, "")}/${jobId}`;
        const job = newJob(jobId, hostId, title, jobDir);
        job.timeoutMinutes = timeoutMinutes;

        // 1) 建远程作业目录 + 上传
        await adapter.mkdir(jobDir);
        await adapter.mkdir(`${jobDir}/inputs`);
        await adapter.writeFile(`${jobDir}/script.sh`, scriptContent);
        if (args.env && typeof args.env === "object") {
          const envLines = Object.entries(args.env)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `export ${String(k)}=${JSON.stringify(String(v))}`);
          await adapter.writeFile(`${jobDir}/env.sh`, envLines.join("\n") + "\n");
        }
        if (inputs.length) await adapter.copyUp(inputs, `${jobDir}/inputs`);

        // 2) 决定提交方式（auto：有 sbatch 用 slurm）
        let useSlurm = false;
        if (args.mode === "slurm") useSlurm = true;
        else if (args.mode === "direct") useSlurm = false;
        else {
          const chk = await adapter.run("command -v sbatch >/dev/null 2>&1 && echo yes || echo no");
          useSlurm = chk.stdout.trim() === "yes";
        }

        // 3) 生成 run.sh 并提交
        const workdir = args.workdir ? safePath(args.workdir, "workdir") : null;
        await adapter.writeFile(`${jobDir}/run.sh`, runShContent(jobDir, workdir, timeoutMinutes, useSlurm ? "slurm" : "direct"));
        let pid = null;
        let slurmJobId = null;
        if (useSlurm) {
          const timeFlag = timeoutMinutes && timeoutMinutes > 0 ? ` --time=${Math.floor(timeoutMinutes)}` : "";
          // 先 cd 再以 $(pwd) 取绝对路径作 --chdir（~ 不会被 sbatch 展开）
          const launch =
            `cd ${sq(jobDir)} && sbatch --parsable --chdir="$(pwd)" -o stdout.log -e stderr.log --job-name=dsh-${jobId}${timeFlag} run.sh 2> sbatch.err || (cat sbatch.err >&2; exit 1)`;
          const res = await adapter.run(launch, { timeoutMs: 60000 });
          if (res.code !== 0) throw sshFail(res, `sbatch 提交 ${jobId}`);
          slurmJobId = res.stdout.trim().split("\n").pop().trim();
          if (!/^\d+$/.test(slurmJobId)) {
            const m = /(\d+)/.exec(res.stdout + res.stderr);
            slurmJobId = m ? m[1] : null;
          }
          job.mode = "slurm";
          job.slurmJobId = slurmJobId;
        } else {
          // detached 启动：优先 setsid（独立会话，进程组可整体终止）；无 setsid（如 macOS）退化为 nohup。
          // run.sh 会把自身 $$ 写入 pid 文件（setsid 分叉后即新会话组长 pid）。
          const launch =
            `cd ${sq(jobDir)} && ` +
            `if command -v setsid >/dev/null 2>&1; then nohup setsid sh run.sh > stdout.log 2> stderr.log < /dev/null & ` +
            `else nohup sh run.sh > stdout.log 2> stderr.log < /dev/null & fi; echo $!`;
          const res = await adapter.run(launch, { timeoutMs: 30000 });
          if (res.code !== 0) throw sshFail(res, `启动作业 ${jobId}`);
          pid = Number(res.stdout.trim().split("\n").pop()) || null;
          job.mode = "direct";
          job.pid = pid;
        }
        job.scriptPath = `${jobDir}/script.sh`;
        job.stdoutLog = `${jobDir}/stdout.log`;
        job.stderrLog = `${jobDir}/stderr.log`;
        job.state = "running";
        job.startedAt = core.nowISO();
        job.lastCheckedAt = core.nowISO();
        jobs.push(job);
        return {
          jobId,
          host: hostId,
          state: job.state,
          mode: job.mode,
          jobDir,
          pid: job.pid,
          slurmJobId: job.slurmJobId,
          timeoutMinutes,
          monitor: `remote_status job=${jobId} 查看状态；remote_logs job=${jobId} 看日志；完成后 remote_pull job=${jobId} 拉回输出。`,
        };
      });
    },
  });

  // ── remote_status：批量状态检查（自动迁移 + 可选自动拉取）──
  sciTool(ctx, config, {
    name: "remote_status",
    description:
      "检查远程作业状态（结构化输出）：对每个活动作业探测（direct: ps 存活/done+exitcode 标记；slurm: squeue/sacct），状态自动迁移 running→succeeded/failed/killed，并把迁移写回作业注册表。host 过滤某主机，job 只查单个作业；pull=true 时对刚结束的作业自动 remote_pull 拉回输出。监控长时任务时定期调用本工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        host: { type: "string", description: "只检查该主机的作业（可选）" },
        job: { type: "string", description: "只检查该作业（可选，如 J01）" },
        pull: { type: "boolean", description: "结束的作业是否自动拉回输出（默认 false）" },
      },
    },
    presentTitle: "检查远程作业状态",
    audit: true,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        checkedAt: { type: "string" },
        jobs: { type: "array" },
        summary: { type: "object" },
      },
      required: ["checkedAt", "jobs", "summary"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      return withJobs(root, async (data) => {
        const jobs = data.jobs;
        let targets = jobs;
        if (args.host) targets = targets.filter((j) => j.host === args.host);
        if (args.job) targets = targets.filter((j) => j.id === args.job);
        const active = targets.filter((j) => ["submitted", "running"].includes(j.state));
        const { hosts } = await loadHosts(config);
        const byHost = new Map();
        for (const j of active) {
          const h = hosts.find((x) => x.id === j.host);
          if (!h) {
            j.state = "unknown";
            j.error = "主机未注册";
            continue;
          }
          if (!byHost.has(j.host)) byHost.set(j.host, { host: h, jobs: [] });
          byHost.get(j.host).jobs.push(j);
        }
        const results = [];
        for (const [, { host, jobs: hj }] of byHost) {
          const adapter = makeAdapter(host);
          const res = await adapter.run(statusScript(hj), { timeoutMs: 60000 });
          if (res.code !== 0) {
            for (const j of hj) {
              j.state = "unknown";
              j.error = `状态探测失败：${res.stderr.trim().split("\n").slice(-2).join(" | ")}`;
            }
            continue;
          }
          const rows = parseStatus(res.stdout);
          for (const j of hj) {
            const row = rows.find((r) => r.jobId === j.id);
            if (row) applyStatusRow(j, row);
            else {
              j.state = "unknown";
              j.error = "状态行缺失";
            }
          }
        }
        // 自动拉取：pull=true 且刚结束的作业
        if (args.pull) {
          for (const j of targets) {
            if (["succeeded", "failed", "killed"].includes(j.state) && (!j.pulledAt || j.finishedAt > j.pulledAt)) {
              const h = hosts.find((x) => x.id === j.host);
              if (h) {
                try {
                  const adapter = makeAdapter(h);
                  await pullJobOutputs(h, adapter, j, {}, root, cfg);
                } catch (err) {
                  j.error = `自动拉取失败：${err.message}`;
                }
              }
            }
          }
        }
        const summary = { total: jobs.length };
        for (const s of ["submitted", "running", "succeeded", "failed", "killed", "unknown"]) {
          summary[s] = jobs.filter((j) => j.state === s).length;
        }
        return {
          checkedAt: core.nowISO(),
          jobs: targets.map((j) => ({
            id: j.id,
            host: j.host,
            title: j.title,
            state: j.state,
            mode: j.mode,
            exitCode: j.exitCode,
            elapsedSeconds: j.startedAt ? Math.round((Date.now() - new Date(j.startedAt).getTime()) / 1000) : null,
            submittedAt: j.submittedAt,
            finishedAt: j.finishedAt,
            jobDir: j.jobDir,
            pid: j.pid,
            slurmJobId: j.slurmJobId,
            error: j.error,
            pulled: Boolean(j.pulledAt),
          })),
          summary,
        };
      });
    },
  });

  // ── remote_logs：尾随日志 ──
  sciTool(ctx, config, {
    name: "remote_logs",
    description: "查看远程作业日志尾部：stdout.log / stderr.log（默认各 40 行，tail 参数可调）。作业失败时先看 stderr 再决定如何修脚本重提交。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        job: { type: "string", description: "作业 id（如 J01）" },
        stream: { type: "string", enum: ["stdout", "stderr", "both"], description: "查看哪个日志（默认 both）" },
        tail: { type: "integer", description: "尾部行数（默认 40）" },
      },
    },
    presentTitle: "查看远程作业日志",
    audit: true,
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const jobId = core.requireStr(args, "job");
      const tail = Math.min(Math.max(Number(args.tail ?? 40) || 40, 1), 500);
      const data = await loadJobs(root);
      const job = data.jobs.find((j) => j.id === jobId);
      if (!job) throw core.sciErr("ERR_NOT_FOUND", `作业 ${jobId} 不存在（remote_jobs 查看全部）。`);
      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, job.host);
      const adapter = makeAdapter(h);
      const stream = args.stream ?? "both";
      const lines = [];
      const tailOf = async (logPath, label) => {
        const res = await adapter.run(`if [ -f ${sq(logPath)} ]; then tail -n ${tail} ${sq(logPath)}; else echo "(日志文件尚不存在：${logPath})"; fi`);
        if (res.code !== 0) throw sshFail(res, `读取日志 ${logPath}`);
        lines.push(`## ${label}（${logPath}）`);
        lines.push(res.stdout.trimEnd() || "（空）");
      };
      if (stream === "stdout" || stream === "both") await tailOf(job.stdoutLog, "stdout");
      if (stream === "stderr" || stream === "both") await tailOf(job.stderrLog, "stderr");
      return lines.join("\n");
    },
  });

  // ── remote_pull：拉回输出（大文件留主机并记录路径）──
  sciTool(ctx, config, {
    name: "remote_pull",
    description:
      "把远程作业输出拉回本地（等价于 Claude Science 的输出回传）：<jobDir> 下除控制文件与 inputs/ 外的顶层条目，大小不超过阈值的拉回 <output>/（默认 analyses/remote/<jobId>/），超过阈值的留在主机并记录路径与大小。写入 pulled-manifest.json 说明每个文件的去向。可传 output 指定本地目录、thresholdBytes 调整阈值。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        job: { type: "string", description: "作业 id" },
        output: { type: "string", description: "本地输出目录（相对项目根；默认 analyses/remote/<jobId>）" },
        thresholdBytes: { type: "integer", description: "大小阈值（默认 100MB）" },
      },
    },
    presentTitle: "拉取远程作业输出",
    audit: true,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        jobId: { type: "string" },
        host: { type: "string" },
        localOutDir: { type: "string" },
        pulled: { type: "array" },
        leftOnHost: { type: "array" },
        manifestPath: { type: "string" },
      },
      required: ["jobId", "host", "localOutDir", "pulled", "leftOnHost"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const jobId = core.requireStr(args, "job");
      const data = await loadJobs(root);
      const job = data.jobs.find((j) => j.id === jobId);
      if (!job) throw core.sciErr("ERR_NOT_FOUND", `作业 ${jobId} 不存在。`);
      if (["submitted", "running"].includes(job.state)) {
        throw core.sciErr("ERR_VALIDATION", `作业 ${jobId} 仍在运行（${job.state}），先 remote_status 等它结束再拉取。`);
      }
      const { hosts } = await loadHosts(config);
      const h = findHost(hosts, job.host);
      const adapter = makeAdapter(h);
      const { manifest, outDir } = await pullJobOutputs(h, adapter, job, args, root, cfg);
      await withJobs(root, async (d) => {
        const j = d.jobs.find((x) => x.id === jobId);
        if (j) {
          j.localOutDir = manifest.localOutDir;
          j.bigFiles = manifest.leftOnHost;
          j.pulledAt = manifest.pulledAt;
        }
      });
      return {
        jobId,
        host: h.id,
        localOutDir: manifest.localOutDir,
        pulled: manifest.pulled,
        leftOnHost: manifest.leftOnHost,
        manifestPath: outDir ? path.join(outDir, "pulled-manifest.json") : null,
      };
    },
  });

  // ── remote_cancel：取消作业 ──
  sciTool(ctx, config, {
    name: "remote_cancel",
    description:
      "取消远程作业：direct 模式终止整个进程组（setsid 会话，含子进程），slurm 模式 scancel。已结束的作业返回当前终态。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        job: { type: "string", description: "作业 id" },
      },
    },
    presentTitle: "取消远程作业",
    audit: true,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        jobId: { type: "string" },
        result: { type: "string" },
        state: { type: "string" },
      },
      required: ["jobId", "result", "state"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const jobId = core.requireStr(args, "job");
      return withJobs(root, async (data) => {
        const job = data.jobs.find((j) => j.id === jobId);
        if (!job) throw core.sciErr("ERR_NOT_FOUND", `作业 ${jobId} 不存在。`);
        if (!["submitted", "running"].includes(job.state)) {
          return { jobId, result: `作业已结束（${job.state}），无需取消`, state: job.state };
        }
        const { hosts } = await loadHosts(config);
        const h = findHost(hosts, job.host);
        const adapter = makeAdapter(h);
        let result;
        if (job.mode === "slurm") {
          const res = await adapter.run(`scancel ${sq(job.slurmJobId)} 2>&1; echo "rc=$?"`);
          result = res.stdout.trim().split("\n").slice(-1)[0] === "rc=0" ? "scancel 已发送" : `scancel 失败：${res.stdout.trim()}`;
        } else {
          // 有 setsid 会话时按进程组终止；否则回退 pkill 子树 + kill 主进程
          const res = await adapter.run(
            `pid=$(cat ${sq(`${job.jobDir}/pid`)} 2>/dev/null); ` +
              `if [ -n "$pid" ]; then ` +
              `kill -TERM -- -$pid 2>/dev/null || { pkill -TERM -P $pid 2>/dev/null; kill -TERM $pid 2>/dev/null; }; ` +
              `sleep 2; ` +
              `kill -KILL -- -$pid 2>/dev/null || { pkill -KILL -P $pid 2>/dev/null; kill -KILL $pid 2>/dev/null; }; ` +
              `echo "killed $pid"; else echo "no pid"; fi`
          );
          result = res.stdout.trim();
        }
        job.state = "killed";
        job.finishedAt = core.nowISO();
        job.lastCheckedAt = core.nowISO();
        return { jobId, result, state: "killed" };
      });
    },
  });

  // ── remote_jobs：作业列表 ──
  sciTool(ctx, config, {
    name: "remote_jobs",
    description: "列出项目的远程作业（可按主机/状态过滤）：id、主机、标题、状态、模式、提交/结束时间、退出码。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        host: { type: "string", description: "只列该主机的作业（可选）" },
        state: { type: "string", enum: ["submitted", "running", "succeeded", "failed", "killed", "unknown"], description: "只列该状态的作业（可选）" },
      },
    },
    presentTitle: "列出远程作业",
    audit: true,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        jobs: { type: "array" },
        count: { type: "integer" },
      },
      required: ["jobs", "count"],
    },
    async execute(args, exec) {
      const root = await resolveRootStrictOrThrow(args, exec, "继续操作");
      const data = await loadJobs(root);
      let jobs = data.jobs;
      if (args.host) jobs = jobs.filter((j) => j.host === args.host);
      if (args.state) jobs = jobs.filter((j) => j.state === args.state);
      return {
        jobs: jobs.map((j) => ({
          id: j.id,
          host: j.host,
          title: j.title,
          state: j.state,
          mode: j.mode,
          exitCode: j.exitCode,
          submittedAt: j.submittedAt,
          finishedAt: j.finishedAt,
          jobDir: j.jobDir,
          slurmJobId: j.slurmJobId,
        })),
        count: jobs.length,
      };
    },
  });
}

export { apply };
