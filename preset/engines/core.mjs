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
import os from "node:os";
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
// ERR_REVIEW_GATE  评审门禁拦截（scientific-reviewer gate 模式，research-loop）
// ERR_HOST         主机未注册/未知（remote-compute）
// ERR_SSH          ssh/scp 执行失败（remote-compute）
// ERR_ACCESS       主机未获本项目授权或审批被拒（remote-compute）
// ERR_LIMIT        并发上限等资源限制（remote-compute）
// ERR_APPROVAL     审批流程失败/被拒（remote-compute）
// ERR_REMOTE       远程端异常（remote-compute）

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

// dsh 的会话工作目录在 SessionHeader 上（agent.session.header.cwd），
// Session 对象本身没有 cwd 访问器。旧代码读 agent.session.cwd（不存在），
// 导致永远回退 process.cwd()（宿主进程启动目录，如 ~），项目根随之错位。
export function resolveCwd(exec) {
  try {
    const c = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd;
    if (typeof c === "string" && c.length > 0) return c;
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

// 注意：~/.dsh 是 DSH 自身的配置主目录（DSH_HOME 默认值），不是项目标记。
// 若把 HOME 当作项目根，任何从 home 下出发且路径上没有 .git/.dsh 的探测都会
// 命中 ~/.dsh，把整个 home 当成"项目"并在其中脚手架目录。因此 HOME 永不
// 作为自动探测的项目根（确需以 home 为根时显式传 root 参数）。
export function findProjectRoot(start, markers) {
  let dir = path.resolve(start);
  const home = os.homedir();
  for (;;) {
    if (dir !== home) {
      for (const m of markers) {
        try {
          if (existsSync(path.join(dir, m))) return dir;
        } catch {
          /* 忽略 */
        }
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

// ── 工具参数编译（对齐 dsh defineTool 的 parameterSchemaSpecToJsonSchema）─────
// dsh 的 defineTool 会把扁平参数表（{paramName: {type,description,required,...}}）编译成
// object-rooted JSON Schema（{type:"object", properties, required}）。但 dsh-science 引擎
// 用自定义 makeTool 直接返回扁平参数表，注册后会被当成函数 schema 传给 LLM provider，
// provider 要求顶层 type:"object"，否则报 "Invalid schema for function ... got type: null"。
// 这里复刻 dsh 编译：扁平表 → {type:"object", properties, required}，与 defineTool 输出一致
// （description 保留、required 收集、items/properties/oneOf 递归）。

const SCHEMA_KEYS = ["properties", "items", "oneOf", "required", "additionalProperties", "enum", "const", "$ref"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compileValueSchema(v) {
  if (!isPlainObject(v)) return v ?? { type: "string" };
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === "required") continue; // 属性级标记，不属于值 schema
    if (k === "items") { out.items = compileValueSchema(val); continue; }
    if (k === "properties" && isPlainObject(val)) {
      out.properties = {};
      for (const [pk, pv] of Object.entries(val)) out.properties[pk] = compileValueSchema(pv);
      continue;
    }
    if (k === "oneOf" && Array.isArray(val)) { out.oneOf = val.map((x) => compileValueSchema(x)); continue; }
    out[k] = val;
  }
  return out;
}

export function compileParams(spec) {
  if (!isPlainObject(spec)) return { type: "object", properties: {} };
  // 已是 object-rooted schema（顶层 type 为字符串且带结构关键字）→ 直接透传
  if (typeof spec.type === "string" && spec.type !== "" && SCHEMA_KEYS.some((k) => Object.hasOwn(spec, k))) {
    return spec;
  }
  const properties = {};
  const required = [];
  for (const [name, v] of Object.entries(spec)) {
    if (isPlainObject(v) && v.required === true) required.push(name);
    properties[name] = compileValueSchema(v);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

// ── 工具返回值清洗（保证 lossless JSON，规避 "value is not lossless JSON"）──
// dsh 会对工具返回值做 snapshotJsonValue，含 undefined / NaN / Infinity / 函数 / Date /
// 循环引用的值会被判为"非 lossless JSON"并抛 ToolOutputError。引擎的 execute 若返回
// 含 undefined 的对象（如 step: args?.step 当调用方未传时），就会触发。这里统一深清洗：
//   对象：丢弃值为 undefined 的键；数组：undefined 元素转 null；非有限数转 null；其余透传。

export function sanitizeJson(v) {
  if (v === undefined || v === null) return v ?? null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sanitizeJson(x)));
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = sanitizeJson(val);
    }
    return out;
  }
  // 函数 / symbol / bigint 等：不表达为 JSON，置 null
  return null;
}

/**
 * 渲染工具返回值给模型。
 * - 未声明 outputSchema（非结构化）且返回字符串 → 原样输出（保持 research_* /
 *   artifact_list 等既有工具的可读输出不变）；
 * - 其余（对象/数组/数字，或显式 outputSchema 的结构化工具）→ 缩进 JSON，
 *   避免对象被 `String(value)` 渲染成 "[object Object]"。
 */
function renderToolValue(value, structured) {
  if (!structured && typeof value === "string") return value;
  const json = JSON.stringify(value, null, 2);
  return json === undefined ? String(value) : json;
}

export function makeTool({ name, description, parameters, execute, presentTitle, outputSchema, audit }) {
  const structured = Boolean(outputSchema);
  return {
    name,
    description,
    parameters: compileParams(parameters),
    output: {
      // dsh 会按 `output.schema` 校验 execute 的返回值（dsh-tools createSuccessResult
      // → validateJsonSchemaValue）。旧默认值 `{type:"string"}` 让「返回对象但未声明
      // outputSchema」的工具直接判 INVALID_TOOL_OUTPUT（`"value" must be a string`）——
      // biomni_* 全部 10 个工具曾因此在真实会话中不可用（mock ctx 单测直接调 execute，
      // 绕过框架校验，故一直未被发现）。
      // `{}` 属于 dsh 支持的 JSON Schema 子集且不施加类型约束（接受任意 JSON 值），
      // 作为「无结构化契约」的默认值；显式声明 outputSchema 的工具仍走严格校验。
      schema: outputSchema ?? {},
      render: (_args, value) => [
        { type: "text", text: renderToolValue(value, structured) },
      ],
    },
    async execute(args, exec) {
      try {
        const value = sanitizeJson(await execute(args, exec));
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
