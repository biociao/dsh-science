#!/usr/bin/env bash
# 安装「Biomni 模式」agent preset 到 DSH 用户 preset 根目录（~/.dsh/.agent-presets，遵循 $DSH_HOME）。
# 用法：
#   bash scripts/install-biomni.sh           # 复制安装（默认，最稳妥）
#   bash scripts/install-biomni.sh link      # 符号链接安装（单点维护，仓库即真身）
# 说明：preset-biomni 目录内自带 engines/ 镜像（见 scripts/sync-engines.sh），相对路径
# 引用无需外部依赖。技能另装：bash scripts/install-skills.sh（自动包含 biomni-agent）。

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/preset-biomni"
DST_DIR="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
DST="$DST_DIR/biomni"
MODE="${1:-copy}"

[ -f "$SRC/agent.cordis.yml" ] || { echo "错误：找不到 $SRC/agent.cordis.yml" >&2; exit 1; }
[ -f "$SRC/engines/biomni-registry.mjs" ] || { echo "错误：缺少 $SRC/engines/（先运行 bash scripts/sync-engines.sh）" >&2; exit 1; }

mkdir -p "$DST_DIR"

if [ -e "$DST" ] || [ -L "$DST" ]; then
  echo "警告：已存在 ${DST}（重装前如需保留自定义，请先备份），正在移除"
  rm -rf "$DST"
fi

if [ "$MODE" = "link" ]; then
  ln -s "$SRC" "$DST"
  echo "已符号链接：$DST -> $SRC"
else
  cp -R "$SRC" "$DST"
  echo "已复制：$SRC -> $DST"
fi

echo ""
echo "✔ 安装完成。接下来："
echo "  1. 在 DSH Web 新建会话，选择「Biomni 模式」preset（或把默认 preset 设为 biomni）。"
echo "  2. 新会话中先 biomni_retrieve \`任务\` 做检索增强规划，再 biomni_plan_init 建计划（技能 biomni-agent）。"
echo "  3. 技能：bash scripts/install-skills.sh 装到 ~/.dsh/skills；或把 skills/ 放进项目 .dsh/skills。"
