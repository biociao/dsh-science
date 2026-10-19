#!/usr/bin/env node
// Install one mode as a local declarative bundle for DSH >= 0.2.0-rc.2.
import { cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const [id, mode = 'copy'] = process.argv.slice(2);
if (!['science', 'biomni'].includes(id) || !['copy', 'link'].includes(mode)) {
  throw new Error('Usage: install-preset.mjs science|biomni [copy|link]');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, id === 'science' ? 'preset' : 'preset-biomni');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const name = `dsh-science-preset-${id}`;
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const target = path.join(home, 'local-bundles', name);
const profile = process.env.DSH_PROFILE || 'web';
execFileSync(process.execPath, [path.join(root, 'scripts/build-preset-bundles.mjs'), '--check'], { stdio: 'inherit' });
await mkdir(target, { recursive: true });
// Only replace this installer's engine copy/link; preserve other local files.
await rm(path.join(target, 'engines'), { recursive: true, force: true });
if (mode === 'link') await symlink(path.join(source, 'engines'), path.join(target, 'engines'), 'dir');
else await cp(path.join(source, 'engines'), path.join(target, 'engines'), { recursive: true });
const patch = (await readFile(path.join(source, 'cordis.patch.yml'), 'utf8'))
  .replaceAll('dsh-science/engines/', `${name}/engines/`);
await writeFile(path.join(target, 'cordis.patch.yml'), patch);
await writeFile(path.join(target, 'package.json'), JSON.stringify({
  name, version: pkg.version, type: 'module', private: true,
  exports: { './engines/*': './engines/*', './package.json': './package.json' },
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2) + '\n');
execFileSync('dsh', ['plugin', '--profile', profile, 'add', target], { stdio: 'inherit' });
console.log(`Installed ${id} into profile ${profile}. Restart DSH and select the preset in a new session.`);
