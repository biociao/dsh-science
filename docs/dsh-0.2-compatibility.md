# DSH 0.2.0-rc.2 兼容性迁移

当前修复与集成验证的目标为 **`@deepseek-ai/dsh@0.2.0-rc.2`**。
依据是本机安装的 DSH 插件源码与隔离 profile 测试；以下命令是复核入口，
不能把静态配置检查或旧版测试通过视为新版运行时已全部通过。

## 接口变化与处理

| 位置 | 升级后的影响 | 本仓库处理 |
| --- | --- | --- |
| preset 注册 | 新版使用 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 注册定义，旧 `.agent-presets/` 目录安装方式不再自动发现模式 | 根 bundle 同时声明根补丁与两个 preset 补丁；由 `agent.cordis.yml` 生成声明式配置 |
| preset 引擎解析 | 声明式插件列表需要可从 profile 解析的包名 | 生成器将 `./engines/` 改为 `dsh-science/engines/` 子路径导出；本地安装器再改为所选模式的本地包名 |
| workflow | 旧 `@deepseek-ai/dsh-workflow-worker-thread` 已不在当前 DSH 依赖中 | 两个模式改用 `@deepseek-ai/dsh-workflow-ptc` |
| 模型分档 adapter | 新版通过 adapter 的 `prepareCall` 准备并绑定一次模型调用；旧 adapter 在真实调用时出现 `TypeError: registration.adapter.prepareCall is not a function` | 配套路由包补齐 `prepareCall` 与 `imageRequestPricing`；一次调用绑定模型方案快照，后续调用读取更新后的方案 |
| `/goal` 命令 | 新版 Web profile 禁用了宿主 `command-goal` 行，标准 preset 自行注册 | 科学模式与 Biomni 模式在自己的插件清单注册命令 |
| 发布门禁 | 旧门禁固定在 `0.1.5-rc.1`，单看 boot 无法证明 preset 子插件可挂载和执行 | CI 与发布固定 `0.2.0-rc.2`，并检查真实 preset 挂载、工具执行、workflow 与 HTTP 路由 |

`preset/agent.cordis.yml` 和 `preset-biomni/agent.cordis.yml` 是可编辑的源清单。
`preset/cordis.patch.yml` 与 `preset-biomni/cordis.patch.yml` 为生成文件，修改清单后运行：

```bash
node scripts/build-preset-bundles.mjs
node scripts/build-preset-bundles.mjs --check
```

## 从旧版安装迁移

若安装完整 profile bundle，更新到包含本次修复的包或 checkout，再重新执行
`dsh plugin --profile web add <包或本地仓库路径>`。完整 bundle 注册科学模式与 Biomni 模式，
并提供 profile 级引擎、Web 面板及模型分档路由。

只安装一个模式时，在本仓库根目录运行：

```bash
bash scripts/install.sh          # 科学模式，默认 copy
bash scripts/install-biomni.sh   # Biomni 模式，默认 copy
DSH_PROFILE=my-profile bash scripts/install.sh link
```

安装器在 `$DSH_HOME/local-bundles/dsh-science-preset-science/` 或
`$DSH_HOME/local-bundles/dsh-science-preset-biomni/` 创建声明式 bundle，再注册到 profile。
`DSH_HOME` 默认 `~/.dsh`；`DSH_PROFILE` 默认 `web`。
`copy` 复制引擎，`link` 链接引擎目录。配置清单变更后，两种模式都应重新运行安装器。
安装后重启 DSH，在新会话中选择对应 preset。

旧 `.agent-presets/` 中的目录仅是旧版安装遗留；新版注册由 profile bundle 配置决定。
迁移脚本不会删除这些目录。

### 已链接本地仓库，但无法开启模式

`dsh plugin --profile web list` 显示 `dsh-science@link:...` 说明源码已安装，
不代表运行中的服务已加载新配置。DSH 默认 HMR 的 `root: []` 只监视 profile/home
补丁和 profile manifest；已选 bundle 的 `package.json` 新增补丁声明不会自动触发重组，
引擎代码也可能继续使用进程缓存。更新后重启 DSH，再刷新页面。

Web 设置中需开启「显示代码工作视图」才显示模式选择器。新建空白会话后，
在发送第一条消息前选择「科学模式」或「Biomni 模式」；已开始的会话不能切换模式。
完整 bundle 已注册两种模式，无需在同一 profile 重复安装单独 preset bundle。

2026-10-11 在实际本地 web 服务上复核：此前物化组合缺少 `preset-science` 和
`preset-biomni`；通过原生 profile 重载后，真实 `agentPresets/list` API 返回两种模式，
均无 `broken` 诊断，界面模式入口开关已开启。该检查没有创建研究会话或调用商业模型。

## 验证范围

独立逻辑检查继续覆盖 Node 18/20。真实 DSH 集成检查使用 Node 22、隔离的
`DSH_HOME` 与临时工作区，避免改动日常 profile 和研究数据：

```bash
npm test
node scripts/stability-test.mjs
bash test/verify-bundle.sh
bash test/verify-preset-install.sh
bash packages/dsh-model-tier/scripts/test-model-tier.sh
```

`npm test` 覆盖引擎逻辑、模型分档、科学评审与 preset 配置一致性；schema 校验在本地
找不到 DSH 时可以跳过。`test/verify-bundle.sh` 强制使用真实 schema，并安装打包后的
插件，启动隔离 profile，等待运行时探针提供成功结果。
探针检查两个模式的挂载、科研/Biomni 工具执行、workflow 与宿主 HTTP 路由。
单独 preset 安装测试覆盖 copy/link、重装、包导出与再次运行；独立模型路由测试用内存 mock
验证主请求和标题请求，无需用户凭据或商业模型调用。

该验证范围覆盖插件接口与本地执行链路；真实商业模型服务的认证、远程 SSH/SLURM
作业及浏览器交互仍需按各自环境验证。

## 本次实测结果（2026-10-10）

本机 Node `22.21.1`、DSH `0.2.0-rc.2`：逻辑测试 365 项、稳定性测试 25 项、
真实 schema 检查 98 项及 2 项校验器失败路径回归均通过。
完整发布包、单独 preset 的 copy/link 初装与重装、独立模型路由 bundle 集成验证均通过。
集成测试只写临时目录，模型由本地 mock 响应。浏览器交互、真实模型供应商及 SSH/SLURM
尚未纳入本次验收；CI 配置已更新，远端运行结果须在提交后确认。

`patch-session-isolation.mjs status` 能识别新版客户端中的原表达式，现有补丁脚本仍适用；
当前本机新版本尚未应用该 guard。本次只检查状态，没有修改全局 DSH 安装文件。
