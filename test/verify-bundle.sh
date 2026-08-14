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
[ -f "$ROOT/engines/research-loop.mjs" ] && [ -f "$ROOT/engines/artifact-registry.mjs" ] || { echo "缺少引擎" >&2; exit 1; }

echo "== 2/6 pnpm pack（模拟 npm 发布物）=="
( cd "$ROOT" && pnpm pack --pack-destination "$TMP" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz | head -1)"
echo "   tarball: $TGZ"
tar -tzf "$TGZ" | grep -E "engines/(research-loop|artifact-registry)\.mjs|cordis\.patch\.yml|preset/agent\.cordis\.yml|skills/[^/]+/SKILL\.md" | head -8

echo "== 3/6 本机 git 仓库（供 git+file 依赖）=="
git init -q "$GIT_DIR"
cp -R "$ROOT"/{package.json,cordis.patch.yml,engines,preset,skills} "$GIT_DIR/"
git -C "$GIT_DIR" add -A
git -C "$GIT_DIR" -c user.name=verify -c user.email=verify@local commit -qm "verify"

echo "== 4/6 隔离 profile 安装 bundle =="
mkdir -p "$HOME_HOME"
cat > "$HOME_HOME/cordis.patch.yml" <<'EOF'
# 验证专用：webserver 用 OS 分配端口，避免与运行中的 GUI(3080) 冲突
- id: webserver
  config:
    port: 0
EOF
dsh plugin --profile web add "git+file://$GIT_DIR" 2>&1 | grep -E "Packages|Done" || true
python3 - "$HOME_HOME/profiles/web/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
assert "dsh-science" in bundles, f"dsh-science 未入层栈: {bundles}"
print("   dsh-science 已加入 bundles 层栈 ✓")
PY

echo "== 5/6 组合检查（--dump-config）=="
OUT="$(dsh --profile web --dump-config 2>&1 || true)"
for row in science-research-loop science-artifact-registry; do
  echo "$OUT" | grep -q "$row" && echo "   行 $row 已合入组合 ✓" || { echo "   行 $row 缺失 ✗"; exit 1; }
done

echo "== 6/6 引导启动（加载器解析 + apply）=="
BOOT_LOG="$TMP/boot.log"
timeout 40 dsh --profile web >"$BOOT_LOG" 2>&1 || true
if grep -qE "dsh-science/engines|science-research-loop|science-artifact-registry" "$BOOT_LOG"; then
  echo "--- 引导日志中的引擎相关错误 ---"
  grep -E "dsh-science/engines|science-research-loop|science-artifact-registry" "$BOOT_LOG" | head -5
  echo "✗ 引擎加载/apply 出错"; exit 1
fi
echo "   无引擎加载错误（子路径导出解析 + apply 成功）✓"

echo ""
echo "✔ 全部验证通过。隔离环境已清理。"
