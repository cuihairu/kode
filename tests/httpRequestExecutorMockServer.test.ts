import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { executeHttpRequest } from '../src/backend/httpRequestExecutor';
import { parseReloadHttpReceipts } from '../src/backend/hotReloadTransport';

// HR-HTTP-017 mock server e2e(真网,默认 node 传输面,非注入 fake):
// 慢响应、chunked、malformed JSON、状态码、断网(连接拒绝/响应中断)、
// 重复请求、服务端成功但本地超时。每例独立临时服务(端口 0 随机),
// 用完即关,不跨例串状态。

interface TestServer {
  readonly url: string;
  hits: () => number;
  close: () => Promise<void>;
}

const startServer = (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<TestServer> =>
  new Promise(resolve => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise(done => server.close(() => done()))
      });
    });
  });

const servers: TestServer[] = [];
const track = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<TestServer> => {
  const server = await startServer(handler);
  servers.push(server);
  return server;
};

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

const post = (url: string, timeoutMs = 3000) =>
  executeHttpRequest({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'module_name=Account',
    timeoutMs
  });

describe('HR-HTTP-017 mock server e2e(真网默认传输面)', () => {
  it('2xx+JSON 回执:执行器 ok → 回执解析 applied(全链 HR-HTTP-010)', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { file: 'Account.py', status: 'applied', digest: 'sha256:abc', targetId: 'cell-1' }
        ])
      );
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('ok');
    expect(outcome.transportOk).toBe(true);
    expect(outcome.status).toBe(200);
    const receipts = parseReloadHttpReceipts(outcome.body, ['Account.py'], 'cell-1');
    expect(receipts).toEqual([
      { status: 'applied', file: 'Account.py', digest: 'sha256:abc', targetId: 'cell-1' }
    ]);
  });

  it('2xx 非 JSON 回包:已送达但不 claim applied(sent_unverified 本质)', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok - plain text, no receipt protocol');
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('ok');
    const receipts = parseReloadHttpReceipts(outcome.body, ['Account.py'], undefined);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    expect(receipt).toMatchObject({ status: 'sent', file: 'Account.py' });
    if (receipt.status === 'sent') {
      expect(receipt.detail).toContain('非 JSON');
    }
  });

  it('2xx JSON 但无匹配 file 条目:同样不 claim applied', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('ok');
    const receipts = parseReloadHttpReceipts(outcome.body, ['Account.py'], undefined);
    expect(receipts[0]).toMatchObject({ status: 'sent', file: 'Account.py' });
  });

  it('状态码 500:non-2xx + http-status 细类', async () => {
    const server = await track((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('non-2xx');
    expect(outcome.errorCategory).toBe('http-status');
    expect(outcome.transportOk).toBe(true);
    expect(outcome.status).toBe(500);
  });

  it('慢响应+本地超时:客户端 timeout;服务端随后仍完成 200(outcome 只报超时,不 claim 应用失败)', async () => {
    let serverFinished: (status: number) => void = () => undefined;
    const serverDone = new Promise<number>(resolve => {
      serverFinished = resolve;
    });
    const server = await track((_req, res) => {
      // 服务端处理很慢:客户端超时早于应答;完成后仍回 200(应用可能已生效)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('late success');
        serverFinished(200);
      }, 500);
    });
    const outcome = await post(`${server.url}/hotfix`, 100);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.errorCategory).toBe('timeout');
    expect(outcome.status).toBe(0);
    // 服务端最终确实完成:本地超时≠远端失败,outcome 不对「应用与否」下断言
    await serverDone;
    expect(server.hits()).toBe(1);
  });

  it('断网·连接拒绝:端口已关 → network-error/connection-refused', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200);
      res.end('never reached');
    });
    const port = (server.url.match(/:(\d+)$/) ?? [])[1];
    await server.close();
    // 端口已释放:新连接触发 ECONNREFUSED
    const outcome = await post(`http://127.0.0.1:${port}/hotfix`);
    expect(outcome.kind).toBe('network-error');
    expect(outcome.errorCategory).toBe('connection-refused');
    expect(outcome.transportOk).toBe(false);
    expect(outcome.errorMessage).toContain('ECONNREFUSED');
  });

  it('断网·响应中断:服务端中途摧毁 socket → connection-reset', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      setTimeout(() => {
        res.socket?.destroy();
      }, 30);
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('network-error');
    expect(outcome.errorCategory).toBe('connection-reset');
    expect(outcome.transportOk).toBe(false);
  });

  it('chunked 应答(无 content-length 分块写):客户端完整拼接', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('Acc');
      res.write('ount');
      res.write('.py');
      res.end();
    });
    const outcome = await post(`${server.url}/hotfix`);
    expect(outcome.kind).toBe('ok');
    expect(outcome.body).toBe('Account.py');
  });

  it('重复请求:同一服务两次执行,hits=2 且关联 id 各自独立(HR-HTTP-014)', async () => {
    const server = await track((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ file: 'Account.py', status: 'accepted' }]));
    });
    const first = await post(`${server.url}/hotfix`);
    const second = await post(`${server.url}/hotfix`);
    expect(server.hits()).toBe(2);
    expect(first.correlationId).not.toBe(second.correlationId);
    const receipts = parseReloadHttpReceipts(second.body, ['Account.py'], undefined);
    expect(receipts[0]).toMatchObject({ status: 'accepted', file: 'Account.py' });
  });

  it('URL 无法解析/协议不支持:准备期失败,零网络(不需要服务端)', async () => {
    const bad = await executeHttpRequest({
      url: 'not-a-url',
      method: 'GET',
      headers: {},
      body: '',
      timeoutMs: 1000
    });
    expect(bad.kind).toBe('invalid-url');
    const ftp = await executeHttpRequest({
      url: 'ftp://127.0.0.1/x',
      method: 'GET',
      headers: {},
      body: '',
      timeoutMs: 1000
    });
    expect(ftp.kind).toBe('unsupported-protocol');
  });
});
