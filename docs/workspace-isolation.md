# Workspace isolation / 会话隔离（New Session 不再隐式回落最近工作区）

## 背景 Background

dsh-science 会话在工作区之间“串门”的根因：DSH Web 前端的共享 **New Session** 动作
（侧栏「新会话」按钮 / 工作区浏览器）在解析目标工作区时使用隐式回落链：

```js
const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
```

- `workspaceId` — 显式指定的工作区（例如从工作区浏览器进入）；
- `currentWorkspaceId` — 当前会话所在的工作区；
- `recentWorkspaceId` — **最近使用过的工作区（隐式回落）**。

最后一段回落意味着：任何驱动 Web UI 的自动化（Playwright 脚本、程序化创建会话）只要不显式
指定工作区，就会把新会话开进“最近使用过”的项目里——即使那个项目与本次任务毫无关系。
这正是演示会话被自动创建进用户正在工作的 GI-estimate 项目、造成跨项目污染的原因。

## 修复 Fix

一行改动，去掉 `recentWorkspaceId` 回落：

```js
// before
const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
// after
const target = workspaceId ?? currentWorkspaceId
```

行为变化：没有显式目标、也没有当前会话工作区时，不再自动连入最近工作区，而是清空选择进入
New Session 视图状态，**必须由用户显式选择一个工作区**。显式指定 / 跟随当前会话工作区的
行为不变。

修复位于 DSH 核心 `packages/client/runtime/src/client/workspaces/service.ts`（`startSession`），
当前上游不接受外部 PR，因此由本插件以幂等补丁形式携带，升级 `dsh` 后重新应用即可。

## 应用 / 验证 / 回滚 Apply / verify / revert

```bash
# 应用（幂等：已应用则直接提示 already applied；首次应用前自动备份）
node scripts/patch-session-isolation.mjs apply

# 查看状态
node scripts/patch-session-isolation.mjs status

# 回滚（用备份恢复原文件）
node scripts/patch-session-isolation.mjs revert
```

目标文件自动探测自全局 `@deepseek-ai/dsh` 安装（`<npm-root>/@deepseek-ai/dsh/node_modules/
@deepseek-ai/dsh-client-runtime/lib/client.js`）；如需指定路径：

```bash
node scripts/patch-session-isolation.mjs apply --file <path-to-client.js>
# 或
DSH_CLIENT_RUNTIME=<path> node scripts/patch-session-isolation.mjs apply
```

备份文件：`<client.js>.bak-science-isolation`（apply 时创建，revert 时删除）。

### 验证是否生效 Verify

1. 重启 `dsh web`（客户端模块在服务启动时加载，刷新页面即可看到新 bundle rev）。
2. 在 Web GUI 点击「新会话」，确认 composer 的工作区 chip 显示**当前会话的工作区**
   （而非最近使用的工作区）。
3. 在新会话中让 agent 只运行一次 `pwd`：输出应为当前会话所在工作区路径，
   **不应**是最近使用过的其他项目路径。

## 升级说明 Upgrades

`dsh` 升级会覆盖 `node_modules` 里的手工补丁，升级后重新执行：

```bash
node scripts/patch-session-isolation.mjs apply
```

CI/部署流水线可在安装后自动执行同一命令（幂等，安全）。
