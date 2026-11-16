import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Cold-start spawn outcomes that CI runners produce under load and that a
 * single retry on a warm process recovers (nightly win32-x64 43817266345:
 * `spawnSync kode-mcp.exe ETIMEDOUT` at exactly the 20 s smoke budget while
 * every cargo suite passed and the other six platforms passed). Permanent
 * failures (ENOENT, EACCES, bad exit status) are never retried.
 */
const TRANSIENT_SPAWN_CODES = new Set(['ETIMEDOUT', 'ESRCH']);
const MAX_SPAWN_ATTEMPTS = 3;
const SPAWN_BACKOFF_MS = [20, 60, 150];

export function isTransientSpawnError(error) {
  return !!error && typeof error.code === 'string' && TRANSIENT_SPAWN_CODES.has(error.code);
}

/** Keep the child's own output: the old message discarded stdout/stderr, so a
 * failing smoke could not be attributed from the workflow log. */
function outputTail(result) {
  const stdout = typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trimEnd() : '';
  const tail = [stdout.slice(-4000), stderr.slice(-4000)].filter(Boolean).join('\n');
  return tail ? `\n<output>\n${tail}\n</output>` : '';
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function run(command, args, options = {}) {
  const { maxAttempts = MAX_SPAWN_ATTEMPTS, ...spawnOptions } = options;
  for (let attempt = 0; ; attempt += 1) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...spawnOptions });
    const transient = isTransientSpawnError(result.error);
    const exhausted = !transient || attempt + 1 >= maxAttempts;
    if (exhausted) {
      if (result.error) {
        const error = new Error(
          `${command} failed (${result.error.code}): ${result.error.message}${outputTail(result)}`,
        );
        error.code = result.error.code;
        throw error;
      }
      if (result.status !== 0) {
        const error = new Error(`${command} failed (${result.status})${outputTail(result)}`);
        error.code = `EXIT_${result.status}`;
        throw error;
      }
      return result;
    }
    sleepMs(SPAWN_BACKOFF_MS[attempt] ?? 150);
  }
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
      // 顶层 typings/ 是 KBEngine 桩包静态模板(激活期 copy-if-absent 的复制源);
      // 漏 stage 会让打包安装的宿主报「桩包内置模板读不到」(2026-11-11 004b 真机走查抓到)。
      'typings',
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
