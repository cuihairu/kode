#!/usr/bin/env node
/**
 * IDE-AUD-007 证据探针:拉起参考接收端(referenceReceiver.mjs)做真实回环
 * 联调,把「请求、响应与所应用 digest」的原始样本落盘——协议证据不再只是
 * 模拟 JSON 字符串喂解析器。解析/升格行为本身由
 * tests/hotReloadReceiverRoundtrip.test.ts 钉住;本脚本负责采集 wire 样本。
 *
 * 用法: node scripts/hot-reload-receiver/roundtripProbe.mjs [输出文件]
 * 输出: 逐场景 raw request line+body、raw response status+body、digest 对照。
 */

import { spawn, execFileSync } from 'child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const receiverScript = path.join(here, 'referenceReceiver.mjs');
const outPath = process.argv[2] ?? path.join(here, '..', '..', 'docs', 'perf', '2026-11-05-aud007-receiver-roundtrip.txt');

const lines = [];
const log = line => lines.push(line);

const httpRequest = (port, method, reqPath, body) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: { 'content-type': 'application/json' } },
      response => {
        let raw = '';
        response.on('data', chunk => {
          raw += chunk.toString('utf8');
        });
        response.on('end', () => resolve({ status: response.statusCode, body: raw }));
      }
    );
    request.on('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });

const startReceiver = async (mode, scenario) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-probe-'));
  const proc = spawn(process.execPath, [
    receiverScript, '--port', '0', '--root', root, '--mode', mode, '--scenario', scenario
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('receiver 启动超时')), 5000);
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/KODE_RECEIVER_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`receiver 提前退出 code=${code}`));
    });
  });
  return { port, root, proc };
};

const sha256Hex = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const scenarioRun = async (mode, scenario, fileBody, label) => {
  log('');
  log(`### 场景 ${label}(mode=${mode} scenario=${scenario})`);
  const receiver = await startReceiver(mode, scenario);
  const { proc, port, root } = receiver;
  try {
    const probe = await httpRequest(receiver.port, 'GET', '/probe');
    log(`GET /probe -> HTTP ${probe.status} "${probe.body}"(连通性探测面)`);
    // F3 三轮:请求报文带 sender_digests(发送方冻结 digest 随报文下发)
    const body = JSON.stringify({
      files: [fileBody.path],
      sender_digests: { [fileBody.path]: sha256Hex(fileBody.content) }
    });
    log(`POST /reload`);
    log(`  request body : ${body}`);
    const response = await httpRequest(receiver.port, 'POST', '/reload', body);
    log(`  response     : HTTP ${response.status} ${response.body}`);
    let receipt = {};
    try {
      const parsed = JSON.parse(response.body);
      receipt = Array.isArray(parsed) ? parsed[0] ?? {} : parsed;
    } catch {
      log('  (回包非 JSON:未知结构样本,扩展侧解析器保持未确认不升格)');
    }
    const expected = sha256Hex(fileBody.content);
    log(`  所发内容 sha256 : ${expected}`);
    log(`  回执 digest     : ${receipt.digest ?? '(无)'}`);
    log(`  digest 对照     : ${receipt.digest === expected ? '一致(applied 可核验)' : scenario === 'digest-mismatch' ? '故意不符(可疑回执样本,扩展侧核验必须不升格)' : 'accepted 面无 digest(应用核验归 applied 阶段)'}`);
    return { response, receipt, expected };
  } finally {
    proc.kill();
    rmSync(receiver.root, { recursive: true, force: true });
  }
};

const main = async () => {
  log('IDE-AUD-007 参考接收端真实回环联调样本');
  log(`时间: ${new Date().toISOString()}`);
  log(`主机: ${os.hostname()} node ${process.version}`);
  log('接收端: scripts/hot-reload-receiver/referenceReceiver.mjs(零依赖 node:http,已记录契约参考实现)');
  log('契约: {"status":"accepted","file":<逐字回显>} / {"status":"applied","file":<逐字回显>,"digest":<sha256 hex>}');
  log('      请求报文带 sender_digests(F3 三轮:发送方冻结 digest 随报文下发,接收端对引擎应用产物核验后才回 applied)');
  log('背景: 引擎原生重载 KBEngine.reloadScript 无 HTTP 回执(docs/review/2026-10-30-completion-and-lint-audit.md');
  log('      AUD-007 实勘);accepted/applied 契约作用于用户配置 @http: quick action 回包体,本探针提供会说');
  log('      该契约的真实服务端与真实 wire 样本。解析/升格行为由 tests/hotReloadReceiverRoundtrip.test.ts 钉住。');

  const workdir = mkdtempSync(path.join(os.tmpdir(), 'kode-aud007-probe-file-'));
  const pyFile = path.join(workdir, 'Avatar.py');
  const content = 'class Avatar:\n    HP_BASE = 100\n';
  writeFileSync(pyFile, content, 'utf8');

  const gitRev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(here, '..', '..') }).toString().trim();
  log(`基线: feat/kode-rev @ ${gitRev}`);

  await scenarioRun('stage', 'accepted', { path: pyFile, content }, 'accepted(暂存回执)');
  await scenarioRun('apply', 'applied', { path: pyFile, content }, 'applied(digest 双证回执)');
  await scenarioRun('apply', 'digest-mismatch', { path: pyFile, content }, 'digest 不符(可疑回执)');
  await scenarioRun('stage', 'echo', { path: pyFile, content }, '非 JSON 回包(未知结构)');
  await scenarioRun('stage', 'error500', { path: pyFile, content }, '非 2xx(送达失败)');

  rmSync(workdir, { recursive: true, force: true });
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`样本已落盘: ${outPath}\n`);
};

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
