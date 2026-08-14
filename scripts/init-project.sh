#!/usr/bin/env bash
# 初始化科研项目目录骨架（无需科学模式会话也能用）。
# 等价于在科学模式会话中调用 research_init，后者还会创建研究清单与 README。
# 用法：scripts/init-project.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT"/{experiments,literature,artifacts,analyses,figures,manuscript,reviews,data,envs}

# data/README.md —— 数据清单模板
if [ ! -f "$ROOT/data/README.md" ]; then
  cat > "$ROOT/data/README.md" <<'EOF'
# 数据清单（Data Inventory）

每份数据登记一行：id、类型、来源、下载命令、校验值、大小、授权、状态。
详见技能 data-inventory。

| id | 类型 | 来源 | 下载命令 | 校验值 | 大小 | 授权 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |
EOF
fi

# data/samples.csv —— 样本清单模板（分析唯一事实来源）
if [ ! -f "$ROOT/data/samples.csv" ]; then
  echo "sample_id,condition,batch,raw_path" > "$ROOT/data/samples.csv"
fi

# literature/references.bib —— 参考文献库
if [ ! -f "$ROOT/literature/references.bib" ]; then
  touch "$ROOT/literature/references.bib"
fi

echo "✔ 项目骨架已就绪：$ROOT"
echo "  目录：experiments/ literature/ artifacts/ analyses/ figures/ manuscript/ reviews/ data/ envs/"
echo "  下一步：在科学模式会话中调用 research_init 建立研究清单（research-manifest.json）。"
