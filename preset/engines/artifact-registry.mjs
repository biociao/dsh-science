// science-artifact-registry —— 模仿 Claude Science 的工件与溯源（Artifacts + Provenance）
//
// 零第三方依赖（只用 node 内置模块），作为科学模式 preset 的本地插件被挂载。
// 管理 <项目根>/artifacts/<name>/：
//   - v<N>/         每次保存生成一个新版本目录（源文件/目录的副本）
//   - artifact.json 版本索引与溯源元数据（命令、输入、输出、环境、SHA-256）
//   - provenance.md 人类可读的溯源日志（追加式）
//   - artifacts/artifacts.json 全局工件索引
// 等价于 Claude Science 的"结果保存为带完整执行记录（provenance）的版本化工件"。
//
// v0.1.1 修复（相对 v0.1.0，鲁棒性更新）：
//   A 并发一致性：所有写操作经 artifacts/.lock 串行 + 原子写；
//     版本号从最大版本推导；同一文件重复保存时按 path+sha256 去重（硬链接，失败退化为复制）。
//   B 校验：路径越界（ERR_PATH）、大小配额（ERR_QUOTA）、参数校验统一错误码。
//   C 工件系统：流式 SHA-256（大文件不爆内存）；新增 artifact_diff（版本对比）、
//     artifact_verify（重算哈希校验）、artifact_deprecate（标记废弃）；
//     溯源增强：envFile 参数（记录环境文件哈希）、inputs 自动记录 inputHashes；
//     artifact_save 会尽力回写 research-manifest.json 的 artifacts[]（打通清单仪表盘）。
//   D 架构：错误码化、审计日志、artifact_diff / artifact_verify 结构化 JSON 输出。

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "science-artifact-registry";
export const inject = ["tools"];

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 ** 3; // 8 GiB（可通过 config.maxFileBytes 覆盖）

function withinRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) {
    throw core.sciErr("ERR_PATH", `路径越出项目根：${rel}`);
  }
  return abs;
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

function normalizeRel(p) {
  return p.split(path.sep).join("/");
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const allowHardlink = config.allowHardlink !== false;
  const lockOpts = {
    timeoutMs: config.lock?.timeoutMs ?? 10000,
    staleMs: config.lock?.staleMs ?? 30000,
  };

  const audit = async (args, exec) => {
    try {
      return await core.resolveRoot(args, exec, markers);
    } catch {
      return undefined;
    }
  };

  const artifactsLockPath = async (root) => {
    await fsp.mkdir(path.join(root, "artifacts"), { recursive: true });
    return path.join(root, "artifacts", ".lock");
  };

  // ── artifact_save：保存一个版本化工件并记录溯源 ──
  ctx.tools.register(core.makeTool({
    name: "artifact_save",
    description:
      "把分析结果/图表/数据保存为版本化工件（等价于 Claude Science 的 Artifacts）：复制 sources 指定的文件或目录到 artifacts/<name>/v<N>/，流式计算每个文件的 SHA-256，写入 artifact.json（版本+溯源：command、inputs、envFile、环境）并追加 provenance.md 溯源日志。相同内容自动去重（硬链接）。可选 envFile 记录环境文件哈希。同时尽力回写研究清单 artifacts[]。返回版本号与文件哈希清单。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名（字母数字与连字符，如 variant-call-v1）" },
        description: { type: "string", description: "工件描述" },
        sources: { type: "array", items: { type: "string" }, description: "要归档的文件/目录（相对于项目根，至少一个）" },
        command: { type: "string", description: "产生该工件的关键命令/脚本（溯源记录，用于复现）" },
        inputs: { type: "array", items: { type: "string" }, description: "输入文件/数据路径（存在则自动记录哈希）" },
        envFile: { type: "string", description: "（可选）环境文件路径（如 envs/xxx.yaml），记录其哈希用于复现" },
        notes: { type: "string", description: "备注（如参数、版本、注意事项）" },
        tags: { type: "array", items: { type: "string" }, description: "标签，如 genome, snp, figure" },
      },
    },
    presentTitle: "保存工件",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const rawSources = core.asList(args.sources);
      if (rawSources.length === 0) throw core.sciErr("ERR_VALIDATION", "参数 sources 至少需要一个文件或目录");
      const name = core.slugify(core.requireStr(args, "name"), "artifact");
      const artifactDir = withinRoot(root, path.join("artifacts", name));

      return core.withFileLock(await artifactsLockPath(root), async () => {
        const metaPath = path.join(artifactDir, "artifact.json");
        const meta = await core.readJson(metaPath, {
          name,
          description: core.optStr(args, "description", ""),
          created: core.nowISO(),
          versions: [],
        });
        const version = (meta.versions.reduce((mx, v) => Math.max(mx, v.version || 0), 0)) + 1;
        const vdir = path.join(artifactDir, `v${version}`);
        await fsp.mkdir(vdir, { recursive: true });

        // 去重候选：任一旧版本有相同 path + sha256 → 硬链接复用（失败退化为复制）
        const prevCandidate = (relPath, sha) => {
          if (!allowHardlink) return null;
          for (const v of meta.versions) {
            for (const f of v.files || []) {
              if (f.path === relPath && f.sha256 === sha) {
                const abs = path.join(artifactDir, `v${v.version}`, relPath);
                if (existsSync(abs)) return { version: v.version, abs };
              }
            }
          }
          return null;
        };

        const archiveOne = async (srcAbs, relPath) => {
          const st = await fsp.stat(srcAbs);
          if (maxFileBytes && st.size > maxFileBytes) {
            throw core.sciErr(
              "ERR_QUOTA",
              `文件超过大小配额（${st.size} B > ${maxFileBytes} B）：${relPath}（可调 config.maxFileBytes）`
            );
          }
          const sha = await core.sha256Stream(srcAbs);
          const destAbs = path.join(vdir, relPath);
          await fsp.mkdir(path.dirname(destAbs), { recursive: true });
          const cand = prevCandidate(relPath, sha);
          if (cand) {
            try {
              await fsp.link(cand.abs, destAbs);
              return { path: relPath, sha256: sha, size: st.size, linkedFrom: `v${cand.version}` };
            } catch {
              /* 跨设备等 → 退化为复制 */
            }
          }
          await fsp.copyFile(srcAbs, destAbs);
          return { path: relPath, sha256: sha, size: st.size };
        };

        const files = [];
        for (const rel of rawSources) {
          const src = withinRoot(root, rel);
          let st;
          try {
            st = await fsp.stat(src);
          } catch (err) {
            throw core.sciErr("ERR_NOT_FOUND", `源路径不存在：${rel}（${err.message}）`);
          }
          if (st.isDirectory()) {
            const rels = await core.collectFiles(src, src);
            for (const r of rels) {
              const abs = path.join(src, r);
              const relPath = normalizeRel(path.join(path.basename(rel), r));
              files.push(await archiveOne(abs, relPath));
            }
          } else {
            const relPath = normalizeRel(path.basename(rel));
            files.push(await archiveOne(src, relPath));
          }
        }

        // 溯源增强：inputs 哈希（尽力而为）+ envFile 哈希（显式指定必须存在）
        const inputHashes = [];
        for (const inp of core.asList(args.inputs)) {
          try {
            const abs = withinRoot(root, inp);
            const st = await fsp.stat(abs);
            if (st.isFile()) {
              inputHashes.push({ path: inp, sha256: await core.sha256Stream(abs), size: st.size });
            }
          } catch {
            /* 输入缺失：只记录路径，不阻断 */
          }
        }
        let envEntry = null;
        if (args.envFile) {
          const abs = withinRoot(root, args.envFile);
          try {
            const st = await fsp.stat(abs);
            if (st.isFile()) {
              envEntry = { path: args.envFile, sha256: await core.sha256Stream(abs), size: st.size };
            }
          } catch {
            throw core.sciErr("ERR_NOT_FOUND", `envFile 不存在：${args.envFile}`);
          }
        }
        const environment =
          `${process.platform} ${process.arch} / node ${process.version}` +
          (envEntry ? ` / env ${envEntry.path}#${envEntry.sha256.slice(0, 12)}` : "");

        const entry = {
          version,
          created: core.nowISO(),
          author: sessionLabel(exec),
          provenance: {
            command: core.optStr(args, "command", ""),
            inputs: core.asList(args.inputs),
            inputHashes,
            envFile: envEntry ? { path: envEntry.path, sha256: envEntry.sha256 } : null,
            notes: core.optStr(args, "notes", ""),
            environment,
          },
          files,
        };
        meta.versions.push(entry);
        meta.updatedAt = core.nowISO();
        await core.writeJsonAtomic(metaPath, meta);

        // 溯源日志（追加式）
        const provPath = path.join(artifactDir, "provenance.md");
        const provLines = [
          `## v${version} · ${entry.created} · ${entry.author}`,
          "",
          ...(core.optStr(args, "description", "") ? [`描述：${core.optStr(args, "description", "")}`, ""] : []),
          ...(entry.provenance.command ? [`命令：\`${entry.provenance.command}\``, ""] : []),
          ...(entry.provenance.inputs.length ? [`输入：${entry.provenance.inputs.join(", ")}`, ""] : []),
          ...(inputHashes.length ? [`输入哈希：${inputHashes.map((h) => `${h.path}#${h.sha256.slice(0, 12)}`).join(", ")}`, ""] : []),
          ...(envEntry ? [`环境文件：\`${envEntry.path}\` sha256=${envEntry.sha256}`, ""] : []),
          ...(entry.provenance.notes ? [`备注：${entry.provenance.notes}`, ""] : []),
          `环境：${entry.provenance.environment}`,
          "",
          "| 文件 | SHA-256 | 大小 (B) | 来源 |",
          "| --- | --- | ---: | --- |",
          ...files.map((f) => `| \`${f.path}\` | \`${f.sha256}\` | ${f.size} | ${f.linkedFrom ? f.linkedFrom : "复制"} |`),
          "",
        ];
        await fsp.mkdir(path.dirname(provPath), { recursive: true });
        await fsp.appendFile(provPath, provLines.join("\n"), "utf8");

        // 全局索引
        const indexPath = withinRoot(root, path.join("artifacts", "artifacts.json"));
        const index = await core.readJson(indexPath, { artifacts: [] });
        const existing = index.artifacts.find((a) => a.name === name);
        if (existing) {
          existing.latestVersion = version;
          existing.updatedAt = core.nowISO();
          existing.description = core.optStr(args, "description", existing.description);
        } else {
          index.artifacts.push({
            name,
            latestVersion: version,
            created: meta.created,
            updatedAt: core.nowISO(),
            description: core.optStr(args, "description", ""),
            tags: core.asList(args.tags),
          });
        }
        await core.writeJsonAtomic(indexPath, index);

        // 尽力回写研究清单（manifest 不存在则跳过；失败不影响工件保存）
        await syncManifestArtifacts(root, name, version, core.optStr(args, "description", ""), lockOpts);

        const out = [`工件 ${name} v${version} 已保存 → ${artifactDir}`, ""];
        for (const f of files) {
          out.push(`- ${f.path}  sha256=${f.sha256.slice(0, 16)}…  ${f.size} B${f.linkedFrom ? `  （去重：链接自 ${f.linkedFrom}）` : ""}`);
        }
        out.push("", "溯源已追加至 provenance.md。");
        return out.join("\n");
      });
    },
  }));

  // ── artifact_list：列出全部工件与版本 ──
  ctx.tools.register(core.makeTool({
    name: "artifact_list",
    description: "列出项目全部版本化工件（名称、最新版本、更新时间、描述、废弃标记）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
      },
    },
    presentTitle: "列出工件",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const index = await core.readJson(withinRoot(root, path.join("artifacts", "artifacts.json")), { artifacts: [] });
      if (index.artifacts.length === 0) return "暂无工件。用 artifact_save 保存第一个工件。";
      const lines = [`共 ${index.artifacts.length} 个工件：`, ""];
      for (const a of index.artifacts) {
        lines.push(
          `- ${a.name}  v${a.latestVersion}  ${a.deprecated ? "（已废弃）" : ""}（${a.updatedAt}）${a.description ? " — " + a.description : ""}`
        );
      }
      lines.push("", "用 artifact_show <name> 查看某工件详情与溯源；artifact_diff <name> 对比版本；artifact_verify <name> 校验哈希。");
      return lines.join("\n");
    },
  }));

  // ── artifact_show：查看工件详情与溯源 ──
  ctx.tools.register(core.makeTool({
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
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const name = core.requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", core.slugify(name, name)));
      const meta = await core.readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 不存在。用 artifact_list 查看现有工件。`);
      const want = args.version ? Number(args.version) : meta.versions.length;
      const entry = meta.versions.find((v) => v.version === want);
      if (!entry) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有 v${want}（现有版本：${meta.versions.map((v) => v.version).join(", ")}）。`);
      const lines = [
        `# 工件 ${meta.name}`,
        "",
        ...(meta.description ? [`描述：${meta.description}`, ""] : []),
        `创建：${meta.created} ｜ 版本数：${meta.versions.length}`,
        "",
        `## v${entry.version} · ${entry.created} · ${entry.author}${entry.deprecated ? "  ⚠ 已废弃" : ""}`,
        "",
        ...(entry.provenance.command ? [`命令：\`${entry.provenance.command}\``, ""] : []),
        ...(entry.provenance.inputs.length ? [`输入：${entry.provenance.inputs.join(", ")}`, ""] : []),
        ...((entry.provenance.inputHashes || []).length
          ? [`输入哈希：${entry.provenance.inputHashes.map((h) => `${h.path}#${h.sha256.slice(0, 12)}`).join(", ")}`, ""]
          : []),
        ...(entry.provenance.envFile ? [`环境文件：\`${entry.provenance.envFile.path}\` sha256=${entry.provenance.envFile.sha256}`, ""] : []),
        ...(entry.provenance.notes ? [`备注：${entry.provenance.notes}`, ""] : []),
        `环境：${entry.provenance.environment}`,
        "",
        "文件：",
        ...entry.files.map((f) => `- ${f.path}  sha256=${f.sha256.slice(0, 16)}…  ${f.size} B${f.linkedFrom ? `（链接自 ${f.linkedFrom}）` : ""}`),
        "",
        `目录：${artifactDir}`,
      ];
      return lines.join("\n");
    },
  }));

  // ── artifact_diff：对比两个版本（v0.1.1 新增，结构化输出）──
  ctx.tools.register(core.makeTool({
    name: "artifact_diff",
    description:
      "对比工件两个版本的文件差异（结构化 JSON）：added（仅新版）、removed（仅旧版）、changed（哈希变化）、unchanged（相同）。默认对比最新两版；from/to 可指定版本号。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名" },
        from: { type: "integer", description: "可选：起始版本，默认最新版的前一版" },
        to: { type: "integer", description: "可选：目标版本，默认最新版" },
      },
    },
    presentTitle: "对比工件版本",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true, // 注：dsh 只支持单类型 string；from 可能为 null（仅一个版本时），故不列入 properties
      properties: {
        name: { type: "string" },
        to: { type: "integer" },
        added: { type: "array" },
        removed: { type: "array" },
        changed: { type: "array" },
        unchanged: { type: "array" },
      },
      required: ["name", "to", "added", "removed", "changed", "unchanged"],
    },
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const name = core.requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", core.slugify(name, name)));
      const meta = await core.readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 不存在。`);
      const vs = [...meta.versions].sort((a, b) => a.version - b.version);
      if (vs.length === 0) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有任何版本。`);
      const latest = vs[vs.length - 1].version;
      const fromV = args.from !== undefined ? Number(args.from) : vs.length >= 2 ? vs[vs.length - 2].version : null;
      const toV = args.to !== undefined ? Number(args.to) : latest;
      const entryOf = (v) => vs.find((e) => e.version === v);
      if (!entryOf(toV)) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有 v${toV}。`);
      if (fromV !== null && !entryOf(fromV)) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有 v${fromV}。`);

      const mapOf = (e) => Object.fromEntries((e?.files || []).map((f) => [f.path, f.sha256]));
      const fromMap = fromV === null ? {} : mapOf(entryOf(fromV));
      const toMap = mapOf(entryOf(toV));
      const added = [], removed = [], changed = [], unchanged = [];
      for (const p of Object.keys(toMap)) {
        if (!(p in fromMap)) added.push({ path: p, sha256: toMap[p] });
        else if (fromMap[p] !== toMap[p]) changed.push({ path: p, fromSha256: fromMap[p], toSha256: toMap[p] });
        else unchanged.push(p);
      }
      for (const p of Object.keys(fromMap)) {
        if (!(p in toMap)) removed.push({ path: p, sha256: fromMap[p] });
      }
      return { name, from: fromV, to: toV, added, removed, changed, unchanged };
    },
  }));

  // ── artifact_verify：重算哈希校验（v0.1.1 新增，结构化输出）──
  ctx.tools.register(core.makeTool({
    name: "artifact_verify",
    description:
      "校验工件版本的文件完整性（结构化 JSON）：对版本目录内每个文件重算 SHA-256 并与记录对比，报告缺失/不一致文件。status=ok 表示全部一致。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名" },
        version: { type: "integer", description: "可选：校验指定版本，默认最新" },
      },
    },
    presentTitle: "校验工件完整性",
    audit,
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        name: { type: "string" },
        version: { type: "integer" },
        status: { type: "string" },
        checked: { type: "integer" },
        mismatches: { type: "array" },
        missing: { type: "array" },
      },
      required: ["name", "version", "status", "checked"],
    },
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const name = core.requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", core.slugify(name, name)));
      const meta = await core.readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 不存在。`);
      const vs = [...meta.versions].sort((a, b) => a.version - b.version);
      if (vs.length === 0) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有任何版本。`);
      const version = args.version !== undefined ? Number(args.version) : vs[vs.length - 1].version;
      const entry = vs.find((e) => e.version === version);
      if (!entry) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有 v${version}。`);
      const vdir = path.join(artifactDir, `v${version}`);
      const mismatches = [], missing = [];
      for (const f of entry.files || []) {
        const abs = path.join(vdir, f.path);
        let sha;
        try {
          sha = await core.sha256Stream(abs);
        } catch {
          missing.push({ path: f.path, expected: f.sha256 });
          continue;
        }
        if (sha !== f.sha256) mismatches.push({ path: f.path, expected: f.sha256, actual: sha });
      }
      const status = mismatches.length || missing.length ? "mismatch" : "ok";
      return { name, version, status, checked: entry.files.length, mismatches, missing };
    },
  }));

  // ── artifact_deprecate：标记废弃（v0.1.1 新增）──
  ctx.tools.register(core.makeTool({
    name: "artifact_deprecate",
    description:
      "把工件（或指定版本）标记为已废弃：写入 artifact.json 的 deprecated 字段、更新全局索引并追加 provenance.md。废弃不等于删除（append-only），列表与详情会显示标记。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        name: { type: "string", description: "工件名" },
        version: { type: "integer", description: "可选：只废弃指定版本；缺省废弃全部版本" },
        reason: { type: "string", description: "废弃原因" },
      },
    },
    presentTitle: "废弃工件",
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const name = core.requireStr(args, "name");
      const reason = core.optStr(args, "reason", "");
      const artifactDir = withinRoot(root, path.join("artifacts", core.slugify(name, name)));

      return core.withFileLock(await artifactsLockPath(root), async () => {
        const metaPath = path.join(artifactDir, "artifact.json");
        const meta = await core.readJson(metaPath, null);
        if (!meta) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 不存在。`);
        const stamp = core.nowISO();
        const mark = { at: stamp, reason };
        const vs = args.version !== undefined ? [Number(args.version)] : meta.versions.map((v) => v.version);
        const missing = vs.filter((v) => !meta.versions.some((e) => e.version === v));
        if (missing.length) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有版本 v${missing.join(", v")}。`);
        for (const v of vs) {
          const e = meta.versions.find((x) => x.version === v);
          e.deprecated = mark;
        }
        if (args.version === undefined) meta.deprecated = mark;
        meta.updatedAt = stamp;
        await core.writeJsonAtomic(metaPath, meta);

        const indexPath = withinRoot(root, path.join("artifacts", "artifacts.json"));
        const index = await core.readJson(indexPath, { artifacts: [] });
        const ex = index.artifacts.find((a) => a.name === name);
        if (ex) {
          ex.deprecated = mark;
          ex.updatedAt = stamp;
          await core.writeJsonAtomic(indexPath, index);
        }

        const provPath = path.join(artifactDir, "provenance.md");
        await fsp.appendFile(provPath, `\n## 废弃标记 · ${stamp}\n\n- 版本：v${vs.join(", v")}\n- 原因：${reason || "（未注明）"}\n\n`, "utf8");

        return `工件 ${name} v${vs.join(", v")} 已标记废弃${reason ? `（原因：${reason}）` : ""}。`;
      });
    },
  }));

  // ── artifact_reproduce：输出复现步骤 ──
  ctx.tools.register(core.makeTool({
    name: "artifact_reproduce",
    description:
      "输出指定工件版本的复现指引：溯源记录中的命令、输入、环境（含 envFile 与输入哈希），以及当前会话中如何重跑（生成脚本或命令）。等价于 Claude Science 的可复现工件。",
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
    audit,
    async execute(args, exec) {
      const root = await core.resolveRoot(args, exec, markers);
      const name = core.requireStr(args, "name");
      const artifactDir = withinRoot(root, path.join("artifacts", core.slugify(name, name)));
      const meta = await core.readJson(path.join(artifactDir, "artifact.json"), null);
      if (!meta) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 不存在。`);
      const want = args.version ? Number(args.version) : meta.versions.length;
      const entry = meta.versions.find((v) => v.version === want);
      if (!entry) throw core.sciErr("ERR_NOT_FOUND", `工件 ${name} 没有 v${want}。`);
      const vdir = path.join(artifactDir, `v${entry.version}`);
      const lines = [
        `# 复现工件 ${name} v${entry.version}`,
        "",
        `工件目录：${vdir}`,
        "",
        "## 溯源记录",
        ...(entry.provenance.command ? [`- 命令：\`${entry.provenance.command}\``] : ["- 命令：（未记录）"]),
        ...(entry.provenance.inputs.length ? [`- 输入：${entry.provenance.inputs.join(", ")}`] : []),
        ...((entry.provenance.inputHashes || []).length
          ? [`- 输入哈希：${entry.provenance.inputHashes.map((h) => `${h.path}#${h.sha256.slice(0, 12)}`).join(", ")}`]
          : []),
        ...(entry.provenance.envFile ? [`- 环境文件：\`${entry.provenance.envFile.path}\` sha256=${entry.provenance.envFile.sha256}`] : []),
        `- 环境：${entry.provenance.environment}`,
        ...(entry.provenance.notes ? [`- 备注：${entry.provenance.notes}`] : []),
        "",
        "## 复现步骤",
        "1. 确认输入文件可用并核对输入哈希（见上；缺失时从 data/ 或原始来源恢复）。",
        "2. 重建运行环境（见 envs/ 或 conda-environments 技能；有 envFile 时按其中记录恢复并核对哈希）。",
        "3. 在 analyses/ 中重跑产生该工件的命令/脚本，输出到 experiments/ 对应实验的 results/。",
        "4. 对比新输出与 `artifact_show " + name + "` / `artifact_verify " + name + "` 的文件 SHA-256 是否一致。",
        "",
      ];
      return lines.join("\n");
    },
  }));
}

// 尽力把工件登记回写 research-manifest.json 的 artifacts[]（与 research_* 共用同一锁）
async function syncManifestArtifacts(root, name, version, description, lockOpts) {
  const mp = path.join(root, "research-manifest.json");
  if (!existsSync(mp)) return;
  try {
    await core.withFileLock(
      mp,
      async () => {
        const m = await core.readJson(mp, null);
        if (!m) return;
        if (!Array.isArray(m.artifacts)) m.artifacts = [];
        const i = m.artifacts.findIndex((a) => a.name === name);
        const rec = { name, latestVersion: version, updatedAt: core.nowISO(), description };
        if (i >= 0) m.artifacts[i] = { ...m.artifacts[i], ...rec };
        else m.artifacts.push(rec);
        m.updatedAt = core.nowISO();
        await core.writeJsonAtomic(mp, m);
      },
      lockOpts
    );
  } catch {
    /* best-effort：清单不可用/被占用时不阻断工件保存 */
  }
}

export { apply };
