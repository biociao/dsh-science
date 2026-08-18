# dsh-model-tier

**Tiered model router for DeepSeek Harness (DSH)** — automatically picks the model by
task difficulty, per request, across providers. The counterpart of Claude Code's
Opus/Sonnet/Haiku strategy:

> Within one session, **auxiliary calls** (session title, compaction) and **subtasks**
> (subagents / background fan-out) are routed to the **light tier**; the main
> conversation goes to the **default tier**; hard tasks escalate to the **strong tier**
> by rule. Each tier may point at a **different provider**.

**Opt-in per session**: the bundle registers a virtual provider「智能分档」
(`model-tier`) in the session model picker, with each named scheme as one of its
"models". Routing is active **only for sessions that selected a scheme**; every other
session is completely untouched (no global routing).

Zero third-party dependencies — built entirely on DSH's native extension point
(`ctx.llm.registerAdapter`). 中文文档见 [README.zh.md](README.zh.md)。

## How it routes

Once a session picks 智能分档 / \<scheme\> in the model picker, every model call of
that session flows through the virtual adapter:

| Request kind | Routed to | Recognized by |
| --- | --- | --- |
| Auxiliary calls (session title, compaction) | **light** | `GenerateOptions.purpose` (`session-title` / `compaction`) |
| Oversized input (last user message ≥ N chars, optional) | **strong** | `routing.escalateOnChars` |
| Deep subtask chains (`delegationDepth ≥ N`, optional) | **strong** | `routing.subagentDepthStrong` |
| Subtasks (subagents, background fan-out) | **light** | session metadata `origin: "subagent"` |
| Main conversation | **default** | everything else |

**LLM pre-classifier (`routing.classify`, optional)**: on top of the structural
rules, each new user prompt (and each subtask dispatch) can first be classified by a
small model into `light / default / strong` — the entry point for complexity-based
routing (plain execution/monitoring → light; decisions/reasoning/global
understanding → strong). Structural rules win: auxiliary calls and requests already
escalated to strong are never classified. Results are cached by (sessionId, message
hash), so a turn is classified once; classifier failure/timeout/garbage falls back
to the structural tier. The classifier target defaults to the light tier model, or
set `provider`/`model` explicitly. Prefer a **non-thinking** model as the
classifier target: reasoning content also consumes `maxTokens` (default 512,
tunable via `maxTokens`), and a thinking model can spend it all before emitting
the verdict word.

Fallback order: an unconfigured tier degrades `default → light → strong`; a stale
scheme id (deleted etc.) falls back to the scheme marked 默认 (`activeId`); with
`enabled: false` or no routable tier the call passes through to the global default
model (`agent-default-model`).

Safety rails:

- No tiers configured → no schemes appear in the picker (safe to ship the example
  config even without those providers).
- Explicit `agentOptions` on a subagent use a real provider, so those calls never
  reach the virtual adapter — explicit choices always win.
- Adapter exceptions only affect the routed call itself.
- When mixed-tier history hits a thinking-mode target (e.g. DeepSeek) that rejects
  tool-call messages lacking `reasoning_content`, the adapter injects a placeholder
  reasoning block into those messages and transparently retries once (logged as a
  warning).

**Per-session only**: `session.selectModel` natively persists the selection as the
global default model (affecting new sessions). A lightweight `agent/request` guard
restores the last real selection whenever the global default points at the virtual
provider (best-effort: a session created in the tiny window between selection and the
next request inherits the scheme — a known limitation).

## Install

```bash
dsh plugin --profile web add dsh-model-tier   # or github:biociao/dsh-science#packages/dsh-model-tier
# restart the profile
```

The bundle ships an example tier config (see `cordis.patch.yml`) which appears as the
「默认（bundle 配置）」scheme. To use your own providers/models, override in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- update:
    - id: model-tier
      config:
        tiers:
          strong:  { provider: my-strong, model: glm-5.3 }
          default: { provider: deepseek-official, model: deepseek-v4-flash }
          light:   { provider: my-cheap,  model: minimax-m2.7 }
        routing:
          auxiliary: [session-title, compaction]
          subagents: light
          subagentDepthStrong: 3      # optional: deep chains → strong
          # escalateOnChars: 40000    # optional: huge inputs → strong
          # classify: true            # optional: LLM pre-classifier per user prompt /
          #                           # subtask dispatch (light tier model by default)
```

| Key | Meaning | Default |
| --- | --- | --- |
| `tiers.strong` | strong tier `{provider, model, reasoningEffort?}` | unset → falls back to default |
| `tiers.default` | default tier: main conversation of opted-in sessions | unset → falls back to light/strong |
| `tiers.light` | light tier: auxiliary calls + subtasks | unset → falls back to default |
| `routing.auxiliary` | `purpose` list treated as auxiliary | `["session-title", "compaction"]` |
| `routing.subagents` | `"light"` routes subtasks; anything else doesn't | `"light"` |
| `routing.subagentDepthStrong` | `delegationDepth ≥ N` → strong | `null` (off) |
| `routing.escalateOnChars` | last user message ≥ N chars → strong (harness-injected `<system-reminder>` segments are stripped before measuring) | `null` (off) |
| `routing.classify` | LLM pre-classifier: `true`/`{}` (classify via the light tier model) or `{provider, model, timeoutMs?, maxChars?, maxTokens?}`; prefer a non-thinking target | `null` (off) |
| `enabled` | master switch (off → picker hides 智能分档) | `true` |

## Settings UI（智能分档）

The bundle ships a **Settings → 智能分档** page (a sibling of Settings → 模型，which has
no third-party injection slot). It manages **named schemes**: a scheme maps any
already-configured provider/model into the three tiers — 深思（strong）/ 主力（default）/
执行（light）— plus its routing rules. Keep as many schemes as you like. The scheme
marked 默认 (`activeId`) is only a **fallback** — which scheme a session actually uses
is decided by that session's model-picker selection (智能分档 / \<scheme\>). Saving a
new scheme auto-marks it as the default. Saving writes `$DSH_HOME/model-tier.json`
(schema 2: `{schema, enabled, activeId, schemes[]}`), which the router engine hot-reloads
by mtime (**no restart needed**); 「恢复默认」deletes the file entirely. Legacy flat
configs appear as a migratable scheme. Host side: `engines/model-tier-ui.mjs`
(`webServer` routes `/dsh-model-tier/*`); client bundle: `client/model-tier-ui/`
(built by `scripts/build-client-bundle.mjs`).

## Verify

```bash
node test/model-tier.test.mjs      # unit: virtual-adapter decision matrix + fallback + guard
bash scripts/test-model-tier.sh    # E2E: isolated DSH_HOME headless session, light tier
                                   # pointed at a local mock LLM; asserts the title call
                                   # actually lands on the mock
```

## Notes

- Mounts on the **host plane** (profile bundle), not inside an agent preset: the
  virtual provider lives in the process-wide llm adapter registry.
- Companion package of [dsh-science](https://github.com/biociao/dsh-science):
  installing `dsh-science` brings `dsh-model-tier` along as a dependency, but it is
  fully standalone — usable in any profile.
- Engine: `engines/model-tier.mjs` (`name = "dsh-model-tier"`, `inject = ["llm"]`).
  `decideTier` / `resolveTierTarget` / `schemeStoreFrom` / `routeStatus` are exported
  for tests and reuse. After scheme edits the host emits `llm/adapters-updated`, so
  the picker refreshes without a restart; the chat-page readout line is a
  `conversation.composer.dock` entry reading `/dsh-model-tier/route-status`,
  refreshed event-driven (on new turn / running flips; a 3s poll runs only
  while the session is busy — no idle polling).

## License

MIT
