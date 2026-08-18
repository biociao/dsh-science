#!/usr/bin/env bash
# dsh-science 端到端验证：把发布包当作社区 bundle 安装到隔离 profile 并引导启动，
# 确认引擎行合入组合、子路径导出可被加载器解析、apply 不报错。
#
# 用法：bash test/verify-bundle.sh
# 依赖：dsh（PATH 上）、pnpm、git、网络（首次会拉取 web profile 模板依赖）。
# 说明：用 git+file 依赖安装以绕过 pnpm 对未发布 registry 包的供应链接收检查
#       （真实发布到 npm 后可直接 dsh plugin add dsh-science）。
#       用 $DSH_HOME/cordis.patch.yml 把 webserver 端口改为 0（OS 分配），
#       避免与正在运行的 Web GUI（127.0.0.1:3080）冲突。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/dsh-science-verify-XXXXXX)"
HOME_HOME="$TMP/home"          # 隔离的 DSH_HOME
GIT_DIR="$TMP/repo"            # 包的本机 git 仓库（供 git+file 安装）
trap 'rm -rf "$TMP"' EXIT

export DSH_HOME="$HOME_HOME"

echo "== 1/6 包结构检查 =="
[ -f "$ROOT/package.json" ] && [ -f "$ROOT/cordis.patch.yml" ] || { echo "缺少 package.json / cordis.patch.yml" >&2; exit 1; }
[ -f "$ROOT/engines/research-loop.mjs" ] && [ -f "$ROOT/engines/artifact-registry.mjs" ] && [ -f "$ROOT/engines/remote-compute.mjs" ] && [ -f "$ROOT/engines/remote-hosts-ui.mjs" ] || { echo "缺少引擎" >&2; exit 1; }
[ -f "$ROOT/client/remote-hosts-ui/lib/client.js" ] || { echo "缺少 client bundle（先运行 node scripts/build-client-bundle.mjs）" >&2; exit 1; }
[ -f "$ROOT/packages/dsh-model-tier/engines/model-tier.mjs" ] && [ -f "$ROOT/packages/dsh-model-tier/cordis.patch.yml" ] || { echo "缺少配套包 packages/dsh-model-tier" >&2; exit 1; }

echo "== 2/6 pnpm pack（模拟 npm 发布物）=="
( cd "$ROOT" && pnpm pack --pack-destination "$TMP" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz | head -1)"
echo "   tarball: $TGZ"
tar -tzf "$TGZ" | grep -E "engines/(research-loop|artifact-registry|remote-compute|remote-hosts-ui)\.mjs|client/remote-hosts-ui/(lib|src)/|cordis\.patch\.yml|preset/agent\.cordis\.yml|skills/[^/]+/SKILL\.md" | head -10

echo "== 3/6 本机 git 仓库（供 git+file 依赖）=="
git init -q "$GIT_DIR"
cp -R "$ROOT"/{package.json,cordis.patch.yml,engines,preset,skills,client} "$GIT_DIR/"
# 配套路由包 dsh-model-tier 单独建仓（未发布 npm）。把验证副本里 dsh-science 对它的
# 依赖从 ^0.1.0 改写为 git+file —— pnpm 9 的 overrides 改不动 git 依赖的 transitive
# 依赖（已实测），只能在依赖声明处直接替换。真实发布的 package.json 保持 ^0.1.0 不变。
GIT_DIR_MT="$TMP/repo-model-tier"
git init -q "$GIT_DIR_MT"
cp -R "$ROOT"/packages/dsh-model-tier/* "$GIT_DIR_MT/"
git -C "$GIT_DIR_MT" add -A
git -C "$GIT_DIR_MT" -c user.name=verify -c user.email=verify@local commit -qm "verify"
python3 - "$GIT_DIR/package.json" "$GIT_DIR_MT" <<'PY'
import json, sys
p, mt = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d.setdefault("dependencies", {})["dsh-model-tier"] = f"git+file://{mt}"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
git -C "$GIT_DIR" add -A
git -C "$GIT_DIR" -c user.name=verify -c user.email=verify@local commit -qm "verify"

echo "== 4/6 隔离 profile 安装 bundle =="
mkdir -p "$HOME_HOME/profiles/web"
cat > "$HOME_HOME/cordis.patch.yml" <<'EOF'
# 验证专用：webserver 用 OS 分配端口，避免与运行中的 GUI(3080) 冲突
- id: webserver
  config:
    port: 0
EOF
# dsh-model-tier 未发布 npm：预置 profile 清单（模板形态），plugin add 内的
# pnpm install 通过验证副本里的 git+file 依赖解析配套包（发布后预置可删，
# plugin add 会自动从 registry 拉取 ^0.1.0）。
cat > "$HOME_HOME/profiles/web/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
EOF
cat > "$HOME_HOME/profiles/web/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
# 验证副本的 dsh-science 以 git+file 依赖 dsh-model-tier（未发布 npm 的临时形态），
# 属 exotic subdep，需关闭供应链接收检查；发布 npm 后此开关可移除。
blockExoticSubdeps: false
EOF
# 注意：dsh 需为已验证版本（0.1.0-rc.6）；新版本可能改变 plugin add / profile 结构。
# 不要吞掉 plugin add 的输出——失败时打印以便定位。
ADD_OUT="$(dsh plugin --profile web add "git+file://$GIT_DIR" 2>&1 || true)"
echo "$ADD_OUT" | grep -E "Packages|Done" || true
echo "$ADD_OUT" | tail -6
python3 - "$HOME_HOME/profiles/web/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
assert "dsh-science" in bundles, f"dsh-science 未入层栈: {bundles}"
print("   dsh-science 已加入 bundles 层栈 ✓")
PY
# 配套包经 dsh-science 的依赖安装并被 hoisted 到 profile 顶层 node_modules
node -e "const {createRequire}=require('module');const r=createRequire('$HOME_HOME/profiles/web/cordis.yml');console.log('   dsh-model-tier 可解析 ✓', r.resolve('dsh-model-tier/package.json'))"

echo "== 5/6 组合检查（--dump-config）=="
OUT="$(dsh --profile web --dump-config 2>&1 || true)"
for row in science-research-loop science-artifact-registry science-remote-compute science-remote-hosts-ui model-tier model-tier-ui; do
  echo "$OUT" | grep -q "$row" && echo "   行 $row 已合入组合 ✓" || { echo "   行 $row 缺失 ✗"; exit 1; }
done

echo "== 6/6 引导启动（加载器解析 + apply + client bundle 扫描）=="
BOOT_LOG="$TMP/boot.log"
timeout 40 dsh --profile web >"$BOOT_LOG" 2>&1 || true
if grep -qE "dsh-science/engines|science-research-loop|science-artifact-registry|science-remote-compute|science-remote-hosts-ui" "$BOOT_LOG"; then
  echo "--- 引导日志中的引擎相关错误 ---"
  grep -E "dsh-science/engines|science-research-loop|science-artifact-registry|science-remote-compute|science-remote-hosts-ui" "$BOOT_LOG" | head -5
  echo "✗ 引擎加载/apply 出错"; exit 1
fi
if grep -qE "client-modules:.*dsh-science|MissingClientBundle|declares dsh.client but exports no" "$BOOT_LOG"; then
  echo "--- 引导日志中的 client-modules 错误 ---"
  grep -E "client-modules:.*dsh-science|MissingClientBundle|declares dsh.client but exports no" "$BOOT_LOG" | head -5
  echo "✗ client bundle 扫描/加载出错"; exit 1
fi
echo "   无引擎加载错误 + client bundle 扫描正常 ✓"

echo ""
echo "✔ 全部验证通过。隔离环境已清理。"
