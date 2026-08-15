# dsh-science — Hub 收录申请草稿

> 提交渠道：[github.com/dsh-external/issues](https://github.com/dsh-external/issues)（新建 issue）
> 注意：`dsh-external` 组织自 2026-08 起为私有，若该仓库对当前账号不可见，
> 需先通过组织维护者获得访问，或在公开渠道（awesome 列表 PR / dsh-plugin topic）被维护者发现后主动联系。

---

## 标题（EN/中 任选其一）

**EN:** Request: list `dsh-science` in the hub catalog (dsh-plugin, research workbench)

**中:** 申请：将 `dsh-science` 收录进 hub 目录（dsh-plugin，科研工作台）

## 正文

### EN

Hi maintainers,

I'd like to request adding **dsh-science** to the hub catalog.

- **Repo:** https://github.com/biociao/dsh-science
- **What it is:** A Claude Science–style research workbench for DeepSeek Harness — a ReAct research-loop engine (`research_init` / `research_state` / `research_hypothesis` / `research_experiment` / `research_findings` / `research_phase` / `research_review`, persisted in `research-manifest.json`), versioned artifacts with provenance (`artifact_save` / `artifact_list` / `artifact_show` / `artifact_reproduce`, `artifacts/<name>/v<N>/` + SHA-256 + `provenance.md`), plus 10 science skills for genomics / pathogens / bioinformatics. Both engine plugins are zero-dependency cordis plugins (Node built-ins only).
- **Installable:** yes — `package.json` declares `dsh.bundle.patch` (`./cordis.patch.yml`); verified via `dsh plugin --profile web add "github:biociao/dsh-science"` on dsh `0.1.0-rc.6` (isolated profile install + boot check).
- **Topics:** `dsh-plugin`, `dsh-plugins`.
- **Verification:** `node scripts/smoke-test.mjs` (23/23 checks); `bash test/verify-bundle.sh` (end-to-end bundle install + boot).
- **Community PRs:** awesome-dsh-plugin#26, awesome-deepseek-harness#44.
- **License:** MIT. Actively maintained (this is the v0.1.1 release; issues/PRs welcome).

Happy to move the repo into the `dsh-external` org or add whatever metadata `catalog.json` needs — just let me know the process.

Thanks!

### 中文

维护者您好，

申请将 **dsh-science** 收录进 hub 目录。

- **仓库：** https://github.com/biociao/dsh-science
- **简介：** 面向 DeepSeek Harness 的 Claude Science 式科研工作台——ReAct 研究循环引擎（research_init / research_state / research_hypothesis / research_experiment / research_findings / research_phase / research_review，状态持久化于 research-manifest.json）、带溯源的版本化工件（artifact_save / artifact_list / artifact_show / artifact_reproduce，artifacts/<name>/v<N>/ + SHA-256 + provenance.md），以及面向基因组/病原体/生物信息的 10 个科研技能。两个引擎插件均为零依赖 cordis 插件（仅用 Node 内置模块）。
- **可安装：** 是——package.json 声明 `dsh.bundle.patch`（./cordis.patch.yml）；已在 dsh 0.1.0-rc.6 上用 `dsh plugin --profile web add "github:biociao/dsh-science"` 验证（隔离 profile 安装 + boot 检查）。
- **Topics：** `dsh-plugin`、`dsh-plugins`。
- **验证：** `node scripts/smoke-test.mjs`（23/23 通过）；`bash test/verify-bundle.sh`（端到端 bundle 安装 + boot）。
- **社区 PR：** awesome-dsh-plugin#26、awesome-deepseek-harness#44。
- **许可：** MIT。活跃维护中（当前为 v0.1.1，欢迎 issue/PR）。

如需把仓库迁入 dsh-external 组织，或补充 catalog.json 所需的元数据，请告知流程，感谢！
