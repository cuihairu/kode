// kode2 PR-003 单测替身:最小 stdio LSP 服务器(无需 Rust 工具链)。
// 用法:node tests/helpers/kodeFakeServer.cjs [crashMethod|挂死模式]
//   crashMethod 非空时,收到同名请求立即 exit(1)(测崩溃重启)。
//   模式令牌(与 crashMethod 互斥,可同时出现):
//     hangShutdown    — shutdown 请求永不回包(测 dispose 超时 SIGKILL,CORE-1)
//     exitOnShutdown  — 收到 shutdown 后延迟自行 exit 且不回包(测 exit 竞态)
//     traceCancels    — 记录收到的全部 $/cancelRequest id,kode/cancels 可查
//                       (测 CORE-2 正常完成后的迟到取消)
//     failHandshakeAfterCrash — 与 markerPath=<file> 配合:crashMethod 触发时
//                       写标记文件;重启后的新进程 initialize 看到标记即回
//                       -32002 SERVER_NOT_INITIALIZED(测 CORE-3 握手失败语义)
'use strict';

const fs = require('fs');

const MODE_TOKENS = ['hangShutdown', 'exitOnShutdown', 'traceCancels', 'failHandshakeAfterCrash'];
const args = process.argv.slice(2);
const crashMethod = args.find(a => !MODE_TOKENS.includes(a) && !a.startsWith('markerPath=')) || null;
const hangShutdown = args.includes('hangShutdown');
const exitOnShutdown = args.includes('exitOnShutdown');
const traceCancels = args.includes('traceCancels');
const failHandshakeAfterCrash = args.includes('failHandshakeAfterCrash');
const markerPath = (args.find(a => a.startsWith('markerPath=')) || '').slice('markerPath='.length) || null;

let buffer = Buffer.alloc(0);
let shutdown = false;
const documents = new Map();
const waitTimers = new Map();
const cancelTrace = new Set();

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
  );
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (isRequest && msg.method === crashMethod) {
    if (failHandshakeAfterCrash && markerPath) {
      // CORE-3 替身:崩溃时留标记,重启出的新进程据此让 initialize 失败
      try {
        fs.writeFileSync(markerPath, 'crashed');
      } catch {
        // 写不了标记就退化为普通崩溃
      }
    }
    process.exit(1);
  }
  switch (msg.method) {
    case 'initialize':
      if (failHandshakeAfterCrash && markerPath && fs.existsSync(markerPath)) {
        // 行为对齐 kode-server/src/server.rs 未初始化态的 -32002
        return replyError(msg.id, -32002, 'Server not initialized');
      }
      return reply(msg.id, {
        capabilities: { textDocumentSync: { openClose: true, change: 1 } },
        serverInfo: { name: 'kode-fake-server', version: '0.0.0-test' },
      });
    case 'initialized':
      return;
    case 'shutdown':
      if (hangShutdown || exitOnShutdown) {
        // CORE-1 替身:不回包模拟挂死;exitOnShutdown 额外延迟自行退出,
        // 复现 dispose 在 shutdown 等待期间子进程先退出的竞态。
        if (exitOnShutdown) {
          setTimeout(() => process.exit(0), 150);
        }
        return;
      }
      shutdown = true;
      return reply(msg.id, null);
    case 'exit':
      return process.exit(shutdown ? 0 : 1);
    case 'textDocument/didOpen':
      documents.set(msg.params.textDocument.uri, { version: msg.params.textDocument.version });
      return;
    case 'textDocument/didChange':
      documents.set(msg.params.textDocument.uri, { version: msg.params.textDocument.version });
      return;
    case 'textDocument/didClose':
      documents.delete(msg.params.textDocument.uri);
      return;
    case '$/cancelRequest': {
      if (traceCancels) {
        cancelTrace.add(Number(msg.params.id));
      }
      const key = String(msg.params.id);
      const timer = waitTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        waitTimers.delete(key);
        replyError(Number(msg.params.id), -32800, 'cancelled');
      }
      return;
    }
    case '$/kode/health':
      return reply(msg.id, {
        status: 'ok',
        pid: process.pid,
        serverVersion: '0.0.0-test',
        uptimeMs: 0,
        initialized: true,
        shutdownRequested: shutdown,
        restartGeneration: 0,
        documents: [...documents.entries()].map(([uri, d]) => ({ uri, version: d.version })),
      });
    case '$/kode/wait': {
      const key = String(msg.id);
      const ms = (msg.params && msg.params.ms) || 0;
      const timer = setTimeout(() => {
        waitTimers.delete(key);
        reply(msg.id, { waitedMs: ms });
      }, ms);
      waitTimers.set(key, timer);
      return;
    }
    case 'kode/pid':
      return reply(msg.id, { pid: process.pid });
    case 'kode/cancels':
      return reply(msg.id, { ids: [...cancelTrace].sort((a, b) => a - b) });
    default:
      if (isRequest) {
        return replyError(msg.id, -32601, `method not found: ${msg.method}`);
      }
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const match = /^Content-Length: (\d+)\r\n\r\n/.exec(
      buffer.toString('ascii', 0, Math.min(buffer.length, 512))
    );
    if (!match) return;
    const headerEnd = match[0].length;
    const bodyLength = Number(match[1]);
    if (buffer.length < headerEnd + bodyLength) return;
    const body = buffer.subarray(headerEnd, headerEnd + bodyLength);
    buffer = Buffer.from(buffer.subarray(headerEnd + bodyLength));
    try {
      handle(JSON.parse(body.toString('utf8')));
    } catch (error) {
      replyError(null, -32700, `parse error: ${error.message}`);
    }
  }
});
