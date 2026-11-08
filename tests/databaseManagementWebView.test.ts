import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { panelRegistry, window as stubWindow } from './helpers/vscodeStub';
import { windowState } from './fake-vscode/windowState';
import { DatabaseManagementWebView } from '../src/databaseManagementWebView';
import type { DatabaseInterfaceConfig } from '../src/serverConfigMerge';
import type { DriftQueryExecutor } from '../src/databaseDrift';
import type { RedisSession } from '../src/redisDrift';
import { formatRedisHashPreview } from '../src/redisKeySpace';

// DatabaseManagementWebView 控制器半边(面板生命周期/消息分发/后端分支/代际守卫)。
// 走 fake-vscode 的 panelRegistry(vscode.window.createWebviewPanel 默认接 registry)
// + 注入假 deps;只 import,禁 require(21cea64 教训)。
//
// 断言面:
// - 生命周期:createWebviewPanel 参数/二次 show reveal/close 后重建;
// - 数据面:loadTables→tablesLoaded、previewTable→tablePreview(非法表名不建连)、
//   scanKeys→keysLoaded、previewKey→keyPreview(text===formatRedisHashPreview);
// - 错误面:档案 null / 密码不可读(不调工厂)/工厂 reject;
// - 守卫:慢 loadTables + setTab → 无 tablesLoaded(代际弃置);
// - 超时:connectTimeoutMs + 永不 resolve 工厂 → 连接超时错误。

const mysqlProfile = () => ({
  available: true,
  dbType: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  databaseName: 'kbe',
  characterSet: 'utf8',
  encrypt: false,
  passwordAvailable: true
});

const redisProfile = () => ({
  available: true,
  dbType: 'redis',
  host: '127.0.0.1',
  port: 6379,
  username: '',
  databaseName: '0',
  characterSet: '',
  encrypt: false,
  passwordAvailable: true
});

const mysqlConfig = (): DatabaseInterfaceConfig => ({
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  databaseName: 'kbe',
  encrypt: false,
  characterSet: 'utf8',
  plainPassword: 'secret'
});

const fakeExecutor = () => {
  const executor = {
    runQuery: vi.fn(async () => ({ columns: [], rows: [] })),
    close: vi.fn(async () => undefined)
  };
  return executor as unknown as DriftQueryExecutor & { runQuery: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
};

const fakeSession = () => {
  const session = {
    scanKeys: vi.fn(async (_cursor: string, _pattern: string) => ({ cursor: '0', keys: [] })),
    hashGetAll: vi.fn(async (_key: string) => ({})),
    typeOf: vi.fn(async (_key: string) => 'hash'),
    close: vi.fn(() => undefined)
  };
  return session as unknown as RedisSession & {
    scanKeys: ReturnType<typeof vi.fn>;
    hashGetAll: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
};

const makeView = (deps: ConstructorParameters<typeof DatabaseManagementWebView>[1] = {}) =>
  new DatabaseManagementWebView({ subscriptions: [] } as unknown as vscode.ExtensionContext, deps);

/** 让消息处理器(异步)跑完:等微任务队列排空。 */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** 面板 + 推送消息断言辅助。 */
const panel = () => panelRegistry.panels[0]!;
const posted = () => panel().webview.postedMessages.map(m => m.message);

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset();
  stubWindow.showErrorMessage = undefined as unknown as typeof stubWindow.showErrorMessage;
});

describe('DatabaseManagementWebView.show 生命周期', () => {
  it('createWebviewPanel 参数与 nonce CSP', () => {
    const view = makeView({ resolveProfile: mysqlProfile });
    view.show();

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel().viewType).toBe('kbengine.databaseManagement');
    expect(panel().title).toBe('数据库管理');
    expect(panel().webview.html).toContain("default-src 'none'");
    expect(panel().webview.html).toContain('<script nonce="');
  });

  it('二次 show → reveal,不重建面板', () => {
    const view = makeView({ resolveProfile: mysqlProfile });
    view.show();
    view.show();

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel().revealed).toBe(true);
  });

  it('dispose → panel.disposed,重建出新面板', () => {
    const view = makeView({ resolveProfile: mysqlProfile });
    view.show();
    view.dispose();
    expect(panel().disposed).toBe(true);

    view.show();
    expect(panelRegistry.panels).toHaveLength(2);
    expect(panelRegistry.panels[1]!.disposed).toBe(false);
  });

  it('无档案(dbType=none)出「无档案」注记且按钮禁能', () => {
    const view = makeView({ resolveProfile: () => null });
    view.show();

    expect(panel().webview.html).toContain('未读取到引擎数据库档案');
    expect(panel().webview.html).toContain('disabled');
  });
});

describe('DatabaseManagementWebView.loadTables', () => {
  it('建连→SHOW TABLES→close 一次→tablesLoaded', async () => {
    const executor = fakeExecutor();
    executor.runQuery.mockResolvedValueOnce({
      columns: [{ name: 'Tables_in_kbe', type: 'STRING' }],
      rows: [{ Tables_in_kbe: 'tbl_Account' }, { Tables_in_kbe: 'tbl_Avatar' }]
    });
    const createMysqlExecutor = vi.fn(async () => executor);
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();

    expect(createMysqlExecutor).toHaveBeenCalledTimes(1);
    expect(executor.close).toHaveBeenCalledTimes(1);
    expect(posted().at(-1)).toEqual({
      command: 'tablesLoaded',
      result: { ok: true, tables: ['tbl_Account', 'tbl_Avatar'] }
    });
  });

  it('档案 null → 无档案错误,不调工厂', async () => {
    const createMysqlExecutor = vi.fn();
    const view = makeView({ resolveProfile: () => null, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();

    expect(createMysqlExecutor).not.toHaveBeenCalled();
    expect(posted().at(-1)).toEqual({ command: 'tablesLoaded', result: { ok: false, error: '未读取到引擎数据库档案' } });
  });

  it('passwordAvailable=false → 密码不可读错误,不调工厂', async () => {
    const profile = mysqlProfile();
    profile.passwordAvailable = false;
    const createMysqlExecutor = vi.fn();
    const view = makeView({ resolveProfile: () => profile, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();

    expect(createMysqlExecutor).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({
      command: 'tablesLoaded',
      result: { ok: false, error: expect.stringContaining('密码不可读') }
    });
  });

  it('工厂 reject → 错误条', async () => {
    const createMysqlExecutor = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
    });
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();

    expect(posted().at(-1)).toEqual({
      command: 'tablesLoaded',
      result: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:3306' }
    });
  });
});

describe('DatabaseManagementWebView.previewTable', () => {
  it('建连→SELECT→close→tablePreview', async () => {
    const executor = fakeExecutor();
    executor.runQuery.mockResolvedValueOnce({
      columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'VARCHAR' }],
      rows: [{ id: 1, name: 'Hero' }]
    });
    const createMysqlExecutor = vi.fn(async () => executor);
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl_Account' });
    await flush();

    expect(executor.close).toHaveBeenCalledTimes(1);
    expect(posted().at(-1)).toMatchObject({
      command: 'tablePreview',
      result: { kind: 'preview', columns: [{ name: 'id', type: 'INT' }, { name: 'name', type: 'VARCHAR' }] }
    });
  });

  it('非法表名(tbl;DROP)→错误,不建连', async () => {
    const createMysqlExecutor = vi.fn();
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl;DROP' });
    await flush();

    expect(createMysqlExecutor).not.toHaveBeenCalled();
    expect(posted().at(-1)).toEqual({
      command: 'tablePreview',
      result: { kind: 'error', message: expect.stringContaining('表名不合法') }
    });
  });
});

describe('DatabaseManagementWebView.scanKeys/previewKey', () => {
  it('scanKeys → keysLoaded(截断标记)+close 一次', async () => {
    const session = fakeSession();
    session.scanKeys.mockResolvedValueOnce({ cursor: '0', keys: ['kbe_entitylog:1:2'] });
    const openRedisSession = vi.fn(async () => session);
    const view = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();

    expect(openRedisSession).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(posted().at(-1)).toEqual({
      command: 'keysLoaded',
      result: { ok: true, keys: ['kbe_entitylog:1:2'], truncated: false }
    });
  });

  it('previewKey → keyPreview(text===formatRedisHashPreview)+close 一次', async () => {
    const session = fakeSession();
    const fields = { id: '1', name: 'Hero' };
    session.hashGetAll.mockResolvedValueOnce(fields);
    const openRedisSession = vi.fn(async () => session);
    const view = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'previewKey', key: 'kbe_entitylog:1:2' });
    await flush();

    expect(session.close).toHaveBeenCalledTimes(1);
    const last = posted().at(-1);
    expect(last).toMatchObject({
      command: 'keyPreview',
      result: { ok: true, key: 'kbe_entitylog:1:2', fields }
    });
    expect((last as { result: { text: string } }).result.text).toBe(formatRedisHashPreview('kbe_entitylog:1:2', fields));
  });

  it('密码不可读(redis)→keysLoaded 错误,不建连', async () => {
    const profile = redisProfile();
    profile.passwordAvailable = false;
    const openRedisSession = vi.fn();
    const view = makeView({ resolveProfile: () => profile, openRedisSession });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();

    expect(openRedisSession).not.toHaveBeenCalled();
    expect(posted().at(-1)).toMatchObject({ command: 'keysLoaded', result: { ok: false, error: expect.stringContaining('密码不可读') } });
  });
});

describe('DatabaseManagementWebView 代际守卫与超时', () => {
  it('慢 loadTables 在途 setTab → 旧结果弃置,无 tablesLoaded', async () => {
    const executor = fakeExecutor();
    let resolveExec: (value: DriftQueryExecutor) => void = () => undefined;
    const gate = new Promise<DriftQueryExecutor>(resolve => {
      resolveExec = resolve;
    });
    const createMysqlExecutor = vi.fn(() => gate);
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();

    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();
    resolveExec(executor);
    // 切 tab(代际 bump)发生在连接落地后、结果写入前
    panelRegistry.fireMessage(panel(), { command: 'setTab', tab: 'redis' });
    await flush();

    // 结果因代际变化被弃置:面板上只有 setTab 的消息,无 tablesLoaded
    expect(posted().some(m => (m as { command?: string }).command === 'tablesLoaded')).toBe(false);
    // 晚落地的执行器仍在 finally 关闭
    expect(executor.close).toHaveBeenCalledTimes(1);
  });

  it('连接超时(connectTimeoutMs+永不 resolve 工厂)→连接超时错误', async () => {
    vi.useFakeTimers();
    try {
      const createMysqlExecutor = vi.fn(() => new Promise<DriftQueryExecutor>(() => undefined));
      const view = makeView({
        resolveProfile: mysqlProfile,
        resolveConfig: mysqlConfig,
        createMysqlExecutor,
        connectTimeoutMs: 50
      });
      view.show();

      panelRegistry.fireMessage(panel(), { command: 'loadTables' });
      await vi.advanceTimersByTimeAsync(60);

      expect(posted().at(-1)).toMatchObject({
        command: 'tablesLoaded',
        result: { ok: false, error: expect.stringContaining('连接 MySQL 超时') }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
