#!/usr/bin/env node
// 红队替身(2026-11-15 审计 P1-2 prove-red):协议握手/健康面全真,
// 语义三面(definition/completion)恒 null、diagnostic 恒空 items——
// 用户实测此形态曾 5/5 通过旧门。用法:
//   KODE_SERVING_BINARY=/tmp/kode-null-stub.mjs KODE_SERVING_GATE=1 ...
let buffer = Buffer.alloc(0);
let documents = 0;

const send = (id, result) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const handleMessage = msg => {
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === 'textDocument/didOpen') {
      documents += 1;
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send(msg.id, {
        capabilities: {},
        serverInfo: { name: 'kode-server', version: '0.2.0' }
      });
      break;
    case '$/kode/health':
      send(msg.id, {
        initialized: true,
        documents: Array.from({ length: documents }, (_, i) => `doc-${i}`),
        pid: process.pid,
        restartGeneration: 0
      });
      break;
    case 'textDocument/definition':
    case 'textDocument/completion':
    case 'textDocument/hover':
      send(msg.id, null);
      break;
    case 'textDocument/diagnostic':
      send(msg.id, { kind: 'full', items: [] });
      break;
    default:
      send(msg.id, null);
  }
};

// 字节级 LSP 帧解析:头(\r\n\r\n 结)+ Content-Length 定长体。
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) {
      return;
    }
    const header = buffer.slice(0, sep).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.slice(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buffer.length - (sep + 4) < len) {
      return;
    }
    const body = buffer.slice(sep + 4, sep + 4 + len);
    buffer = buffer.slice(sep + 4 + len);
    try {
      handleMessage(JSON.parse(body.toString('utf8')));
    } catch {
      // 坏帧丢弃,替身不崩
    }
  }
});
