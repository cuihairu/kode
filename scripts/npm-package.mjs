// Build, pack and verify the @cuihairu/kode-mcp npm package set.
//
// Layout (Option A: platform optionalDependencies, the esbuild/swc model).
//   packages/kode-mcp/                main package — launcher only, no binary
//   packages/kode-mcp/mcp-<os>-<arch> platform package — holds bin/kode-mcp
//
// The Rust binary is cross-compiled per platform in CI (see
// .github/workflows/npm.yml); locally this script stages whatever it is handed
// so the pipeline itself is testable without a full cargo release build.
//
// Usage:
//   node scripts/npm-package.mjs build  [--target linux-x64] [--from <binary>]
//   node scripts/npm-package.mjs pack   [--target all|<target>]
//   node scripts/npm-package.mjs verify
//   node scripts/npm-package.mjs smoke  [--target <target>]
//   node scripts/npm-package.mjs sizes
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targets } from './platform-vsix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = path.join(root, 'packages', 'kode-mcp');
const distDir = path.join(root, 'dist', 'npm');
const scope = '@cuihairu';
const binary = 'kode-mcp';
const mainManifest = path.join(pkgRoot, 'package.json');
// An unstripped debug build runs to hundreds of MB and would swamp the registry.
const MAX_PUBLISHED_BINARY_BYTES = 200 * 1024 * 1024;

const argv = process.argv.slice(2);
const command = argv[0];
function flag(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

// npm package name for a VSIX-style target key.
const npmName = target => `${scope}/mcp-${target}`;
const npmDir = target => path.join(pkgRoot, `mcp-${target}`);
const npmBinary = (target, name = binary) =>
  path.join(npmDir(target), 'bin', targets[target].os === 'win32' ? `${name}.exe` : name);
const manifestPath = target => path.join(npmDir(target), 'bin', 'manifest.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const currentVersion = () => readJson(path.join(root, 'package.json')).version;

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** Stage a prebuilt binary into one platform package and record its digest. */
function build({ target, from }) {
  if (!targets[target]) {
    throw new Error(`unknown target ${target}; expected one of ${Object.keys(targets).join(', ')}`);
  }
  const destination = npmBinary(target);
  let source = from;
  if (!source) {
    const spec = targets[target];
    const built = path.join('target', spec.rust, 'release', targets[target].os === 'win32' ? `${binary}.exe` : binary);
    if (fs.existsSync(built)) {
      source = built;
    } else {
      throw new Error(
        `no binary found at ${built}; run cargo build --release -p kode-mcp ` +
          `--target ${spec.rust}, or pass --from <path>`
      );
    }
  }
  if (!fs.existsSync(source)) {
    throw new Error(`--from binary does not exist: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o755);
  const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  const info = {
    target,
    rustTarget: targets[target].rust,
    version: currentVersion(),
    commit: gitCommit(),
    file: path.basename(destination),
    sha256: digest,
    bytes: fs.statSync(destination).size,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(manifestPath(target), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`staged ${path.relative(root, destination)} ${info.bytes} bytes ${digest.slice(0, 12)}`);
  return info;
}

/** Pack every staged platform package (plus the main launcher package). */
function pack({ only }) {
  const staged = Object.keys(targets).filter(target => {
    if (only && only !== 'all' && target !== only) return false;
    return fs.existsSync(manifestPath(target));
  });
  if (staged.length === 0) {
    throw new Error(`no staged platform packages under ${path.relative(root, pkgRoot)}`);
  }
  fs.mkdirSync(distDir, { recursive: true });
  const index = staged.map(target => {
    const record = readJson(manifestPath(target));
    const packed = packOne(npmName(target), npmDir(target));
    return {
      target,
      package: packed.name,
      tarball: packed.tarball,
      bytes: packed.size,
      binaryBytes: record.bytes,
      sha256: record.sha256
    };
  });
  const main = packOne(`${scope}/kode-mcp`, pkgRoot);
  index.push({ target: 'main', package: main.name, tarball: main.tarball, bytes: main.size });
  fs.writeFileSync(path.join(distDir, 'npm-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/** npm pack for one package directory; returns the tarball facts. */
function packOne(name, directory) {
  fs.mkdirSync(distDir, { recursive: true });
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', distDir], {
    cwd: directory,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm pack failed for ${name}: ${result.stderr || result.error?.message}`);
  }
  const parsed = JSON.parse(result.stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return { name, tarball: entry.filename, size: entry.size, unpackedSize: entry.unpackedSize };
}

/** Static checks: launcher syntax, staged digests, version agreement, tarball contents. */
function verify() {
  const problems = [];
  const launcher = path.join(pkgRoot, 'bin', 'kode-mcp');
  if (!fs.existsSync(launcher)) {
    problems.push('launcher missing: packages/kode-mcp/bin/kode-mcp');
  } else {
    const check = spawnSync(process.execPath, ['--check', launcher], { stdio: 'pipe', encoding: 'utf8' });
    if (check.status !== 0) problems.push(`launcher fails node --check: ${check.stderr}`);
    if (!(fs.statSync(launcher).mode & 0o111)) problems.push('launcher is not executable');
  }

  const main = readJson(mainManifest);
  if (!main.bin || main.bin['kode-mcp'] !== 'bin/kode-mcp') {
    problems.push('main package bin entry is not bin/kode-mcp');
  }
  const optional = Object.keys(main.optionalDependencies ?? {}).sort();
  const expected = Object.keys(targets).map(npmName).sort();
  if (JSON.stringify(optional) !== JSON.stringify(expected)) {
    problems.push(`optionalDependencies ${JSON.stringify(optional)} != platform set ${JSON.stringify(expected)}`);
  }
  // The published npm version must be the committed extension version.
  if (main.version !== currentVersion()) {
    problems.push(`main package version ${main.version} != package.json ${currentVersion()}`);
  }

  let stagedCount = 0;
  for (const target of Object.keys(targets)) {
    const directory = npmDir(target);
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) {
      problems.push(`platform package.json missing: ${path.relative(root, manifest)}`);
      continue;
    }
    const info = readJson(manifest);
    if (info.name !== npmName(target)) problems.push(`${path.relative(root, manifest)}: name ${info.name} != ${npmName(target)}`);
    const spec = targets[target];
    if (JSON.stringify(info.os ?? []) !== JSON.stringify([spec.os])) {
      problems.push(`${info.name}: os ${JSON.stringify(info.os)} != ${JSON.stringify([spec.os])}`);
    }
    if (JSON.stringify(info.cpu ?? []) !== JSON.stringify([spec.arch])) {
      problems.push(`${info.name}: cpu ${JSON.stringify(info.cpu)} != ${JSON.stringify([spec.arch])}`);
    }
    if (info.version !== currentVersion()) {
      problems.push(`${npmName(target)}: version ${info.version} != package.json ${currentVersion()}`);
    }
    // A platform package is only "staged" once a build placed a binary in it.
    const staged = fs.existsSync(manifestPath(target));
    if (!staged) {
      // Unstaged packages must stay un-publishable until a build stages them.
      if (info.private !== true) {
        problems.push(`${npmName(target)}: not staged but package.json is not private`);
      }
      continue;
    }
    stagedCount += 1;
    const record = readJson(manifestPath(target));
    const real = createHash('sha256').update(fs.readFileSync(npmBinary(target))).digest('hex');
    if (real !== record.sha256) problems.push(`${npmName(target)}: staged binary does not match manifest digest`);
    if (record.version !== currentVersion()) {
      problems.push(`${npmName(target)}: manifest version ${record.version} != package.json ${currentVersion()}`);
    }
    // Guard against publishing an unstripped debug build (hundreds of MB).
    if (record.bytes > MAX_PUBLISHED_BINARY_BYTES) {
      problems.push(
        `${npmName(target)}: staged binary is ${record.bytes} bytes, above the ` +
          `${MAX_PUBLISHED_BINARY_BYTES} byte publish limit — stage a cargo --release build`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`npm packaging verification failed:\n  ${problems.join('\n  ')}`);
  }
  console.log(`npm packaging verification passed (${stagedCount} platform package staged)`);
  return true;
}

/** Run the staged binary through a real MCP handshake (initialize + tools/list). */
function smoke({ target }) {
  const staged = Object.keys(targets).filter(t => fs.existsSync(manifestPath(t)));
  const pick = target || staged[0];
  if (!pick) throw new Error('nothing staged to smoke; run build first');
  const spec = targets[pick];
  if (spec.os !== process.platform || spec.arch !== process.arch) {
    throw new Error(`smoke requires native ${pick}, running ${process.platform}-${process.arch}`);
  }
  const executable = npmBinary(pick);
  // MCP stdio is newline-delimited JSON, one request per line. (kode-server is
  // LSP and uses Content-Length framing instead — do not mix the two.)
  const request = message => `${JSON.stringify(message)}\n`;
  const input =
    request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'npm-package-smoke', version: '1' }
    } }) +
    request({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
    request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  // The first argument is the asset root; feed the same demo assets the Rust
  // e2e suite uses so the index is real rather than empty.
  const assets = path.join(root, 'tests', 'fixtures', 'kbengine-demo-assets');
  const result = spawnSync(executable, [assets], {
    input,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, RUST_LOG: 'off' }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`kode-mcp exited ${result.status}: ${result.stderr ?? result.error?.message}`);
  }
  const messages = (result.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
    .filter(Boolean);
  const reply = id => messages.find(message => message.id === id && message.result);
  if (!reply(1)) throw new Error('no initialize result');
  if (!reply(2)) throw new Error('no tools/list result');
  const tools = (reply(2).tools ?? []).map(tool => tool.name);
  console.log(`${pick}: initialize ok, ${tools.length} tools (${tools.slice(0, 6).join(', ')}...)`);
  return tools;
}

/** Report tarball sizes, so a large binary cannot creep in unnoticed. */
function sizes() {
  if (!fs.existsSync(distDir)) {
    console.log('nothing packed yet; run pack first');
    return [];
  }
  const rows = fs.readdirSync(distDir).filter(name => name.endsWith('.tgz')).map(name => {
    const file = path.join(distDir, name);
    return { tarball: name, bytes: fs.statSync(file).size };
  });
  for (const row of rows) {
    console.log(`${path.relative(root, path.join(distDir, row.tarball))}: ${row.bytes} bytes`);
  }
  const indexFile = path.join(distDir, 'npm-index.json');
  if (fs.existsSync(indexFile)) {
    for (const row of readJson(indexFile)) {
      const detail = row.binaryBytes ? `staged binary ${row.binaryBytes} bytes` : 'launcher only';
      console.log(`${row.package}: ${detail}`);
    }
  }
  return rows;
}

/** Make the staged packages publishable at a given version. */
function prepare({ version, targets: only }) {
  const releaseVersion = version || currentVersion();
  const staged = Object.keys(targets).filter(target => {
    if (only && only !== 'all' && target !== only) return false;
    return fs.existsSync(manifestPath(target));
  });
  if (staged.length === 0) {
    throw new Error(`nothing staged under ${path.relative(root, pkgRoot)}`);
  }
  const main = readJson(mainManifest);
  main.version = releaseVersion;
  fs.writeFileSync(mainManifest, `${JSON.stringify(main, null, 2)}\n`);
  for (const target of staged) {
    const manifest = path.join(npmDir(target), 'package.json');
    const info = readJson(manifest);
    info.version = releaseVersion;
    delete info.private;
    info.publishConfig = { access: 'public' };
    const record = readJson(manifestPath(target));
    if (record.version !== releaseVersion) {
      record.version = releaseVersion;
      fs.writeFileSync(manifestPath(target), `${JSON.stringify(record, null, 2)}\n`);
    }
    fs.writeFileSync(manifest, `${JSON.stringify(info, null, 2)}\n`);
    console.log(`${npmName(target)}: unlocked at ${releaseVersion}`);
  }
  console.log(`${scope}/kode-mcp: main package at ${releaseVersion}`);
  return releaseVersion;
}

/**
 * Publish to the registry. Deliberately gated: it refuses unless
 * KODE_NPM_PUBLISH=1 is set, so an ordinary build can never reach the registry.
 *
 * Publishes the packed tarballs rather than re-packing the directories, so what
 * leaves this machine is byte-for-byte what pack verified.
 */
function publish({ dry }) {
  if (process.env.KODE_NPM_PUBLISH !== '1') {
    throw new Error('refusing to publish: set KODE_NPM_PUBLISH=1 to publish explicitly');
  }
  if (!fs.existsSync(distDir)) {
    throw new Error(`nothing to publish: ${path.relative(root, distDir)} is absent; run pack first`);
  }
  const tarballs = fs.readdirSync(distDir)
    .filter(name => name.endsWith('.tgz'))
    .map(name => path.join(distDir, name))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(`no tarballs in ${path.relative(root, distDir)}`);
  }
  for (const tarball of tarballs) {
    const args = ['publish', '--access', 'public', tarball];
    if (dry) args.push('--dry-run');
    runNpm(args, root);
  }
  console.log(`published ${tarballs.length} tarballs`);
}

function runNpm(args, directory) {
  const result = spawnSync('npm', args, { cwd: directory, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (${result.status ?? result.error?.message})`);
  }
}

if (!command) {
  console.error(
    'usage: npm-package.mjs <build|pack|verify|smoke|sizes|prepare|publish> [options]\n' +
      '  build  --target <linux-x64|…> [--from <binary>]   stage a prebuilt binary\n' +
      '  pack   [--target <target|all>]                      npm pack the staged set\n' +
      '  verify                                              static checks (always safe)\n' +
      '  smoke  [--target <target>]                          MCP handshake on a staged binary\n' +
      '  sizes                                               report tarball and binary sizes\n' +
      '  prepare [--target <target|all>] [--version <v>]     unlock staging for publishing\n' +
      '  publish [--dry]                                     gated by KODE_NPM_PUBLISH=1'
  );
  process.exit(2);
}
try {
  if (command === 'build') build({ target: flag('--target', ''), from: flag('--from', '') });
  else if (command === 'pack') pack({ only: flag('--target', 'all') });
  else if (command === 'verify') verify();
  else if (command === 'smoke') smoke({ target: flag('--target', '') });
  else if (command === 'sizes') sizes();
  else if (command === 'prepare') {
    prepare({ version: flag('--version', ''), targets: flag('--target', 'all') });
  } else if (command === 'publish') {
    publish({ dry: argv.includes('--dry') });
  } else {
    console.error(`unknown command ${command}`);
    process.exit(2);
  }
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
