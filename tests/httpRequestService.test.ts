import * as http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  HttpRequestService,
  RESPONSE_PREVIEW_LIMIT,
  type OutgoingHttpRequest
} from '../src/httpRequestService';
import { BUILTIN_HTTP_REQUEST_EXAMPLE } from '../src/httpRequests';

// HttpRequestService 执行层:注入 transport 的流水/回执语义 + 默认 transport
// 的真 TCP localhost 行为(成功/连接拒绝/坏 URL/非 http 协议/POST 体/大回包
// 截顶/超时/响应中断)。OUTPUT 通道无着色,失败以 ✗ 标记+错误弹窗如实呈现。

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))
  );
});

const listen = (handler: http.RequestListener): Promise<number> =>
  new Promise(resolve => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as http.AddressInfo).port);
    });
  });

const freePort = (): Promise<number> =>
  listen(() => undefined).then(port => {
    const server = servers.pop()!;
    return new Promise<number>(resolve => server.close(() => resolve(port)));
  });

const entry = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name: '热更',
  url: 'http://127.0.0.1:9/never',
  method: 'GET',
  headers: {},
  body: '',
  enabled: true,
  keybinding: '',
  ...over
});

const makeService = (
  entries: Array<Record<string, unknown>>,
  over: Partial<ConstructorParameters<typeof HttpRequestService>[0]> = {}
): { service: HttpRequestService; logs: string[]; errors: string[] } => {
  const logs: string[] = [];
  const errors: string[] = [];
  const service = new HttpRequestService({
    getEntries: () => entries as never[],
    log: line => logs.push(line),
    notifyError: message => errors.push(message),
    ...over
  });
  return { service, logs, errors };
};

describe('注入 transport:流水与回执语义', () => {
  it('成功:▶ 请求行(模板替换后)/✓ 状态·耗时/回包,回 true', async () => {
    const seen: OutgoingHttpRequest[] = [];
    const { service, logs } = makeService([entry({
      url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
      headers: { 'X-File': '${file}' }
    })], {
      transport: async request => {
        seen.push(request);
        return { ok: true, status: 200, durationMs: 12, body: 'ok-body' };
      },
      getTemplateContext: () => ({
        filePath: '/ws/entities/fight/FightAI.py',
        cursorLineZeroBased: 9,
        selection: '',
        workspaceRoots: ['/ws']
      })
    });

    await expect(service.runByName('热更')).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://127.0.0.1:8090/hotfix?module_name=entities.fight.FightAI');
    expect(seen[0].headers).toEqual({ 'X-File': 'FightAI.py' });
    expect(seen[0].timeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(logs[0]).toBe('▶ [热更] GET http://127.0.0.1:8090/hotfix?module_name=entities.fight.FightAI');
    expect(logs[1]).toBe('✓ 200 · 12ms');
    expect(logs[2]).toBe('ok-body');
  });

  it('失败:✗ 标记行 + 错误弹窗,回 false', async () => {
    const { service, logs, errors } = makeService([entry()], {
      transport: async () => ({ ok: false, status: 0, durationMs: 5, body: '', error: 'ECONNREFUSED' })
    });

    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(logs[1]).toContain('✗ [热更]');
    expect(logs[1]).toContain('5ms · ECONNREFUSED');
    expect(errors[0]).toBe('HTTP 快捷请求「热更」失败: ECONNREFUSED');
  });

  it('停用或未知名:如实回执不空转(无请求无流水,仅弹窗)', async () => {
    const calls: OutgoingHttpRequest[] = [];
    const { service, logs, errors } = makeService([entry({ enabled: false })], {
      transport: async request => {
        calls.push(request);
        return { ok: true, status: 200, durationMs: 1, body: '' };
      }
    });

    await expect(service.runByName('热更')).resolves.toBe(false);
    await expect(service.runByName('不存在')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(0);
    expect(errors[0]).toContain('「热更」不存在或已停用');
    expect(errors[1]).toContain('「不存在」不存在或已停用');
  });

  it('回包截顶:超长标注截断与全长;空回包如实标注', async () => {
    const longBody = 'x'.repeat(RESPONSE_PREVIEW_LIMIT + 1000);
    const { service, logs } = makeService([entry()], {
      transport: async () => ({ ok: true, status: 200, durationMs: 1, body: longBody })
    });
    await service.runByName('热更');
    expect(logs[2]).toBe(`${'x'.repeat(RESPONSE_PREVIEW_LIMIT)}…(截断,共 ${longBody.length} 字符)`);

    const empty = makeService([entry()], {
      transport: async () => ({ ok: true, status: 204, durationMs: 1, body: '' })
    });
    await empty.service.runByName('热更');
    expect(empty.logs[2]).toBe('(空回包)');
  });

  it('listEnabled 只出启用条目', () => {
    const { service } = makeService([entry(), entry({ name: '停的', enabled: false })]);
    expect(service.listEnabled().map(item => item.name)).toEqual(['热更']);
  });

  it('自定义 timeoutMs 下传 transport', async () => {
    const seen: OutgoingHttpRequest[] = [];
    const { service } = makeService([entry()], {
      transport: async request => {
        seen.push(request);
        return { ok: true, status: 200, durationMs: 0, body: '' };
      },
      timeoutMs: 1234
    });
    await service.runByName('热更');
    expect(seen[0].timeoutMs).toBe(1234);
  });
});

describe('默认 transport(真 TCP localhost)', () => {
  it('GET 成功:状态/耗时/回包进流水;服务端收到方法与 URL', async () => {
    let seenMethod = '';
    let seenUrl = '';
    const port = await listen((req, res) => {
      seenMethod = req.method ?? '';
      seenUrl = req.url ?? '';
      res.end('ok-body');
    });
    const { service, logs } = makeService([entry({
      url: `http://127.0.0.1:${port}/hotfix?module_name=entities.fight.FightAI`
    })]);

    await expect(service.runByName('热更')).resolves.toBe(true);
    expect(seenMethod).toBe('GET');
    expect(seenUrl).toBe('/hotfix?module_name=entities.fight.FightAI');
    expect(logs[1]).toMatch(/^✓ 200 · \d+ms$/);
    expect(logs[2]).toBe('ok-body');
  });

  it('POST 体随请求到达服务端', async () => {
    let received = '';
    const port = await listen((req, res) => {
      req.on('data', chunk => {
        received += chunk;
      });
      req.on('end', () => res.end('created'));
    });
    const { service } = makeService([entry({
      method: 'POST',
      url: `http://127.0.0.1:${port}/hotfix`,
      body: '{"module":"entities.fight.FightAI"}'
    })]);

    await expect(service.runByName('热更')).resolves.toBe(true);
    expect(received).toBe('{"module":"entities.fight.FightAI"}');
  });

  it('端口未开:ECONNREFUSED → ✗ + 弹窗', async () => {
    const port = await freePort();
    const { service, logs, errors } = makeService([entry({ url: `http://127.0.0.1:${port}/x` })]);

    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(logs[1]).toContain('✗');
    expect(errors[0]).toContain('ECONNREFUSED');
  });

  it('URL 无法解析:如实报错不裸抛', async () => {
    const { service, errors } = makeService([entry({ url: 'not a url' })]);
    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(errors[0]).toContain('URL 无法解析');
  });

  it('非 http(s) 协议(ftp):不支持的协议', async () => {
    const { service, errors } = makeService([entry({ url: 'ftp://127.0.0.1/x' })]);
    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(errors[0]).toContain('不支持的协议');
  });

  it('大回包截顶:窗口收满即止,后续块(room=0)如实丢弃;预览按 4000 上限截断', async () => {
    const port = await listen((_req, res) => {
      // 首块超窗(裁前 16K,整块截断臂);延时分块确保独立 data 事件
      res.write('a'.repeat(RESPONSE_PREVIEW_LIMIT * 4 + 4000));
      setTimeout(() => {
        res.write('b'.repeat(4000));
        res.end();
      }, 20);
    });
    const { service, logs } = makeService([entry({ url: `http://127.0.0.1:${port}/big` })]);

    await expect(service.runByName('热更')).resolves.toBe(true);
    expect(logs[2]).toBe(`${'a'.repeat(RESPONSE_PREVIEW_LIMIT)}…(截断,共 ${RESPONSE_PREVIEW_LIMIT * 4} 字符)`);
  });

  it('失败结果缺 error 字段:日志与弹窗如实落「未知错误」', async () => {
    const { service, logs, errors } = makeService([entry()], {
      transport: async () => ({ ok: false, status: 0, durationMs: 1, body: '' })
    });
    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(logs[1]).toContain('· 未知错误');
    expect(errors[0]).toBe('HTTP 快捷请求「热更」失败: 未知错误');
  });

  it('https 目标连到明文端口:选 https 通道并如实失败(不悬挂)', async () => {
    const port = await listen(() => undefined); // 明文服务端,握不了 TLS
    const { service, errors } = makeService([entry({ url: `https://127.0.0.1:${port}/x` })]);
    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(errors[0]).toContain('失败');
  }, 10000);

  it('响应中断(服务端提前断开):✗ + 失败弹窗,不悬挂', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('partial');
      res.socket!.destroy();
    });
    const { service, logs, errors } = makeService([entry({ url: `http://127.0.0.1:${port}/` })]);

    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(logs[1]).toContain('✗ [热更]');
    expect(errors[0]).toContain('失败');
  });

  it('服务端不应答:超时中止(注入小超时,确定性)', async () => {
    const port = await listen(() => undefined); // accept 后永不响应
    const { service, errors } = makeService([entry({ url: `http://127.0.0.1:${port}/slow` })], {
      timeoutMs: 60
    });

    await expect(service.runByName('热更')).resolves.toBe(false);
    expect(errors[0]).toContain('请求超时(60ms)');
  }, 10000);
});

describe('内置示例默认停用(服务侧过滤兜底)', () => {
  it('仅内置示例(停用)时 listEnabled 为空、按名运行拒', async () => {
    const { service, errors } = makeService([{ ...BUILTIN_HTTP_REQUEST_EXAMPLE }]);
    expect(service.listEnabled()).toHaveLength(0);
    await expect(service.runByName(BUILTIN_HTTP_REQUEST_EXAMPLE.name)).resolves.toBe(false);
    expect(errors[0]).toContain('已停用');
  });
});
