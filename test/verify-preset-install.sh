#!/usr/bin/env bash
# Verify the standalone preset installers on DSH 0.2 in an isolated home.
# Covers copied/link engines, package resolution, reinstall, and real preset tools.
# Uses the installed DSH base/web bundles; never loads a production profile or LLM.
# Usage: bash test/verify-preset-install.sh (VERIFY_KEEP=1 retains diagnostics).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/dsh-science-preset-verify-XXXXXX)"
export DSH_HOME="$TMP/home"
export DSH_PROFILE=web
trap 'if [ "${VERIFY_KEEP:-0}" != 1 ]; then rm -rf "$TMP"; else echo "保留验证目录: $TMP"; fi' EXIT

mkdir -p "$DSH_HOME/profiles/web"
cat > "$DSH_HOME/profiles/web/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
cat > "$DSH_HOME/profiles/web/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
cp "$ROOT/test/runtime-probe.mjs" "$TMP/runtime-probe.mjs"

install_preset() {
  local script="$1" mode="$2" output
  if ! output="$(bash "$ROOT/scripts/$script" "$mode" 2>&1)"; then
    echo "$output" >&2
    return 1
  fi
  echo "$output" | tail -6
}

assert_install() {
  node --input-type=module - "$ROOT" "$DSH_HOME" "$1" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
const [root, home, phase] = process.argv.slice(2);
const profile = path.join(home, 'profiles/web');
const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
const bundles = manifest.dsh.profile.bundles;
const req = createRequire(path.join(profile, 'package.json'));
for (const [id, sourceDir, linked] of [['science', 'preset', false], ['biomni', 'preset-biomni', true]]) {
  const name = `dsh-science-preset-${id}`;
  assert.equal(bundles.filter(b => b === name).length, 1, `${name} must activate exactly once`);
  assert(manifest.dependencies[name], `${name} absent from profile dependencies`);
  const target = path.join(home, 'local-bundles', name);
  assert.equal(await realpath(req.resolve(`${name}/package.json`)), await realpath(path.join(target, 'package.json')),
    `${name}: local-path installation must keep the installer target live`);
  const targetEngines = path.join(target, 'engines');
  const sourceEngines = path.join(root, sourceDir, 'engines');
  assert.equal((await lstat(targetEngines)).isSymbolicLink(), linked, `${name}: copy/link mode`);
  if (linked) assert.equal(await realpath(targetEngines), await realpath(sourceEngines));
  for (const file of await readdir(sourceEngines)) {
    assert.deepEqual(await readFile(path.join(targetEngines, file)), await readFile(path.join(sourceEngines, file)),
      `${name}/${file}: installer engine differs from source`);
    await import(req.resolve(`${name}/engines/${file}`));
  }
  const patch = await readFile(path.join(target, 'cordis.patch.yml'), 'utf8');
  const expected = (await readFile(path.join(root, sourceDir, 'cordis.patch.yml'), 'utf8'))
    .replaceAll('dsh-science/engines/', `${name}/engines/`);
  assert.equal(patch, expected, `${name}: generated patch differs`);
  assert(!patch.includes('name: dsh-science/engines/'), `${name}: unrewritten dependency on full bundle`);
  if (phase === 'reinstall') assert.equal(await readFile(path.join(target, 'keep-me.txt'), 'utf8'), 'preserved\n');
  console.log(`  ✔ ${id}: ${linked ? 'linked' : 'copied'} engines, live local package and exports (${phase})`);
}
assert(!bundles.includes('dsh-science'), 'Standalone test must not use the full dsh-science bundle');
assert(!bundles.includes('dsh-model-tier'), 'Standalone test must not use the companion model router');
if (phase === 'reinstall') {
  await assert.rejects(lstat(path.join(home, 'local-bundles/dsh-science-preset-science/engines/obsolete.mjs')),
    { code: 'ENOENT' });
  console.log('  ✔ reinstall preserves other local files and replaces the copied engine directory');
}
JS
}

verify_runtime() {
  local phase="$1"
  cat > "$DSH_HOME/cordis.patch.yml" <<EOF
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- insert:
    - id: standalone-compatibility-probe
      name: "$TMP/runtime-probe.mjs"
      config:
        workspace: "$TMP/workspace"
        resultFile: "$TMP/runtime-$phase.json"
        hostChecks: false
        presetIds: [science, biomni]
EOF
  node "$ROOT/test/verify-runtime.mjs" "$TMP/runtime-$phase.json"
}

echo "== 1/4 standalone science copy / biomni link 安装 =="
install_preset install.sh copy
install_preset install-biomni.sh link
assert_install initial

echo "== 2/4 standalone 真实 preset 挂载、工具执行、workflow =="
verify_runtime initial

echo "== 3/4 重装，检查保留文件及层栈幂等性 =="
for id in science biomni; do
  echo preserved > "$DSH_HOME/local-bundles/dsh-science-preset-$id/keep-me.txt"
done
echo '// Obsolete install-only fixture.' > "$DSH_HOME/local-bundles/dsh-science-preset-science/engines/obsolete.mjs"
install_preset install.sh copy
install_preset install-biomni.sh link
assert_install reinstall

echo "== 4/4 重装后再次真实运行 =="
verify_runtime reinstall
echo "✔ standalone preset 安装与重装验证通过。"
