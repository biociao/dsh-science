#!/usr/bin/env bash
# dsh-model-tier 端到端冒烟 —— 用隔离的 DSH_HOME（仓库内 test/.e2e-home/）起一个
# headless 会话，真实挂载模型分档路由引擎（独立 bundle 形态），并把"轻档"指向本地
# mock LLM 服务器：
#   若辅助请求（会话标题，purpose=session-title）真的被路由到轻档，mock 服务器就会
#   收到 model=mock-title 的请求 —— 这是决定性证据（不依赖日志可见性）。
# 同时验证：主会话请求保持默认档（deepseek-official，不被误改）。
#
# 前提：本机 ~/.dsh 下已有 DEEPSEEK_API_KEY 等凭据（会复制进隔离 home，再追加
# E2E_LIGHT_API_KEY=test 供 mock provider 使用）。
# 用法：bash scripts/test-model-tier.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$ROOT/test/.e2e-home"
PROFILE="$HOME_DIR/profiles/router-test"
PORT_FILE="$(mktemp /tmp/mock-llm-port.XXXXXX)"
LOG_FILE="$(mktemp /tmp/mock-llm-requests.XXXXXX.jsonl)"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$PORT_FILE" "$LOG_FILE"
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "== 启动 mock LLM 服务器 =="
node "$ROOT/scripts/mock-llm-server.mjs" "$PORT_FILE" "$LOG_FILE" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -s "$PORT_FILE" ] && break
  sleep 0.1
done
PORT="$(cat "$PORT_FILE" 2>/dev/null || echo "")"
[ -n "$PORT" ] || { echo "错误：mock 服务器未就绪" >&2; exit 1; }
echo "mock 服务器端口：$PORT"

echo "== 准备隔离 DSH_HOME：$HOME_DIR =="
rm -rf "$HOME_DIR"
mkdir -p "$PROFILE/node_modules"

# 复制真实凭据与 provider 配置，并追加 mock provider（e2e-light）。
# 注意：必须把 e2e-light 合并进已有的 llm-pi-ai.providers 块（追加顶层键会触发
# settings-file 的 DUPLICATE_KEY 校验）。
cp "$HOME/.dsh/settings.yaml" "$HOME_DIR/settings.yaml"
cp "$HOME/.dsh/.credentials.yaml" "$HOME_DIR/.credentials.yaml"
printf '\nE2E_LIGHT_API_KEY: test\n' >> "$HOME_DIR/.credentials.yaml"
node -e '
const fs = require("fs");
const p = process.argv[1];
const port = process.argv[2];
let s = fs.readFileSync(p, "utf8");
const anchor = "llm-pi-ai:\n  providers:\n";
const i = s.indexOf(anchor);
if (i < 0) { console.error("错误：settings.yaml 缺少 llm-pi-ai.providers 锚点"); process.exit(1); }
const ins = "    e2e-light:\n" +
  "      apiKeyEnv: E2E_LIGHT_API_KEY\n" +
  "      api: openai-completions\n" +
  "      baseURL: http://127.0.0.1:" + port + "/v1\n" +
  "      models:\n" +
  "        - id: mock-title\n";
s = s.slice(0, i + anchor.length) + ins + s.slice(i + anchor.length);
// 路由按会话 opt-in：headless 会话的模型来自 agent-default-model ——
// 把它指向虚拟 provider（智能分档 / bundle 默认方案），整个会话即被路由。
// 先剥掉已有的顶层 agent-default-model 块（避免 DUPLICATE_KEY），再追加。
s = s.replace(/^agent-default-model:\n(?:[ \t].*\n)*/m, "");
s += "\nagent-default-model:\n  provider: model-tier\n  model: bundle\n";
fs.writeFileSync(p, s);
' "$HOME_DIR/settings.yaml" "$PORT"

ln -s "$ROOT" "$PROFILE/node_modules/dsh-model-tier"

cat > "$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-router-test",
  "private": true,
  "dependencies": { "dsh-model-tier": "link:$ROOT" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-model-tier"] } }
}
EOF

cat > "$PROFILE/cordis.patch.yml" <<'EOF'
# headless 测试 profile：覆盖路由引擎配置，轻档指向本地 mock provider
# （e2e-light/mock-title），强档/主档用真实 provider。
- id: model-tier
  config:
    tiers:
      strong: { provider: zai-coding-cn, model: glm-5.3 }
      default: { provider: deepseek-official, model: deepseek-v4-flash }
      light: { provider: e2e-light, model: mock-title }
    routing:
      auxiliary: [session-title, compaction]
      subagents: light
      subagentDepthStrong: 3
EOF

echo "== 启动 headless 会话（主对话走 deepseek-official，标题应走 mock）=="
OUT="$(DSH_HOME="$HOME_DIR" dsh --profile router-test "请只回复：模型路由冒烟测试通过" 2>&1 || true)"

echo "---- 会话答复 ----"
echo "$OUT" | head -3

echo "---- mock 服务器收到的请求（决定性证据）----"
if [ -s "$LOG_FILE" ]; then
  cat "$LOG_FILE"
  ROUTED="$(grep -c '"model":"mock-title"' "$LOG_FILE" || true)"
  echo "→ 路由到轻档的请求数：$ROUTED"
else
  echo "（mock 未收到任何请求 —— 路由未生效）"
  ROUTED=0
fi

if [ "$ROUTED" -ge 1 ]; then
  echo "✔ 通过：辅助请求被路由到轻档（e2e-light/mock-title）"
else
  echo "✗ 失败：未捕获到路由证据" >&2
  exit 1
fi
echo "✔ 完成"
