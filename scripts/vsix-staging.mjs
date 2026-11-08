import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? ''}`);
  }
  return result;
}

/** Stage only runtime assets: never scan a checkout's worktrees or change its manifest. */
export function packageVsix({ target, pureTS = false }) {
  for (const command of ['pnpm run compile', 'pnpm run bundle']) {
    run(command, [], { shell: true }); // Fixed commands; Windows pnpm is a .cmd shim.
  }
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (pureTS) { manifest.contributes.configuration.properties['kbengine.core.backend'].default = 'ts'; }
  delete manifest.scripts['vscode:prepublish']; // Already built above, before staging.
  fs.mkdirSync('.vtmp', { recursive: true });
  const stage = fs.mkdtempSync(path.resolve('.vtmp/vsix-'));
  try {
    for (const name of [
      '.vscodeignore', 'README.md', 'CHANGELOG.md', 'LICENSE',
      'package.nls.json', 'package.nls.zh-cn.json',
      'language-configuration.json',
      'out', 'media', 'l10n', 'resources', 'schemas', 'snippets', 'syntaxes', 'templates',
      ...(!pureTS ? ['bin'] : []),
    ]) {
      if (fs.existsSync(name)) { fs.cpSync(name, path.join(stage, name), { recursive: true }); }
    }
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync('dist', { recursive: true });
    const output = path.resolve(`dist/kode-${manifest.version}-${pureTS ? 'pure-ts' : target}.vsix`);
    const require = createRequire(import.meta.url);
    const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
    run(process.execPath, [vsce, 'package', '--no-dependencies', ...(!pureTS ? ['--target', target] : []), '--out', output], { cwd: stage });
    return output;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
