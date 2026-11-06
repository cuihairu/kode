#!/usr/bin/env node
/**
 * 参考接收端真机回环探针(八场景:rename 覆盖 1-5 + .staged 源拒绝 6 +
 * 悬空别名拒绝 7 + .staged symlink 拒绝 8)。
 *
 * 十一轮证据绑定(round-11):探针把自己的采集身份写进输出头部,输出即
 * 原始 stdout、不做事后编辑——
 *   - 运行时 `git rev-parse HEAD` / `--abbrev-ref HEAD` / `git status --porcelain`
 *   - 运行时所执行探针文件与接收端文件的 sha256
 *   - 与 `git show HEAD:<path>` blob 的 sha256 对比(执行字节是否等于记录提交的字节)
 *
 * 用法: node scripts/hot-reload-receiver/winRoundtripProbe.mjs [接收端脚本路径]
 *       (省略则用同目录 referenceReceiver.mjs)
 * 输出: 逐场景 raw request/response 摘要 + FINAL_VERDICT;头部为运行时采集绑定。
 */
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const here = path.dirname(selfPath);
const receiverScript = process.argv[2] ?? path.join(here, 'referenceReceiver.mjs');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const sha256Hex = c => sha256(Buffer.from(c, 'utf8'));

const git = (args, opts = {}) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: opts.cwd ?? here, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).replace(/\n+$/, '');
  } catch (err) {
    return `unavailable (${String(err?.message ?? err).split('\n')[0]})`;
  }
};

const repoTop = git(['rev-parse', '--show-toplevel']);
const inRepo = repoTop !== '' && !repoTop.startsWith('unavailable');
const relOf = abs => (inRepo ? path.relative(repoTop, abs).split(path.sep).join('/') : abs);
const blobSha256 = abs => {
  if (!inRepo) return 'unavailable (no git toplevel)';
  const rel = relOf(abs);
  try {
    const buf = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repoTop, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    return sha256(buf);
  } catch (err) {
    return `unavailable (${String(err?.message ?? err).split('\n')[0]})`;
  }
};
const runtimeFileSha256 = abs => (existsSync(abs) ? sha256(readFileSync(abs)) : 'file-missing');

const lines = [];
const log = line => { lines.push(line); console.log(line); };

const bindingHeader = () => {
  const status = git(['status', '--porcelain']);
  log('# reference-receiver roundtrip probe — raw probe stdout, no post-editing of these lines');
  log(`# captured-at: ${new Date().toString()}`);
  log(`# host: ${os.hostname()} ${process.platform} ${os.release()} node ${process.version}`);
  log(`# git toplevel: ${inRepo ? repoTop : 'unavailable (running outside a git checkout)'}`);
  log(`# git rev-parse HEAD: ${git(['rev-parse', 'HEAD'])}`);
  log(`# git rev-parse --abbrev-ref HEAD: ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
  log(`# git status --porcelain: ${status === '' ? '(empty — clean worktree)' : status.split('\n').join(' | ')}`);
  const probeRel = relOf(selfPath);
  const recvRel = relOf(receiverScript);
  log(`# probe file: ${probeRel}`);
  log(`# probe sha256 (runtime bytes): ${runtimeFileSha256(selfPath)}`);
  log(`# probe sha256 (git show HEAD:${probeRel}): ${blobSha256(selfPath)}`);
  log(`# probe bytes == HEAD blob: ${runtimeFileSha256(selfPath) === blobSha256(selfPath)}`);
  log(`# receiver file: ${recvRel}`);
  log(`# receiver sha256 (runtime bytes): ${runtimeFileSha256(receiverScript)}`);
  log(`# receiver sha256 (git show HEAD:${recvRel}): ${blobSha256(receiverScript)}`);
  log(`# receiver bytes == HEAD blob: ${runtimeFileSha256(receiverScript) === blobSha256(receiverScript)}`);
  log('# scenarios: 1-5 rename overwrite roundtrip, 6 .staged source reject, 7 dangling alias reject, 8 .staged symlink reject');
};

const post = (port, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/reload', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
    let raw = '';
    res.on('data', c => { raw += c.toString('utf8'); });
    res.on('end', () => resolve({ status: res.statusCode, body: raw }));
  });
  req.on('error', reject);
  req.write(body);
  req.end();
});

const startReceiver = async (script, root, mode, scenario, extra = []) => {
  const proc = spawn(process.execPath, [script, '--port', '0', '--root', root, '--mode', mode, '--scenario', scenario, ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('receiver start timeout')), 8000);
    proc.stdout.on('data', c => {
      buf += c.toString('utf8');
      const m = buf.match(/KODE_RECEIVER_PORT=(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    proc.on('exit', code => { clearTimeout(t); reject(new Error(`receiver exited early code=${code} ${buf}`)); });
  });
  return { proc, port };
};

const main = async () => {
  bindingHeader();
  log(`receiver port: pending`);
  const root = mkdtempSync(path.join(os.tmpdir(), 'kode-win-probe-root-'));
  mkdirSync(path.join(root, 'engine'), { recursive: true });
  const receiver = await startReceiver(receiverScript, root, 'apply', 'applied', ['--artifact-dir', path.join(root, 'engine')]);
  const { proc, port } = receiver;
  log(`receiver port: ${port}`);
  log(`platform: ${process.platform} ${os.release()} node ${process.version}`);
  let verdict = 'PASS';
  try {
    const pyFile = path.join(root, 'Avatar.py');
    const engineFile = path.join(root, 'engine', 'Avatar.py');
    const apply = async content => {
      writeFileSync(pyFile, content, 'utf8');
      const body = JSON.stringify({ files: [pyFile], sender_digests: { [pyFile]: sha256Hex(content) } });
      const res = await post(port, body);
      return JSON.parse(res.body);
    };
    // 1) fresh apply
    const r1 = await apply('class Avatar:\n    HP = 100\n');
    log(`1) fresh apply     -> HTTP 200 ${JSON.stringify(r1)}`);
    log(`   artifact bytes  : ${JSON.stringify(readFileSync(engineFile, 'utf8'))}`);
    if (r1.status !== 'applied' || r1.revision !== 1) verdict = 'FAIL';
    // 2) overwrite apply (rename over existing target)
    const r2 = await apply('class Avatar:\n    HP = 200\n');
    log(`2) overwrite apply -> HTTP 200 ${JSON.stringify(r2)}`);
    log(`   artifact bytes  : ${JSON.stringify(readFileSync(engineFile, 'utf8'))}`);
    if (r2.status !== 'applied' || r2.revision !== 2) verdict = 'FAIL';
    // 3) idempotent replay
    const r3 = await apply('class Avatar:\n    HP = 200\n');
    log(`3) idempotent apply-> HTTP 200 ${JSON.stringify(r3)}`);
    if (r3.status !== 'applied' || r3.revision !== 3) verdict = 'FAIL';
    // 4) staged independent subdir
    const stagedPath = path.join(root, '.staged', 'Avatar.py');
    const stagedOk = existsSync(stagedPath) && readFileSync(stagedPath, 'utf8') === 'class Avatar:\n    HP = 200\n';
    log(`4) staged copy     : ${stagedOk}`);
    if (!stagedOk) verdict = 'FAIL';
    // 5) artifact parent symlink rejection
    mkdirSync(path.join(root, 'other'), { recursive: true });
    symlinkSync(path.join(root, 'other'), path.join(root, 'engine', 'sub'), 'dir');
    const subFile = path.join(root, 'sub', 'X.py');
    mkdirSync(path.dirname(subFile), { recursive: true });
    writeFileSync(subFile, 'X_SYMLINK_PROBE = 1\n', 'utf8');
    const body5 = JSON.stringify({ files: [subFile], sender_digests: { [subFile]: sha256Hex('X_SYMLINK_PROBE = 1\n') } });
    const res5 = await post(port, body5);
    const r5 = JSON.parse(res5.body);
    log(`5) symlink parent  -> HTTP ${res5.status} ${JSON.stringify(r5)}`);
    const leak = existsSync(path.join(root, 'other', 'X.py'));
    const linkIntact = lstatSync(path.join(root, 'engine', 'sub')).isSymbolicLink();
    log(`   leak check      : other/X.py exists = ${leak}`);
    log(`   link intact     : ${linkIntact}`);
    if (r5.status !== 'failed' || leak || !linkIntact) verdict = 'FAIL';
    // 6) batch containing a .staged-namespace source file → whole batch rejected
    const topFile = path.join(root, 'R9.py');
    const stagedSource = path.join(root, '.staged', 'R9.py');
    const topContent = 'R9_TOP = 1\n';
    const stagedContent = 'R9_STAGED_SRC = 2\n';
    mkdirSync(path.dirname(stagedSource), { recursive: true });
    writeFileSync(topFile, topContent, 'utf8');
    writeFileSync(stagedSource, stagedContent, 'utf8');
    const body6 = JSON.stringify({
      files: [topFile, stagedSource],
      sender_digests: { [topFile]: sha256Hex(topContent), [stagedSource]: sha256Hex(stagedContent) }
    });
    const res6 = await post(port, body6);
    const receipts6 = JSON.parse(res6.body);
    const allFailed = Array.isArray(receipts6) && receipts6.every(r => r.status === 'failed' && r.reason.includes('.staged'));
    const sourcesIntact = readFileSync(stagedSource, 'utf8') === stagedContent && readFileSync(topFile, 'utf8') === topContent;
    log(`6) .staged source reject -> HTTP ${res6.status} all-failed=${allFailed} sources-intact=${sourcesIntact}`);
    if (!allFailed || !sourcesIntact) verdict = 'FAIL';
    // 7) dangling alias source (root/alias -> root/.staged; alias/X.py not yet
    //    present) — in-batch staging of X.py would "complete" the alias target
    const aliasDir = path.join(root, 'alias');
    symlinkSync(path.join(root, '.staged'), aliasDir, 'dir');
    const topX = path.join(root, 'X.py');
    const aliasX = path.join(aliasDir, 'X.py');
    const xContent = 'X_DANGLE = 4\\n';
    writeFileSync(topX, xContent, 'utf8');
    const body8 = JSON.stringify({
      files: [topX, aliasX],
      sender_digests: { [topX]: sha256Hex(xContent), [aliasX]: sha256Hex(xContent) }
    });
    const res8 = await post(port, body8);
    const receipts8 = JSON.parse(res8.body);
    const allFailed8 = Array.isArray(receipts8) && receipts8.length === 2 && receipts8.every(r => r.status === 'failed' && r.reason.includes('符号链接'));
    const engineX = existsSync(path.join(root, 'engine', 'X.py'));
    const stagedX = existsSync(path.join(root, '.staged', 'X.py'));
    log(`7) dangling alias  -> HTTP ${res8.status} all-failed=${allFailed8} engine-x=${engineX} staged-x=${stagedX}`);
    if (!allFailed8 || engineX || stagedX) verdict = 'FAIL';
    // 8) .staged dir replaced by external symlink → staging refused, no escape
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'kode-win-probe-out-'));
    const escapeDir = path.join(outsideDir, 'escape');
    mkdirSync(escapeDir, { recursive: true });
    const root2 = mkdtempSync(path.join(os.tmpdir(), 'kode-win-probe-root2-'));
    symlinkSync(escapeDir, path.join(root2, '.staged'), 'dir');
    const f2 = path.join(root2, 'X.py');
    writeFileSync(f2, 'X_STAGE_LINK = 93\n', 'utf8');
    // second receiver instance (root2): stage mode is enough to verify refusal
    proc.kill();
    const rec2 = await startReceiver(receiverScript, root2, 'stage', 'accepted');
    const res7 = await post(rec2.port, JSON.stringify({ files: [f2] }));
    const r7 = JSON.parse(res7.body);
    const escapeEmpty = readdirSync(escapeDir).length === 0;
    log(`8) .staged symlink -> HTTP ${res7.status} ${JSON.stringify(r7)}`);
    log(`   escape dir empty: ${escapeEmpty}`);
    if (r7.status !== 'failed' || !r7.reason.includes('符号链接') || !escapeEmpty) verdict = 'FAIL';
    rec2.proc.kill();
  } finally {
    proc.kill();
  }
  log(`VERDICT: ${verdict === 'PASS' ? 'PASS (rename overwrite + staged namespace isolation + staged symlink rejection + dangling alias rejection hold on this platform)' : 'FAIL'}`);
  log(`FINAL_VERDICT=${verdict}`);
  process.exitCode = verdict === 'PASS' ? 0 : 1;
};

main().catch(err => { console.error(err?.stack ?? err); process.exit(1); });
