// kode2 PR-003 单测替身:最小 stdio LSP 服务器(无需 Rust 工具链)。
// 用法:node tests/helpers/kodeFakeServer.cjs [crashMethod]
//   crashMethod 非空时,收到同名请求立即 exit(1)(测崩溃重启)。
// 行为对齐 kode-server:initialize 协商、didOpen/didChange/didClose、
// $/kode/health、可取消的 $/kode/wait、shutdown/exit。
'use strict';

const crashMethod = process.argv[2] || null;

let buffer = Buffer.alloc(0);
let shutdown = false;
const documents = new Map();
const waitTimers = new Map();

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
    process.exit(1);
  }
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        capabilities: { textDocumentSync: { openClose: true, change: 1 } },
        serverInfo: { name: 'kode-fake-server', version: '0.0.0-test' },
      });
    case 'initialized':
      return;
    case 'shutdown':
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
