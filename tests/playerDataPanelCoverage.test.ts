// playerDataPanel.ts 覆盖收口(测试扇出 2026-11-08):树提供器(toItem/
// refresh/getChildren 含派生失败吞错)、连接配置聚合(明文就地读取)、
// 连接测试与 dbid 查询全分支(成功/降级/失败/close 吞错)。依赖 mock 边界
// = configDerive/serverConfigMerge/databaseDrift,面板逻辑全走真实代码。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../src/configDerive', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/configDerive')>();
  return {
    ...actual,
    getDerivedDatabaseProfile: vi.fn(),
    ensureConfigDerivedScanRoot: vi.fn()
  };
});
vi.mock('../src/serverConfigMerge', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/serverConfigMerge')>();
  return { ...actual, resolveDatabaseInterfaceConfig: vi.fn(), buildConfigTreePair: vi.fn() };
});
vi.mock('../src/databaseDrift', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/databaseDrift')>();
  return { ...actual, createMysqlDriftExecutor: vi.fn() };
});

// 依赖 mock 后的模块(import 顺序须在 vi.mock 之后)
import { ensureConfigDerivedScanRoot, getDerivedDatabaseProfile } from '../src/configDerive';
import { createMysqlDriftExecutor, type DriftQueryExecutor, type QueryResult } from '../src/databaseDrift';
import { buildConfigTreePair, resolveDatabaseInterfaceConfig } from '../src/serverConfigMerge';
import {
  PLAYER_DATA_CHANNEL_NAME,
  PlayerDataTreeProvider,
  READ_ONLY_QUERY_CHECK_CONNECTION,
  READ_ONLY_QUERY_MISSING_CONFIG,
  READ_ONLY_QUERY_OPEN_REPORT,
  buildPlayerQuerySql,
  queryPlayerByDbid,
  readOnlyQueryConfigGate,
  testPlayerDatabaseConnection
} from '../src/playerDataPanel';
import { configurationOverrides } from './fake-vscode/workspaceState';
import { windowState } from './fake-vscode/windowState';

const mockedProfile = vi.mocked(getDerivedDatabaseProfile);
const mockedEnsure = vi.mocked(ensureConfigDerivedScanRoot);
const mockedResolve = vi.mocked(resolveDatabaseInterfaceConfig);
const mockedPair = vi.mocked(buildConfigTreePair);
const mockedCreate = vi.mocked(createMysqlDriftExecutor);

/** 假只读执行器:记录查询与关闭,可脚本化失败。 */
class FakeExecutor implements DriftQueryExecutor {
  queries: string[] = [];
  closed = 0;
  result: QueryResult = {
    columns: [],
    rows: [{ id: 7, sm_name: 'hero' } as Record<string, unknown>]
  };
  queryError: Error | null = null;
  closeError: Error | null = null;

  async runQuery(sql: string): Promise<QueryResult> {
    this.queries.push(sql);
    if (this.queryError) {
      throw this.queryError;
    }
    return this.result;
  }

  async close(): Promise<void> {
    this.closed += 1;
    if (this.closeError) {
      throw this.closeError;
    }
  }
}

const mysqlProfile = () => ({
  available: true,
  dbType: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  username: 'kbe',
  databaseName: 'kbe',
  characterSet: 'utf8mb4',
  encrypt: false,
  passwordAvailable: true
});

const installExecutor = (): FakeExecutor => {
  const executor = new FakeExecutor();
  mockedCreate.mockImplementation(async () => executor);
  return executor;
};

/** 最终合成配置全叶样例(用户令 2026-11-09:视图主真源=resolve dbInterface) */
const finalConfig = (overrides: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port: 13306,
  username: 'kbe',
  databaseName: 'kbe',
  encrypt: false,
  characterSet: 'utf8mb4',
  plainPassword: 'pw',
  ...overrides
});

/** 元件配置在场(非 defaults-only)的树对样例 */
const treePairWithCustom = () => ({
  customTree: { name: 'root', text: '', children: [] },
  defaultsTree: null,
  customPath: '/assets/res/server/kbengine.xml',
  defaultsPath: '/engine/kbe/res/server/kbengine_defaults.xml'
});

beforeEach(() => {
  vi.resetAllMocks();
  windowState.reset();
  configurationOverrides.clear();
  mockedProfile.mockReturnValue(mysqlProfile() as never);
  mockedResolve.mockReturnValue(finalConfig() as never);
  mockedPair.mockReturnValue(treePairWithCustom() as never);
  mockedEnsure.mockResolvedValue({ ok: true } as never);
});

describe('PlayerDataTreeProvider(覆盖收口)', () => {
  it('refresh → onDidChangeTreeData fire(null)', () => {
    const provider = new PlayerDataTreeProvider();
    const fired: Array<unknown> = [];
    provider.event(value => fired.push(value));
    provider.refresh();
    expect(fired).toEqual([null]);
  });

  it('getTreeItem 原样返回元素', () => {
    const provider = new PlayerDataTreeProvider();
    const node = { label: 'x' } as unknown as ReturnType<typeof provider.getTreeItem>;
    expect(provider.getTreeItem(node)).toBe(node);
  });

  it('getChildren 顶层:任务入口(004a)+ 派生档案;顺手触发派生刷新', () => {
    const provider = new PlayerDataTreeProvider();
    const nodes = provider.getChildren();
    expect(mockedEnsure).toHaveBeenCalledTimes(1);
    // 3 条任务入口 + 连接档案
    expect(nodes).toHaveLength(4);
    expect(nodes[0].label).toBe('只读查询(DBID)');
    expect(nodes[0].command).toMatchObject({ command: 'kbengine.playerData.queryByDbid' });
    expect(nodes[1].label).toBe('导出玩家(Export)');
    expect(nodes[1].command).toMatchObject({ command: 'kbengine.clone.export' });
    expect(nodes[2].label).toBe('导入到本地或测试库(Import)');
    expect(nodes[2].command).toMatchObject({ command: 'kbengine.clone.import' });
    // 任务条目说明点明「不代表在线状态」(004a 验收线)
    for (const task of nodes.slice(0, 3) as Array<{ description?: string }>) {
      expect(task.description).toContain('不代表在线状态');
    }
    const root = nodes[3];
    expect(root.label).toBe('mysql default');
    expect(root.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(root.description).toBe('127.0.0.1:13306/kbe');
    // toItem 面:children 原样透传(非递归 toItem——子项无展开态字段)
    expect(root.children).toHaveLength(7);
    expect(root.children?.every(child => child.collapsibleState === undefined)).toBe(true);
    expect(root.children?.map(child => child.label)).toEqual([
      '类型', '主机', '端口', '账号', '密码', '数据库', '字符集'
    ]);
  });

  it('getChildren 子层:元素自带 children → toItem 映射', () => {
    const provider = new PlayerDataTreeProvider();
    const element = {
      children: [{ label: '主机', description: '127.0.0.1' }]
    } as unknown as ReturnType<typeof provider.getTreeItem> & { children: Array<{ label: string; description: string }> };
    const children = provider.getChildren(element);
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe('主机');
    expect(children[0].description).toBe('127.0.0.1');
  });

  it('派生刷新失败 → 吞错不冒泡(面板如实展示当前帧)', async () => {
    mockedEnsure.mockRejectedValue(new Error('derive boom'));
    const provider = new PlayerDataTreeProvider();
    expect(() => provider.getChildren()).not.toThrow();
    // 让吞错分支真正执行(微任务排空)
    await new Promise(resolve => setImmediate(resolve));
    expect(mockedProfile).toHaveBeenCalled();
  });

  it('无派生档案 → 任务入口仍可用 + 单节点「未找到数据库配置段」', () => {
    mockedProfile.mockReturnValue(null);
    // 最终配置也无:两面皆空 = 真没有,面板如实降级单节点
    mockedResolve.mockReturnValue(null as never);
    const provider = new PlayerDataTreeProvider();
    const nodes = provider.getChildren();
    // 任务入口(真实命令)不因无档案消失;档案区如实降级单节点
    expect(nodes).toHaveLength(4);
    expect(nodes[3].label).toContain('未找到数据库配置段');
    expect(nodes[0].command).toMatchObject({ command: 'kbengine.playerData.queryByDbid' });
  });

  it('用户令 2026-11-09:最终配置优先于派生档案——面板与连接都以 resolve dbInterface 为准', () => {
    // 派生缓存仍是旧默认(127.0.0.1:13306),最终配置已是部署真值(192.168.5.5):
    // 面板展示与建连要素都必须跟最终配置走,不吃派生缓存旧值。
    mockedResolve.mockReturnValue(
      finalConfig({
        host: '192.168.5.5',
        port: 3306,
        username: 'root',
        databaseName: 'kode_demo',
        plainPassword: 'pw-final'
      }) as never
    );
    const provider = new PlayerDataTreeProvider();
    const nodes = provider.getChildren();
    const root = nodes[3];
    expect(root.description).toBe('192.168.5.5:3306/kode_demo');
    const children = root.children ?? [];
    const byLabel = (label: string): string =>
      String(children.find(child => child.label === label)?.description ?? '');
    expect(byLabel('主机')).toBe('192.168.5.5');
    expect(byLabel('账号')).toBe('root');
    expect(byLabel('数据库')).toBe('kode_demo');
    // 建连要素同源(不再派生 host + resolve 密码异源)
    const executor = installExecutor();
    return testPlayerDatabaseConnection().then(result => {
      expect(result).toContain('连接成功');
      expect(result).toContain('192.168.5.5:3306/kode_demo');
      expect(mockedCreate.mock.calls[0][0]).toMatchObject({
        host: '192.168.5.5',
        port: 3306,
        username: 'root',
        databaseName: 'kode_demo',
        plainPassword: 'pw-final'
      });
      expect(executor.closed).toBe(1);
    });
  });

  it('用户令 2026-11-09:defaults-only 如实告警——引擎默认值不许装成最终配置', async () => {
    mockedPair.mockReturnValue({
      customTree: null,
      defaultsTree: null,
      customPath: null,
      defaultsPath: null
    } as never);
    // 面板:描述带「引擎默认」标记,tooltip 注明未发现元件配置
    const provider = new PlayerDataTreeProvider();
    const nodes = provider.getChildren();
    const root = nodes[3] as { description?: string; tooltip?: { value?: string } };
    expect(root.description).toBe('127.0.0.1:13306/kbe(引擎默认)');
    expect(root.tooltip?.value ?? '').toContain('未发现元件 kbengine.xml');
    // 命令结果:连接成功/失败都追加 defaults-only 注意,不静默
    const executor = installExecutor();
    const okResult = await testPlayerDatabaseConnection();
    expect(okResult).toContain('连接成功');
    expect(okResult).toContain('注意:');
    expect(okResult).toContain('kbengine_defaults.xml');
    executor.queryError = new Error('ECONNREFUSED');
    const failResult = await testPlayerDatabaseConnection();
    expect(failResult).toContain('连接失败');
    expect(failResult).toContain('注意:');
  });
});

describe('testPlayerDatabaseConnection 全分支(覆盖收口)', () => {
  it('无派生档案 → 未测试如实降级,不建连', async () => {
    mockedProfile.mockReturnValue(null);
    // 最终配置也无(resolve null):两面皆空 = 真没有,如实降级
    mockedResolve.mockReturnValue(null as never);
    const result = await testPlayerDatabaseConnection();
    expect(result).toContain('未找到数据库配置段');
    expect(result).toContain('未测试');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('encrypt 且无明文 → RSA 密文不解读,未测试', async () => {
    mockedProfile.mockReturnValue({ ...mysqlProfile(), encrypt: true } as never);
    mockedResolve.mockReturnValue({ ...finalConfig(), encrypt: true, plainPassword: undefined } as never);
    const result = await testPlayerDatabaseConnection();
    expect(result).toContain('RSA 密文');
    expect(result).toContain('未测试');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('连接成功:SELECT 1 只读探测,要素齐全,耗时展示,会话关闭', async () => {
    const executor = installExecutor();
    const result = await testPlayerDatabaseConnection();
    expect(executor.queries).toEqual(['SELECT 1 AS ok']);
    expect(result).toContain('连接成功');
    expect(result).toContain('127.0.0.1:13306/kbe');
    expect(result).toContain('只读会话');
    expect(executor.closed).toBe(1);
    // 聚合的连接要素与派生档案同源(明文就地读取)
    expect(mockedCreate.mock.calls[0][0]).toMatchObject({
      host: '127.0.0.1',
      port: 13306,
      username: 'kbe',
      databaseName: 'kbe',
      encrypt: false,
      characterSet: 'utf8mb4',
      plainPassword: 'pw'
    });
  });

  it('探测失败 → 「连接失败:<原因>」只读降级,会话仍关闭', async () => {
    const executor = installExecutor();
    executor.queryError = new Error('ECONNREFUSED');
    const result = await testPlayerDatabaseConnection();
    expect(result).toContain('连接失败');
    expect(result).toContain('ECONNREFUSED');
    expect(result).toContain('只读降级');
    expect(executor.closed).toBe(1);
  });

  it('非 Error 失败 → String 化原因', async () => {
    const executor = installExecutor();
    executor.queryError = 'boom-string' as unknown as Error;
    const result = await testPlayerDatabaseConnection();
    expect(result).toContain('boom-string');
  });

  it('close 失败 → 不掩盖主结果(连接成功照常返回)', async () => {
    const executor = installExecutor();
    executor.closeError = new Error('close hang');
    const result = await testPlayerDatabaseConnection();
    expect(result).toContain('连接成功');
    expect(executor.closed).toBe(1);
  });
});

describe('queryPlayerByDbid 全分支(覆盖收口)', () => {
  it('非法 dbid → 查询前即拒绝', async () => {
    expect(await queryPlayerByDbid('4.2')).toContain('十进制正整数');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('无派生档案 → 未查询如实降级', async () => {
    mockedProfile.mockReturnValue(null);
    // 最终配置也无:两面皆空 = 真没有,如实降级
    mockedResolve.mockReturnValue(null as never);
    expect(await queryPlayerByDbid('42')).toContain('未找到数据库配置段——未查询');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('明文不可读 → 未查询如实降级(不虚构连接)', async () => {
    mockedResolve.mockReturnValue({ ...finalConfig(), plainPassword: undefined } as never);
    expect(await queryPlayerByDbid('42')).toContain('密码不可读');
    expect(await queryPlayerByDbid('42')).toContain('未查询');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('查询成功:表前缀来自配置、SQL 白名单形态、整表 JSON 落输出通道', async () => {
    configurationOverrides.set('kbengine', { 'db.tablePrefix': 'x_' });
    const executor = installExecutor();
    executor.result = { columns: [], rows: [{ id: 42, sm_name: 'alice' }] };
    const result = await queryPlayerByDbid(' 42 ');
    expect(executor.queries).toEqual(['SELECT * FROM `x_Account` WHERE `id` = 42']);
    expect(result).toContain('查询完成:1 行');
    expect(result).toContain('只读');
    const channel = windowState.channels[windowState.channels.length - 1];
    expect(channel.name).toBe(PLAYER_DATA_CHANNEL_NAME);
    const text = channel.lines.join('\n');
    expect(text).toContain('[dbid 42] SELECT * FROM `x_Account` WHERE `id` = 42');
    expect(text).toContain(JSON.stringify({ id: 42, sm_name: 'alice' }));
    expect(executor.closed).toBe(1);
  });

  it('0 行 → 输出通道注明该 dbid 不存在', async () => {
    const executor = installExecutor();
    executor.result = { columns: [], rows: [] };
    const result = await queryPlayerByDbid('999');
    expect(result).toContain('查询完成:0 行');
    const text = windowState.channels[windowState.channels.length - 1].lines.join('\n');
    expect(text).toContain('(0 行——该 dbid 不存在或账号表为空)');
    // 缺省前缀 tbl_
    expect(executor.queries[0]).toContain('`tbl_Account`');
  });

  it('查询失败 → 「查询失败:<原因>」,会话仍关闭', async () => {
    const executor = installExecutor();
    executor.queryError = new Error('READ ONLY session');
    const result = await queryPlayerByDbid('42');
    expect(result).toContain('查询失败');
    expect(result).toContain('READ ONLY session');
    expect(executor.closed).toBe(1);
  });

  it('close 失败 → 不掩盖查询结果', async () => {
    const executor = installExecutor();
    executor.closeError = new Error('close boom');
    const result = await queryPlayerByDbid('42');
    expect(result).toContain('查询完成');
  });
});

describe('buildPlayerQuerySql 纯函数(覆盖收口)', () => {
  it('非法 dbid 拒;合法 dbid 拼白名单 SQL;前缀反引号剥除', () => {
    expect(buildPlayerQuerySql('12ab', '')).toBeNull();
    expect(buildPlayerQuerySql('', '')).toBeNull();
    expect(buildPlayerQuerySql('7', '')).toBe('SELECT * FROM `tbl_Account` WHERE `id` = 7');
    expect(buildPlayerQuerySql('7', ' x_ ')).toBe('SELECT * FROM `x_Account` WHERE `id` = 7');
    expect(buildPlayerQuerySql('7', 'x`_')).toBe('SELECT * FROM `x_Account` WHERE `id` = 7');
  });
});

describe('readOnlyQueryConfigGate(004d)', () => {
  it('有派生档案 → 闸放行(null);无档案 → 降级文案点明来源边界与两个恢复入口', () => {
    expect(readOnlyQueryConfigGate(mysqlProfile() as never)).toBeNull();
    const message = readOnlyQueryConfigGate(null);
    expect(message).toBe(READ_ONLY_QUERY_MISSING_CONFIG);
    expect(message).toContain('dbmgr/databaseInterfaces/default');
    expect(message).toContain('与克隆 Source/Target 台账无关');
    // 两个恢复入口都是真实命令面(发现报告 / 重新派生并检查连接)
    expect(typeof READ_ONLY_QUERY_OPEN_REPORT).toBe('string');
    expect(typeof READ_ONLY_QUERY_CHECK_CONNECTION).toBe('string');
  });
});
