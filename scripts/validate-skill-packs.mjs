#!/usr/bin/env node
// Validate the domain packs under skills/bioinformatics-habits/packs:
//  - packs/index.json matches the pack directories on disk
//  - every registry.json satisfies the pack contract (5 hooks)
//  - every pack has a SKILL.md whose frontmatter name is omics-pack-<pack>
// Zero dependencies; exits non-zero on the first failing pack.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const packsDir = join(root, "skills", "bioinformatics-habits", "packs");
const indexFile = join(packsDir, "index.json");

const MATURITY = new Set(["execution", "planning"]);
const RESOURCE_KIND = new Set([
  "reference",
  "database",
  "library",
  "annotation",
  "panel",
  "other",
]);

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isStrArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);

function loadJson(file, where) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(where, `cannot parse JSON (${err.message})`);
    return null;
  }
}

function validateRegistry(pack, reg) {
  const at = `packs/${pack}/registry.json`;
  if (!isObj(reg)) return fail(at, "root must be an object");
  if (reg.schema_version !== "0.1.0") fail(at, `schema_version must be "0.1.0"`);
  if (reg.pack !== pack) fail(at, `pack must equal directory name "${pack}"`);
  if (!isStr(reg.display_name)) fail(at, "display_name missing");
  if (!MATURITY.has(reg.maturity)) fail(at, `maturity must be one of ${[...MATURITY].join("|")}`);
  if (!isStr(reg.scope)) fail(at, "scope missing");

  if (!Array.isArray(reg.intake_fields) || reg.intake_fields.length === 0) {
    fail(at, "intake_fields must be a non-empty array");
  } else {
    reg.intake_fields.forEach((f, i) => {
      const w = `${at} intake_fields[${i}]`;
      if (!isObj(f)) return fail(w, "must be an object");
      if (!isStr(f.name)) fail(w, "name missing");
      if (!isStr(f.values)) fail(w, "values missing");
      if (typeof f.blocking !== "boolean") fail(w, "blocking must be boolean");
      if (!isStr(f.why)) fail(w, "why missing");
    });
  }

  if (!isObj(reg.resources) || Object.keys(reg.resources).length === 0) {
    fail(at, "resources must be a non-empty object");
  } else {
    for (const [name, r] of Object.entries(reg.resources)) {
      const w = `${at} resources.${name}`;
      if (!isObj(r)) { fail(w, "must be an object"); continue; }
      if (!RESOURCE_KIND.has(r.kind)) fail(w, `kind must be one of ${[...RESOURCE_KIND].join("|")}`);
      if (!isStr(r.root_env)) fail(w, "root_env missing");
      if (!isStrArray(r.expected_files)) fail(w, "expected_files must be a non-empty string array");
      if (!isStrArray(r.required_for)) fail(w, "required_for must be a non-empty string array");
    }
  }

  if (!isObj(reg.pipelines) || Object.keys(reg.pipelines).length === 0) {
    fail(at, "pipelines must be a non-empty object");
  } else {
    for (const [name, p] of Object.entries(reg.pipelines)) {
      const w = `${at} pipelines.${name}`;
      if (!isObj(p)) { fail(w, "must be an object"); continue; }
      if (!isStrArray(p.route_when)) fail(w, "route_when must be a non-empty string array");
      if (!isStr(p.preferred_workflow)) fail(w, "preferred_workflow missing");
      if (!isStrArray(p.tools)) fail(w, "tools must be a non-empty string array");
      if (!isStrArray(p.essential_questions)) fail(w, "essential_questions must be a non-empty string array");
      if (!(p.local_runner === null || isStr(p.local_runner))) fail(w, "local_runner must be a string or null");
    }
  }

  if (!Array.isArray(reg.qc_metrics) || reg.qc_metrics.length === 0) {
    fail(at, "qc_metrics must be a non-empty array");
  } else {
    reg.qc_metrics.forEach((m, i) => {
      const w = `${at} qc_metrics[${i}]`;
      if (!isObj(m)) return fail(w, "must be an object");
      if (!isStr(m.name)) fail(w, "name missing");
      if (!isStr(m.rule)) fail(w, "rule missing");
      if (!isStr(m.source)) fail(w, "source missing");
      if (typeof m.blocking !== "boolean") fail(w, "blocking must be boolean");
    });
  }

  if (!Array.isArray(reg.compliance) || reg.compliance.length === 0) {
    fail(at, "compliance must be a non-empty array");
  }
  if (!Array.isArray(reg.handoff)) fail(at, "handoff must be an array");
}

function validateSkillMd(pack) {
  const file = join(packsDir, pack, "SKILL.md");
  const at = `packs/${pack}/SKILL.md`;
  if (!existsSync(file)) return fail(at, "missing");
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---\n")) return fail(at, "missing YAML frontmatter");
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return fail(at, "malformed frontmatter");
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1];
  if (name !== `omics-pack-${pack}`) fail(at, `frontmatter name must be omics-pack-${pack} (got ${name ?? "none"})`);
  if (!/^description:\s*\S/m.test(fm)) fail(at, "frontmatter description missing");
  if (!/^whenToUse:\s*\S/m.test(fm)) fail(at, "frontmatter whenToUse missing");
  if (!text.includes("bioinformatics-habits")) fail(at, "must reference the bioinformatics-habits core");
}

function main() {
  if (!existsSync(packsDir)) {
    console.error(`✖ packs directory not found: ${packsDir}`);
    process.exit(1);
  }
  if (!existsSync(indexFile)) {
    console.error(`✖ packs/index.json not found`);
    process.exit(1);
  }
  const index = loadJson(indexFile, "packs/index.json");
  if (!index) return report();
  if (index.schema_version !== "0.1.0") fail("packs/index.json", "schema_version must be 0.1.0");
  if (index.core !== "bioinformatics-habits") fail("packs/index.json", "core must be bioinformatics-habits");
  if (!Array.isArray(index.packs) || index.packs.length === 0) fail("packs/index.json", "packs must be a non-empty array");

  const indexed = new Map();
  for (const entry of index.packs ?? []) {
    if (!isObj(entry) || !isStr(entry.pack)) { fail("packs/index.json", "entry.pack missing"); continue; }
    if (indexed.has(entry.pack)) fail("packs/index.json", `duplicate pack entry "${entry.pack}"`);
    indexed.set(entry.pack, entry);
    if (!MATURITY.has(entry.maturity)) fail(`packs/index.json ${entry.pack}`, "maturity invalid");
    if (entry.path !== `packs/${entry.pack}/`) fail(`packs/index.json ${entry.pack}`, "path must be packs/<pack>/");
  }

  const onDisk = readdirSync(packsDir)
    .filter((n) => statSync(join(packsDir, n)).isDirectory())
    .sort();

  for (const pack of onDisk) {
    if (!indexed.has(pack)) fail(`packs/${pack}`, "directory is not listed in packs/index.json");
    validateSkillMd(pack);
    const reg = loadJson(join(packsDir, pack, "registry.json"), `packs/${pack}/registry.json`);
    if (reg) validateRegistry(pack, reg);
  }
  for (const pack of indexed.keys()) {
    if (!onDisk.includes(pack)) fail(`packs/index.json`, `listed pack "${pack}" has no directory`);
  }

  report(
    `checked ${onDisk.length} pack(s): ${onDisk.join(", ")}`,
  );
}

function report(summary) {
  if (errors.length) {
    console.error("✖ skill pack validation failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✔ skill packs OK — ${summary}`);
  const exec = [];
  const plan = [];
  for (const f of readdirSync(packsDir)) {
    const reg = join(packsDir, f, "registry.json");
    if (!existsSync(reg)) continue;
    const m = JSON.parse(readFileSync(reg, "utf8")).maturity;
    (m === "execution" ? exec : plan).push(f);
  }
  console.log(`  execution: ${exec.join(", ")}`);
  console.log(`  planning : ${plan.join(", ")}`);
}

main();
