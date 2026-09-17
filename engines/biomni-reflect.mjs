// biomni-reflect —— Biomni 模式的「反思 / 自批判」（Reflection & Self-Criticism）引擎
//
// 对应 Biomni configure(reflect=True) 时为 agent 注入的"每轮工具执行后反思"纪律：
//   - reflect on the current state of the problem and the results of the last round
//   - What does the observation mean?
//   - If there is an error, what caused the error and how to debug?
// 也呼应 A1.configure(self_critic=True) 的 self-critic 路由：发现问题→修正→再评估。
//
// 本引擎把每轮反思落盘为 <项目根>/.biomni/reflect.jsonl（追加式，绝不静默覆盖）：
//   biomni_reflect      —— 记录 observation（上一步工具的客观输出）、reflection（它意味着什么）、
//                          diagnosis（出错原因/下一步）、nextAction、step
//   biomni_reflect_list —— 列出最近反思（含由反思链推断的"修正动作"）
//
// 这也是"自批判（actor-critic）"在单 agent 内部的落地：actor 执行，critic 在同一上下文里
// 用反思约束下一轮。评审可另由 DSH 的 scientific-reviewer 引擎 / research_review 归档。

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "biomni-reflect";
export const inject = ["tools"];

const REFLECT_FILE = "reflect.jsonl";
const BIOMNI_DIR = ".biomni";
const VERDICTS = ["ok", "revise", "rerun", "blocked"];

async function reflectPath(root) {
  return path.join(root, BIOMNI_DIR, REFLECT_FILE);
}

async function appendReflect(root, entry) {
  const p = await reflectPath(root);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // 追加式写（原子：写临时文件后 rename 会覆盖，改用 append 到目标即可；为防并发交错，
  // 经 withFileLock 串行，每条 jsonl 一行）
  await core.withFileLock(p, async () => {
    await fsp.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  });
}

async function readReflections(root, limit) {
  const p = await reflectPath(root);
  let raw;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw core.sciErr("ERR_IO", `读取反思日志失败：${err.message}`);
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out.slice(-(limit || 20));
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const markers = Array.isArray(config.markers) && config.markers.length ? config.markers : [".dsh", ".git"];
  const audit = async (args, exec) => {
    try {
      return await core.resolveRoot(args, exec, markers);
    } catch {
      return undefined;
    }
  };

  // biomni_reflect：记录一轮反思
  ctx.tools.register(
    core.makeTool({
      name: "biomni_reflect",
      description:
        "Biomni 模式的反思/自批判节点。执行完一步（工具/代码）后记录：observation（该步客观输出）、reflection（它意味着什么、当前问题状态）、diagnosis（若出错，原因是什么、如何修复/排除）、nextAction（下一步）。verdict ∈ ok/revise/rerun/blocked。这约束下一轮行动（actor-critic 的自批判）；跨 session 持久化在 .biomni/reflect.jsonl。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        observation: { type: "string", description: "上一步工具/代码的客观输出（结果、报错、统计量）" },
        reflection: { type: "string", description: "这个观察意味着什么？当前问题/任务处于什么状态？" },
        diagnosis: { type: "string", description: "若出错：原因是什么、如何修复；否则可写'无'" },
        nextAction: { type: "string", description: "下一步（修正方案 / 继续 / 重跑）" },
        step: { type: "integer", description: "对应计划步骤下标（可选）" },
        verdict: { type: "string", enum: VERDICTS, description: "自评结论（默认 ok）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const entry = {
          at: core.nowISO(),
          observation: (args?.observation ?? "").trim(),
          reflection: (args?.reflection ?? "").trim(),
          diagnosis: (args?.diagnosis ?? "").trim(),
          nextAction: (args?.nextAction ?? "").trim(),
          step: args?.step,
          verdict: args?.verdict ?? "ok",
        };
        if (!entry.observation && !entry.reflection) throw core.sciErr("ERR_VALIDATION", "observation 或 reflection 至少填一项");
        await appendReflect(root, entry);
        return { root, recorded: entry, hint: "反思已落盘。请结合 nextAction 继续；如 verdict=revise/rerun，请调整接下来的步骤或重跑。" };
      },
    }),
  );

  // biomni_reflect_list：列出最近反思
  ctx.tools.register(
    core.makeTool({
      name: "biomni_reflect_list",
      description: "列出最近的 Biomni 反思记录（按时间倒序），用于回顾执行轨迹/自批判链。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        limit: { type: "integer", description: "最多返回条数（默认 20）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const limit = Number(args?.limit) > 0 ? Number(args.limit) : 20;
        const items = await readReflections(root, limit);
        return { root, count: items.length, reflections: items.slice().reverse() };
      },
    }),
  );
}

export { apply, readReflections };
