import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseConnectionRegistry,
  DatabaseQueryResultCache,
  DEFAULT_QUERY_RESULT_TTL_MS
} from '../src/databaseConnectionRegistry';
import type { DatabaseInterfaceConfig } from '../src/serverConfigMerge';
import {
  ProfileDatabaseConnectionService,
  WORKSPACE_DEFAULT_DATABASE_PROFILE_ID,
  createProfileScopedDriftExecutor,
  resolveProfileDatabaseInterfaceConfig
} from '../src/profileDatabaseConnection';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-REV-015(原项 IDE-DB-001 重开):连接台账接到真实命令的中介面——
// 活动 profile 的引擎根/资产根各自推导连接要素入台账,命令只认台账;
// 切换即释放旧 profile 的会话缓存;查询结果按 profile 缓存(TTL 内同 SQL
// 不再下发,判读字段往返不丢)。

const CONFIG_A: DatabaseInterfaceConfig = {
  host: '10.0.0.1', port: 3301, username: 'game-a', databaseName: 'db_a',
  encrypt: false, characterSet: 'utf8mb4', plainPassword: 'pa'
};
const CONFIG_B: DatabaseInterfaceConfig = {
  host: '10.0.0.2', port: 3302, username: 'game-b', databaseName: 'db_b',
  encrypt: false, characterSet: 'utf8mb4', plainPassword: 'pb'
};

interface Harness {
  registry: DatabaseConnectionRegistry;
  cache: DatabaseQueryResultCache;
  resolveConfig: ReturnType<typeof vi.fn>;
  service: ProfileDatabaseConnectionService;
  saved: unknown[];
}

const makeService = (
  configs: Record<string, DatabaseInterfaceConfig | null>
): Harness => {
  const saved: unknown[] = [];
  const registry = new DatabaseConnectionRegistry({ now: () => 1, save: data => saved.push(data) });
  const cache = new DatabaseQueryResultCache({ now: () => 1 });
  const resolveConfig = vi.fn((profile: { engineRoot: string } | null) =>
    profile === null ? (configs['<workspace>'] ?? null) : (configs[profile.engineRoot] ?? null)
  );
  const service = new ProfileDatabaseConnectionService({ registry, queryResultCache: cache, resolveConfig });
  return { registry, cache, resolveConfig, service, saved };
};

describe('ProfileDatabaseConnectionService(台账中介)', () => {
  it('两个 profile 各自选择各自取:连接配置互不串,命令只认台账', () => {
    const h = makeService({ '/eng/a': CONFIG_A, '/eng/b': CONFIG_B });
    expect(h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' }))
      .toMatchObject({ host: '10.0.0.1', port: 3301 });
    expect(h.service.getActiveConfig('id-a')).toMatchObject({ host: '10.0.0.1', port: 3301, plainPassword: 'pa' });
    expect(h.service.selectActive('id-b', { engineRoot: '/eng/b', assetsRoot: '' }))
      .toMatchObject({ host: '10.0.0.2', port: 3302 });
    expect(h.service.getActiveConfig('id-b')).toMatchObject({ host: '10.0.0.2', port: 3302, plainPassword: 'pb' });

    // 切走后 A 的会话面已释放(全量要素不再可取),台账快照留档;
    // 切回重选即恢复——绝不因释放而读到 B 的配置
    expect(h.service.getActiveConfig('id-a')).toBeNull();
    expect(h.registry.getActive('id-a')).toMatchObject({ host: '10.0.0.1' });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    expect(h.service.getActiveConfig('id-a')).toMatchObject({ host: '10.0.0.1', port: 3301 });
  });

  it('解析失败/未选过 = 如实 null,邻居台账不动', () => {
    const h = makeService({ '/eng/a': CONFIG_A, '/eng/b': null });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    h.service.selectActive('id-b', { engineRoot: '/eng/b', assetsRoot: '' });

    expect(h.service.getActiveConfig('id-b')).toBeNull(); // 解析失败如实 null
    expect(h.registry.getActive('id-b')).toBeNull(); // 台账也不记(不回退邻居)
    expect(h.registry.getActive('id-a')).toMatchObject({ host: '10.0.0.1' }); // 邻居台账原样
  });

  it('切换即释放:旧 profile 的结果缓存被清,新 profile 不继承', () => {
    const h = makeService({ '/eng/a': CONFIG_A, '/eng/b': CONFIG_B });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    h.cache.set('id-a', 'SHOW TABLES', { columns: [], rows: [{ t: 'tbl_Gold' }] });
    expect(h.cache.get('id-a', 'SHOW TABLES')).toBeDefined();

    h.service.selectActive('id-b', { engineRoot: '/eng/b', assetsRoot: '' });

    expect(h.cache.get('id-a', 'SHOW TABLES')).toBeUndefined(); // 释放
    expect(h.cache.get('id-b', 'SHOW TABLES')).toBeUndefined(); // 新人不吃旧缓存
    expect(h.service.getActiveConfig('id-b')).toMatchObject({ host: '10.0.0.2' });
  });

  it('台账快照与全量要素不一致(陈旧)= null,不拿旧全量冒充新选择', () => {
    const h = makeService({ '/eng/a': CONFIG_A });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    // 台账被外部覆盖成另一份快照(引擎配置变更未经服务重选)
    h.registry.select('id-a', () => ({ host: '10.9.9.9', port: 9999, user: 'x', database: 'y' }));
    expect(h.service.getActiveConfig('id-a')).toBeNull(); // 对账不过 = 如实无配置
  });

  it('无活动 profile = 工作区默认键,与 profile 键互不混', () => {
    const h = makeService({ '/eng/a': CONFIG_A, '<workspace>': CONFIG_B });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    h.service.selectActive(WORKSPACE_DEFAULT_DATABASE_PROFILE_ID, null);

    expect(h.service.getActiveConfig(WORKSPACE_DEFAULT_DATABASE_PROFILE_ID))
      .toMatchObject({ host: '10.0.0.2' });
    // 各键各的台账:工作区默认键不覆盖 profile 键的快照
    expect(h.registry.getActive(WORKSPACE_DEFAULT_DATABASE_PROFILE_ID))
      .toMatchObject({ host: '10.0.0.2' });
    expect(h.registry.getActive('id-a')).toMatchObject({ host: '10.0.0.1' });
  });

  it('重选同 profile 覆盖旧配置(引擎配置变更生效)且不清自己的缓存', () => {
    const h = makeService({ '/eng/a': CONFIG_A });
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });
    h.cache.set('id-a', 'SHOW TABLES', { columns: [], rows: [] });

    h.resolveConfig.mockImplementation(() => CONFIG_B);
    h.service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' }); // 同 profile 重选

    expect(h.service.getActiveConfig('id-a')).toMatchObject({ host: '10.0.0.2' });
    expect(h.cache.get('id-a', 'SHOW TABLES')).toBeDefined(); // 同人不触发释放
  });

  it('台账快照随选择落盘(save),重启经 load 按 profile 读回', () => {
    const store = new Map<string, unknown>();
    const registry = new DatabaseConnectionRegistry({
      now: () => 1,
      load: () => store.get('connections'),
      save: data => store.set('connections', data)
    });
    const service = new ProfileDatabaseConnectionService({
      registry,
      queryResultCache: new DatabaseQueryResultCache({ now: () => 1 }),
      resolveConfig: () => CONFIG_A
    });
    service.selectActive('id-a', { engineRoot: '/eng/a', assetsRoot: '' });

    // 重启:新 registry 同一持久层;快照在,全量要素会话内重建后可取
    const restarted = new DatabaseConnectionRegistry({
      now: () => 1, load: () => store.get('connections'), save: () => undefined
    });
    expect(restarted.getActive('id-a')).toMatchObject({ host: '10.0.0.1', port: 3301 });
  });
});

describe('createProfileScopedDriftExecutor(结果按 profile 缓存)', () => {
  const RESULT = {
    columns: [{ name: 'Field', type: 'varchar', nullable: false, defaultValue: '', key: 'PRI' }],
    rows: [{ Field: 'id' }]
  };

  it('同 SQL 命中即不再下发连接;判读字段随缓存往返不丢', async () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1 });
    const runQuery = vi.fn(async () => RESULT);
    const close = vi.fn(async () => undefined);
    const factory = createProfileScopedDriftExecutor('id-a', cache, async () => ({ runQuery, close }));
    const database = CONFIG_A;
    const executor = await factory(database);

    const first = await executor.runQuery('SHOW TABLES');
    const second = await executor.runQuery('SHOW TABLES');

    expect(runQuery).toHaveBeenCalledTimes(1); // 第二次吃缓存
    expect(second).toEqual(first);
    expect(second.columns[0]).toMatchObject({ nullable: false, key: 'PRI' }); // 元数据不丢

    await executor.close();
    expect(close).toHaveBeenCalledTimes(1); // 释放透传
  });

  it('TTL 过期不再命中:陈旧结果不冒充新查询', async () => {
    let now = 1;
    const cache = new DatabaseQueryResultCache({ now: () => now });
    const runQuery = vi.fn(async () => RESULT);
    const factory = createProfileScopedDriftExecutor('id-a', cache, async () => ({ runQuery, close: async () => undefined }));
    const executor = await factory(CONFIG_A);

    await executor.runQuery('SHOW TABLES');
    now += DEFAULT_QUERY_RESULT_TTL_MS + 1;
    await executor.runQuery('SHOW TABLES');

    expect(runQuery).toHaveBeenCalledTimes(2); // 过期即真查
  });

  it('两个 profile 各存各的:同 SQL 不吃邻居缓存', async () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1 });
    const runQuery = vi.fn(async () => RESULT);
    const makeExecutor = async (profileId: string) =>
      createProfileScopedDriftExecutor(profileId, cache, async () => ({ runQuery, close: async () => undefined }))(CONFIG_A);
    const a = await makeExecutor('id-a');
    const b = await makeExecutor('id-b');

    await a.runQuery('SHOW TABLES');
    await b.runQuery('SHOW TABLES');

    expect(runQuery).toHaveBeenCalledTimes(2); // B 不吃 A 的缓存
  });
});

describe('resolveProfileDatabaseInterfaceConfig(按根组合解析)', () => {
  let root = '';

  const writeDefaults = (dir: string, host: string, port: number): void => {
    const engine = path.join(dir, 'kbe', 'res', 'server');
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(path.join(engine, 'kbengine_defaults.xml'), [
      '<defaults>',
      '  <dbmgr>',
      '    <databaseInterfaces>',
      '      <default>',
      `        <host>${host}</host>`,
      `        <port>${port}</port>`,
      '        <databaseName>game_db</databaseName>',
      '        <auth><username>game</username><encrypt>false</encrypt></auth>',
      '      </default>',
      '    </databaseInterfaces>',
      '  </dbmgr>',
      '</defaults>'
    ].join('\n'), 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rev15-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  });

  afterEach(() => {
    configurationOverrides.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('profile 根各自推导,不回落工作区设置链', () => {
    writeDefaults(path.join(root, 'eng-p1'), '10.1.1.1', 3301);
    writeDefaults(path.join(root, 'eng-p2'), '10.2.2.2', 3302);
    writeDefaults(root, '10.3.3.3', 3303); // 工作区设置链(探针:不该被读到)
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });

    const p1 = resolveProfileDatabaseInterfaceConfig({ engineRoot: path.join(root, 'eng-p1'), assetsRoot: '' });
    const p2 = resolveProfileDatabaseInterfaceConfig({ engineRoot: path.join(root, 'eng-p2'), assetsRoot: '' });

    expect(p1).toMatchObject({ host: '10.1.1.1', port: 3301 });
    expect(p2).toMatchObject({ host: '10.2.2.2', port: 3302 });
  });

  it('profile 引擎根读不到 defaults = 如实 null(不落工作区配置)', () => {
    writeDefaults(root, '10.3.3.3', 3303);
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });

    const missing = resolveProfileDatabaseInterfaceConfig({ engineRoot: path.join(root, 'eng-none'), assetsRoot: '' });
    expect(missing).toBeNull();
  });

  it('空引擎根 = 该 profile 无自己的引擎,该轴走设置链', () => {
    writeDefaults(root, '10.3.3.3', 3303);
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });

    const config = resolveProfileDatabaseInterfaceConfig({ engineRoot: '', assetsRoot: '' });
    expect(config).toMatchObject({ host: '10.3.3.3', port: 3303 });
  });

  it('无 profile = 工作区默认(设置链)', () => {
    writeDefaults(root, '10.3.3.3', 3303);
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });

    expect(resolveProfileDatabaseInterfaceConfig(null)).toMatchObject({ host: '10.3.3.3', port: 3303 });
  });
});
