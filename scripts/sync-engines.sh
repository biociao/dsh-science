#!/usr/bin/env bash
# 把 engines/ 的引擎源镜像到 preset/engines/（agent-preset 形态需要引擎在 preset 目录内，
# 因为 preset 挂载按 preset 目录解析相对路径）。
# 用法：bash scripts/sync-engines.sh   （修改 engines/ 后运行；提交前请保持两份一致）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/engines"
DST="$ROOT/preset/engines"

mkdir -p "$DST"
for f in core.mjs research-loop.mjs artifact-registry.mjs; do
  [ -f "$SRC/$f" ] || { echo "错误：缺少 $SRC/$f" >&2; exit 1; }
  cp "$SRC/$f" "$DST/$f"
done

# 校验一致
for f in core.mjs research-loop.mjs artifact-registry.mjs; do
  a=$(shasum -a 256 "$SRC/$f" | awk '{print $1}')
  b=$(shasum -a 256 "$DST/$f" | awk '{print $1}')
  [ "$a" = "$b" ] || { echo "错误：$f 同步后不一致" >&2; exit 1; }
done

echo "✔ engines/ 已镜像到 preset/engines/（SHA-256 一致）"
