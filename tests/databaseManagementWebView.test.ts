import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { panelRegistry, window as stubWindow } from './helpers/vscodeStub';
import { windowState } from './fake-vscode/windowState';
import { DatabaseManagementWebView } from '../src/databaseManagementWebView';
import type { DatabaseInterfaceConfig } from '../src/serverConfigMerge';
import type { DriftQueryExecutor } from '../src/backend/databaseDrift';
import type { RedisSession } from '../src/backend/redisDrift';
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

describe('DatabaseManagementWebView 缺口臂(默认依赖/后端错配/配置缺失/晚落地/弃置面)', () => {

  /** 第 i 个面板的推送序列(多面板用例:view2/3/4 各自建面板)。 */
  const postedAt = (index: number) =>
    panelRegistry.panels[index]!.webview.postedMessages.map(m => m.message);
  it('零注入构造:默认依赖装配不抛错(resolveConfig 等走真实现装载)', () => {
    const view = new DatabaseManagementWebView({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    expect(view).toBeInstanceOf(DatabaseManagementWebView);
    view.dispose();
  });

  it('mysql 门口径:redis 档案 → 「当前数据库后端不是 MySQL」;配置缺失 → 「未读取到连接配置」', async () => {
    const createMysqlExecutor = vi.fn();
    const view = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, createMysqlExecutor });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();
    expect(createMysqlExecutor).not.toHaveBeenCalled();
    expect(posted().at(-1)).toEqual({
      command: 'tablesLoaded',
      result: { ok: false, error: '当前数据库后端不是 MySQL' }
    });

    const createMysqlExecutor2 = vi.fn();
    const view2 = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: () => null,
      createMysqlExecutor: createMysqlExecutor2
    });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'loadTables' });
    await flush();
    expect(createMysqlExecutor2).not.toHaveBeenCalled();
    expect(postedAt(1).at(-1)).toEqual({
      command: 'tablesLoaded',
      result: { ok: false, error: '未读取到连接配置' }
    });
  });

  it('redis 门口径:mysql 档案 → 「当前数据库后端不是 Redis」;配置缺失 → 「未读取到连接配置」', async () => {
    const openRedisSession = vi.fn();
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, openRedisSession });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();
    expect(openRedisSession).not.toHaveBeenCalled();
    expect(posted().at(-1)).toEqual({
      command: 'keysLoaded',
      result: { ok: false, error: '当前数据库后端不是 Redis' }
    });

    const openRedisSession2 = vi.fn();
    const view2 = makeView({
      resolveProfile: redisProfile,
      resolveConfig: () => null,
      openRedisSession: openRedisSession2
    });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'scanKeys' });
    await flush();
    expect(openRedisSession2).not.toHaveBeenCalled();
    expect(postedAt(1).at(-1)).toEqual({
      command: 'keysLoaded',
      result: { ok: false, error: '未读取到连接配置' }
    });
  });

  it('connectTimeoutMs=0:不限时直通建连,数据面照常', async () => {
    const executor = fakeExecutor();
    const createMysqlExecutor = vi.fn(async () => executor);
    const view = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: mysqlConfig,
      createMysqlExecutor,
      connectTimeoutMs: 0
    });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();
    expect(posted().at(-1)).toMatchObject({
      command: 'tablesLoaded',
      result: { ok: true }
    });
  });

  it('mysql 建连晚落地(超时后才 resolve):超时错误先发,晚到句柄防泄漏关闭', async () => {
    const executor = fakeExecutor();
    let resolveExec: (value: DriftQueryExecutor) => void = () => undefined;
    const view = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: mysqlConfig,
      createMysqlExecutor: () =>
        new Promise<DriftQueryExecutor>(resolve => {
          resolveExec = resolve;
        }),
      connectTimeoutMs: 20
    });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(posted().some(m => (m as { command?: string }).command === 'tablesLoaded')).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    // 超时错误已发
    expect(posted().at(-1)).toMatchObject({
      command: 'tablesLoaded',
      result: { ok: false, error: expect.stringContaining('连接 MySQL 超时') }
    });
    // 晚落地执行器:超时胜出后才 resolve → 防泄漏关闭
    resolveExec(executor);
    await flush();
    expect(executor.close).toHaveBeenCalledTimes(1);
  });

  it('mysql previewTable 建连晚落地:超时错误 + 晚到句柄关闭', async () => {
    const executor = fakeExecutor();
    let resolveExec: (value: DriftQueryExecutor) => void = () => undefined;
    const view = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: mysqlConfig,
      createMysqlExecutor: () =>
        new Promise<DriftQueryExecutor>(resolve => {
          resolveExec = resolve;
        }),
      connectTimeoutMs: 20
    });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl_Account' });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(posted().at(-1)).toMatchObject({
      command: 'tablePreview',
      result: { kind: 'error', message: expect.stringContaining('连接 MySQL 超时') }
    });
    resolveExec(executor);
    await flush();
    expect(executor.close).toHaveBeenCalledTimes(1);
  });

  it('建连在途被 setTab 弃置后工厂才 reject:旧代错误静默,零 tablesLoaded', async () => {
    let rejectExec: (reason: Error) => void = () => undefined;
    const view = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: mysqlConfig,
      createMysqlExecutor: () =>
        new Promise<DriftQueryExecutor>((_resolve, reject) => {
          rejectExec = reject;
        })
    });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();
    panelRegistry.fireMessage(panel(), { command: 'setTab', tab: 'redis' });
    rejectExec(new Error('late boom'));
    await flush();
    expect(posted().some(m => (m as { command?: string }).command === 'tablesLoaded')).toBe(false);
  });

  it('previewTable 结果在途被 setTab 弃置:查询晚回不渲染;查询抛错新代照常亮错', async () => {
    // 成功路径晚回 + 代际已换代 → 弃置
    const executor = fakeExecutor();
    let resolveRows: (value: unknown) => void = () => undefined;
    executor.runQuery.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRows = resolve;
        })
    );
    const view = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor: async () => executor });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl_Account' });
    await flush();
    panelRegistry.fireMessage(panel(), { command: 'setTab', tab: 'redis' });
    resolveRows({ columns: [{ name: 'id', type: 'INT' }], rows: [{ id: 1 }] });
    await flush();
    expect(posted().some(m => (m as { command?: string }).command === 'tablePreview')).toBe(false);
    expect(executor.close).toHaveBeenCalledTimes(1);

    // 抛错路径(新代现行)→ 错误条
    const executor2 = fakeExecutor();
    executor2.runQuery.mockRejectedValueOnce(new Error('query exploded'));
    const view2 = makeView({ resolveProfile: mysqlProfile, resolveConfig: mysqlConfig, createMysqlExecutor: async () => executor2 });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'previewTable', table: 'tbl_Account' });
    await flush();
    expect(postedAt(1).at(-1)).toMatchObject({
      command: 'tablePreview',
      result: { kind: 'error', message: 'query exploded' }
    });
    expect(executor2.close).toHaveBeenCalledTimes(1);
  });

  it('previewTable 建连抛错且代已换代 → 旧代错误静默,零 tablePreview', async () => {
    // previewTableData 对查询失败自身兜底为 error-result 不抛;catch 面只能由
    // 建连期抛错(工厂 reject/超时)进入,此处锁「抛错时代已换代」的弃置面。
    let rejectExec: (reason: Error) => void = () => undefined;
    const view = makeView({
      resolveProfile: mysqlProfile,
      resolveConfig: mysqlConfig,
      createMysqlExecutor: () =>
        new Promise<DriftQueryExecutor>((_resolve, reject) => {
          rejectExec = reject;
        })
    });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl_Account' });
    await flush();
    panelRegistry.fireMessage(panel(), { command: 'setTab', tab: 'redis' });
    rejectExec(new Error('stale connect'));
    await flush();
    expect(posted().some(m => (m as { command?: string }).command === 'tablePreview')).toBe(false);
  });

  it('默认依赖装配:零注入 show/loadTables 走真实现取数(无工作区档案如实 null 门)', async () => {
    const view = new DatabaseManagementWebView({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'loadTables' });
    await flush();
    // 真实现取数在测试环境拿不到档案/配置:如实落错误门,不炸面板
    const last = posted().at(-1) as { command: string; result: { ok: boolean; error: string } };
    expect(last.command).toBe('tablesLoaded');
    expect(last.result.ok).toBe(false);
    view.dispose();

    // 档案注入但 resolveConfig 缺省:默认解析器跑真实现,读不到如实拒连
    const view2 = makeView({ resolveProfile: mysqlProfile });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'loadTables' });
    await flush();
    const last2 = panelRegistry.panels[1]!.webview.postedMessages.map(m => m.message).at(-1) as {
      command: string;
      result: { ok: boolean; error: string };
    };
    expect(last2.command).toBe('tablesLoaded');
    expect(last2.result.ok).toBe(false);
    expect(last2.result.error).toContain('配置');
  });

  it('无档案门(previewTable/previewKey/scanKeys):如实落各自错误条', async () => {
    const factory = vi.fn();
    const view = makeView({ resolveProfile: () => null, createMysqlExecutor: factory, openRedisSession: factory });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'previewTable', table: 'tbl_Account' });
    await flush();
    expect(posted().at(-1)).toEqual({
      command: 'tablePreview',
      result: { kind: 'error', message: '未读取到引擎数据库档案' }
    });
    panelRegistry.fireMessage(panel(), { command: 'previewKey', key: 'kbe_a' });
    await flush();
    expect(posted().at(-1)).toEqual({
      command: 'keyPreview',
      result: { ok: false, error: '未读取到引擎数据库档案' }
    });
    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();
    expect(posted().at(-1)).toEqual({
      command: 'keysLoaded',
      result: { ok: false, error: '未读取到引擎数据库档案' }
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('redis 建连晚落地(scanKeys/previewKey):超时错误先发,晚到会话防泄漏关闭', async () => {
    for (const message of [
      { command: 'scanKeys' },
      { command: 'previewKey', key: 'kbe_entitylog:1:2' }
    ]) {
      panelRegistry.reset();
      const session = fakeSession();
      let resolveSession: (value: RedisSession) => void = () => undefined;
      const view = makeView({
        resolveProfile: redisProfile,
        resolveConfig: mysqlConfig,
        openRedisSession: () =>
          new Promise<RedisSession>(resolve => {
            resolveSession = resolve;
          }),
        connectTimeoutMs: 20
      });
      view.show();
      panelRegistry.fireMessage(panel(), message);
      await new Promise(resolve => setTimeout(resolve, 40));
      const last = posted().at(-1) as { command: string; result: { ok?: boolean; error: string } };
      expect(last.result.ok).toBe(false);
      expect(last.result.error).toContain('连接 Redis 超时');
      // 晚落地会话:超时胜出后才 resolve → 防泄漏关闭
      resolveSession(session);
      await flush();
      expect(session.close).toHaveBeenCalledTimes(1);
    }
  });

  it('redis 结果在途被 setTab 弃置:scanKeys/hashGetAll 晚回零渲染', async () => {
    const session = fakeSession();
    let resolveScan: (value: { cursor: string; keys: string[] }) => void = () => undefined;
    session.scanKeys.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveScan = resolve;
        })
    );
    const view = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();
    panelRegistry.fireMessage(panel(), { command: 'setTab', tab: 'mysql' });
    resolveScan({ cursor: '0', keys: ['kbe_a'] });
    await flush();
    expect(posted().some(m => (m as { command?: string }).command === 'keysLoaded')).toBe(false);
    expect(session.close).toHaveBeenCalledTimes(1);

    const session2 = fakeSession();
    let resolveHash: (value: Record<string, string>) => void = () => undefined;
    session2.hashGetAll.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveHash = resolve;
        })
    );
    const view2 = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session2 });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'previewKey', key: 'kbe_entitylog:1:2' });
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'setTab', tab: 'mysql' });
    resolveHash({ id: '1' });
    await flush();
    expect(posted().some(m => (m as { command?: string }).command === 'keyPreview')).toBe(false);
    expect(session2.close).toHaveBeenCalledTimes(1);
  });

  it('redis 命令抛错:新代现行亮错误条;代已换代旧代静默', async () => {
    // 新代现行:scanKeys 抛错 → keysLoaded 错误
    const session = fakeSession();
    session.scanKeys.mockRejectedValueOnce(new Error('scan exploded'));
    const view = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session });
    view.show();
    panelRegistry.fireMessage(panel(), { command: 'scanKeys' });
    await flush();
    expect(posted().at(-1)).toMatchObject({
      command: 'keysLoaded',
      result: { ok: false, error: 'scan exploded' }
    });
    expect(session.close).toHaveBeenCalledTimes(1);

    // 新代现行:hashGetAll 抛错 → keyPreview 错误
    const session2 = fakeSession();
    session2.hashGetAll.mockRejectedValueOnce(new Error('hash exploded'));
    const view2 = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session2 });
    view2.show();
    panelRegistry.fireMessage(panelRegistry.panels[1]!, { command: 'previewKey', key: 'kbe_a' });
    await flush();
    expect(postedAt(1).at(-1)).toMatchObject({
      command: 'keyPreview',
      result: { ok: false, error: 'hash exploded' }
    });
    expect(session2.close).toHaveBeenCalledTimes(1);

    // 代已换代:scanKeys 抛错 → 旧代静默
    const session3 = fakeSession();
    let rejectScan: (reason: Error) => void = () => undefined;
    session3.scanKeys.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        })
    );
    const view3 = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session3 });
    view3.show();
    panelRegistry.fireMessage(panelRegistry.panels[2]!, { command: 'scanKeys' });
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[2]!, { command: 'setTab', tab: 'mysql' });
    rejectScan(new Error('stale scan'));
    await flush();
    expect(postedAt(2).some(m => (m as { command?: string }).command === 'keysLoaded')).toBe(false);
    expect(session3.close).toHaveBeenCalledTimes(1);

    // 代已换代:hashGetAll 抛错 → 旧代静默
    const session4 = fakeSession();
    let rejectHash: (reason: Error) => void = () => undefined;
    session4.hashGetAll.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHash = reject;
        })
    );
    const view4 = makeView({ resolveProfile: redisProfile, resolveConfig: mysqlConfig, openRedisSession: async () => session4 });
    view4.show();
    panelRegistry.fireMessage(panelRegistry.panels[3]!, { command: 'previewKey', key: 'kbe_a' });
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[3]!, { command: 'setTab', tab: 'mysql' });
    rejectHash(new Error('stale hash'));
    await flush();
    expect(postedAt(3).some(m => (m as { command?: string }).command === 'keyPreview')).toBe(false);
    expect(session4.close).toHaveBeenCalledTimes(1);
  });
});

});
