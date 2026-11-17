'use strict';
// QA-004(旧 KSEM-QA-04)交互截止测量辅助:LSP stdio 假服务器。握手应答后
// 对其余请求按模式处置——hang(默认,存活但无响应)或 cancel-ack(仅在收到
// $/cancelRequest 时对被取消 id 回 -32800)。扰动钩子(仅 prove-red 用):
// DEAD_HEALTH_ECHO=1 收到任意请求即回空结果;DEAD_CANCEL_MUTE=1 时 cancel-ack
// 模式不回 -32800;DEAD_DELAY_MS=<n> 每次处置前延迟 n 毫秒。

const mode = process.argv[2] === 'cancel-ack' ? 'cancel-ack' : 'hang';
const delayMs = Number(process.env.DEAD_DELAY_MS || 0);
const healthEcho = process.env.DEAD_HEALTH_ECHO === '1';
const cancelMute = process.env.DEAD_CANCEL_MUTE === '1';

let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer.toString('ascii'));
    if (!header) {
      if (buffer.length > 64 * 1024) buffer = Buffer.alloc(0);
      return;
    }
    const bodyLength = Number(header[1]);
    const start = header[0].length;
    if (buffer.length < start + bodyLength) return;
    const body = buffer.subarray(start, start + bodyLength).toString('utf8');
    buffer = Buffer.from(buffer.subarray(start + bodyLength));
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
});

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    // 协议版本经环境传入(套件从 src 读 KODE_PROTOCOL_VERSION),版本演进自动跟
    reply(id, { capabilities: {}, serverInfo: { version: process.env.DEAD_PROTOCOL_VERSION || '0.2.0' } });
    return;
  }
  if (method === 'shutdown') {
    reply(id, null);
    return;
  }
  if (method === 'exit') {
    process.exit(0);
  }
  if (method === '$/cancelRequest' && mode === 'cancel-ack' && !cancelMute) {
    // 假服务器只在真实收到 $/cancelRequest 时回 -32800:错误包到达即证明
    // 取消链经传输层传播,而非客户端本地伪造(CORE-007 验收语义)。
    setTimeout(() => replyError(params.id, -32800, 'request cancelled via $/cancelRequest'), delayMs);
    return;
  }
  if (healthEcho) {
    setTimeout(() => reply(id, null), delayMs);
    return;
  }
  // hang(默认):存活但无响应 —— 请求永不结算。
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
