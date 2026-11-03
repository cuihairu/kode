import { describe, expect, it } from 'vitest';
import {
  HttpReloadTransport,
  KbengineOfficialTransport,
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

describe('HttpReloadTransport.probe (IDE-HOT-101 验收 5)', () => {
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
    let pushed: ReloadReceipt[] = [];
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
