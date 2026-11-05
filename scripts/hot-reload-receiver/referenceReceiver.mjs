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
 *   applied:  {"status":"applied","file":"<逐字回显>","digest":"<内容 sha256 hex>",
 *              "revision":<本次应用的全局递增版本号>}
 *   (可选 targetId:请求体给了就逐字回显;批量=逐条 JSON 数组)
 *
 * F3(2026-11-05 审核):applied 必须是「真实应用后」的协议证据,不是读取
 * +复制就能自称的状态——
 *  - apply 模式必须配置 --apply-command <shell 命令>(真实应用实现,例如调
 *    引擎 reloadScript 的包装脚本);逐文件执行,退出码 0 才回 applied,
 *    并把 revision/file/digest/命令/输出逐条落 <root>/applied-revisions.jsonl
 *    (应用后证据);非 0 如实回 failed(带退出码与 stderr 尾行),不冒充。
 *  - 未配置 --apply-command 时如实回 accepted(仅暂存,未应用)+未配置原因,
 *    不落应用台账——没有引擎调用就没有 applied 证据,契约口径见 todo 的
 *    「缺服务端依据时保持开放」。
 *  - 暂存副本失败如实回 failed(不再静默忽略后继续自称 accepted/applied)。
 *
 * 用法:
 *   node referenceReceiver.mjs --port 0 --root <暂存目录> --mode stage|apply
 *        [--apply-command <shell 命令>]
 *        --scenario accepted|applied|digest-mismatch|echo|error500
 * 就绪后向 stdout 打一行 KODE_RECEIVER_PORT=<port>。
 *
 * - POST /reload:body 形如 {"files":[...],"targetId":"..."}(通道 ${files}/
 *   ${targetId} 占位 substitution 产物)或裸 JSON 数组;逐文件读盘、sha256、
 *   暂存副本进 --root,按 mode 回:
 *   - stage:   每文件一条 accepted(暂存=接收端已收下待重载)
 *   - apply:   真实执行 --apply-command 成功后每文件一条 applied
 *              (digest=接收端对所发文件重算的 sha256,revision 递增)
 *   - digest-mismatch: 形态同 applied 但 digest 故意错(可疑回执样本)
 *   - echo:    回纯文本非 JSON(未知结构样本)
 * - GET /probe(其余任何路径):200 "ok"(连通性探测面)。
 * - --scenario error500:重载端点回 500。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const argValue = name => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
};

const port = Number(argValue('--port') ?? 0);
const root = argValue('--root') ?? process.cwd();
const mode = argValue('--mode') ?? 'stage';
const applyCommand = argValue('--apply-command');
const scenario = argValue('--scenario') ?? (mode === 'apply' ? 'applied' : 'accepted');

mkdirSync(root, { recursive: true });

const sha256Hex = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
const APPLIED_LEDGER = path.join(root, 'applied-revisions.jsonl');
let appliedRevision = 0;

const recordApplied = entry => {
  appendFileSync(APPLIED_LEDGER, `${JSON.stringify(entry)}\n`, 'utf8');
};

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
    let targetId;
    try {
      const parsed = JSON.parse(raw);
      files = Array.isArray(parsed) ? parsed : parsed.files;
      if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && typeof parsed.targetId === 'string') {
        targetId = parsed.targetId;
      }
    } catch {
      files = undefined;
    }
    if (!Array.isArray(files) || files.length === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', reason: 'body 无 files 数组' }));
      return;
    }
    const withTarget = receipt => (targetId !== undefined ? { ...receipt, targetId } : receipt);
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
        receipts.push(withTarget({ status: 'failed', file, reason: '接收端读不到所发文件' }));
        continue;
      }
      const staged = path.join(root, path.basename(file));
      try {
        copyFileSync(file, staged);
      } catch (error) {
        // F3:暂存失败如实回 failed,不再静默忽略后继续自称已收下
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `接收端暂存副本失败:${error instanceof Error ? error.message : String(error)}`
          })
        );
        continue;
      }
      const digest = sha256Hex(content);
      if (mode !== 'apply') {
        receipts.push(withTarget({ status: 'accepted', file }));
        continue;
      }
      // F3:applied 只能来自真实应用实现——没有配置应用命令就如实回
      // accepted(仅暂存,未应用),绝不自称 applied
      if (!applyCommand) {
        receipts.push(
          withTarget({
            status: 'accepted',
            file,
            note: '接收端未配置真实应用命令(--apply-command),仅暂存未应用,不自称 applied'
          })
        );
        continue;
      }
      const result = spawnSync(applyCommand, {
        shell: true,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          KODE_RELOAD_FILE: file,
          KODE_RELOAD_DIGEST: digest,
          ...(targetId !== undefined ? { KODE_RELOAD_TARGET_ID: targetId } : {})
        }
      });
      if (result.error) {
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `应用命令执行失败:${result.error.message}`
          })
        );
        continue;
      }
      if (result.status !== 0) {
        const stderrTail = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
        receipts.push(
          withTarget({
            status: 'failed',
            file,
            reason: `应用命令失败(exit ${result.status})${stderrTail ? `:${stderrTail}` : ''}`
          })
        );
        continue;
      }
      appliedRevision += 1;
      const entry = {
        revision: appliedRevision,
        file,
        digest,
        command: applyCommand,
        stdout: (result.stdout ?? '').trim(),
        appliedAt: new Date().toISOString()
      };
      try {
        recordApplied(entry);
      } catch {
        // 台账落盘失败不影响回执协议证据本身(revision 已递增)
      }
      receipts.push(
        withTarget({
          status: 'applied',
          file,
          digest: scenario === 'digest-mismatch' ? digest.replace(/^./, d => (d === '0' ? '1' : '0')) : digest,
          revision: appliedRevision
        })
      );
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
