// Loaded only by verify-bundle.sh in its temporary profile. No external LLM calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const inject = ['agentPresets', 'agents', 'tools', 'webServer', 'llm'];
export function apply(ctx, config) {
  const timer = setTimeout(async () => {
    const passed = [];
    const handles = [];
    const runId = randomUUID();
    let result;
    try {
      const presets = await ctx.agentPresets.list();
      for (const id of config.presetIds ?? ['science', 'biomni']) {
        const preset = presets.find(p => p.id === id);
        assert(preset, `Missing preset: ${id}`);
        assert(!preset.broken, `${id}: ${preset.broken}`);
        passed.push(`preset ${id} mounted`);
        const cwd = path.join(config.workspace, runId, id);
        await mkdir(cwd, { recursive: true });
        const handle = await ctx.agents.create({
          sessionId: `compat-${id}-${runId}`,
          meta: { cwd, agentPreset: id },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id); },
        });
        handles.push(handle);
        const call = async (name, args) => {
          const result = await ctx.tools.execute({
            name, arguments: args, agent: handle.agent,
            callId: `compat-${id}-${name}`, signal: AbortSignal.timeout(15000),
          });
          assert(!result.isError, `${id}/${name}: ${JSON.stringify(result)}`);
          passed.push(`${id}/${name} through ToolRuntime`);
          return result.value;
        };
        if (id === 'science') {
          await call('research_init', { title: 'Compatibility test', question: 'Does DSH load this plugin?' });
          await call('research_state', {});
          await call('research_workbench', { root: path.dirname(cwd) });
          // 技术路线图：节点 → 关系 → 全图（纯文件读写，不需要进程沙箱）
          await call('roadmap_init', { root: cwd, title: 'Compatibility roadmap' });
          await call('roadmap_node_add', { root: cwd, title: 'step A' });
          await call('roadmap_node_add', { root: cwd, title: 'step B' });
          await call('roadmap_link', { root: cwd, from: 'n1', to: 'n2', type: 'serial' });
          await call('roadmap_show', { root: cwd, node: 'n1' });
          await call('roadmap_node_update', { root: cwd, node: 'n1', status: 'done', params: { q20: 0.95 }, note: 'toolruntime' });
          // 进度：对象形态（done/total）经真实 ToolRuntime 的参数 schema 校验
          await call('roadmap_node_update', { root: cwd, node: 'n1', progress: { done: 30, total: 120, unit: '样本' }, note: 'progress' });
          await call('roadmap_node_history', { root: cwd, node: 'n1', from: 1, to: 2 });
          await call('roadmap_node_revert', { root: cwd, node: 'n1', version: 1, note: 'rollback' });
          await call('roadmap_layout', { root: cwd, mode: 'auto', overwrite: true });
          await call('roadmap_render', { root: cwd, format: 'mermaid' });
          await call('roadmap_apply', {
            root: cwd,
            spec: { nodes: [{ ref: 'a', title: 'A' }, { ref: 'b', title: 'B' }], edges: [{ from: 'a', to: 'b', type: 'serial' }] },
            note: 'toolruntime apply',
          });
          await call('roadmap_link', { root: cwd, action: 'remove', id: 'e1' });
        } else {
          await call('biomni_retrieve', { query: 'single cell RNA analysis' });
          await call('biomni_plan_init', { task: 'Compatibility test' });
          await call('biomni_plan_status', {});
        }
        // workflow 走 DSH 的进程沙箱（sandbox-exec）。在无法应用沙箱的环境里
        // （受限 CI / 代理沙箱：`sandbox_apply: Operation not permitted`）可用
        // VERIFY_SKIP_WORKFLOW=1 跳过这一步；其余检查照常执行。
        if (process.env.VERIFY_SKIP_WORKFLOW !== '1') {
          const workflow = await call('workflow', {
            meta: { name: 'compat-check', description: 'Verify local PTC workflow execution' },
            script: 'return { compatible: true }',
          });
          assert.equal(workflow.result.compatible, true);
        }
      }
      if (config.hostChecks !== false) {
        const routed = [];
        const adapter = {
          providerInfo: provider => ({ id: provider, name: provider }),
          providerRetryPolicy: () => undefined,
          imageRequestPricing: () => undefined,
          listModels: async provider => ['main', 'light'].map(id => ({ provider, id, name: id })),
          resolveModel: async (provider, id) => ({ provider, id, name: id }),
          async prepareCall(provider, id) {
            return { model: await this.resolveModel(provider, id), stream: options => this.stream(options) };
          },
          async *stream(options) {
            routed.push(options.model);
            yield { type: 'text-delta', index: 0, text: 'local mock' };
            yield { type: 'finish', reason: { kind: 'success' } };
          },
        };
        const registration = ctx.llm.registerAdapter(['compat-mock'], adapter);
        try {
          await writeFile(path.join(process.env.DSH_HOME, 'model-tier.json'), JSON.stringify({
            schema: 2, enabled: true, activeId: 'compat', schemes: [{ id: 'compat', name: 'Compatibility',
              tiers: { default: { provider: 'compat-mock', model: 'main' }, light: { provider: 'compat-mock', model: 'light' } },
              routing: { auxiliary: ['session-title', 'compaction'] },
            }],
          }));
          assert((await ctx.llm.listModels('model-tier')).some(m => m.id === 'compat'));
          await ctx.llm.prepareCall({ provider: 'model-tier', model: 'compat' });
          ctx.llm.imageRequestPricing('model-tier', 'compat');
          for (const purpose of [undefined, 'session-title']) {
            const chunks = [];
            for await (const chunk of ctx.llm.stream({
              provider: 'model-tier', model: 'compat', purpose,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
              signal: AbortSignal.timeout(5000),
            })) chunks.push(chunk);
            assert(chunks.some(c => c.type === 'text-delta' && c.text === 'local mock'), JSON.stringify(chunks));
          }
          assert.deepEqual(routed, ['main', 'light']);
          passed.push('model-tier catalog, prepareCall, image pricing and main/auxiliary routing');
        } finally { registration(); }
        const origin = `http://127.0.0.1:${ctx.webServer.port}`;
        for (const endpoint of config.httpEndpoints ?? ['/dsh-science/remote-hosts/list', '/dsh-science/workbench/config', '/dsh-science/roadmap/config', '/dsh-science/sidebar/config', '/dsh-model-tier/config']) {
          const response = await fetch(origin + endpoint, {
            method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(response.status, 200, endpoint);
          const data = await response.json();
          assert.equal(data.ok, true, `${endpoint}: ${JSON.stringify(data)}`);
          passed.push(`HTTP ${endpoint}`);
        }
      }
      result = { ok: true, passed };
    } catch (error) {
      result = { ok: false, passed, error: error.stack };
    } finally {
      try {
        for (const handle of handles.reverse()) await handle.dispose();
      } catch (error) {
        result = { ok: false, passed, error: error.stack };
      }
      await writeFile(config.resultFile, JSON.stringify(result, null, 2));
    }
  }, 250);
  ctx.on('dispose', () => { clearTimeout(timer); });
}
