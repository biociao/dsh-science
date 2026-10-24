// Regression gates for missing packages and default-exported Config schemas.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-preset-gate-'));
try {
  const file = path.join(dir, 'agent.cordis.yml');
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/validate-presets.mjs'), file], {
    encoding: 'utf8', env: process.env,
  });
  await writeFile(file, "- id: missing\n  name: '@deepseek-ai/compat-missing-package'\n");
  const missing = run();
  const output = missing.stdout + missing.stderr;
  if (output.includes('找不到 @deepseek-ai/dsh') && missing.status === 0) {
    console.log('Preset gate regressions skipped: install DSH to run real schema checks.');
  } else {
    assert.equal(missing.status, 1, output);
    assert.match(output, /FAIL.*missing/);
    console.log('✔ Missing preset package fails validation');
    await writeFile(file, "- id: invalid\n  name: '@deepseek-ai/dsh-workflow-ptc'\n  config:\n    provider: 123\n");
    const invalid = run();
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stdout + invalid.stderr, /FAIL.*invalid/);
    console.log('✔ Default-exported Config rejects invalid configuration');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
