// biomni-plan —— Biomni 模式的「研究计划与状态」（Research Plan and Status）引擎
//
// 对应 Biomni configure(plan=True) 时为 agent 注入的"编号清单"计划纪律：
//   - 先给一个高层计划（可修订）
//   - 记录哪些步骤已完成 / 进行中 / 失败
//   - 每步执行后记一小段"结果与结论"（只包含上一步已确认的观察，不臆测）
//   - Research Plan and Status 必须只含此前步骤已确认的进展，不得含未被观察直接确认的结论
//
// 本引擎把"计划+状态+结果"落盘为 <项目根>/.biomni/plan.json，提供：
//   biomni_plan_init   —— 建计划（可用检索层 plan_hint 初始化，也可手给 steps）
//   biomni_plan_update —— 更新步骤状态 / 增删步骤 / 追加结果与结论（只有观察能写 result）
//   biomni_plan_status —— 渲染当前计划（历史可回溯）
//
// 零第三方依赖；写经 withFileLock 串行 + 原子写。

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as core from "./core.mjs";

export const name = "biomni-plan";
export const inject = ["tools"];

const SCHEMA = 1;
const PLAN_FILE = "plan.json";
const BIOMNI_DIR = ".biomni";
const STEP_STATUS = ["pending", "in_progress", "done", "failed"];
const PLAN_STATUS = ["active", "done"];

async function planPath(root) {
  return path.join(root, BIOMNI_DIR, PLAN_FILE);
}

async function loadPlan(root) {
  return core.readJson(await planPath(root), null);
}

async function savePlan(root, plan) {
  plan.updatedAt = core.nowISO();
  await core.writeJsonAtomic(await planPath(root), plan);
}

async function withPlan(root, fn) {
  return core.withFileLock(await planPath(root), async () => {
    const plan = (await loadPlan(root)) ?? { schema: SCHEMA, task: "", goal: "", status: "active", steps: [], results: [], updatedAt: "" };
    const v = await fn(plan);
    await savePlan(root, plan);
    return v;
  });
}

function renderPlan(plan) {
  const lines = [];
  lines.push(`# 研究计划：${plan.task || "（未命名）"}`);
  if (plan.goal) lines.push(`目标：${plan.goal}`);
  lines.push(`状态：${plan.status} ｜ 步骤：${plan.steps.length} ｜ 更新：${plan.updatedAt}`);
  lines.push("");
  lines.push("## Research Plan and Status");
  lines.push("");
  for (const s of plan.steps) {
    const mark = s.status === "done" ? "[✓]" : s.status === "failed" ? "[✗]" : s.status === "in_progress" ? "[…]" : "[ ]";
    lines.push(`${mark} ${s.text}${s.status === "failed" && s.note ? ` （${s.note}）` : ""}`);
  }
  if (plan.results.length) {
    lines.push("");
    lines.push("## 结果与结论（只含已确认观察）");
    lines.push("");
    for (const r of plan.results) {
      lines.push(`- 步骤 ${r.step}：${r.result}`);
    }
  }
  return lines.join("\n");
}

function findStep(plan, step) {
  return Number(step) >= 0 ? Number(step) : -1;
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

  // biomni_plan_init：创建/重建一份研究计划
  ctx.tools.register(
    core.makeTool({
      name: "biomni_plan_init",
      description:
        "创建（或重建）一份 Biomni 研究计划与状态（Research Plan and Status）。task 为任务名，goal 为目标；steps 为计划步骤列表（可省略，此时用 biombi_retrieve 的 plan_hint 或自行拟定需调 biomni_plan_update 逐步补）。建好后用 biomni_plan_update 更新每步状态、biomni_plan_status 查看。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        task: { type: "string", description: "任务名（必填）" },
        goal: { type: "string", description: "目标（可选）" },
        steps: { type: "array", items: { type: "string" }, description: "计划步骤（编号清单），可选" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const task = (args?.task ?? "").trim();
        if (!task) throw core.sciErr("ERR_VALIDATION", "task 必填");
        const plan = await withPlan(root, (p) => {
          p.schema = SCHEMA;
          p.task = task;
          p.goal = (args?.goal ?? "").trim();
          p.status = "active";
          p.steps = (args?.steps ?? []).map((text, i) => ({ id: i, text, status: "pending", note: "" }));
          p.results = [];
          return p;
        });
        return { root, plan };
      },
    }),
  );

  // biomni_plan_update：更新步骤状态 / 追加结果与结论
  ctx.tools.register(
    core.makeTool({
      name: "biomni_plan_update",
      description:
        "更新 Biomni 研究计划与状态。step 为步骤下标（0 基）；可置 stepStatus ∈ pending/in_progress/done/failed（failed 可注明 note 原因）；可 addResult（该步已确认的结果/结论——只写已确认观察）；可 addStep（追加步骤文本）；可 task/goal 更新标题/目标。保持清单在每步后更新，让用户能追踪进度。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
        step: { type: "integer", description: "目标步骤下标（0 基）" },
        stepStatus: { type: "string", enum: STEP_STATUS, description: "该步新状态" },
        note: { type: "string", description: "failed 时的原因说明（可选）" },
        addResult: { type: "string", description: "该步结果/结论（只写已确认观察）" },
        addStep: { type: "string", description: "追加一个步骤文本" },
        task: { type: "string", description: "更新任务名（可选）" },
        goal: { type: "string", description: "更新目标（可选）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const plan = await withPlan(root, (p) => {
          if (args?.task) p.task = String(args.task).trim();
          if (args?.goal !== undefined) p.goal = String(args.goal).trim();
          if (args?.addStep) {
            p.steps.push({ id: p.steps.length, text: String(args.addStep).trim(), status: "pending", note: "" });
          }
          if (args?.step !== undefined && args?.stepStatus) {
            const s = p.steps[Number(args.step)];
            if (!s) throw core.sciErr("ERR_NOT_FOUND", `步骤不存在：${args.step}`);
            if (!STEP_STATUS.includes(args.stepStatus)) throw core.sciErr("ERR_VALIDATION", `stepStatus 必须是 ${STEP_STATUS.join("/")}`);
            s.status = args.stepStatus;
            if (args.note) s.note = String(args.note).trim();
          }
          if (args?.addResult) {
            p.results.push({ step: args.step ?? 0, result: String(args.addResult).trim(), at: core.nowISO() });
          }
          return p;
        });
        return { root, plan };
      },
    }),
  );

  // biomni_plan_status：查看当前计划
  ctx.tools.register(
    core.makeTool({
      name: "biomni_plan_status",
      description: "渲染当前 Biomni 研究计划与状态（编号清单 + 结果与结论），供展示/回溯。",
      parameters: {
        root: { type: "string", description: "项目根目录（默认自动探测）" },
      },
      execute: async (args, exec) => {
        const root = await core.resolveRoot(args, exec, markers);
        const plan = await loadPlan(root);
        if (!plan) {
          return { root, initialized: false, hint: "尚未创建计划。先用 biomni_plan_init（可参考 biomni_retrieve 的 plan_hint）建立一份。" };
        }
        return { root, initialized: true, task: plan.task, goal: plan.goal, status: plan.status, plan: plan, text: renderPlan(plan) };
      },
    }),
  );
}

export { apply, renderPlan };
