// Native release packaging shared by nightly and future Marketplace publishing.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, packageVsix } from './vsix-staging.mjs';

export const targets = {
  'linux-x64': { rust: 'x86_64-unknown-linux-musl', os: 'linux', arch: 'x64' },
  'linux-arm64': { rust: 'aarch64-unknown-linux-musl', os: 'linux', arch: 'arm64' },
  'win32-x64': { rust: 'x86_64-pc-windows-msvc', os: 'win32', arch: 'x64' },
  'win32-arm64': { rust: 'aarch64-pc-windows-msvc', os: 'win32', arch: 'arm64' },
  'darwin-x64': { rust: 'x86_64-apple-darwin', os: 'darwin', arch: 'x64' },
  'darwin-arm64': { rust: 'aarch64-apple-darwin', os: 'darwin', arch: 'arm64' },
};
export const binaries = ['kode-server', 'kode-kbengine', 'kode-mcp'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function smokeBinaries(directory, target) {
  const spec = targets[target];
  if (!spec || spec.os !== process.platform || spec.arch !== process.arch) {
    throw new Error(`Smoke requires native ${target}, running ${process.platform}-${process.arch}`);
  }
  const suffix = spec.os === 'win32' ? '.exe' : '';
  const frame = message => {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  };
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
    { jsonrpc: '2.0', method: 'initialized', params: {} },
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: {
      uri: path.resolve('tests/fixtures/kbengine-demo-assets/scripts/entity_defs/Avatar.def'),
      languageId: 'kbengine-def', version: 1,
      text: fs.readFileSync('tests/fixtures/kbengine-demo-assets/scripts/entity_defs/Avatar.def', 'utf8'),
    } } },
    { jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: {
      textDocument: { uri: path.resolve('tests/fixtures/kbengine-demo-assets/scripts/entity_defs/Avatar.def') },
      position: { line: 35, character: 18 },
    } },
    { jsonrpc: '2.0', id: 2, method: 'shutdown', params: null },
    { jsonrpc: '2.0', method: 'exit' },
  ].map(frame).join('');
  const server = run(path.resolve(directory, `kode-server${suffix}`), [], {
    input, encoding: 'utf8', stdio: 'pipe', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  let output = server.stdout;
  const replies = [];
  while (output.length) {
    const boundary = output.indexOf('\r\n\r\n');
    const length = /^Content-Length:\s*(\d+)/im.exec(output.slice(0, boundary));
    if (boundary < 0 || !length) { throw new Error('Invalid server framing'); }
    // LSP JSON replies may contain Unicode: consume byte lengths, not JS character counts.
    const bytes = Buffer.from(output.slice(boundary + 4));
    const size = Number(length[1]);
    if (bytes.length < size) { throw new Error('Truncated server response'); }
    replies.push(JSON.parse(bytes.subarray(0, size).toString('utf8')));
    output = bytes.subarray(size).toString('utf8');
  }
  if (!replies.some(reply => reply.id === 1 && reply.result?.capabilities)
      || !replies.some(reply => reply.id === 2 && reply.result === null)
      || !replies.some(reply => reply.id === 3 && reply.result?.range?.start?.line >= 60
        && reply.result?.range?.start?.line <= 62)
      || replies.some(reply => reply.error)) {
    throw new Error(`LSP lifecycle smoke failed: ${server.stdout}\n${server.stderr}`);
  }
  const cli = run(path.resolve(directory, `kode-kbengine${suffix}`), ['--version'], {
    encoding: 'utf8', stdio: 'pipe', timeout: 10000,
  });
  if (!/kode-kbengine\s+\d+\./.test(cli.stdout)) { throw new Error(`Invalid CLI version: ${cli.stdout}`); }
  const schema = run(path.resolve(directory, `kode-kbengine${suffix}`), [
    'schema', 'validate', '--project', path.resolve('tests/fixtures/kbengine-demo-assets'),
    '--defaults', path.resolve('crates/kode-kbengine/tests/fixtures/messages_fixed_defaults.xml'),
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 20000 });
  const report = JSON.parse(schema.stdout);
  if (report.valid !== true || report.entities < 1 || !/^[a-f0-9]{64}$/.test(report.sha256)) {
    throw new Error(`CLI schema validation failed: ${schema.stdout}`);
  }
  // kode-mcp stdio smoke (MCP uses newline-delimited JSON, not LSP framing;
  // 2026-11-13 built-in MCP hosting ships the binary in platform packages).
  const mcpInput = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'platform-smoke', version: '0.0.0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n';
  const mcp = run(path.resolve(directory, `kode-mcp${suffix}`), [path.resolve('tests/fixtures/kbengine-demo-assets')], {
    input: mcpInput, encoding: 'utf8', stdio: 'pipe', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  const mcpReplies = mcp.stdout.split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  if (!mcpReplies.some(reply => reply.id === 1 && reply.result?.serverInfo?.name === 'kode-mcp')
      || !mcpReplies.some(reply => reply.id === 2 && Array.isArray(reply.result?.tools) && reply.result.tools.length >= 20)
      || mcpReplies.some(reply => reply.error)) {
    throw new Error(`MCP handshake smoke failed: ${mcp.stdout}\n${mcp.stderr}`);
  }
  console.log(`Native executable smoke passed: ${target}`);
}

export function packagePlatform(target) {
  const spec = targets[target];
  if (!spec || spec.os !== process.platform || spec.arch !== process.arch) {
    throw new Error(`Unsupported or non-native target: ${target}`);
  }
  const env = { ...process.env };
  if (spec.os === 'linux') {
    const key = `CARGO_TARGET_${spec.rust.toUpperCase().replaceAll('-', '_')}_LINKER`;
    env[key] ??= 'rust-lld';
  }
  run('cargo', ['build', '--locked', '--release', '--target', spec.rust,
    '-p', 'kode-server', '--bin', 'kode-server', '-p', 'kode-kbengine', '--bin', 'kode-kbengine',
    '-p', 'kode-mcp', '--bin', 'kode-mcp'], { env });
  fs.rmSync('bin', { recursive: true, force: true });
  fs.mkdirSync('bin');
  const files = {};
  for (const binary of binaries) {
    const name = `${binary}${spec.os === 'win32' ? '.exe' : ''}`;
    fs.copyFileSync(path.join('target', spec.rust, 'release', name), path.join('bin', name));
    fs.chmodSync(path.join('bin', name), 0o755);
    files[name] = sha256(fs.readFileSync(path.join('bin', name)));
  }
  smokeBinaries('bin', target);
  const commit = run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).stdout.trim();
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  fs.writeFileSync('bin/manifest.json', JSON.stringify({ target, rustTarget: spec.rust, version, commit, files }, null, 2));
  const output = packageVsix({ target });
  run(process.execPath, ['scripts/verify-platform-vsix.mjs', output, target]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { packagePlatform(process.argv[2]); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
