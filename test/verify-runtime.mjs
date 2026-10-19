// Require positive runtime evidence, and bound both boot and shutdown.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const resultFile = process.argv[2];
const child = spawn('dsh', ['--profile', 'web', '--no-open'], {
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let output = '';
let exited = false;
child.stdout.on('data', b => { output += b; });
child.stderr.on('data', b => { output += b; });
child.on('exit', () => { exited = true; });
child.on('error', error => { output += error.message; exited = true; });
try {
  let result;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    result = await readFile(resultFile, 'utf8').then(JSON.parse).catch(() => null);
    if (result || exited) break;
    await delay(200);
  }
  if (!result?.ok) throw new Error(result?.error ?? (exited ? 'DSH exited before runtime verification' : 'Runtime verification timed out'));
  if (/plugin tree failed to load|failed to apply loader entry|MissingClientBundle|declares dsh.client but exports no/.test(output)) {
    throw new Error('DSH reported a loader/client failure');
  }
  for (const check of result.passed) console.log(`  ✔ ${check}`);
} catch (error) {
  // The boot URL includes a local access token; redact it even in failure logs.
  console.error(output.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'));
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 25 && !exited; i++) await delay(100);
  // Kill any surviving descendants belonging to this test process group.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}
