import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCurlCommand, fetchHttp, RESPONSE_PREVIEW_LIMIT, terminalScript } from '../src/quickActions';
import { workspace as stubWorkspace, Uri } from './helpers/vscodeStub';

// 快速执行动作的两个默认执行器:真实 spawn(跨平台 shell)与真实 localhost TCP。
// 注入测试已覆盖「装配层语义」,这里只验证默认实现本身(设计 1.6 的超时中止、
// 非 2xx 照实回状态码、后台不挂管道、大回包截顶、坏 cwd 不悬挂)。

const servers: http.Server[] = [];
const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-quickaction-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
  stubWorkspace.workspaceFolders = [];
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const listen = (handler: http.RequestListener): Promise<number> =>
  new Promise(resolve => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as http.AddressInfo).port);
    });
  });

/** 占一个端口号再立刻放开:拿到一个确定没人监听的端口 */
const freePort = (): Promise<number> =>
  listen(() => undefined).then(port => {
    const server = servers.pop() as http.Server;
    return new Promise<number>(resolve => server.close(() => resolve(port)));
  });

describe('terminalScript', () => {
  it('creates a hidden interactive terminal and reuses it without auto reveal', async () => {
    const calls: unknown[][] = [];
    const original = (await import('vscode')).window.createTerminal;
    (await import('vscode')).window.createTerminal = ((options: unknown) => {
      calls.push([options]);
      return { sendText: (...args: unknown[]) => calls.push(args) } as never;
    }) as never;
    try {
      const result = await terminalScript({ name: 'Start server', script: 'start.bat', background: false, cwd: '/workspace' });
      await terminalScript({ name: 'Start server', script: 'start.bat', background: false, cwd: '/workspace' });
      expect(calls).toEqual([
        [{ name: 'Kode: Start server · start.bat', cwd: '/workspace', hideFromUser: true }],
        [expect.stringContaining('即将执行：start.bat'), true],
        ['start.bat', true],
        [expect.stringContaining('即将执行：start.bat'), true],
        ['start.bat', true]
      ]);
      expect(calls).toHaveLength(5);
      expect(result.code).toBeNull();
    } finally {
      (await import('vscode')).window.createTerminal = original;
    }
  });
});

describe('buildCurlCommand', () => {
  it('builds method, URL, headers and body with POSIX shell quoting', () => {
    expect(buildCurlCommand({
      method: 'POST', url: 'http://127.0.0.1:8080/api/login',
      headers: { 'Content-Type': 'application/json', Authorization: "Bearer it's" },
      body: '{"name":"a b","quote":"it\'s"}'
    }, 'linux')).toBe("curl --silent --show-error --write-out '\\nHTTP_STATUS:%{http_code}\\n' --request 'POST' --header 'Content-Type: application/json' --header 'Authorization: Bearer it'\\''s' --data-binary '{\"name\":\"a b\",\"quote\":\"it'\\''s\"}' 'http://127.0.0.1:8080/api/login'");
  });

  it('uses curl.exe and PowerShell safe literal arguments on Windows', () => {
    expect(buildCurlCommand({ method: 'GET', url: 'http://127.0.0.1:8080/health' }, 'win32'))
      .toContain("curl.exe --silent --show-error");
  });
});

describe('fetchHttp', () => {
  it('resolves a 2xx answer with its body', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('reloaded');
    });

    const result = await fetchHttp({ url: `http://127.0.0.1:${port}/reload`, method: 'POST' });

    expect(result).toEqual({ status: 200, body: 'reloaded' });
  });

  it('returns a non-2xx status as is instead of throwing', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });

    const result = await fetchHttp({ url: `http://127.0.0.1:${port}/reload`, method: 'GET' });

    expect(result.status).toBe(500);
    expect(result.body).toBe('boom');
  });

  it('sends the configured body and reads the answer', async () => {
    let received = '';
    let method = '';
    const port = await listen((req, res) => {
      method = req.method ?? '';
      req.on('data', chunk => {
        received += chunk.toString('utf8');
      });
      req.on('end', () => {
        res.end('ack');
      });
    });

    const result = await fetchHttp({
      url: `http://127.0.0.1:${port}/reload`,
      method: 'POST',
      body: '{"scope":"all"}'
    });

    expect(method).toBe('POST');
    expect(received).toBe('{"scope":"all"}');
    expect(result.body).toBe('ack');
  });

  it('drops the later chunks once the preview limit is filled', async () => {
    const port = await listen((_req, res) => {
      res.write('x'.repeat(RESPONSE_PREVIEW_LIMIT));
      // 分两次写:第二块到达时额度已满,必须整块丢弃而不是负数切片
      setTimeout(() => res.end('dropped'), 20);
    });

    const result = await fetchHttp({ url: `http://127.0.0.1:${port}/dump`, method: 'GET' });

    expect(result.body).toHaveLength(RESPONSE_PREVIEW_LIMIT);
  });

  it('truncates a body beyond the preview limit', async () => {
    const port = await listen((_req, res) => {
      // 首段超窗(裁剪保留前段),次段整段丢弃
      res.write('x'.repeat(RESPONSE_PREVIEW_LIMIT + 2000));
      res.write('y'.repeat(RESPONSE_PREVIEW_LIMIT));
      res.end();
    });

    const result = await fetchHttp({ url: `http://127.0.0.1:${port}/dump`, method: 'GET' });

    expect(result.body).toBe('x'.repeat(RESPONSE_PREVIEW_LIMIT));
  });

  it('rejects an unparsable url', async () => {
    await expect(fetchHttp({ url: 'not a url', method: 'GET' })).rejects.toThrow(/URL 无法解析/);
  });

  it('rejects a non-http protocol', async () => {
    await expect(fetchHttp({ url: 'ftp://127.0.0.1/reload', method: 'GET' })).rejects.toThrow(/不支持的协议/);
  });

  it('rejects when nothing listens on the port', async () => {
    const port = await freePort();

    await expect(fetchHttp({ url: `http://127.0.0.1:${port}/reload`, method: 'GET' })).rejects.toThrow(
      /ECONNREFUSED/
    );
  });

  it('picks the https channel and fails truthfully against a plain port', async () => {
    const port = await freePort();

    await expect(fetchHttp({ url: `https://127.0.0.1:${port}/reload`, method: 'GET' })).rejects.toThrow();
  });

  it('stops a hanging request at the timeout instead of hanging', async () => {
    const port = await listen(() => undefined);

    await expect(fetchHttp({ url: `http://127.0.0.1:${port}/reload`, method: 'GET' }, 80)).rejects.toThrow(
      /请求超时/
    );
  });
});
