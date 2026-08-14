#!/usr/bin/env bash
# 安装 dsh-science 的 10 个技能到用户技能根（~/.dsh/skills，遵循 $DSH_HOME）。
# 用法：
#   bash scripts/install-skills.sh            # 装到 ~/.dsh/skills（全机所有项目可用）
#   bash scripts/install-skills.sh workspace  # 装到当前项目 .dsh/skills
# 技能由 skill-filesystem 自动发现，无需重启会话（新会话生效）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-user}"

case "$MODE" in
  user)
    DST="${DSH_HOME:-$HOME/.dsh}/skills"
    ;;
  workspace)
    DST="$(pwd)/.dsh/skills"
    ;;
  *)
    echo "用法：bash scripts/install-skills.sh [user|workspace]" >&2
    exit 1
    ;;
esac

mkdir -p "$DST"
count=0
for d in "$ROOT"/skills/*/; do
  name="$(basename "$d")"
  if [ -f "$d/SKILL.md" ]; then
    rm -rf "$DST/$name"
    cp -R "$d" "$DST/$name"
    count=$((count + 1))
  fi
done

echo "✔ 已安装 $count 个技能到 $DST"
echo "  技能列表：research-loop / science-project-setup / artifact-provenance / scientific-reviewer /"
echo "  literature-connector / parallel-delegation / manuscript-writing / bioinformatics-toolkit /"
echo "  conda-environments / data-inventory"
