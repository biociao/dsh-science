#!/usr/bin/env bash
# 安装「科学模式」agent preset 到 DSH 用户 preset 根目录（~/.dsh/.agent-presets，遵循 $DSH_HOME）。
# 用法：
#   bash scripts/install.sh            # 复制安装（默认，最稳妥）
#   bash scripts/install.sh link       # 符号链接安装（单点维护，仓库即真身）
# 说明：preset 目录内自带 engines/ 镜像（见 sync-engines.sh），相对路径引用无需外部依赖。
# 技能另装：bash scripts/install-skills.sh

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/preset"
DST_DIR="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
DST="$DST_DIR/science"
MODE="${1:-copy}"

[ -f "$SRC/agent.cordis.yml" ] || { echo "错误：找不到 $SRC/agent.cordis.yml" >&2; exit 1; }
[ -f "$SRC/engines/research-loop.mjs" ] || { echo "错误：缺少 $SRC/engines/（先运行 bash scripts/sync-engines.sh）" >&2; exit 1; }

mkdir -p "$DST_DIR"

if [ -e "$DST" ] || [ -L "$DST" ]; then
  echo "警告：已存在 $DST，正在移除（重装前如需保留自定义，请先备份）"
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
echo "  1. 在 DSH Web 新建会话，选择「科学模式」preset（或把默认 preset 设为 science）。"
echo "  2. 新会话中调用 research_init 初始化你的科研项目（技能 research-loop / science-project-setup）。"
echo "  3. 技能：bash scripts/install-skills.sh 装到 ~/.dsh/skills；或把 skills/ 放进项目 .dsh/skills。"
