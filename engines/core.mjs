// science-core —— dsh-science 引擎共享核心（零第三方依赖，只用 node 内置模块）
//
// 为两个引擎（research-loop / artifact-registry）提供：
//   - 原子写入（tmp + rename，读方永不见半截文件）
//   - 轻量文件锁（O_EXCL lockfile + 超时 + 陈旧检测），修复并行写丢失更新
//   - 错误码体系（ERR_*），模型可程序化分支
//   - 流式 SHA-256（大文件不爆内存）
//   - 结构化工具输出支持（outputSchema）
//   - 审计日志（<root>/.science.log，NDJSON 追加式）
//   - 项目根探测 / 参数校验 / ID 分配等公共小工具

import { promises as fsp, existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// ── 时间与等待 ──────────────────────────────────────────────────────────────

export const nowISO = () => new Date().toISOString();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 错误码 ──────────────────────────────────────────────────────────────────
// ERR_NOT_INIT     项目未初始化（缺 research-manifest.json）
// ERR_NOT_FOUND    对象不存在（实验/假设/工件/版本）
// ERR_VALIDATION   参数或状态校验失败
// ERR_PATH         路径越出项目根
// ERR_IO           文件读写/解析失败
// ERR_QUOTA        超过大小配额
// ERR_LOCK_TIMEOUT 等待文件锁超时
// ERR_CONFLICT     并发冲突

export function sciErr(code, msg) {
  const e = new Error(`[${code}] ${msg}`);
  e.code = code;
  return e;
}

// ── 字符串工具 ──────────────────────────────────────────────────────────────

export function slugify(text, fallback, max = 60) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s || fallback;
}

export function requireStr(args, key) {
  const v = args?.[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw sciErr("ERR_VALIDATION", `参数 ${key} 必填且不能为空`);
  }
  return v.trim();
}

export function optStr(args, key, dflt) {
  const v = args?.[key];
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

export function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// ── 项目根探测 ──────────────────────────────────────────────────────────────

export function resolveCwd(exec) {
  try {
    const c = exec?.agent?.session?.cwd;
    if (typeof c === "string" && c.length > 0) return c;
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

export function findProjectRoot(start, markers) {
  let dir = path.resolve(start);
  for (;;) {
    for (const m of markers) {
      try {
        if (existsSync(path.join(dir, m))) return dir;
      } catch {
        /* 忽略 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export async function resolveRoot(args, exec, markers) {
  const base = args?.root ? path.resolve(resolveCwd(exec), args.root) : resolveCwd(exec);
  return findProjectRoot(base, markers);
}

// ── 原子读写 ────────────────────────────────────────────────────────────────

export async function readJson(p, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw sciErr("ERR_IO", `读取失败 ${p}：${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw sciErr("ERR_IO", `文件损坏（JSON 解析失败）${p}：${err.message}`);
  }
}

// 原子写：写临时文件后 rename。同一目录内 rename 是原子的，
// 读方（不加锁）只会看到旧完整文件或新完整文件，永不见半截。
export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw sciErr("ERR_IO", `创建目录失败 ${dir}：${err.message}`);
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, data, "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw sciErr("ERR_IO", `写入失败 ${file}：${err.message}`);
  }
}

export async function writeJsonAtomic(file, obj) {
  await writeFileAtomic(file, JSON.stringify(obj, null, 2) + "\n");
}

// ── 轻量文件锁 ──────────────────────────────────────────────────────────────
// 约定：写方必须持有 <目标文件>.lock 才允许写。读方不加锁（原子写保证一致性）。
// 并发写方互斥；崩溃残留锁由 mtime 陈旧检测回收。

export async function withFileLock(file, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const staleMs = opts.staleMs ?? 30000;
  const lockPath = `${file}.lock`;
  const start = Date.now();

  const acquire = async () => {
    for (;;) {
      try {
        await fsp.mkdir(path.dirname(lockPath), { recursive: true }); // 首次初始化时根目录可能还不存在
        const fh = await fsp.open(lockPath, "wx");
        try {
          await fh.writeFile(JSON.stringify({ pid: process.pid, at: nowISO() }));
        } finally {
          await fh.close();
        }
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw sciErr("ERR_IO", `创建锁失败 ${lockPath}：${err.message}`);
        // 陈旧锁回收
        try {
          const st = await fsp.stat(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) {
            await fsp.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          continue; // 锁刚被释放
        }
        if (Date.now() - start > timeoutMs) {
          throw sciErr("ERR_LOCK_TIMEOUT", `等待锁超时（${timeoutMs}ms）：${lockPath}`);
        }
        await sleep(20 + Math.random() * 60);
      }
    }
  };

  await acquire();
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

// ── 哈希（流式，不整读入内存）────────────────────────────────────────────────

export async function sha256Stream(p) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const rs = createReadStream(p);
    rs.on("data", (c) => h.update(c));
    rs.on("end", resolve);
    rs.on("error", reject);
  });
  return h.digest("hex");
}

// ── 目录文件收集 ────────────────────────────────────────────────────────────

export async function collectFiles(dir, base) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(abs, base)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// ── ID 分配：从现有最大编号推导，而非数组长度（删除/并发下不碰撞、不跳号）────

export function nextSeqId(items, prefix, pad = 0) {
  let max = 0;
  for (const it of items || []) {
    const m = /(\d+)$/.exec(String(it?.id ?? ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const n = String(max + 1);
  return prefix + (pad ? n.padStart(pad, "0") : n);
}

// ── 审计日志（尽力而为，失败不影响主流程）───────────────────────────────────

export async function appendAudit(root, entry) {
  try {
    const p = path.join(root, ".science.log");
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.appendFile(p, JSON.stringify({ at: nowISO(), ...entry }) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────
// 相比旧版 makeTool 的增强：
//   1. outputSchema 支持结构化 JSON 输出（缺省仍为字符串）
//   2. 错误不再吞成字符串，而是带错误码抛出（模型可程序化分支）
//   3. audit 钩子：每次工具调用（成功/失败）记入审计日志
// 注：execute 抛错时交由宿主框架向模型展示错误，行为更可预测。

export function makeTool({ name, description, parameters, execute, presentTitle, outputSchema, audit }) {
  const structured = Boolean(outputSchema);
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema ?? { type: "string" },
      render: (_args, value) => [
        { type: "text", text: structured ? JSON.stringify(value, null, 2) : String(value) },
      ],
    },
    async execute(args, exec) {
      try {
        const value = await execute(args, exec);
        if (audit) {
          await appendAudit(await auditRoot(audit, args, exec), { tool: name, ok: true });
        }
        return value;
      } catch (err) {
        if (audit) {
          await appendAudit(await auditRoot(audit, args, exec), {
            tool: name,
            ok: false,
            code: err?.code ?? "ERR_UNKNOWN",
          });
        }
        throw err;
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: presentTitle,
      kind: "other",
      rawInput: args,
    }),
  };
}

// audit 可以是：(args, exec) => Promise<string | undefined>（返回项目根），
// 或一个 resolve 函数；(auditRoot) 内部统一容错。
async function auditRoot(audit, args, exec) {
  try {
    return await audit(args, exec);
  } catch {
    return undefined;
  }
}
