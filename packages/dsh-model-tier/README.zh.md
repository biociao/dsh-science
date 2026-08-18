# dsh-model-tier

**模型分档路由（Model Tier Router）** —— 按任务难易度自动选择模型，逐请求生效，跨
provider。目标与 Claude Code 的 Opus/Sonnet/Haiku 分级策略对应：

> 在同一会话内自动把**辅助请求**（会话标题、压缩摘要）与**子任务**（后台任务 /
> 子代理 / workflow 扇出的子代理）分流到**轻量档**；主对话走**主力档**；复杂任务
> 按规则升级到**强档**。各档位可以指向**不同 provider**。

**按会话启用**：本包在会话模型选择器里注册一个虚拟 provider「智能分档」，每个
分档方案是它下面的一个"模型"。只有会话选中了「智能分档 / 某方案」才开启自动
路由；未选中的会话完全不受影响（零全局路由）。

零第三方依赖，全部建立在 DSH 现成扩展点（`ctx.llm.registerAdapter`）上。English:
[README.md](README.md)。

## 一、机制

| 挂点 | 作用范围 | 本引擎做什么 |
|---|---|---|
| `ctx.llm.registerAdapter(["model-tier"], adapter)` | 进程级 llm 适配器注册表 | 注册虚拟 provider「智能分档」；`listModels` 返回方案列表（选择器自动出现该组并热刷新） |
| `adapter.stream(options)` | 选中会话的每一次模型调用（主对话 / 辅助 / 子任务） | 按规则决策档位，改写 provider/model 后派发真实适配器 |
| `agent/request` 监听（轻量守卫） | 每步请求 | 回退「全局默认模型」被写成分档方案的副作用（见下） |

**档位决策（`decideTier`，仅作用于选中「智能分档」的会话）**：
1. 辅助请求（`purpose` = `session-title` / `compaction`）→ 轻档
2. 超长输入（最近用户消息 ≥ `escalateOnChars`，可选）→ 强档
3. 深链子任务（`delegationDepth >= subagentDepthStrong`，可选）→ 强档
4. 子任务（`origin === 'subagent'` 且 `subagents === "light"`）→ 轻档
5. 其余（主对话）→ 主力档

**LLM 前置分类器（`routing.classify`，可选）**：结构规则之外，可在每次用户提问
（主对话新消息）/ 子任务派发前，用一个小模型把任务分类为 `light / default / strong`，
按分类档位派发——这是"按任务复杂度分档"的入口（简单执行/监控 → 轻档，决策/推理/
全局理解 → 强档）。结构规则优先：辅助请求与已升强（超长/深链）的请求不再分类。
按 (sessionId, 消息哈希) 缓存，同一轮提问只分类一次；分类失败 / 超时 / 乱答自动
回落结构档位。分类器目标缺省用执行（弱）档模型，也可显式指定 `provider`/`model`。
注意：分类目标建议选**非 thinking 模型**——推理内容同样吃 `maxTokens` 额度
（默认 512，可用 `maxTokens` 调整），thinking 模型可能把额度用光导致拿不到分类词。

**回落次序**：期望档位未配置（缺 provider/model）时按 `default → light → strong`
次序回落；方案 id 失效（被删除等）时回落「默认方案」（文件里的 `activeId`）；
`enabled: false` 或无可路由档位时透传全局默认模型（`agent-default-model`）。

**仅当前会话生效**：`session.selectModel` 会把选择持久化为全局默认模型（平台固有
行为），导致新建会话也默认走分档。本引擎的守卫在任何请求经过时检查：全局默认若是
虚拟 provider，立即恢复为最近记住的真实选择（best-effort：选中到下一次请求之间的
极短窗口内新建会话会继承分档，属已知限制）。

**为什么是 HOST 平面**：虚拟 provider 必须注册进进程级 llm 适配器注册表；
agent preset 是"按 agent 隔离"的平面，装不下这种注册（无 isolate 的服务行会被
`dsh-agent-presets` 拒绝）。因此它挂在 **profile bundle**（`cordis.patch.yml`）
而不是任何 agent preset 里。

**辅助请求识别**：`dsh-session-title-llm` 的标题调用带 `purpose: "session-title"`，
`dsh-compaction-basic` 的压缩调用带 `purpose: "compaction"` —— 这是 DSH 内置的
`GenerateOptions.purpose` 分类，本引擎只是消费它。

**子任务识别**：子代理会话的持久元数据带 `origin: "subagent"` 与 `delegationDepth`
（`childSessionMeta` 写入），与主会话天然区分。子代理若通过工具配置了显式
`agentOptions`（真实 provider/model），其请求根本不经过虚拟适配器 —— 显式选择
天然优先。

## 二、配置

包自带示例档位（见 `cordis.patch.yml`），作为**「默认（bundle 配置）」方案**出现在
选择器里。覆盖方式：`~/.dsh/profiles/<profile>/cordis.patch.yml` ——

```yaml
- update:
    - id: model-tier
      config:
        tiers:
          strong:            # 强档：复杂任务（深链子任务 / 超长输入）
            provider: zai-coding-cn
            model: glm-5.3
            # reasoningEffort: high        # 可选：档位自带的推理强度（覆盖选择器的推理等级）
          default:           # 主力档：主对话
            provider: deepseek-official
            model: deepseek-v4-flash
          light:             # 轻档：辅助请求（标题/压缩）+ 子任务
            provider: opencode-go
            model: minimax-m2.7
        routing:
          auxiliary: [session-title, compaction]   # 这些 purpose → 轻档（默认值即如此）
          subagents: light                          # 子任务 → 轻档
          subagentDepthStrong: 3                    # 可选：delegationDepth >= 3 → 强档
          # escalateOnChars: 40000                  # 可选：单步用户输入超过 4 万字符 → 强档
          # classify: true                          # 可选：LLM 前置分类器（每次提问/子任务派发前
          #                                         # 分类为 light/default/strong；缺省用轻档模型分类）
          # classify:                               # 也可显式指定分类模型与限额：
          #   provider: opencode-go
          #   model: minimax-m2.7
          #   timeoutMs: 10000                      # 超时回落结构档位
          #   maxChars: 4000                        # 送入分类器的消息截断长度
          #   maxTokens: 512                        # 分类输出额度（thinking 模型会吃这部分额度）
        enabled: true                               # 总开关（关闭 → 选择器不再出现「智能分档」）
```

| 键 | 含义 | 默认 |
|---|---|---|
| `tiers.strong` | 强档 `{provider, model, reasoningEffort?}` | 未配置 → 相关规则回落主力档 |
| `tiers.default` | 主力档；选中会话的主对话 | 未配置 → 回落轻档/强档 |
| `tiers.light` | 轻档；辅助请求 + 子任务 | 未配置 → 回落主力档 |
| `routing.auxiliary` | 视为辅助请求的 `purpose` 列表 | `["session-title", "compaction"]` |
| `routing.subagents` | `"light"`（子任务→轻档）或其它值（不路由） | `"light"` |
| `routing.subagentDepthStrong` | 子代理 `delegationDepth ≥ N` → 强档 | `null`（关闭） |
| `routing.escalateOnChars` | 最近一条用户消息文本长度 ≥ N → 强档（剥离 harness 注入的 `<system-reminder>` 段后计量） | `null`（关闭） |
| `routing.classify` | LLM 前置分类器：`true`/`{}` 启用（轻档模型分类），或 `{provider, model, timeoutMs?, maxChars?, maxTokens?}`；目标建议非 thinking 模型 | `null`（关闭） |
| `enabled` | 总开关 | `true` |

**安全护栏**：`tiers` 未配置 → 选择器里不出现方案；目标档位的 provider 未注册时，
由 DSH 自身的未注册路由报错兜底；适配器内任何异常只影响该次分档调用本身。
跨档位混用历史时，若 thinking 模式目标（如 DeepSeek）因历史工具调用消息缺
`reasoning_content` 拒绝请求，引擎会自动补占位推理块透明重试一次（日志有 warn）。

## 二点五、设置页 UI（智能分档）

包自带**设置 → 智能分档**页面（「模型」页的同级 section —— 内置模型页没有第三方注入
槽位，无法嵌进去）。页面以**方案**为单位管理：一个方案 = 已配置的 provider/模型到
**深思（strong）/ 主力（default）/ 执行（light）**三档的映射 + 路由规则（子任务走弱档、
深链/超长升级强档）。可以保存多套方案；列表里的「默认」方案（`activeId`）仅作
**回落**用途 —— 会话实际用哪套方案，由该会话在模型选择器里选中的「智能分档 /
方案」决定。新建方案保存后自动设为默认方案。
保存写入 `$DSH_HOME/model-tier.json`
（schema 2：`{schema, enabled, activeId, schemes[]}`），路由引擎按 mtime 热加载
（**无需重启**）；「恢复默认」删除整个配置文件。旧版扁平配置会显示为「迁移的旧配置」
方案，可编辑或设为默认。
宿主侧 `engines/model-tier-ui.mjs`（webServer 路由 `/dsh-model-tier/*`，POST-only +
同源校验）；客户端 `client/model-tier-ui/`（`scripts/build-client-bundle.mjs` 生成）。

## 三、安装 / 启用 / 使用

```bash
dsh plugin --profile web add dsh-model-tier   # 未发布前可用 github:biociao/dsh-science#packages/dsh-model-tier
# 重启 profile 后生效
```

- 本包也是 [dsh-science](https://github.com/biociao/dsh-science) 的配套依赖：
  安装 dsh-science 会自动带上 dsh-model-tier，无需单独安装。
- **preset 用户注意**：preset 按 agent 隔离，装不下进程级适配器注册；请在 profile
  层安装本 bundle。

**使用**：在会话输入框的模型选择器里选 **智能分档 / \<方案名\>** —— 该会话即刻进入
auto 路由（主对话→主力档、标题/压缩与子任务→轻档、深链/超长→强档）；输入框下方会
显示一行读数「智能分档 · \<方案名\> → \<实际模型\>（\<档位\>）」。切回普通模型即
恢复手动选择。**未选中的会话完全不路由。**

### 生效范围

- 仅**选中了「智能分档」的会话**（按会话 opt-in，无全局路由）；
- 主对话 → 所选方案的**主力档**；
- 辅助请求（标题、压缩）与子任务 → **轻档**；
- 深链子任务 / 超长输入 → **强档**（按方案规则）；
- 选择本身仅当前会话生效（全局默认模型副作用由守卫回退，见「机制」）。

## 四、验证

```bash
node test/model-tier.test.mjs        # 单元测试：虚拟适配器决策矩阵 + 回落 + 守卫（零依赖）
bash scripts/test-model-tier.sh      # E2E：隔离 DSH_HOME 起 headless 会话，
                                     # 轻档指向本地 mock LLM，断言标题请求真的打到 mock
```

E2E 原理：把 `tiers.light` 指向本地 mock 服务器（`scripts/mock-llm-server.mjs`），
跑一个选中「智能分档」的 headless 会话 —— 若 `purpose=session-title` 的标题调用被
路由，mock 服务器就会收到 `model=mock-title` 的请求；同时主对话请求仍走主力档
（不进 mock）。

## 五、与 Claude Code 策略的对照

| Claude Code | 本引擎 |
|---|---|
| `--model` / `/model` 切换会话主模型 | 会话模型选择器：选普通模型 = 手动；选「智能分档 / 方案」= auto 路由 |
| `--model-small` / `smallModel`：标题、压缩、后台任务走轻量模型 | 选中会话内按 `purpose` / `origin` 路由 → 轻档 |
| 自定义 subagent 的 `model` frontmatter（per-agent 固定） | 子代理工具 `agentOptions`（显式配置不经虚拟适配器，天然优先） |
| 社区路由器（claude-code-router / LiteLLM / OpenRouter） | 本引擎（基于 DSH 原生适配器注册点，进程内、零依赖） |

## 六、实现说明

- 引擎文件：`engines/model-tier.mjs`（`name = "dsh-model-tier"`，`inject = ["llm"]`）。
- 决策函数 `decideTier` / `resolveTierTarget`、方案仓库 `schemeStoreFrom` /
  `makeSchemeStoreSource`、路由状态 `routeStatus`（sessionId → 最近一次路由）已导出，
  便于单测与复用。
- 设置页改动方案后宿主侧发 `llm/adapters-updated`，前端模型目录自动热刷新。
- 聊天页底部读数由 client 插件注册 `conversation.composer.dock`，从
  `/dsh-model-tier/route-status` 获得；刷新是事件驱动的（新 turn / running
  翻转时立即拉取，仅运行中保留 3s 轮询跟踪逐步路由，空闲不轮询）。

## License

MIT
