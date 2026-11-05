#!/usr/bin/env node
/**
 * 参考接收端(IDE-AUD-007):Kode 热更新 accepted/applied 回执契约的参考
 * 实现——零依赖 node:http,真实监听回环端口,真实读取所发文件、暂存副本、
 * 重算 sha256,按已记录契约回真实回包。用途:
 *  1. 引擎原生重载无 HTTP 回执(KBEngine.reloadScript 是 Python 调用,见
 *     docs/review/2026-10-30-completion-and-lint-audit.md AUD-007 实勘);
 *     accepted/applied JSON 契约作用于用户配置的 @http: quick action 回包体,
 *     本脚本是「会说该契约的服务端」参考实现,让请求/响应/digest 有真实
 *     样本可取,不再只拿模拟 JSON 字符串喂解析器。
 *  2. tests/hotReloadReceiverRoundtrip.test.ts 经它做真实回环联调。
 *
 * 已记录契约(docs/design/hot-reload-design.md §4 + src/hotReloadReceipt.ts):
 *   accepted: {"status":"accepted","file":"<所发文件绝对路径逐字回显>"}
 *   applied:  {"status":"applied","file":"<逐字回显>","digest":"<内容 sha256 hex>"}
 *   (可选 targetId;批量=逐条 JSON 数组)
 *
 * 用法:
 *   node referenceReceiver.mjs --port 0 --root <暂存目录> --mode stage|apply
 *        --scenario accepted|applied|digest-mismatch|echo|error500
 * 就绪后向 stdout 打一行 KODE_RECEIVER_PORT=<port>。
 *
 * - POST /reload:body 形如 {"files":[...]}(通道 ${files} 占位 substitution
 *   产物)或裸 JSON 数组;逐文件读盘、sha256、暂存副本进 --root,按 mode 回:
 *   - stage:   每文件一条 accepted(暂存=接收端已收下待重载)
 *   - apply:   每文件一条 applied,digest=接收端对所发文件重算的 sha256
 *   - digest-mismatch: 形态同 applied 但 digest 故意错(可疑回执样本)
 *   - echo:    回纯文本非 JSON(未知结构样本)
 * - GET /probe(其余任何路径):200 "ok"(连通性探测面)。
 * - --scenario error500:重载端点回 500。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const argValue = name => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

const port = Number(argValue('--port') ?? 0);
const root = argValue('--root') ?? process.cwd();
const mode = argValue('--mode') ?? 'stage';
const scenario = argValue('--scenario') ?? (mode === 'apply' ? 'applied' : 'accepted');

mkdirSync(root, { recursive: true });

const sha256Hex = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET') {
    // 连通性探测面(transport probe 用 GET 无体请求)
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (url.pathname !== '/reload') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  if (scenario === 'error500') {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('internal receiver error (scenario)');
    return;
  }

  let raw = '';
  request.on('data', chunk => {
    raw += chunk.toString('utf8');
  });
  request.on('end', () => {
    if (scenario === 'echo') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('receiver said ok, move along');
      return;
    }
    let files;
    try {
      const parsed = JSON.parse(raw);
      files = Array.isArray(parsed) ? parsed : parsed.files;
    } catch {
      files = undefined;
    }
    if (!Array.isArray(files) || files.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', reason: 'body 无 files 数组' }));
      return;
    }
    const receipts = [];
    for (const file of files) {
      if (typeof file !== 'string') {
        continue;
      }
      // 接收端视角:读所发文件、留暂存副本、对收到的内容重算 digest
      let content = '';
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        receipts.push({ status: 'failed', file, reason: '接收端读不到所发文件' });
        continue;
      }
      const staged = path.join(root, path.basename(file));
      try {
        copyFileSync(file, staged);
      } catch {
        // 暂存失败不影响回执证据面
      }
      const digest = sha256Hex(content);
      if (mode === 'apply') {
        receipts.push({
          status: 'applied',
          file,
          digest: scenario === 'digest-mismatch' ? digest.replace(/^./, d => (d === '0' ? '1' : '0')) : digest
        });
      } else {
        receipts.push({ status: 'accepted', file });
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    // 单文件=单对象回执(@http: quick action 逐文件口径,hotReloadReceipt
    // 单目标协议);多文件=逐条数组(parseReloadHttpReceipts 批量口径)。
    response.end(JSON.stringify(receipts.length === 1 ? receipts[0] : receipts));
  });
});

server.listen(port, '127.0.0.1', () => {
  const actual = server.address();
  process.stdout.write(`KODE_RECEIVER_PORT=${actual.port}\n`);
});
