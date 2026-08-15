# dsh-science 维护与开发指南 —— 当前局限性与开发方向

> 面向仓库维护者。基于 v0.1.0 源码逐项核对（含代码行号引用），
> 按优先级（P0 正确性 → P1 数据质量/工件 → P2 架构/产品/工程化）给出开发路线图。

## 一、当前局限性

### A. 状态一致性与并发（最严重）

1. **共享状态文件无并发保护。** `research-manifest.json` 与 `artifacts/artifacts.json`
   都是"读-改-写"（`saveManifest` research-loop.mjs L92-108；`readJson`/`writeJson`
   artifact-registry.mjs L111-124），无文件锁、无原子 rename、无版本号。
   `parallel-delegation` 技能又恰恰鼓励并行 subagent——并行轨道同时调用
   `research_*` / `artifact_save` 会发生丢失更新（lost update）或半截 JSON。
   目前只能靠"清单更新回主会话串行"的纪律规避，引擎本身不防。
2. **manifest.artifacts 是死字段。** `research-manifest.json` 初始化了
   `artifacts: []`（research-loop.mjs L151），但全文件**只读不写**（仅 L180 仪表盘
   取 length），因此仪表盘"工件（0）"恒为 0；真实的工件索引在
   `artifacts/artifacts.json`（artifact-registry.mjs L265-282）。两套索引不打通：
   循环仪表盘看不到工件，工件也关联不到假设/实验/评审。
3. **ID 分配与 iteration 语义不一致。** 假设 `H{length+1}`（L340）、实验
   `E{length+1}`（L386）、评审 `R{length+1}`（L536）都基于数组长度，删除或并发会
   碰撞/跳号；`m.loop.iteration` 一处被赋值为 `experiments.length`（L422）、另一处
   是 `+1`（L476），同一字段两种语义。
4. **写入非原子。** `saveManifest` 直接 `writeFile`，进程中断会留下损坏的 JSON。

### B. 校验与数据质量

5. **`research_review.verdict` 无枚举校验**（L525 是裸 string；对比 hypothesis
   status、findings conclusion、phase 都有 `enum`）。
6. **假设状态无转移约束**：`proposed` 可直跳 `supported`，不经 `testing`/实验，状态机形同虚设。
7. **循环阶段可任意跳转**：`literature` 可直跳 `concluded`；进入 `manuscript` 无"证据
   充分性"门槛（只有技能文档里的纪律）。
8. **允许空核心问题**跑循环；问题更新只能借道 hypothesis/findings 参数，无
   `research_question` 工具。
9. **评审与假设/实验无联动**：评审结论不自动回写假设状态或实验状态。

### C. 工件系统

10. **全文件哈希整读入内存**：`sha256File` 用 `readFile`（artifact-registry.mjs
    L90-93），对多 GB 测序数据会爆内存/极慢；无流式、无进度、无大小上限。
11. **全量复制、无去重**：v2 与 v1 完全相同也会整份重拷（`fsp.cp` L217/224），无
    hardlink/增量/相同跳过；生信场景成本高。
12. **无版本差异/废弃/校验工具**：没有 `artifact_diff`（对比 v1/v2）、没有
    `artifact_deprecate`（append-only 是特性，但无法在索引标记废弃）、没有
    `artifact_verify`（重算 SHA-256 对比记录）。
13. **溯源信息不足**：environment 只记 platform/arch/node 版本（L237），不含 conda
    env 哈希/包清单；inputs 只记路径不记哈希；`artifact_reproduce` 只输出文字指引，
    不真正校验可复现性。

### D. 引擎实现与架构

14. **双引擎大量重复代码**：`resolveCwd` / `findProjectRoot` / `makeTool` /
    `requireStr` / `optStr` / `asList` 在两个引擎各拷一份；零依赖约束下仍可抽
    `engines/core.mjs` 共享。
15. **工具输出恒为字符串**：`makeTool` 的 `output.schema` 固定 `{type:"string"}`
    （research-loop.mjs L219-221），无结构化 JSON 输出；模型只能解析文本，Web UI
    也无法用卡片渲染结构化状态。
16. **manifest 无 schema 迁移机制**：`schema: 1` 硬编码（L132），未来加字段没有
    migration runner，旧清单会静默缺字段。
17. **错误处理弱**：所有异常被吞成 `错误：{msg}` 字符串（L228），无错误码/类型，
    模型无法程序化区分"参数错 / 状态错 / IO 错"。
18. **无操作日志/审计**：只有 manifest.history（截断 400 字符/条、上限 1000 条），
    无项目级审计日志。
19. **`research_state detail=true` 全量 JSON 入上下文**（L313），无分页/裁剪参数，
    长项目会撑爆上下文。
20. **工具描述与行为不符**：`research_experiment` 描述称"返回…下一步建议"
    （L361），实际只返回 dashboard，无建议。
21. **无项目导入/导出**：跨机迁移只能整目录拷贝，无 `research_export` 报告工具。

### E. 技能与产品面

22. **技能是纯文档**：10 个技能全部是 SKILL.md，无可执行模板/脚本——literature-
    connector 无 fetch+bib 工具链、manuscript-writing 无草稿骨架生成器、
    bioinformatics-toolkit 无真实流水线模板。指导性强、落地弱。
23. **无 CLI**：只有 `init-project.sh` 骨架脚本，没有 `dsh-science` 命令行
    （init/status/export/reproduce）。
24. **无 git 集成**：不自动提交 manifest/工件，无 .gitignore 模板钩子。
25. **多项目/嵌套项目边界**：marker 探测取最近 `.dsh/.git`（research-loop.mjs
    L65-79），嵌套仓库会误判；单 manifest/项目根，无项目名隔离。
26. **领域绑定生信**：目录约定/技能/示例都面向基因组-病原体，其它科研领域复用成本高。
27. **安装脚本 POSIX-only**：install.sh / sync-engines.sh / verify-bundle.sh 都是
    bash；preset 虽已处理 win32 的 bash/pwsh 工具切换，但安装侧没有 Windows 路径。

### F. 测试与发布

28. **测试未挂真实运行时**：smoke-test 用假 `exec` 对象直调工具（L26）；verify-bundle
    只验证"组合合入 + apply 不报错"（test/verify-bundle.sh 6/6），没有真实 agent
    会话端到端跑循环。
29. **无并发/大文件/快照测试**；23 项断言偏"路径存在/字符串包含"。
30. **发布未自动化**：v0.1.0 无 CI（GitHub Actions）、无 semantic-release；hub 收录
    还是申请草稿（docs/hub-application.md）。
31. **dsh 版本兼容未锁定**：只在 dsh 0.1.0-rc.6 验证过，无 peerDependencies/
    engines 声明对 dsh 的约束；dsh API 演进（tools 注册、exec 结构）无兼容测试。

## 二、开发方向（按优先级）

### P0 —— 正确性与并发（先修，小改动大收益）

| # | 方向 | 要点 |
|---|------|------|
| 1 | 状态文件原子写 + 轻量锁 | `saveManifest`/`writeJson` 改 tmp+rename；`O_EXCL` lockfile + 超时/陈旧检测（零依赖可行）；或清单乐观版本号 + 冲突报错 |
| 2 | 打通 manifest ↔ artifacts | `research_state` 读时合并 `artifacts/artifacts.json` 展示（零迁移成本）；`artifact_save` 增加 `experiment`/`hypothesis` 关联参数并回写 manifest |
| 3 | ID/iteration 语义统一 + schema 迁移 | id 从"最大现有 id + 1"推导而非 length；iteration 语义二选一并文档化；加 `schema: 2` 与 migration runner（向后兼容 schema:1） |

### P1 —— 数据质量与校验

| # | 方向 | 要点 |
|---|------|------|
| 4 | 结构化工具输出 | `makeTool` 支持 JSON output（`output.schema` 可配对象），新增 `research_report` 返回结构化状态；文本渲染保留兼容 |
| 5 | 校验补齐 | verdict 枚举；假设状态机（proposed→testing→supported/refuted）；阶段跳转 guard（可选配置）；空问题警告/开关 |
| 6 | 错误码化 | 统一错误前缀 `ERR_NOT_INIT / ERR_NOT_FOUND / ERR_VALIDATION / ERR_IO`，模型可程序化分支 |

### P1 —— 工件系统升级

| # | 方向 | 要点 |
|---|------|------|
| 7 | 流式哈希与大文件支持 | `createReadStream` 哈希 + 进度回调 + 文件大小配额（默认值 + 可配置） |
| 8 | 版本智能 | 先哈希再决定是否拷贝（相同跳过）；可选 hardlink；新增 `artifact_diff`（v1/v2 文件与哈希对比） |
| 9 | 可复现性闭环 | `artifact_verify`（重算哈希对比）；`artifact_deprecate`；溯源增强：`envFile` 参数自动记录 conda env 导出摘要、inputs 记录哈希 |

### P2 —— 引擎架构与工具补全

| # | 方向 | 要点 |
|---|------|------|
| 10 | 抽 `engines/core.mjs` | 共享 resolve/makeTool/校验/锁（零依赖不变，同步 smoke-test 的镜像一致性检查） |
| 11 | 工具补全 | `research_question` / `research_export`（Markdown 项目报告）/ `research_timeline` / 实验状态更新（planned→running→concluded 显式工具） |
| 12 | 审计日志 | 项目 `.dsh/science.log`（NDJSON，追加式），与 manifest.history 互补 |

### P2 —— 技能落地与产品化

| # | 方向 | 要点 |
|---|------|------|
| 13 | 技能可执行化 | literature-connector 附 bib 维护脚本；manuscript-writing 附草稿骨架生成器；bioinformatics-toolkit 附真实流水线模板（fastp/kraken2/AMRFinder） |
| 14 | CLI | 单文件 Node CLI：`dsh-science init|status|export|reproduce`，复用引擎模块 |
| 15 | git 集成 | `.gitignore` 模板、可选手动 `research_commit`（提交 manifest+工件+日志） |
| 16 | 领域解耦 | 目录约定/示例抽成 domain pack（life-science 默认，其它领域可换） |

### P2 —— 工程化与发布

| # | 方向 | 要点 |
|---|------|------|
| 17 | 真实 dsh 集成测试 | verify-bundle 扩展：隔离 profile 里起真实会话，跑一遍 research_init→…→artifact_save 断言落盘 |
| 18 | 测试矩阵 | 并发写入测试（并行 artifact_save）、大文件（>1GB 流式）、manifest 快照测试 |
| 19 | CI + 自动发版 | GitHub Actions：PR 跑 smoke+verify；main 打 tag 触发 semantic-release → npm publish |
| 20 | 兼容与社区 | 声明 dsh peer 范围；工具描述英文化（面向 hub/awesome 社区）；提交 hub 收录 |

## 三、建议的落地顺序

```
P0（并发安全 + manifest↔artifacts 打通 + 迁移机制）     → v0.1.1 ✅
P1（结构化输出 + 校验 + 工件流式/差异/校验）            → v0.1.1 ✅
P2（core 抽取 + 工具补全 + 技能可执行化 + CLI）         → v0.2.0（新功能版本）
工程化（CI/集成测试/自动发版/hub 收录）                 → 全程穿插
```

## 四、v0.1.1 修复记录（鲁棒性更新，已落地）

| 类别 | 修复内容 | 落点 |
|------|----------|------|
| A 并发一致性 | 全部状态写操作经 `withFileLock`（O_EXCL + 陈旧回收 + 超时）串行；`writeFileAtomic`（tmp+rename）保证读方永不见半截 JSON | `engines/core.mjs` |
| A 并发一致性 | ID 改为 `nextSeqId`（最大编号+1），并发/删除不再碰撞；`loop.iteration` 统一为"已完成轮次"（仅 nextQuestion 递增） | `engines/research-loop.mjs` |
| A 并发一致性 | manifest schema 升级到 2，v1→v2 迁移（加载时迁移、下次写入持久化、向后兼容） | `engines/research-loop.mjs` |
| A 打通 | `research_state` 实时合并 `artifacts/artifacts.json`（仪表盘不再恒为 0）；`artifact_save` 尽力回写 manifest.artifacts（共用同一 manifest 锁） | 两个引擎 |
| B 校验 | 假设状态机 proposed→testing→supported/refuted/inconclusive（初始状态限 proposed/testing；终态须经 testing 才能改判）；阶段只前进、回退需 `config.allowPhaseRewind`；`verdict` 枚举；空问题警告；评审可终结 testing 假设并关联实验/假设 | `research-loop.mjs` |
| C 工件 | 流式 SHA-256（大文件不爆内存）+ 大小配额 `config.maxFileBytes`；相同内容硬链接去重（失败退化复制）；`artifact_diff`（版本对比）/ `artifact_verify`（重算哈希）/ `artifact_deprecate`（废弃标记）；envFile + inputs 哈希溯源；列表/详情显示废弃与链接来源 | `artifact-registry.mjs` |
| D 架构 | 抽 `engines/core.mjs` 共享核心；错误码化（ERR_*）；`research_state` 支持 historyLimit 裁剪；审计日志 `.science.log`（NDJSON）；`research_report` 结构化 JSON 输出；`artifact_diff`/`artifact_verify` 结构化输出；`research_experiment` 返回下一步建议；未知实验不再产生垃圾目录 | 两个引擎 + core |
| 工程化 | 修复 dsh 加载器不支持 type 数组的 schema 问题（`artifact_diff.from` 移出 properties） | `artifact-registry.mjs` |
| 测试 | `smoke-test.mjs` 重写为 62 项（错误码/状态机/迁移/去重/结构化/审计）；新增 `stability-test.mjs` 25 项（并行保存、同工件丢失更新回归、并行 research_*、锁超时、写读原子性、死锁 soak、20 轮循环压力、结构化契约）；`verify-bundle.sh` 在 dsh 0.1.0-rc.6 上验证通过 | `scripts/` + `test/` |

> 说明：迁移在**加载时**应用、在**下次写入**时持久化到磁盘（避免只读操作产生写副作用）。
> 技能可执行化（方向 13）、CLI（14）、git 集成（15）、领域解耦（16）、CI/自动发版（19）尚未实施，属后续版本。
