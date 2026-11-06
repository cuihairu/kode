import { describe, expect, it } from 'vitest';
import {
  HttpReloadTransport,
  KbengineOfficialTransport,
  normalizeReloadChannelConfig,
  parseReloadHttpReceipts,
  resolveReloadTransport,
  substituteReloadVariables,
  type ReloadHttpRunner,
  type ReloadReceipt,
  type ReloadSendSummary,
  type ReloadTarget,
  type ReloadTelnetConnection
} from '../src/hotReloadTransport';
import type { HttpRequestEntry } from '../src/httpRequests';

const target: ReloadTarget = { rootId: '/ws/scripts', targetId: 'baseapp' };
const files = ['/ws/scripts/base/Monster.py', '/ws/scripts/cell/Avatar.py'];

const entry = (overrides: Partial<HttpRequestEntry> = {}): HttpRequestEntry => ({
  name: 'reload',
  url: 'http://127.0.0.1:8000/api/hotfix?files=${files}',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-files': '${fileList}' },
  body: '{"files":${files}}',
  enabled: true,
  keybinding: '',
  ...overrides
});

const runStub = (result: { status: number; body: string }): ReloadHttpRunner => async () => result;

const collect = (summary: ReloadSendSummary): ReloadReceipt[] => summary.receipts;

describe('substituteReloadVariables (IDE-HOT-101 占位)', () => {
  it('${files} 替换为 JSON 数组,${fileList} 替换为逗号分隔', () => {
    expect(substituteReloadVariables('files=${files}', files)).toBe(
      `files=${JSON.stringify(files)}`
    );
    expect(substituteReloadVariables('list=${fileList}', files)).toBe('list=' + files.join(','));
  });

  it('未知占位原样保留,已知变量经上下文解析', () => {
    expect(substituteReloadVariables('${module}/${filename}', files, { folders: [] })).toBe(
      '${module}/${filename}'
    );
    const substituted = substituteReloadVariables('${workspaceFolder}', files, {
      folders: [{ fsPath: '/ws', name: 'ws' }]
    });
    expect(substituted).toBe('/ws');
  });

  it('空文件集 → 空 JSON 数组 / 空串', () => {
    expect(substituteReloadVariables('${files}', [])).toBe('[]');
    expect(substituteReloadVariables('${fileList}', [])).toBe('');
  });
});

describe('parseReloadHttpReceipts (IDE-HOT-101 回执解析)', () => {
  it('单对象 accepted 回执 → accepted', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify({ status: 'accepted', file: files[0], digest: 'a'.repeat(64) }),
      files
    );
    expect(receipts).toEqual([
      { status: 'accepted', file: files[0], digest: 'a'.repeat(64) },
      { status: 'sent', file: files[1], detail: expect.stringContaining('无匹配') }
    ]);
  });

  it('数组 accepted/applied/failed 逐条识别', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify([
        { status: 'accepted', file: files[0], digest: 'a'.repeat(64) },
        { status: 'applied', file: files[1], digest: 'b'.repeat(64) }
      ]),
      files
    );
    expect(receipts).toEqual([
      { status: 'accepted', file: files[0], digest: 'a'.repeat(64) },
      { status: 'applied', file: files[1], digest: 'b'.repeat(64) }
    ]);
  });

  it('非 JSON → 全部 sent(不 claim applied)', () => {
    const receipts = parseReloadHttpReceipts('server said hi', files);
    expect(receipts).toHaveLength(2);
    expect(receipts.every(r => r.status === 'sent')).toBe(true);
  });

  it('file 不在所发集/未知状态 → 该文件落 sent', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify([
        { status: 'accepted', file: '/elsewhere/NotMine.py' },
        { status: 'queued', file: files[0] }
      ]),
      files
    );
    expect(receipts).toEqual([
      { status: 'sent', file: files[0], detail: expect.stringContaining('无匹配') },
      { status: 'sent', file: files[1], detail: expect.stringContaining('无匹配') }
    ]);
  });

  it('failed 带 reason 识别', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify({ status: 'failed', file: files[0], reason: 'boom' }),
      files
    );
    expect(receipts[0]).toEqual({ status: 'failed', file: files[0], reason: 'boom' });
  });
});

describe('HttpReloadTransport.send (IDE-HOT-101 验收 1/2)', () => {
  it('${files} 替换进 url/headers/body,回执逐条推送,返回汇总', async () => {
    const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const transport = new HttpReloadTransport(entry(), {
      run: request => {
        captured.push(request);
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ status: 'applied', file: files[0], digest: 'd'.repeat(64) })
        });
      }
    });
    const pushed: ReloadReceipt[] = [];
    const summary = await transport.send(target, files, r => pushed.push(r));
    expect(captured[0].url).toContain('files=');
    expect(captured[0].url).toContain(JSON.stringify(files));
    expect(captured[0].headers['x-files']).toBe(files.join(','));
    expect(captured[0].body).toContain(JSON.stringify(files));
    expect(pushed).toHaveLength(2);
    expect(pushed[0].status).toBe('applied');
    expect(collect(summary)).toHaveLength(2);
    expect(summary.kind).toBe('http');
  });

  it('非 2xx → 全 failed', async () => {
    const transport = new HttpReloadTransport(entry(), { run: runStub({ status: 500, body: 'err' }) });
    const summary = await transport.send(target, files, () => undefined);
    expect(summary.receipts).toEqual([
      { status: 'failed', file: files[0], reason: expect.stringContaining('500') },
      { status: 'failed', file: files[1], reason: expect.stringContaining('500') }
    ]);
  });

  it('执行器抛错 → 全 failed(不吞异常)', async () => {
    const transport = new HttpReloadTransport(entry(), {
      run: async () => {
        throw new Error('connection refused');
      }
    });
    const summary = await transport.send(target, files, () => undefined);
    expect(summary.receipts).toEqual([
      { status: 'failed', file: files[0], reason: 'connection refused' },
      { status: 'failed', file: files[1], reason: 'connection refused' }
    ]);
  });
});

// F4 回归(2026-11-05 审核):HTTP 通道忽略可选 targetId——回执带错误
// targetId 仍可 accepted/applied。修后:目标传入解析,显式不一致的
// targetId 回执一律拒绝;${targetId} 占位透传,请求侧也能区分目标。
describe('F4 回归:HTTP 通道透传并核验 targetId', () => {
  it('回执显式 targetId 与目标一致 → 接受并回显 targetId', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify({ status: 'applied', file: files[0], digest: 'd'.repeat(64), targetId: 'baseapp' }),
      files,
      'baseapp'
    );
    expect(receipts[0]).toEqual({
      status: 'applied',
      file: files[0],
      digest: 'd'.repeat(64),
      targetId: 'baseapp'
    });
  });

  it('回执显式 targetId 与目标不一致 → 拒绝该回执,该文件落 sent(不 claim applied)', () => {
    const receipts = parseReloadHttpReceipts(
      JSON.stringify([
        { status: 'applied', file: files[0], digest: 'd'.repeat(64), targetId: 'other-app' },
        { status: 'accepted', file: files[1], targetId: 'baseapp' }
      ]),
      files,
      'baseapp'
    );
    // 被拒回执的文件在回退段如实落 sent(带不一致原因);一致回执照常接受
    expect(receipts[0]).toEqual({ status: 'accepted', file: files[1], targetId: 'baseapp' });
    expect(receipts[1]).toMatchObject({ status: 'sent', file: files[0] });
    expect(JSON.stringify(receipts[1])).toContain('targetId');
  });

  it('${targetId} 占位替换为发送目标(url/headers/body 均可)', async () => {
    const captured: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const transport = new HttpReloadTransport(
      entry({
        url: 'http://127.0.0.1:8000/${targetId}/reload?files=${files}',
        body: '{"target":"${targetId}","files":${files}}'
      }),
      {
        run: request => {
          captured.push(request);
          return Promise.resolve({ status: 200, body: 'ok' });
        }
      }
    );
    await transport.send(target, files, () => undefined);
    expect(captured[0].url).toContain('/baseapp/reload');
    expect(captured[0].body).toContain('"target":"baseapp"');
  });

  it('F4 二轮回归:显式非字符串 targetId(null/数字/对象)→ 拒绝该回执,不当「未提供」处理', () => {
    for (const bad of [null, 42, { id: 'baseapp' }]) {
      const receipts = parseReloadHttpReceipts(
        JSON.stringify({ status: 'applied', file: files[0], digest: 'd'.repeat(64), targetId: bad }),
        files,
        'baseapp'
      );
      // 非字符串 targetId 是畸形回执不是缺省:绝不按未提供处理而接受 applied
      expect(receipts.some(r => r.status === 'applied' || r.status === 'accepted')).toBe(false);
      expect(receipts[0]).toMatchObject({ status: 'sent', file: files[0] });
      expect(JSON.stringify(receipts[0])).toContain('targetId');
    }
  });

  it('F4 二轮回归:JSON 请求体自动附加 targetId 字段(不依赖 ${targetId} 模板占位符)', async () => {
    const captured: Array<{ body: string }> = [];
    const transport = new HttpReloadTransport(
      // 模板没有 ${targetId} 占位符:请求侧仍必须让接收端知道目标
      entry({ body: '{"files":${files}}' }),
      {
        run: async request => {
          captured.push(request);
          return { status: 200, body: 'ok' };
        }
      }
    );
    await transport.send(target, files, () => undefined);
    const parsed = JSON.parse(captured[0].body);
    expect(parsed.targetId).toBe('baseapp');
    expect(parsed.files).toEqual(files);
  });

  it('F4 二轮回归:请求体已有显式 targetId 字段 → 不覆盖', async () => {
    const captured: Array<{ body: string }> = [];
    const transport = new HttpReloadTransport(
      entry({ body: '{"targetId":"explicit-target","files":${files}}' }),
      {
        run: async request => {
          captured.push(request);
          return { status: 200, body: 'ok' };
        }
      }
    );
    await transport.send(target, files, () => undefined);
    const parsed = JSON.parse(captured[0].body);
    expect(parsed.targetId).toBe('explicit-target');
    expect(parsed.files).toEqual(files);
  });

  it('端到端:回包 applied 带不匹配 targetId → 通道不产生 applied 回执', async () => {
    const transport = new HttpReloadTransport(entry(), {
      run: async () => ({
        status: 200,
        body: JSON.stringify({
          status: 'applied',
          file: files[0],
          digest: 'd'.repeat(64),
          targetId: 'someone-else'
        })
      })
    });
    const pushed: ReloadReceipt[] = [];
    await transport.send(target, files, r => pushed.push(r));
    expect(pushed.some(r => r.status === 'applied')).toBe(false);
    expect(pushed[0]).toMatchObject({ status: 'sent', file: files[0] });
  });
});

describe('HttpReloadTransport.probe (IDE-HOT-101 验收 5)', () => {
  it('无副作用(KODE-AUD-009):探测与真实 fire 分离——GET 无体,不携带重载载荷', async () => {
    const captured: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const transport = new HttpReloadTransport(entry(), {
      run: request => {
        captured.push(request);
        return Promise.resolve({ status: 200, body: '' });
      }
    });
    await transport.probe();
    expect(captured).toHaveLength(1);
    // 与 fire(send)的 POST+body 载荷分离:安全方法 GET、空体、
    // headers/url 不做文件占位替换——端点不会因探测而实际重载。
    expect(captured[0].method).toBe('GET');
    expect(captured[0].body).toBe('');
    expect(captured[0].url).not.toContain('/ws/scripts');
    expect(captured[0].headers['x-files']).toBe('${fileList}');
  });
  it('2xx → ok', async () => {
    const transport = new HttpReloadTransport(entry(), { run: runStub({ status: 200, body: '' }) });
    expect(await transport.probe()).toEqual({ ok: true, detail: expect.stringContaining('可达') });
  });
  it('非 2xx → not ok', async () => {
    const transport = new HttpReloadTransport(entry(), { run: runStub({ status: 503, body: '' }) });
    expect((await transport.probe()).ok).toBe(false);
  });
  it('抛错 → not ok with 原因', async () => {
    const transport = new HttpReloadTransport(entry(), {
      run: async () => {
        throw new Error('ECONNREFUSED');
      }
    });
    const result = await transport.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('ECONNREFUSED');
  });
});

describe('KbengineOfficialTransport (IDE-HOT-101 验收 1/2)', () => {
  const fakeConn = (overrides: Partial<ReloadTelnetConnection> = {}): ReloadTelnetConnection & {
    sent: string[];
    emitData: (text: string) => void;
  } => {
    let dataListener: ((text: string) => void) | undefined;
    const sent: string[] = [];
    return {
      sent,
      emitData: text => dataListener?.(text),
      connect: () => undefined,
      disconnect: () => undefined,
      isReady: () => true,
      sendCommand: command => {
        sent.push(command);
        return true;
      },
      onData: listener => {
        dataListener = listener;
      },
      onClose: () => undefined,
      ...overrides
    };
  };

  const readyDeps = (conn: ReloadTelnetConnection) => ({
    connect: () => conn,
    waitForReady: async () => true,
    awaitEchoMs: 0
  });

  it('ready → 发 KBEngine.reloadScript(True),回执全 sent 绝不 applied', async () => {
    const conn = fakeConn();
    const transport = new KbengineOfficialTransport({ host: 'h', port: 100 }, readyDeps(conn));
    const summary = await transport.send(target, files, () => undefined);
    expect(conn.sent).toEqual(['KBEngine.reloadScript(True)']);
    expect(summary.receipts).toHaveLength(2);
    expect(summary.receipts.every(r => r.status === 'sent')).toBe(true);
    expect(summary.receipts.every(r => r.status !== 'applied')).toBe(true);
    expect(summary.kind).toBe('kbengine-official');
  });

  it('fullReload=false → KBEngine.reloadScript(False)', async () => {
    const conn = fakeConn();
    const transport = new KbengineOfficialTransport(
      { host: 'h', port: 100, fullReload: false },
      readyDeps(conn)
    );
    await transport.send(target, files, () => undefined);
    expect(conn.sent).toEqual(['KBEngine.reloadScript(False)']);
  });

  it('自定义 command 优先', async () => {
    const conn = fakeConn();
    const transport = new KbengineOfficialTransport(
      { host: 'h', port: 100, command: 'reloadScript()' },
      readyDeps(conn)
    );
    await transport.send(target, files, () => undefined);
    expect(conn.sent).toEqual(['reloadScript()']);
  });

  it('未 ready → 全 failed', async () => {
    const conn = fakeConn();
    const transport = new KbengineOfficialTransport(
      { host: 'h', port: 100 },
      { connect: () => conn, waitForReady: async () => false }
    );
    const summary = await transport.send(target, files, () => undefined);
    expect(summary.receipts.every(r => r.status === 'failed')).toBe(true);
    expect(conn.sent).toEqual([]);
  });

  it('sendCommand 拒 → 全 failed', async () => {
    const conn = fakeConn({ sendCommand: () => false });
    const transport = new KbengineOfficialTransport({ host: 'h', port: 100 }, readyDeps(conn));
    const summary = await transport.send(target, files, () => undefined);
    expect(summary.receipts.every(r => r.status === 'failed')).toBe(true);
  });

  it('回显捕获进 detail(awaitEchoMs>0)', async () => {
    const conn = fakeConn();
    const transport = new KbengineOfficialTransport(
      { host: 'h', port: 100 },
      {
        connect: () => conn,
        waitForReady: async () => true,
        awaitEchoMs: 200
      }
    );
    const pushed: ReloadReceipt[] = [];
    const sendPromise = transport.send(target, files, r => pushed.push(r));
    // 模拟控制台回显到达
    queueMicrotask(() => conn.emitData('reload done'));
    const summary = await sendPromise;
    expect(summary.receipts[0].status).toBe('sent');
    if (summary.receipts[0].status === 'sent') {
      expect(summary.receipts[0].detail).toContain('回显');
    }
    expect(pushed).toHaveLength(2);
  });

  it('probe ready → ok / 未 ready → not ok', async () => {
    const okConn = fakeConn();
    const okTransport = new KbengineOfficialTransport(
      { host: 'h', port: 100 },
      { connect: () => okConn, waitForReady: async () => true }
    );
    expect((await okTransport.probe()).ok).toBe(true);

    const badConn = fakeConn();
    const badTransport = new KbengineOfficialTransport(
      { host: 'h', port: 100 },
      { connect: () => badConn, waitForReady: async () => false }
    );
    expect((await badTransport.probe()).ok).toBe(false);
  });
});

describe('resolveReloadTransport (IDE-HOT-101 验收 3/4)', () => {
  it('未配 → null(回落既有 actionName 通道)', () => {
    expect(resolveReloadTransport(undefined)).toBeNull();
  });

  it('http + 条目 → HTTP 通道', () => {
    const transport = resolveReloadTransport(
      { channel: 'http', http: entry() },
      { http: { run: runStub({ status: 200, body: '{}' }) } }
    );
    expect(transport).not.toBeNull();
    expect(transport?.kind).toBe('http');
  });

  it('official + 参数 → 官方通道', () => {
    const transport = resolveReloadTransport(
      { channel: 'kbengine-official', official: { host: 'h', port: 1 } },
      { official: { connect: () => fakeConn(), waitForReady: async () => true } }
    );
    expect(transport).not.toBeNull();
    expect(transport?.kind).toBe('kbengine-official');
  });

  it('channel 配了但字段缺失/未知 → null(保守回落)', () => {
    expect(resolveReloadTransport({ channel: 'http' })).toBeNull();
    expect(resolveReloadTransport({ channel: 'kbengine-official' })).toBeNull();
    expect(resolveReloadTransport({ channel: 'unknown' as never })).toBeNull();
  });
});

describe('normalizeReloadChannelConfig (IDE-HOT-102 profile 读回校验)', () => {
  it('非对象/空 → undefined(如实按未配)', () => {
    expect(normalizeReloadChannelConfig(undefined)).toBeUndefined();
    expect(normalizeReloadChannelConfig(null)).toBeUndefined();
    expect(normalizeReloadChannelConfig('http')).toBeUndefined();
    expect(normalizeReloadChannelConfig([])).toBeUndefined();
  });

  it('channel 未知 → undefined(不猜)', () => {
    expect(normalizeReloadChannelConfig({ channel: 'carrier-pigeon' })).toBeUndefined();
    expect(normalizeReloadChannelConfig({})).toBeUndefined();
  });

  it('http + url → 归一条目,未知字段忽略,缺省填类型默认', () => {
    const normalized = normalizeReloadChannelConfig({
      channel: 'http',
      http: { url: 'http://h:1/r', method: 'put', headers: { a: 'b', skip: 42 }, junk: 'ignored' }
    });
    // normalize 只校验/填默认,不改写既有字段(面板写入时已大写,读回原样)
    expect(normalized).toEqual({
      channel: 'http',
      http: {
        name: 'hot-reload',
        url: 'http://h:1/r',
        method: 'put',
        headers: { a: 'b' },
        body: '',
        enabled: true,
        keybinding: ''
      }
    });
  });

  it('http url 缺失/空/非对象段 → undefined', () => {
    expect(normalizeReloadChannelConfig({ channel: 'http', http: {} })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'http', http: { url: '' } })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'http' })).toBeUndefined();
  });

  it('official + host/port → 归一条目,password/fullReload/command 可选', () => {
    const normalized = normalizeReloadChannelConfig({
      channel: 'kbengine-official',
      official: { host: '127.0.0.1', port: 2560, password: 'pw', fullReload: false, junk: 'ignored' }
    });
    expect(normalized).toEqual({
      channel: 'kbengine-official',
      official: { host: '127.0.0.1', port: 2560, password: 'pw', fullReload: false, command: undefined }
    });
  });

  it('official host 空/port 越界或非整数 → undefined', () => {
    expect(normalizeReloadChannelConfig({ channel: 'kbengine-official', official: { host: '', port: 1 } })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'kbengine-official', official: { host: 'h', port: 0 } })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'kbengine-official', official: { host: 'h', port: 65536 } })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'kbengine-official', official: { host: 'h', port: 1.5 } })).toBeUndefined();
    expect(normalizeReloadChannelConfig({ channel: 'kbengine-official' })).toBeUndefined();
  });
});
