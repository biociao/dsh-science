# 分支模型与发布流程（Git Flow-lite）

> 仓库采用 **main / dev / feat\*** 三层分支模型，配合 tag 触发的自动发布。
> CI 与发布自动化见 `.github/workflows/ci.yml` 与 `.github/workflows/release.yml`。

## 一、分支分工

| 分支 | 角色 | 规则 |
|------|------|------|
| `main` | **只放可发布状态** | 禁止直接 push；只接受 `dev → main` 的发布 PR（或 `hotfix/* → main`）；每次合入打 `vX.Y.Z` tag。main 上的每个 commit 都对应一个可安装版本 |
| `dev` | **集成测试分支** | 禁止直接 push；`feat/*` 通过 PR 合入。不发布；PR 进 dev 跑逻辑与真实 DSH 集成门禁 |
| `feat/<name>` | **新功能 / 修复分支** | 从 `dev` 切出，PR 回 `dev`；命名如 `feat/artifact-quota`、`fix/lock-timeout` |
| `hotfix/<name>`（可选） | **紧急修复** | 从 `main` 切出，PR 回 `main` 与 `dev`（双合并）；走全量验证 |

```
feat/a ──┐
feat/b ──┼──▶ PR ──▶ dev ──▶ PR(发布) ──▶ main ──▶ tag vX.Y.Z ──▶ CI：测试 → npm publish → GitHub Release
         │         ▲ 集成测试            ▲ 全量验证             │
         └─────────┘                                           ▼
                                              github: 安装路径也获得版本锚点
```

## 二、测试矩阵与门禁

| 阶段 | 跑什么 | 在哪跑 |
|------|--------|--------|
| 提交 / feat 分支 | 本地 `npm test`；修改 preset 后先生成补丁 | 开发者本机 |
| PR → `dev` / push dev | `npm test` + stability（Node 18/20）+ bundle/preset/router 集成验证（Node 22） | CI（`ci.yml`） |
| PR → `main` / push main | 上述检查 + **bundle-verify**（真实 DSH 隔离安装、preset schema、运行时检查） | CI（`ci.yml`，DSH 使用 Node 22） |
| tag `v*`（发布） | 全量检查 + bundle-verify + tag/版本一致性 | CI（`release.yml`） |

真实 DSH 门禁固定使用 **`@deepseek-ai/dsh@0.2.0-rc.2`**。
`npm test` 包含研究/Biomni 引擎、模型分档、科学评审、preset 生成一致性与 schema 检查；
本地缺少 DSH 时 schema 检查可以跳过，因此不能仅凭 `npm test` 宣称真实 DSH 兼容。
`bundle-verify` 在隔离 `$DSH_HOME` 中安装发布包，检查两个 preset 的真实挂载、工具调用、
workflow 与 HTTP 路由，并独立检查 preset 安装/重装及模型路由 bundle。升级 DSH 固定版本时，应先按
[兼容性迁移说明](dsh-0.2-compatibility.md) 核验接口，再更新 CI 与发布工作流。

## 三、发布流程（tag 触发，全自动）

1. `dev` 集成稳定后，提发布 PR 合入 `main`。
2. 打 annotated tag 并推送（tag 必须与 `package.json` 的 version 一致）：

   ```bash
   git tag -a v0.1.1 -m "robustness update"
   git push origin v0.1.1
   ```

3. `release.yml` 自动执行：
   - 测试门禁：`npm test` + stability（Node 18/20）+ bundle-verify（Node 22）
   - 校验 tag 与 `package.json` 版本一致（不一致拒绝发布）
   - `pnpm pack` 产出 `dsh-science-<ver>.tgz` + `SHA256SUMS`
   - `npm publish`（使用仓库 secret `NPM_TOKEN`）
   - 创建 GitHub Release：附 tgz + 校验和 + 自动 release notes

4. 人工只需：review PR + 打 tag。发布失败（测试不过 / 版本不一致 / npm 已存在同版本）会中断并给出明确错误。

## 四、首次发布前的一次性配置

1. **npm token**：在 [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens) 建一个 *publish* 权限的 token，
   在仓库 **Settings → Secrets and variables → Actions** 添加 `NPM_TOKEN`。
2. **分支保护（可选但推荐）**：Settings → Branches 中给 `main` 和 `dev` 加规则：
   - 要求 PR 合入（禁止直接 push）
   - 要求状态检查通过（`CI` 工作流）

## 五、日常开发示例

```bash
# 新功能
git checkout dev && git pull
git checkout -b feat/artifact-quota
# ... 开发，本地跑 node scripts/smoke-test.mjs
git push -u origin feat/artifact-quota
# 提 PR → dev（CI 自动跑 smoke + stability）

# 发布
# dev 稳定后提 PR → main → 合入
git tag -a v0.1.1 -m "robustness update" && git push origin v0.1.1
```

## 六、语义化版本约定

- **patch（v0.1.1）**：修复 / 鲁棒性 / 向后兼容的行为调整（如并发安全、校验、错误码）。
- **minor（v0.2.0）**：新功能（新工具、新技能、CLI、结构化输出等）。
- 0.x 阶段允许不兼容变更，但尽量走 minor 并写迁移说明（manifest 有 schema 迁移机制兜底）。
