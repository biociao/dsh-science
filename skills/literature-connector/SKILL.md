---
name: literature-connector
description: 文献连接器（对应 Claude Science 的 Literature access / connectors）：检索文献、提取要点、维护 literature/ 笔记库与 references.bib，写作时按规范引用。做文献调研或引用文献时使用。
whenToUse: 文献调研、背景写作、方法选择、查证某个说法是否有文献支持时。
---

# 文献连接器（Literature Connector）

把"检索 → 精读 → 笔记 → 引用"组织成可追溯的文献库，所有引用可回溯到来源。

## 检索协议

1. 明确检索问题 → 拆成 2-4 个检索式（关键词 + 组合，如 `"antimicrobial resistance" AND "WGS" AND outbreak`）。
2. 用 `web_search` 检索；优先权威来源：PubMed / bioRxiv / Nature 系 / 期刊官网 / 预印本。
3. 每次检索记录到 `literature/search-log.md`：日期、检索式、引擎、命中数、采用的条目。
4. 对关键文献抓取摘要/全文要点（`web_search` 返回摘要或抓取页面文本）。

## 精读与笔记

每篇纳入文献在 `literature/notes/<author>-<year>-<topic>.md` 写笔记：

```markdown
# 作者 年份 主题
- 来源：<URL / DOI>
- 核心问题：
- 方法（一句）：
- 关键结果（数字）：
- 局限：
- 对本项目的意义：
- 相关假设：H?（若相关）
```

## 参考文献库

- 统一维护 `literature/references.bib`（BibTeX）。新文献用下列模板追加：

```bibtex
@article{key2024,
  author  = {Last, First and Other, Author},
  title   = {Title},
  journal = {Journal},
  year    = {2024},
  volume  = {1},
  pages   = {1--10},
  doi     = {10.xxxx/xxxx}
}
```

- 无法获得完整元数据时记 `note = {unverified metadata}`，宁缺毋滥。
- 论文撰写时用 citation key 引用（如 `\cite{key2024}`），确保 key 全局唯一。

## 引用纪律

- 论断必须能回溯到具体文献；不确定时写"据我们检索，尚未见…"。
- 区分原始研究 vs 综述 vs 预印本；预印本标注 `preprint`。
- 综述性主张（"已有多项研究表明…"）要能列出至少 2-3 篇具体文献。
- 每月/每轮循环结束可跑一次检索补漏（同主题关键词 + 引用网络）。
