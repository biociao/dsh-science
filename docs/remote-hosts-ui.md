# Remote Hosts UI（远程主机配置页）

对应 Claude Science 的 **Settings > Compute > SSH hosts**：在 DSH Web 的设置面板新增
「远程主机」页面，图形化查看/添加/探测/编辑/移除 SSH 主机，并查看各项目的访问白名单与作业。

## 界面功能

| 区块 | 功能 |
| --- | --- |
| 主机列表 | 每台主机卡片：id、传输（ssh/local）/conda/slurm 徽章、探测摘要（OS · CPU · 内存 · GPU · SLURM · 探测时间）、备注预览 |
| ＋ 添加主机 | host id、ssh alias（`~/.ssh/config` 别名或 `user@host`）、传输、备注（Details 文档）、scratch、端口/私钥、并发上限/作业超时，可选"注册后立即只读探测" |
| 每台主机 | 重新探测（真实 ssh 探测并回写存档）、详情/编辑（备注编辑器 + 运行设置 + 完整 JSON）、移除 |
| 项目白名单与作业 | 输入项目根 → 查看该项目授权主机列表（可逐个撤销）与最近作业/状态统计（按 project 隔离） |

## 架构

```
浏览器（DSH Web）                          DSH 宿主（Node）
┌──────────────────────────┐              ┌────────────────────────────────┐
│ settings.section「远程主机」│  fetch POST  │ engines/remote-hosts-ui.mjs     │
│ client/remote-hosts-ui/  │ ───────────► │ webServer 前缀路由               │
│   lib/client.js (bundle) │  JSON RPC    │   /dsh-science/remote-hosts/*   │
└──────────────────────────┘              │ 列表/添加/更新/移除/探测/白名单/作业 │
                                          └───────────────┬────────────────┘
                                              node:fs / node:child_process
                                                          ▼
                                          hosts.json（全机）· <项目根>/.dsh/remotes/
                                          allowlist.json · jobs.json（按项目）
```

- **宿主侧**（`engines/remote-hosts-ui.mjs`，零第三方依赖）：作为 bundle 行挂载
  （`cordis.patch.yml` 的 `science-remote-hosts-ui`），注册 `webServer` 前缀路由
  `/dsh-science/remote-hosts`，提供 `config / list / add-host / update-host /
  remove-host / probe-host / project-info / revoke` 八个 JSON 方法。与
  `remote-compute` 引擎读写**同一套数据文件**，UI 与工具改动互相可见。
  探测复用引擎同一只读脚本与解析格式；路由做同源校验（Origin ↔ Host）与
  POST-only 限制，防止跨站调用本地服务。
- **客户端**（`client/remote-hosts-ui/`）：`src/index.js` 是源码（React 无 JSX +
  浏览器 fetch），`lib/client.js` 是 **`window.__ModuleLoader__.load({id, factory})`
  格式的预构建 bundle**，由 `scripts/build-client-bundle.mjs` 生成（factory 内注入
  `React`/`h`，追加 `module.exports = plugin`）。package.json 的 `dsh.client` 声明
  使 client-modules 在 profile 启动时加载该 bundle 并注册到设置面板。
- 安全语义：设置页是**用户手动操作**，不弹审批（用户本人即授权者）；Agent 通过
  `remote_*` 工具操作仍走原有审批（首次授权/作业审批），两套互不冲突。

## 安装 / 更新

client 插件是 **profile/bundle 级**功能（设置页为 root 作用域），不进 agent preset。

```bash
bash scripts/sync-engines.sh            # 无变化（host 引擎不走 preset 镜像，无需）
node scripts/build-client-bundle.mjs    # 修改 client 源码后重新生成 bundle
dsh plugin --profile web add "github:biociao/dsh-science"   # 或已有 symlink 安装则跳过
# 重启 dsh web 进程（client-modules 在启动时扫描 dsh.client 并加载 bundle）
```

> 说明：`dsh.client` 的 bundle 缓存按内容哈希刷新；`dsh.client.inject` 声明客户端模块
> 依赖（`@deepseek-ai/dsh-client-runtime` 提供 slots 服务、`@deepseek-ai/dsh-client-ui-settings`
> 提供设置面板，均为 shell 内置 client 模块）。
> 注意：`cordis.patch.yml` 里携带 client bundle 的引擎行，`name` 必须是**包根名**
> `dsh-science`（经 `exports["."]` 指向宿主引擎文件）——client-modules 按 loader 条目名
> `require.resolve("<name>/package.json")` 定位 `dsh.client` 声明，子路径条目名
> （如 `dsh-science/engines/*.mjs`）解析不到 package.json，bundle 会被静默跳过。

## 测试

- `node scripts/smoke-test.mjs` 第 9 节：静态检查（`dsh.client` 声明、
  `exports["./client"]`、bundle 与源码一致性）+ 宿主路由单测（webServer stub 捕获
  路由、模拟 HTTP 请求验证 405/403/404 与增删改查、白名单/作业读取）。
- `bash test/verify-bundle.sh`：发布物检查新增 client bundle 与 `science-remote-hosts-ui`
  组合行、boot 无加载错误。

## 常见问题

- **设置里没有"远程主机"页**：确认重启了 web 进程（client-modules 启动时扫描）；
  确认 `node_modules/dsh-science/package.json` 的 `dsh.client` 与
  `exports["./client"]` 存在（bundle 重新安装后生效）。
- **页面报 fetch 403**：请求缺失/不匹配 Origin（浏览器同源访问不会触发）；
  用 curl 直接调试会被同源校验拒绝，属预期。
- **探测失败**：检查密钥/ssh-agent、`ssh <alias>` 连通性；UI 会展示 stderr 摘要。
