// science-artifact-registry —— 模仿 Claude Science 的工件与溯源（Artifacts + Provenance）
//
// 零第三方依赖（只用 node 内置模块），作为科学模式 preset 的本地插件被挂载。
// 管理 <项目根>/artifacts/<name>/：
//   - v<N>/         每次保存生成一个新版本目录（源文件/目录的副本）
//   - artifact.json 版本索引与溯源元数据（命令、输入、输出、环境、SHA-256）
//   - provenance.md 人类可读的溯源日志（追加式）
//   - artifacts/artifacts.json 全局工件索引
// 等价于 Claude Science 的"结果保存为带完整执行记录（provenance）的版本化工件"。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const name = "science-artifact-registry";
export const inject = ["tools"];

// ── 小工具 ──────────────────────────────────────────────────────────────────

const nowISO = () => new Date().toISOString();

function slugify(text, fallback) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

function resolveCwd(exec) {
  try {
    const c = exec?.agent?.session?.cwd;
    if (typeof c === "string" && c.length > 0) return c;
  } catch {
    /* 忽略 */
  }
  return process.cwd();
}

function findProjectRoot(start, markers) {
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

async function resolveRoot(args, exec, markers) {
  const base = args.root ? path.resolve(resolveCwd(exec), args.root) : resolveCwd(exec);
  return findProjectRoot(base, markers);
}

function requireStr(args, key) {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`参数 ${key} 必填且不能为空`);
  return v.trim();
}

function optStr(args, key, dflt) {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// 路径安全：解析到项目根内
function withinRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) {
    throw new Error(`路径越出项目根：${rel}`);
  }
  return abs;
}

async function sha256File(p) {
  const data = await fsp.readFile(p);
  return createHash("sha256").update(data).digest("hex");
}

// 递归收集目录内所有文件，返回相对路径列表
async function collectFiles(dir, base) {
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

async function readJson(p, fallback) {
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(p, obj) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function sessionLabel(exec) {
  try {
    const sid = exec?.agent?.session?.id;
    if (typeof sid === "string" && sid.length) return sid.slice(0, 12);
  } catch {
    /* 忽略 */
  }
  return "model";
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

function makeTool({ name, description, parameters, execute, presentTitle }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args, exec) {
      let value;
      try {
        value = await execute(args, exec);
      } catch (err) {
        value = `错误：${err?.message ?? String(err)}`;
      }
      return String(value);
    },
    presentCall: (args) => ({
      card: "generic",
      title: presentTitle,
      kind: "other",
      rawInput: args,
    }),
  };
}

function apply(ctx, config) {
  const markers = Array.isArray(config?.markers) && config.markers.length ? config.markers : [".dsh", ".git"];

  // ── artifact_save：保存一个版本化工件并记录溯源 ──
  ctx.tools.register(makeTool({
    name: "artifact_save",
    description:
      "把分析结果/图表/数据保存为版本化工件（等价于 Claude Science 的 Artifacts）：复制 sources 指定的文件或目录到 artifacts/<name>/v<N>/，计算每个文件的 SHA-256，写入 artifact.json（版本+溯源：command、inputs、notes、环境）并追加 provenance.md 溯源日志。返回版本号与文件哈希清单。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名（字母数字与连字符，如 variant-call-v1）" },
        description: { type: "string", description: "工件描述" },
        sources: { type: "array", items: { type: "string" }, description: "要归档的文件/目录（相对于项目根，至少一个）" },
        command: { type: "string", description: "产生该工件的关键命令/脚本（溯源记录，用于复现）" },
        inputs: { type: "array", items: { type: "string" }, description: "输入文件/数据路径" },
        notes: { type: "string", description: "备注（如参数、版本、注意事项）" },
        tags: { type: "array", items: { type: "string" }, description: "标签，如 genome, snp, figure" },
      },
    },
    presentTitle: "保存工件",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const rawSources = asList(args.sources);
      if (rawSources.length === 0) throw new Error("参数 sources 至少需要一个文件或目录");
      const name = slugify(requireStr(args, "name"), "artifact");
      const artifactDir = withinRoot(root, path.join("artifacts", name));
      const metaPath = path.join(artifactDir, "artifact.json");
      const meta = await readJson(metaPath, {
        name,
        description: optStr(args, "description", ""),
        created: nowISO(),
        versions: [],
      });
      const version = meta.versions.length + 1;
      const vdir = path.join(artifactDir, `v${version}`);
      await fsp.mkdir(vdir, { recursive: true });

      // 复制源（文件或目录）到 v<N>/，保留 basename
      const files = [];
      for (const rel of rawSources) {
        const src = withinRoot(root, rel);
        let st;
        try {
          st = await fsp.stat(src);
        } catch (err) {
          throw new Error(`源路径不存在：${rel}（${err.message}）`);
        }
        const dest = path.join(vdir, path.basename(rel));
        if (st.isDirectory()) {
          await fsp.cp(src, dest, { recursive: true });
          const rels = await collectFiles(dest, dest);
          for (const r of rels) {
            const abs = path.join(dest, r);
            files.push({ path: `${path.basename(rel)}/${r}`, sha256: await sha256File(abs), size: (await fsp.stat(abs)).size });
          }
        } else {
          await fsp.cp(src, dest);
          files.push({ path: path.basename(rel), sha256: await sha256File(dest), size: (await fsp.stat(dest)).size });
        }
      }

      const entry = {
        version,
        created: nowISO(),
        author: sessionLabel(exec),
        provenance: {
          command: optStr(args, "command", ""),
          inputs: asList(args.inputs),
          notes: optStr(args, "notes", ""),
          environment: `${process.platform} ${process.arch} / node ${process.version}`,
        },
        files,
      };
      meta.versions.push(entry);
      meta.updatedAt = nowISO();
      await writeJson(metaPath, meta);

      // 溯源日志（追加式）
      const provPath = path.join(artifactDir, "provenance.md");
      const provLines = [
        `## v${version} · ${entry.created} · ${entry.author}`,
        "",
        ...(optStr(args, "description", "") ? [`描述：${optStr(args, "description", "")}`, ""] : []),
        ...(entry.provenance.command ? [`命令：\`${entry.provenance.command}\``, ""] : []),
        ...(entry.provenance.inputs.length ? [`输入：${entry.provenance.inputs.join(", ")}`, ""] : []),
        ...(entry.provenance.notes ? [`备注：${entry.provenance.notes}`, ""] : []),
        `环境：${entry.provenance.environment}`,
        "",
        "| 文件 | SHA-256 | 大小 (B) |",
        "| --- | --- | ---: |",
        ...files.map((f) => `| \`${f.path}\` | \`${f.sha256}\` | ${f.size} |`),
        "",
      ];
      await fsp.mkdir(path.dirname(provPath), { recursive: true });
      await fsp.appendFile(provPath, provLines.join("\n"), "utf8");

      // 全局索引
      const indexPath = withinRoot(root, path.join("artifacts", "artifacts.json"));
      const index = await readJson(indexPath, { artifacts: [] });
      const existing = index.artifacts.find((a) => a.name === name);
      if (existing) {
        existing.latestVersion = version;
        existing.updatedAt = nowISO();
        existing.description = optStr(args, "description", existing.description);
      } else {
        index.artifacts.push({
          name,
          latestVersion: version,
          created: meta.created,
          updatedAt: nowISO(),
          description: optStr(args, "description", ""),
          tags: asList(args.tags),
        });
      }
      await writeJson(indexPath, index);

      const out = [`工件 ${name} v${version} 已保存 → ${artifactDir}`, ""];
      for (const f of files) {
        out.push(`- ${f.path}  sha256=${f.sha256.slice(0, 16)}…  ${f.size} B`);
      }
      out.push("", "溯源已追加至 provenance.md。");
      return out.join("\n");
    },
  }));

  // ── artifact_list：列出全部工件与版本 ──
  ctx.tools.register(makeTool({
    name: "artifact_list",
    description: "列出项目全部版本化工件（名称、最新版本、更新时间、描述）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
      },
    },
    presentTitle: "列出工件",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const index = await readJson(withinRoot(root, path.join("artifacts", "artifacts.json")), { artifacts: [] });
      if (index.artifacts.length === 0) return "暂无工件。用 artifact_save 保存第一个工件。";
      const lines = [`共 ${index.artifacts.length} 个工件：`, ""];
      for (const a of index.artifacts) {
        lines.push(`- ${a.name}  v${a.latestVersion}  （${a.updatedAt}）${a.description ? " — " + a.description : ""}`);
      }
      lines.push("", "用 artifact_show <name> 查看某工件详情与溯源。");
      return lines.join("\n");
    },
  }));

  // ── artifact_show：查看工件详情与溯源 ──
  ctx.tools.register(makeTool({
    name: "artifact_show",
    description: "查看指定工件（artifact.json 元数据 + 最近版本溯源日志），参数 name 为工件名。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名，如 variant-call-v1" },
        version: { type: "string", description: "可选：查看指定版本，如 2；默认最新" },
      },
    },
    presentTitle: "查看工件",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const name = requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", slugify(name, name)));
      const meta = await readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) return `工件 ${name} 不存在。用 artifact_list 查看现有工件。`;
      const want = args.version ? Number(args.version) : meta.versions.length;
      const entry = meta.versions.find((v) => v.version === want);
      if (!entry) return `工件 ${name} 没有 v${want}（现有版本：${meta.versions.map((v) => v.version).join(", ")}）。`;
      const lines = [
        `# 工件 ${meta.name}`,
        "",
        ...(meta.description ? [`描述：${meta.description}`, ""] : []),
        `创建：${meta.created} ｜ 版本数：${meta.versions.length}`,
        "",
        `## v${entry.version} · ${entry.created} · ${entry.author}`,
        "",
        ...(entry.provenance.command ? [`命令：\`${entry.provenance.command}\``, ""] : []),
        ...(entry.provenance.inputs.length ? [`输入：${entry.provenance.inputs.join(", ")}`, ""] : []),
        ...(entry.provenance.notes ? [`备注：${entry.provenance.notes}`, ""] : []),
        `环境：${entry.provenance.environment}`,
        "",
        "文件：",
        ...entry.files.map((f) => `- ${f.path}  sha256=${f.sha256.slice(0, 16)}…  ${f.size} B`),
        "",
        `目录：${artifactDir}`,
      ];
      return lines.join("\n");
    },
  }));

  // ── artifact_reproduce：输出复现步骤 ──
  ctx.tools.register(makeTool({
    name: "artifact_reproduce",
    description:
      "输出指定工件版本的复现指引：溯源记录中的命令、输入、环境，以及当前会话中如何重跑（生成脚本或命令）。等价于 Claude Science 的可复现工件。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名" },
        version: { type: "string", description: "可选：版本号，默认最新" },
      },
    },
    presentTitle: "复现工件",
    async execute(args, exec) {
      const root = await resolveRoot(args, exec, markers);
      const name = requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", slugify(name, name)));
      const meta = await readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) return `工件 ${name} 不存在。`;
      const want = args.version ? Number(args.version) : meta.versions.length;
      const entry = meta.versions.find((v) => v.version === want);
      if (!entry) return `工件 ${name} 没有 v${want}。`;
      const vdir = path.join(artifactDir, `v${entry.version}`);
      const lines = [
        `# 复现工件 ${name} v${entry.version}`,
        "",
        `工件目录：${vdir}`,
        "",
        "## 溯源记录",
        ...(entry.provenance.command ? [`- 命令：\`${entry.provenance.command}\``] : ["- 命令：（未记录）"]),
        ...(entry.provenance.inputs.length ? [`- 输入：${entry.provenance.inputs.join(", ")}`] : []),
        `- 环境：${entry.provenance.environment}`,
        ...(entry.provenance.notes ? [`- 备注：${entry.provenance.notes}`] : []),
        "",
        "## 复现步骤",
        "1. 确认输入文件可用（见上；缺失时从 data/ 或原始来源恢复）。",
        "2. 重建运行环境（见 envs/ 或 conda-environments 技能）。",
        "3. 在 analyses/ 中重跑产生该工件的命令/脚本，输出到 experiments/ 对应实验的 results/。",
        "4. 对比新输出与 `artifact_show " + name + "` 的文件 SHA-256 是否一致。",
        "",
      ];
      return lines.join("\n");
    },
  }));
}

export { apply };
