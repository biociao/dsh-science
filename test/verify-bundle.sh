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
VERIFY_HOME="$TMP/home"          # 隔离的 DSH_HOME
PKG_REPO="$TMP/repo"            # 包的本机 git 仓库（供 git+file 安装）
trap 'if [ "${VERIFY_KEEP:-0}" != 1 ]; then rm -rf "$TMP"; else echo "保留验证目录: $TMP"; fi' EXIT

export DSH_HOME="$VERIFY_HOME"

echo "== 1/7 包结构检查 =="
[ -f "$ROOT/package.json" ] && [ -f "$ROOT/cordis.patch.yml" ] || { echo "缺少 package.json / cordis.patch.yml" >&2; exit 1; }
[ -f "$ROOT/engines/research-loop.mjs" ] && [ -f "$ROOT/engines/artifact-registry.mjs" ] && [ -f "$ROOT/engines/remote-compute.mjs" ] && [ -f "$ROOT/engines/remote-hosts-ui.mjs" ] && [ -f "$ROOT/engines/workbench.mjs" ] && [ -f "$ROOT/engines/workbench-ui.mjs" ] && [ -f "$ROOT/engines/roadmap.mjs" ] && [ -f "$ROOT/engines/roadmap-ui.mjs" ] && [ -f "$ROOT/engines/sidebar-ui.mjs" ] || { echo "缺少引擎" >&2; exit 1; }
[ -f "$ROOT/client/remote-hosts-ui/lib/client.js" ] || { echo "缺少 client bundle（先运行 node scripts/build-client-bundle.mjs）" >&2; exit 1; }
[ -f "$ROOT/packages/dsh-model-tier/engines/model-tier.mjs" ] && [ -f "$ROOT/packages/dsh-model-tier/cordis.patch.yml" ] || { echo "缺少配套包 packages/dsh-model-tier" >&2; exit 1; }

echo "== 2/7 pnpm pack（模拟 npm 发布物）=="
( cd "$ROOT" && pnpm pack --pack-destination "$TMP" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz | head -1)"
echo "   tarball: $TGZ"
tar -tzf "$TGZ" | grep -E "engines/(research-loop|artifact-registry|remote-compute|remote-hosts-ui)\.mjs|client/remote-hosts-ui/(lib|src)/|cordis\.patch\.yml|preset/agent\.cordis\.yml|skills/[^/]+/SKILL\.md" | head -10

echo "== 3/7 本机 git 仓库（供 git+file 依赖）=="
git init -q "$PKG_REPO"
tar -xzf "$TGZ" --strip-components=1 -C "$PKG_REPO"
# 配套路由包 dsh-model-tier 单独建仓（未发布 npm）。把验证副本里 dsh-science 对它的
# 依赖从 ^0.1.0 改写为 git+file —— pnpm 9 的 overrides 改不动 git 依赖的 transitive
# 依赖（已实测），只能在依赖声明处直接替换。真实发布的 package.json 保持 ^0.1.0 不变。
MODEL_REPO="$TMP/repo-model-tier"
git init -q "$MODEL_REPO"
cp -R "$ROOT"/packages/dsh-model-tier/* "$MODEL_REPO/"
git -C "$MODEL_REPO" add -A
git -C "$MODEL_REPO" -c user.name=verify -c user.email=verify@local commit -qm "verify"
python3 - "$PKG_REPO/package.json" "$MODEL_REPO" <<'PY'
import json, sys
p, mt = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d.setdefault("dependencies", {})["dsh-model-tier"] = f"git+file://{mt}"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
git -C "$PKG_REPO" add -A
git -C "$PKG_REPO" -c user.name=verify -c user.email=verify@local commit -qm "verify"

echo "== 4/7 隔离 profile 安装 bundle =="
mkdir -p "$VERIFY_HOME/profiles/web"
cat > "$VERIFY_HOME/cordis.patch.yml" <<'EOF'
# 验证专用：webserver 用 OS 分配端口，避免与运行中的 GUI(3080) 冲突。
# 注意：@deepseek-ai/dsh-host-webserver 的 Config 里 host 与 port **都是 required**
# （host ∈ {127.0.0.1, 0.0.0.0}），只覆盖 port 会让整个 plugin tree 加载失败：
#   plugin tree failed to load: … invalid config: $.host missing required value
# 而旧版脚本对此完全没有断言，于是「boot 失败」也会打印「全部验证通过」。
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
EOF
# dsh-model-tier 未发布 npm：预置 profile 清单（模板形态），plugin add 内的
# pnpm install 通过验证副本里的 git+file 依赖解析配套包（发布后预置可删，
# plugin add 会自动从 registry 拉取 ^0.1.0）。
cat > "$VERIFY_HOME/profiles/web/package.json" <<'EOF'
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
cat > "$VERIFY_HOME/profiles/web/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
# 验证副本的 dsh-science 以 git+file 依赖 dsh-model-tier（未发布 npm 的临时形态），
# 属 exotic subdep，需关闭供应链接收检查；发布 npm 后此开关可移除。
blockExoticSubdeps: false
EOF
# 注意：dsh 需为已验证版本（当前钉 0.2.0-rc.2，见 .github/workflows）；新版本可能改变
# plugin add / profile / webserver config 结构 —— 出现新结构时先修本脚本再升钉版。
# 不要吞掉 plugin add 的输出——失败时打印以便定位。
if ! ADD_OUT="$(dsh plugin --profile web add "git+file://$PKG_REPO" 2>&1)"; then
  echo "$ADD_OUT"; exit 1
fi
echo "$ADD_OUT" | grep -E "Packages|Done" || true
echo "$ADD_OUT" | tail -6
python3 - "$VERIFY_HOME/profiles/web/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
assert "dsh-science" in bundles, f"dsh-science 未入层栈: {bundles}"
print("   dsh-science 已加入 bundles 层栈 ✓")
PY
# 配套包经 dsh-science 的依赖安装并被 hoisted 到 profile 顶层 node_modules
node -e "const {createRequire}=require('module');const r=createRequire('$VERIFY_HOME/profiles/web/cordis.yml');console.log('   dsh-model-tier 可解析 ✓', r.resolve('dsh-model-tier/package.json'))"

echo "== 5/7 组合检查（--dump-config）=="
if ! OUT="$(dsh --profile web --dump-config 2>&1)"; then
  echo "$OUT"; exit 1
fi
for row in science-research-loop science-artifact-registry science-remote-compute science-remote-hosts-ui science-scientific-reviewer science-research-workbench science-workbench-ui science-roadmap science-roadmap-ui science-sidebar-ui biomni-registry biomni-retriever biomni-plan biomni-reflect model-tier model-tier-ui preset-science preset-biomni; do
  grep -q "$row" <<< "$OUT" && echo "   行 $row 已合入组合 ✓" || { echo "   行 $row 缺失 ✗"; exit 1; }
done

echo "== 6/7 agent preset 配置 schema 校验（真实 dsh schema）=="
# preset 挂载发生在「会话选中该 preset」时，引导日志与 --dump-config 都看不到它，
# 所以必须用真实 dsh 的插件 schema 逐行跑 config 校验（历史上 persona 的
# text→prefix 破坏就是这样漏过全部门禁的）。
PRESET_VALIDATE_REQUIRE=1 node "$ROOT/scripts/validate-presets.mjs"

echo "== 7/7 真实 preset 挂载、工具执行、workflow 和 HTTP 路由 =="
cp "$ROOT/test/runtime-probe.mjs" "$TMP/runtime-probe.mjs"
cat >> "$VERIFY_HOME/cordis.patch.yml" <<EOF
- id: science-scientific-reviewer
  config:
    enabled: false
- insert:
    - id: compatibility-probe
      name: "$TMP/runtime-probe.mjs"
      config:
        workspace: "$TMP/workspace"
        resultFile: "$TMP/runtime-result.json"
EOF
node "$ROOT/test/verify-runtime.mjs" "$TMP/runtime-result.json"

echo "✔ 全部验证通过。"
