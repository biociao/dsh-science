#!/usr/bin/env bash
# 把 engines/ 的引擎源镜像到 preset/engines/（science）与 preset-biomni/engines/（biomni）。
# agent-preset 形态需要引擎在 preset 目录内，因为 preset 挂载按预设目录解析相对路径。
# 用法：bash scripts/sync-engines.sh   （修改 engines/ 后运行；提交前请保持两份一致）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engines"

# ── science preset ──
SCI_DST="$ROOT/preset/engines"
SCI_FILES=(core.mjs research-loop.mjs artifact-registry.mjs remote-compute.mjs workbench.mjs)

# ── biomni preset ──
BIO_DST="$ROOT/preset-biomni/engines"
BIO_FILES=(core.mjs biomni-registry.mjs biomni-retriever.mjs biomni-plan.mjs biomni-reflect.mjs)

mirror() {
  local dst="$1"; shift
  local files=("$@")
  mkdir -p "$dst"
  for f in "${files[@]}"; do
    [ -f "$SRC/$f" ] || { echo "错误：缺少 $SRC/$f" >&2; exit 1; }
    cp "$SRC/$f" "$dst/$f"
  done
  # 校验一致
  for f in "${files[@]}"; do
    a=$(shasum -a 256 "$SRC/$f" | awk '{print $1}')
    b=$(shasum -a 256 "$dst/$f" | awk '{print $1}')
    [ "$a" = "$b" ] || { echo "错误：$f 同步后不一致" >&2; exit 1; }
  done
}

mirror "$SCI_DST" "${SCI_FILES[@]}"
echo "✔ engines/ 已镜像到 preset/engines/（${#SCI_FILES[@]} 个，SHA-256 一致）"

mirror "$BIO_DST" "${BIO_FILES[@]}"
echo "✔ engines/ 已镜像到 preset-biomni/engines/（${#BIO_FILES[@]} 个，SHA-256 一致）"
