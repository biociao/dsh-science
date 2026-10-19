#!/usr/bin/env bash
# dsh-model-tier 独立 bundle 集成验证（目标 DSH 0.2.0-rc.2）。
# 在临时 DSH_HOME 的 web profile 安装本地包，复用仓库运行时探针注册内存 mock
# adapter，验证模型目录、prepareCall、imageRequestPricing、主请求/标题分档和
# HTTP 配置接口。无需用户凭据，不调用外部模型 API，也不启动 mock HTTP 服务器。
# 依赖：Node 22、dsh；首次安装 profile 依赖需要访问包注册表。
# 用法：bash packages/dsh-model-tier/scripts/test-model-tier.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
TMP="$(mktemp -d /tmp/dsh-model-tier-verify-XXXXXX)"
VERIFY_HOME="$TMP/home"
VERIFY_PROFILE="$VERIFY_HOME/profiles/web"
trap 'if [ "${VERIFY_KEEP:-0}" != 1 ]; then rm -rf "$TMP"; else echo "保留验证目录: $TMP"; fi' EXIT
export DSH_HOME="$VERIFY_HOME"

[ -f "$ROOT/package.json" ] && [ -f "$ROOT/cordis.patch.yml" ] || {
  echo "缺少 dsh-model-tier bundle 文件" >&2; exit 1;
}
[ -f "$REPO_ROOT/test/runtime-probe.mjs" ] && [ -f "$REPO_ROOT/test/verify-runtime.mjs" ] || {
  echo "缺少仓库运行时探针，请从 dsh-science checkout 运行" >&2; exit 1;
}

echo "== 1/3 准备隔离 web profile =="
mkdir -p "$VERIFY_PROFILE"
cat > "$VERIFY_PROFILE/package.json" <<'EOF'
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
cat > "$VERIFY_PROFILE/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF
cat > "$VERIFY_HOME/cordis.patch.yml" <<'EOF'
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
EOF

echo "== 2/3 安装独立 dsh-model-tier bundle =="
if ! ADD_OUT="$(dsh plugin --profile web add "$ROOT" 2>&1)"; then
  echo "$ADD_OUT"; exit 1
fi
echo "$ADD_OUT" | tail -6
node --input-type=module - "$VERIFY_PROFILE/package.json" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(pkg.dsh.profile.bundles.includes('dsh-model-tier'), 'dsh-model-tier 未入 bundle 层栈');
assert(!pkg.dsh.profile.bundles.includes('dsh-science'), '此检查只安装独立模型分档 bundle');
console.log('  ✔ 独立 dsh-model-tier bundle 已注册');
JS

echo "== 3/3 真实 DSH 运行时接口与本地 mock 路由 =="
cp "$REPO_ROOT/test/runtime-probe.mjs" "$TMP/runtime-probe.mjs"
cat >> "$VERIFY_HOME/cordis.patch.yml" <<EOF
- insert:
    - id: model-tier-compatibility-probe
      name: "$TMP/runtime-probe.mjs"
      config:
        workspace: "$TMP/workspace"
        resultFile: "$TMP/runtime-result.json"
        presetIds: []
        httpEndpoints: ['/dsh-model-tier/config']
EOF
node "$REPO_ROOT/test/verify-runtime.mjs" "$TMP/runtime-result.json"
echo "✔ 独立 dsh-model-tier bundle 集成验证通过。"
