import { createServer } from 'net';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KodeCoreClient } from '../src/kodeCoreClient';
import { firstDiffPath, KodeCoreGate, type ShadowClientLike } from '../src/kodeCoreGate';
import {
  CORE_SHADOW_CHANNEL_NAME,
  setupKodeCoreGate,
  SHOW_SHADOW_DIFF_LOG_COMMAND
} from '../src/kodeCoreGateWiring';
import {
  checkDatabaseDriftForSnapshots,
  createMysqlDriftExecutorWith,
  type DriftQueryExecutor,
  type MysqlModuleLike,
  type QueryResult
} from '../src/databaseDrift';
import type { DatabaseInterfaceConfig } from '../src/serverConfigMerge';
import type { DatabaseSchemaSnapshot, TableFieldDescriptor } from '../src/databaseSchema';
import { openSshTunnel, pickFreeLocalPort } from '../src/remoteConnection';
import { defaultRuntimeQueryProtocol, RuntimeQueryWebView } from '../src/runtimeQueryWebView';
import type {
  KBEngineComponentInfo,
  SpaceQueryResult,
  WatcherQueryResult
} from '../src/kbengineProtocol';
import { LogHub, RuntimeLogLevel, type LogBatch } from '../src/logHub';
import { HttpRequestService } from '../src/httpRequestService';
import type { HttpRequestEntry } from '../src/httpRequests';
import { resolveLaunchOrder } from '../src/launchDependencies';
import { SemanticIndex } from '../src/semanticIndex';
import { findFilesAcrossRoots, getIndexScanRoots, resetScanRootCache } from '../src/scanRoots';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { resendHotReloadTarget } from '../src/hotReloadRetryCommand';
import {
  getOperationSummary,
  resetLanguageServiceMetrics,
  startLanguageServiceOperation
} from '../src/languageServiceMetrics';
import { resolvePytestEntries, spawnTestProcess } from '../src/pythonTestRunner';
import {
  computeReceiverNoneFindings,
  computeReceiverNoneFindingsAsync
} from '../src/receiverNoneDiagnostics';
import { parsePythonFile } from '../src/pythonParser';
import { DebugConfigManager } from '../src/debugConfig';
import {
  configurationOverrides,
  debug as stubDebug,
  lastFileSystemWatcher,
  memoryFileSystem,
  messages,
  panelRegistry,
  Uri,
  window as fakeWindow,
  windowState,
  workspace as stubWorkspace,
  workspaceEvents,
  type ExtensionContext
} from './helpers/vscodeStub';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';

// 长尾补测:coverage/lcov.info 里 18 个模块的零散未覆盖行,逐模块分组补
// 真实行为断言(非凑行数)。真不可达的分支文末 skip 注记,并回报需要
// 生产线开口的建议。复用各模块既有注入面(timers/targetState/executor
// 工厂/假 stdio server/假 worker),不开真实外网连接。

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(80);
  }
  return predicate();
};

// ---------------------------------------------------------------------------
// pythonParserWorkerHost:FakeWorker 隔离真线程(复用既有 worker 测试的
// vi.mock 面;工厂内经 await import 取 EventEmitter,避开 require 禁令)。
// fs 命名空间整体透传,仅 existsSync 可挂探针(文件内其余用例不受影响)。
// ---------------------------------------------------------------------------
const workerState = vi.hoisted(() => {
  return {
    instances: [] as Array<{
      posted: Array<Record<string, unknown>>;
      emit: (event: string, ...args: unknown[]) => boolean;
    }>,
    existsProbe: undefined as undefined | ((candidate: string) => boolean),
    failPostMessage: false
  };
});

vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('events');
  class FakeWorker extends EventEmitter {
    posted: Array<Record<string, unknown>> = [];
    constructor(file: string) {
      super();
      void file;
      workerState.instances.push(this);
    }
    unref(): void {
      // 桩不阻塞进程退出
    }
    postMessage(message: Record<string, unknown>): void {
      if (workerState.failPostMessage) {
        throw new Error('postMessage blew up');
      }
      this.posted.push(message);
    }
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }
  return { Worker: FakeWorker };
});

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (candidate: Parameters<typeof actual.existsSync>[0]): boolean => {
      if (workerState.existsProbe) {
        return workerState.existsProbe(String(candidate));
      }
      return actual.existsSync(candidate);
    },
    promises: actual.promises,
    default: actual
  };
});

// ---------------------------------------------------------------------------
// kodeCoreClient:内联 node -e 假 server,逐 mode 复现协议边角(静默挂死/
// stderr 洪水/坏 JSON 帧/非法流/重启握手失败)。shutdown 正常回,exit 只在
// mute 模式装死(走 dispose 的 SIGKILL 兜底)。
// ---------------------------------------------------------------------------
const MATRIX_SERVER = String.raw`
const MODE = process.argv[2] || process.argv[1] || '';
let buf = Buffer.alloc(0);
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}
function rawBody(text) {
  const body = Buffer.from(text);
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}
if (MODE === 'noisy') {
  for (let i = 0; i < 60; i += 1) { process.stderr.write('noise ' + i + '\n'); }
}
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const m = /^Content-Length: (\d+)\r\n\r\n/.exec(buf.toString('ascii', 0, Math.min(buf.length, 512)));
    if (!m) break;
    const start = m[0].length;
    const len = Number(m[1]);
    if (buf.length < start + len) break;
    const text = buf.toString('utf8', start, start + len);
    buf = buf.subarray(start + len);
    let msg;
    try { msg = JSON.parse(text); } catch (error) { continue; }
    if (msg.method === 'crash') { process.exit(1); }
    if (msg.method === 'initialize') {
      const gen = msg.params && msg.params.initializationOptions ? msg.params.initializationOptions.restartGeneration : 0;
      if (MODE === 'genfail' && gen > 0) {
        frame({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'generation mismatch' } });
      } else {
        frame({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: { openClose: true, change: 1 } }, serverInfo: { name: 'kode-matrix', version: '0.0.0-test' } } });
        if (MODE === 'noisy') {
          frame({ jsonrpc: '2.0', method: 'window/logMessage', params: { text: 'hello' } });
          frame({ jsonrpc: '2.0', id: 424242, result: { ignored: true } });
        }
      }
      continue;
    }
    if (msg.method === 'shutdown') { frame({ jsonrpc: '2.0', id: msg.id, result: null }); continue; }
    if (msg.method === 'exit') { if (MODE !== 'mute') { process.exit(0); } continue; }
    if (MODE === 'mute') { continue; }
    if (MODE === 'badjson' && msg.method === 'bad') { rawBody('not-json-at-all'); continue; }
    if (MODE === 'garbage' && msg.method === 'dump') { process.stdout.write('x'.repeat(70000)); continue; }
    if (msg.id !== undefined && msg.id !== null) { frame({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }); }
  }
});
`;

describe('kodeCoreClient(协议边角:静默/噪声/坏帧/重启握手)', () => {
  const clients: KodeCoreClient[] = [];
  afterAll(async () => {
    for (const client of clients.splice(0)) {
      await client.dispose().catch(() => undefined);
    }
  });
  const tracked = (client: KodeCoreClient): KodeCoreClient => {
    clients.push(client);
    return client;
  };
  const matrixClient = (
    mode: string,
    extra: Partial<ConstructorParameters<typeof KodeCoreClient>[0]> = {}
  ): KodeCoreClient =>
    tracked(new KodeCoreClient({ binaryPath: process.execPath, args: ['-e', MATRIX_SERVER, mode], ...extra }));

  it('mute:硬超时兜底拒绝;dispose 宽限后 SIGKILL 收口', async () => {
    const client = matrixClient('mute');
    await client.start();
    await expect(client.request('$/kode/wait', { ms: 60_000 }, { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'TIMEOUT'
    });
    // shutdown 有回,exit 通知装死:1.5s 宽限到点走 SIGKILL
    await client.dispose();
    expect(client.childProcess).toBeNull();
  }, 15_000);

  it('noisy:stderr 尾巴只保 50 行;服务器通知与未知 id 回包被忽略', async () => {
    const client = matrixClient('noisy');
    const result = await client.start();
    expect(result.serverInfo.name).toBe('kode-matrix');
    expect(await waitFor(() => client.recentStderr.length === 50, 3000)).toBe(true);
    expect(client.recentStderr).toContain('noise 59');
    expect(client.recentStderr).not.toContain('noise 0');
    await sleep(200); // 无 id 通知与 424242 回包已被消费且无害
    expect(await client.request('kode/pid')).toMatchObject({ ok: true });
    await client.dispose();
  }, 15_000);

  it('badjson:帧体非法 JSON 只记诊断行,通道不死', async () => {
    const client = matrixClient('badjson');
    await client.start();
    client.request('bad').catch(() => undefined);
    expect(await waitFor(() => client.recentStderr.some(line => line.includes('bad json frame body')), 3000)).toBe(
      true
    );
    await client.dispose();
  }, 15_000);

  it('garbage:64KB 以上无头流整段丢弃并记诊断', async () => {
    const client = matrixClient('garbage');
    await client.start();
    client.request('dump').catch(() => undefined);
    expect(await waitFor(() => client.recentStderr.some(line => line.includes('illegal frame stream')), 3000)).toBe(
      true
    );
    await client.dispose();
  }, 15_000);

  it('genfail:重启后握手失败如实入 stderr,代数停在 1', async () => {
    const client = matrixClient('genfail');
    await client.start();
    await expect(client.request('crash')).rejects.toMatchObject({ code: 'EXITED' });
    expect(await waitFor(() => client.recentStderr.some(line => line.includes('restart handshake failed')), 5000)).toBe(
      true
    );
    expect(client.restartGeneration).toBe(1);
    await client.dispose();
  }, 20_000);

  it('重启策略封零:崩溃即放弃,进程句柄清空后 notify 直吞不炸', async () => {
    const client = matrixClient('genfail', { restart: { maxRestarts: 0, windowMs: 10_000 } });
    await client.start();
    await expect(client.request('crash')).rejects.toMatchObject({ code: 'EXITED' });
    await waitFor(() => client.childProcess === null, 2000);
    expect(client.recentStderr.some(line => line.includes('restart limit reached'))).toBe(true);
    expect(() => client.notify('textDocument/didOpen', {})).not.toThrow(); // 无进程:sendRaw 直吞
    await client.dispose();
    expect(() => client.notify('whatever')).not.toThrow(); // disposed 分支
  }, 15_000);
});

// ---------------------------------------------------------------------------
// kodeCoreGate / kodeCoreGateWiring
// ---------------------------------------------------------------------------
describe('kodeCoreGate(diff 细节与 notice 环形)', () => {
  it('firstDiffPath:原始值相等走 canonical 全等短路;键序无关的对象相等为 null', () => {
    expect(firstDiffPath(7, 7)).toBeNull();
    expect(firstDiffPath({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBeNull();
  });

  it('diff 细节序列化不了 bigint 时退 String(value)', async () => {
    const client = {
      start: async () => undefined,
      request: async () => ({ hp: 2n }),
      dispose: async () => undefined
    };
    const gate = new KodeCoreGate({ clientFactory: () => client as unknown as ShadowClientLike });
    gate.setConfig({ backend: 'shadow', serverPath: '/stub/kode-server', shadowTimeoutMs: 500 });
    const out = await gate.compare('textDocument/definition', {}, { hp: 1n }, 'file:///w/Monster.def');
    expect(out).toEqual({ hp: 1n });
    const entry = gate.diffLog.entries()[0];
    expect(entry.verdict).toBe('diff');
    expect(entry.detail).toContain('$.hp');
    expect(entry.detail).toContain('ts=[object Object]');
  });

  it('notice 只保 20 条:越压越滚,最新失败在尾部', async () => {
    let clockNow = 0;
    let n = 0;
    const gate = new KodeCoreGate({
      clientFactory: (): ShadowClientLike => {
        n += 1;
        throw new Error(`nope-${n}`);
      },
      now: () => clockNow
    });
    gate.setConfig({ backend: 'shadow', serverPath: '/missing/kode-server', shadowTimeoutMs: 100 });
    for (let round = 0; round < 24; round += 1) {
      clockNow += 40_000; // 越过 30s spawn 冷却
      expect(await gate.compare('hover', {}, round)).toBe(round);
    }
    expect(gate.state.notices).toHaveLength(20);
    expect(gate.state.notices[19]).toContain('nope-24');
  });

  it('mirrorDocument:client 创建失败静默返回(shadow 铁律不上浮)', async () => {
    const gate = new KodeCoreGate({
      clientFactory: () => {
        throw new Error('no client');
      },
      now: () => 0
    });
    gate.setConfig({ backend: 'shadow', serverPath: '/missing/kode-server', shadowTimeoutMs: 100 });
    await expect(gate.mirrorDocument('file:///w/A.py', 'python', 1, 'x=1')).resolves.toBeUndefined();
  });
});

describe('kodeCoreGateWiring(差异日志通道行格式)', () => {
  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    configurationOverrides.clear();
    workspaceEvents.configurationChanged.dispose();
  });

  it('shadow 差异逐行落通道(序号/uri/明细);查看命令直接亮通道不再弹信息', async () => {
    configurationOverrides.set('kbengine', { 'core.backend': 'shadow' });
    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
    const gate = setupKodeCoreGate(context);
    try {
      const channel = windowState.channels.find(entry => entry.name === CORE_SHADOW_CHANNEL_NAME);
      expect(channel).toBeDefined();
      const out = await gate.compare('textDocument/hover', {}, 42, 'file:///w/Monster.def');
      expect(out).toBe(42); // 恒返回 TS 结果
      expect(channel?.lines[0]).toContain('#1');
      expect(channel?.lines[0]).toContain('rust-unavailable');
      expect(channel?.lines[0]).toContain('textDocument/hover');
      expect(channel?.lines[0]).toContain('file:///w/Monster.def');
      expect(channel?.lines[0]).toContain('serverPath');
      await commands.executeCommand(SHOW_SHADOW_DIFF_LOG_COMMAND);
      expect(messages.info).toHaveLength(0); // 通道在场:走 show,不走信息弹窗
    } finally {
      for (const disposable of [...context.subscriptions]) {
        void Promise.resolve(disposable.dispose?.()).catch(() => undefined);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// databaseDrift:快照批检入口(空批/连不上/读失败/成功落账)与 destroy 兜底
// ---------------------------------------------------------------------------
describe('databaseDrift(checkDatabaseDriftForSnapshots)', () => {
  const database: DatabaseInterfaceConfig = {
    host: '127.0.0.1',
    port: 13306,
    username: 'game',
    databaseName: 'game_db',
    encrypt: false,
    characterSet: 'utf8mb4',
    plainPassword: 'kbe'
  };
  const field = (name: string, typeLabel: string): TableFieldDescriptor => ({
    name,
    typeLabel,
    sourcePath: name,
    source: { filePath: '/proj/Hero.def', line: 1, path: name, category: 'entity' },
    identifier: false
  });
  const heroSnapshot: DatabaseSchemaSnapshot = {
    backend: 'mysql',
    entityName: 'Hero',
    tables: [
      {
        name: 'tbl_Hero',
        kind: 'entity',
        title: 'Hero',
        source: { filePath: '/proj/Hero.def', line: 1, path: 'Hero', category: 'entity' },
        fields: [field('id', 'bigint unsigned'), field('sm_autoLoad', 'tinyint'), field('sm_hp', 'int unsigned')]
      },
      {
        name: 'tbl_Hero_bag',
        kind: 'array',
        title: 'bag',
        parentTableName: 'tbl_Hero',
        source: { filePath: '/proj/Hero.def', line: 9, path: 'bag', category: 'entity' },
        fields: [field('id', 'bigint unsigned'), field('parentID', 'bigint unsigned'), field('sm_value', 'int unsigned')]
      }
    ],
    tableIndex: new Map()
  };
  const monsterSnapshot: DatabaseSchemaSnapshot = {
    backend: 'mysql',
    entityName: 'Monster',
    tables: [
      {
        name: 'tbl_Monster',
        kind: 'entity',
        title: 'Monster',
        source: { filePath: '/proj/Monster.def', line: 1, path: 'Monster', category: 'entity' },
        fields: [field('id', 'bigint unsigned')]
      }
    ],
    tableIndex: new Map()
  };

  /** 替身执行器:按 SQL 形态回表清单/列清单,记 close */
  const makeExecutor = (
    tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>
  ): DriftQueryExecutor & { closed: boolean } => {
    const state = { closed: false };
    const executor: DriftQueryExecutor & { closed: boolean } = {
      closed: false,
      runQuery: async (sql: string): Promise<QueryResult> => {
        if (/^SHOW TABLES/i.test(sql)) {
          return {
            columns: [{ name: 'Tables_in_game_db', type: '' }],
            rows: tables.map(table => ({ Tables_in_game_db: table.name }))
          };
        }
        const match = /^SHOW FULL COLUMNS FROM `(.+)`$/i.exec(sql);
        const table = match ? tables.find(item => item.name === match[1]) : undefined;
        return {
          columns: [
            { name: 'Field', type: '' },
            { name: 'Type', type: '' }
          ],
          rows: (table?.columns ?? []).map(column => ({ Field: column.name, Type: column.type }))
        };
      },
      close: async () => {
        state.closed = true;
        executor.closed = true;
      }
    };
    return executor;
  };

  it('空快照批:如实未检查,不连库', async () => {
    const report = await checkDatabaseDriftForSnapshots([], database, 'tbl_', async () => {
      throw new Error('不应连库');
    });
    expect(report.checked).toBe(false);
    expect(report.reason).toBe('工作区没有可检查的实体定义');
    expect(report.entityName).toBe('全部实体 (0)');
  });

  it('两实体一批:缺表如实报,收尾关连接', async () => {
    const executor = makeExecutor([
      {
        name: 'tbl_Hero',
        columns: [
          { name: 'id', type: 'bigint unsigned' },
          { name: 'sm_autoLoad', type: 'tinyint' },
          { name: 'sm_hp', type: 'int unsigned' }
        ]
      },
      { name: 'tbl_Monster', columns: [{ name: 'id', type: 'bigint unsigned' }] }
    ]);
    let seenDatabase: DatabaseInterfaceConfig | undefined;
    const report = await checkDatabaseDriftForSnapshots(
      [heroSnapshot, monsterSnapshot],
      database,
      'tbl_',
      async received => {
        seenDatabase = received;
        return executor;
      }
    );
    expect(seenDatabase).toBe(database);
    expect(report.checked).toBe(true);
    expect(report.entityName).toBe('全部实体 (2)');
    expect(report.findings).toEqual([
      { kind: 'missing-table', tableName: 'tbl_Hero_bag', message: '表中不存在 tbl_Hero_bag(该实体或属性尚未建表)' }
    ]);
    expect(executor.closed).toBe(true);
  });

  it('连接建不起来:连不上数据库口径,不猜表结构', async () => {
    const report = await checkDatabaseDriftForSnapshots([heroSnapshot], database, 'tbl_', async () => {
      throw new Error('ECONNREFUSED 13306');
    });
    expect(report.checked).toBe(false);
    expect(report.reason).toContain('连不上数据库');
    expect(report.reason).toContain('ECONNREFUSED');
  });

  it('表结构读失败:读取失败口径', async () => {
    const report = await checkDatabaseDriftForSnapshots(
      [heroSnapshot],
      database,
      'tbl_',
      async () => ({
        runQuery: async () => {
          throw new Error('lost connection');
        },
        close: async () => undefined
      })
    );
    expect(report.checked).toBe(false);
    expect(report.reason).toContain('读取表结构失败');
  });

  it('createMysqlDriftExecutorWith:连接带 destroy 面即暴露,destroy 直撕 socket', async () => {
    const destroyed: string[] = [];
    const fakeMysql = {
      createConnection: async () => ({
        query: async () => [[]],
        end: async () => undefined,
        destroy: async () => {
          destroyed.push('destroyed');
        }
      })
    };
    const factory = createMysqlDriftExecutorWith(async () => fakeMysql as unknown as MysqlModuleLike);
    const executor = await factory(database);
    expect(executor.destroy).toBeTypeOf('function');
    await executor.destroy!();
    expect(destroyed).toEqual(['destroyed']);
  });
});

// ---------------------------------------------------------------------------
// remoteConnection:端口回退与默认 spawn 面(真回环套接字/真 ssh 进程,
// 不建任何目标连接)
// ---------------------------------------------------------------------------
describe('remoteConnection(端口回退/默认隧道工厂)', () => {
  it('pickFreeLocalPort:首选口被占由内核分临时口(真实回环套接字)', async () => {
    const preferred = await pickFreeLocalPort(0);
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(preferred, '127.0.0.1', resolve));
    try {
      const port = await pickFreeLocalPort(preferred);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(preferred);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });

  it('openSshTunnel 缺省 spawn 面:ssh 进程起不来如实失败(不朝空隧道附加)', async () => {
    const outcome = await openSshTunnel({ host: '--kode-not-an-option' }, 5678, {
      probe: async () => ({ open: false }),
      waitMs: 1200
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/退出|未就绪/);
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// runtimeQueryWebView:默认发现面 / 面板重入 / 消息边角
// ---------------------------------------------------------------------------
describe('runtimeQueryWebView(边角分支)', () => {
  const component: KBEngineComponentInfo = {
    uid: 1000,
    username: 'tester',
    componentType: 5,
    componentID: 9001n,
    componentIDEx: 0n,
    globalOrderID: 0,
    groupOrderID: 0,
    genuuidSections: 0,
    intaddr: '127.0.0.1',
    intport: 20005,
    extaddr: '127.0.0.1',
    extport: 20006,
    extaddrEx: '127.0.0.1',
    pid: 123,
    cpu: 0,
    mem: 0,
    usedmem: 0,
    state: 1,
    machineID: 1,
    extradata: 0n,
    extradata1: 0n,
    extradata2: 0n,
    extradata3: 0n,
    backaddr: 0,
    backport: 0,
    componentName: 'cellapp1',
    fullName: 'cellapp1'
  };
  const space: SpaceQueryResult = { componentType: 4, componentID: 1n, spaces: [] };
  const watcher: WatcherQueryResult = { type: 0, path: '/cellapp', values: { uptime: 42 }, keys: [] };
  const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };

  const makeProtocol = (options: { failWatcher?: boolean } = {}) => {
    let discoveries = 0;
    return {
      discoveries: () => discoveries,
      protocol: {
        discoverComponents: async (): Promise<KBEngineComponentInfo[]> => {
          discoveries += 1;
          return [component];
        },
        querySpaces: async (): Promise<SpaceQueryResult> => space,
        queryWatcherPath: async (): Promise<WatcherQueryResult[]> => {
          if (options.failWatcher) {
            throw new Error('stream blew up');
          }
          return [watcher];
        }
      }
    };
  };
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const lastState = (panelIndex = 0): Record<string, unknown> => {
    const message = panelRegistry.panels[panelIndex].webview.postedMessages.at(-1)?.message as Record<string, unknown>;
    expect(message.command).toBe('state');
    return message;
  };

  beforeEach(() => {
    panelRegistry.reset();
  });
  afterEach(() => {
    for (const panel of [...panelRegistry.panels]) {
      panel.dispose();
    }
  });

  it('默认协议发现面:回环广播无人应答,空清单收场', async () => {
    await expect(defaultRuntimeQueryProtocol.discoverComponents(10)).resolves.toEqual([]);
  }, 5000);

  it('show 重入:同一面板 reveal 不重建;refresh 消息重跑发现', async () => {
    const made = makeProtocol();
    const webview = new RuntimeQueryWebView(context, made.protocol);
    webview.show();
    await flush();
    webview.show(); // 已在场:早退 reveal
    await flush();
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].revealed).toBe(true);
    expect(made.discoveries()).toBe(1);
    panelRegistry.fireMessage(panelRegistry.panels[0], { command: 'refresh' });
    await flush();
    expect(made.discoveries()).toBe(2);
  });

  it('queryWatcher 空路径:选了组件也要求路径', async () => {
    const webview = new RuntimeQueryWebView(context, makeProtocol().protocol);
    webview.show();
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[0], { command: 'queryWatcher', componentKey: '5:9001', path: '   ' });
    await flush();
    expect(lastState().error).toEqual({ kind: 'watcher', componentKey: '5:9001', message: 'Enter a watcher path.' });
  });

  it('流轮询查询失败:watchList 面如实带错误原因', async () => {
    const webview = new RuntimeQueryWebView(context, makeProtocol({ failWatcher: true }).protocol, {
      enabled: () => true,
      pollIntervalMs: () => 60_000
    });
    webview.show();
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[0], { command: 'addWatcher', path: '/cellapp' });
    await flush();
    panelRegistry.fireMessage(panelRegistry.panels[0], { command: 'toggleStream', componentKey: '5:9001' });
    await flush();
    expect(lastState().error).toEqual({ kind: 'watchList', message: 'stream blew up' });
  });
});

// ---------------------------------------------------------------------------
// logHub:warning 通道 / clear / 文件监控三态(stat 失败/增长尾部/读失败)
// ---------------------------------------------------------------------------
describe('logHub(告警与文件监控边角)', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'kode-loghub-'));

  it('warning 入账为 WARNING 级;clear 清保留与未冲刷', async () => {
    const hub = new LogHub({ flushIntervalMs: 10 });
    const batches: LogBatch[] = [];
    const off = hub.onBatch(batch => batches.push(batch));
    try {
      hub.warning({ source: 'process', component: 'kb', text: '小心\r\n' });
      expect(await waitFor(() => batches.length > 0, 2000)).toBe(true);
      expect(batches[0].events[0].level).toBe(RuntimeLogLevel.WARNING);
      expect(batches[0].events[0].text).toBe('小心');
      expect(hub.getRetained()).toHaveLength(1);
      hub.flush(); // 无待冲刷:早退不炸
      hub.clear();
      expect(hub.getRetained()).toHaveLength(0);
    } finally {
      off();
      hub.dispose();
    }
  });

  it('watchFile 文件不存在:stat 失败入账错误行,不外抛', () => {
    const hub = new LogHub({ flushIntervalMs: 60_000 });
    try {
      hub.watchFile('kb', join(tmp(), 'ghost.log'), 60_000);
      const texts = hub.getRetained().map(event => event.text);
      expect(texts.some(text => text.includes('日志文件监控失败'))).toBe(true);
    } finally {
      hub.dispose();
    }
  });

  it('watchFile 首轮全量读:完整行与无换行末行都立即入账', () => {
    const hub = new LogHub({ flushIntervalMs: 60_000 });
    try {
      const file = join(tmp(), 'app.log');
      writeFileSync(file, 'first\nlast-tail');
      hub.watchFile('kb', file, 60_000);
      const texts = hub.getRetained().map(event => event.text);
      expect(texts).toContain('first');
      expect(texts).toContain('last-tail');
    } finally {
      hub.dispose();
    }
  });

  it('watchFile 路径是目录:读取失败入账错误行(Linux 上 read EISDIR)', () => {
    const hub = new LogHub({ flushIntervalMs: 60_000 });
    try {
      hub.watchFile('kb', tmp(), 60_000);
      const texts = hub.getRetained().map(event => event.text);
      expect(texts.some(text => text.includes('日志文件读取失败'))).toBe(true);
    } finally {
      hub.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// httpRequestService:runEntry 的停用/execute 面
// ---------------------------------------------------------------------------
describe('httpRequestService(runEntry 边角)', () => {
  const baseEntry: HttpRequestEntry = {
    name: '清理缓存',
    url: 'http://127.0.0.1:1/clean',
    method: 'POST',
    headers: {},
    body: '',
    enabled: true,
    keybinding: ''
  };
  const makeService = (entry: HttpRequestEntry): { service: HttpRequestService; errors: string[] } => {
    const errors: string[] = [];
    const service = new HttpRequestService({
      getEntries: () => [entry],
      transport: async () => ({ ok: true, status: 200, durationMs: 1, body: '' }),
      log: () => undefined,
      notifyError: message => errors.push(message)
    });
    return { service, errors };
  };

  it('条目停用:如实回 false 并弹窗(不猜不空转)', async () => {
    const { service, errors } = makeService({ ...baseEntry, enabled: false });
    expect(await service.runEntry({ ...baseEntry, enabled: false })).toBe(false);
    expect(errors).toEqual(['HTTP 快捷请求「清理缓存」不存在或已停用']);
  });

  it('execute 面成功:true 且不走 transport', async () => {
    const { service, errors } = makeService(baseEntry);
    expect(await service.runEntry(baseEntry, async () => undefined)).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('execute 面抛错:失败弹窗带原因,回 false', async () => {
    const { service, errors } = makeService(baseEntry);
    expect(
      await service.runEntry(baseEntry, async () => {
        throw new Error('boom');
      })
    ).toBe(false);
    expect(errors).toEqual(['HTTP 快捷请求「清理缓存」失败: boom']);
  });
});

// ---------------------------------------------------------------------------
// launchDependencies:findCyclePath 的走查分支
// ---------------------------------------------------------------------------
describe('launchDependencies(环路径走查)', () => {
  it('纯环 + 已走完的分支:报出首尾同名的环路径', () => {
    const result = resolveLaunchOrder([
      { key: 'A', dependsOn: ['X'] }, // 组外依赖不参与(continue)
      { key: 'B', dependsOn: ['A'] }, // 走已访节点回 null + 回溯弹栈
      { key: 'C', dependsOn: ['D'] },
      { key: 'D', dependsOn: ['C'] }
    ]);
    expect(result).toEqual({ ok: false, kind: 'cycle', cycle: ['C', 'D', 'C'] });
  });

  it('重复键:波次发射不完整但无环,兜底报全量键序', () => {
    const result = resolveLaunchOrder([
      { key: 'A', dependsOn: [] },
      { key: 'A', dependsOn: [] }
    ]);
    expect(result).toEqual({ ok: false, kind: 'cycle', cycle: ['A', 'A'] });
  });
});

// ---------------------------------------------------------------------------
// semanticIndex:清账与实体名清单
// ---------------------------------------------------------------------------
describe('semanticIndex(清账/实体名)', () => {
  it('registerEntity 后 getEntityNames 保注册序;clearEntities 全账清空', () => {
    const index = new SemanticIndex();
    index.registerEntity({ rootId: '/ws', entityName: 'Hero', defFile: '/ws/Hero.def', pythonFiles: [], owners: [] });
    index.registerEntity({
      rootId: '/ws',
      entityName: 'Avatar',
      defFile: '/ws/Avatar.def',
      pythonFiles: [],
      owners: []
    });
    expect(index.getEntityNames()).toEqual(['Hero', 'Avatar']);
    expect(index.findEntityByName('Hero')).not.toBeNull();
    index.clearEntities();
    expect(index.getEntityNames()).toEqual([]);
    expect(index.findEntityByName('Hero')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scanRoots:配置读取异常回退 / 不认识的 glob / 目录段 exclude / 不可读根 /
// 大目录让出宿主
// ---------------------------------------------------------------------------
describe('scanRoots(回退与遍历边角)', () => {
  const makeTmpDir = (label: string): string => mkdtempSync(join(tmpdir(), `kode-cov-scanroots-${label}-`));

  beforeEach(() => {
    stubWorkspace.workspaceFolders = [];
    configurationOverrides.delete('kbengine');
    resetScanRootCache();
  });
  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
    configurationOverrides.delete('kbengine');
    resetScanRootCache();
  });
  const useWorkspace = (ws: string): void => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
  };
  const setAssetsRoot = (value: string): void => {
    configurationOverrides.set('kbengine', { assetsRoot: value });
    resetScanRootCache();
  };

  it('配置读取抛错:回退 workspace 根,不外抛', () => {
    const ws = makeTmpDir('cfg-throw');
    useWorkspace(ws);
    const original = stubWorkspace.getConfiguration;
    stubWorkspace.getConfiguration = (() => {
      throw new Error('config exploded');
    }) as typeof stubWorkspace.getConfiguration;
    try {
      expect(getIndexScanRoots()).toEqual([ws]);
    } finally {
      stubWorkspace.getConfiguration = original;
    }
  });

  it('不认识的 glob 形状:不手工遍历外部根,只剩 workspace 结果', async () => {
    const ws = makeTmpDir('glob-unknown-ws');
    const assets = makeTmpDir('glob-unknown-assets');
    useWorkspace(ws);
    setAssetsRoot(assets);
    writeFileSync(join(assets, 'keep.def'), '<r/>');
    expect(await findFilesAcrossRoots('src/**/*.def')).toEqual([]);
  });

  it('exclude 目录段形态(无花括号)同样跳过整目录', async () => {
    const ws = makeTmpDir('exclude-ws');
    const assets = makeTmpDir('exclude-assets');
    useWorkspace(ws);
    setAssetsRoot(assets);
    writeFileSync(join(assets, 'keep.def'), '<r/>');
    mkdirSync(join(assets, 'node_modules'), { recursive: true });
    writeFileSync(join(assets, 'node_modules', 'skip.def'), '<r/>');
    expect(await findFilesAcrossRoots('**/*.def', '**/node_modules/**')).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)('外部根不可读(readdir EACCES):遍历降级为空,不外抛', async () => {
    const ws = makeTmpDir('denied-ws');
    const assets = makeTmpDir('denied-assets');
    useWorkspace(ws);
    setAssetsRoot(assets);
    writeFileSync(join(assets, 'a.def'), '<r/>');
    chmodSync(assets, 0o000);
    try {
      expect(await findFilesAcrossRoots('**/*.def')).toEqual([]);
    } finally {
      chmodSync(assets, 0o755); // 还原权限便于清理
    }
  });

  it('大目录遍历:超过 256 项让出宿主后仍完整收账', async () => {
    const ws = makeTmpDir('yield-ws');
    const assets = makeTmpDir('yield-assets');
    useWorkspace(ws);
    setAssetsRoot(assets);
    for (let i = 0; i < 300; i += 1) {
      writeFileSync(join(assets, `f${i}.def`), '<r/>');
    }
    expect(await findFilesAcrossRoots('**/*.def')).toHaveLength(300);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// hotReload:默认错误口 / rootId 解不到 / 装配释放清结算句柄
// ---------------------------------------------------------------------------
describe('hotReload(装配边角)', () => {
  const makeTimers = (): { timers: HotReloadTimerDeps; pending: () => number; tick: () => number } => {
    const handles = new Map<unknown, () => void>();
    return {
      pending: () => handles.size,
      tick: () => {
        const callbacks = [...handles.values()];
        handles.clear();
        for (const callback of callbacks) {
          callback();
        }
        return callbacks.length;
      },
      timers: {
        set: callback => {
          const handle = handles.size;
          handles.set(handle, callback);
          return handle;
        },
        clear: handle => {
          handles.delete(handle);
        }
      }
    };
  };
  const makeContext = (): ExtensionContext => ({ subscriptions: [], extensionUri: Uri.file('/tmp') });
  const disposeAll = (context: ExtensionContext): void => {
    for (const disposable of [...context.subscriptions]) {
      disposable.dispose();
    }
  };
  const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });
  afterEach(() => {
    commandRegistry.reset();
    windowState.reset();
  });

  it('无注入错误口:弹窗通道损坏也不炸 watcher 边界', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, actionName: '热更' } });
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const original = windowish.showErrorMessage;
    windowish.showErrorMessage = (): Promise<undefined> => Promise.reject(new Error('ui down'));
    const context = makeContext();
    const clock = makeTimers();
    try {
      setupHotReload(
        context,
        () => {
          throw new Error('boom');
        },
        { timers: clock.timers }
      );
      lastFileSystemWatcher.current!.fireChange({ fsPath: '/a.py' } as never);
      expect(() => clock.tick()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve(); // 弹窗 promise 的 .catch 收口被真实执行
      expect(messages.error).toHaveLength(0);
    } finally {
      windowish.showErrorMessage = original;
      disposeAll(context);
    }
  });

  it('回包到达但 rootId 解不到:该文件不落账也不喂 digest', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, actionName: '热更' } });
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const digests: unknown[][] = [];
    const context = makeContext();
    const clock = makeTimers();
    setupHotReload(
      context,
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
      },
      {
        timers: clock.timers,
        targetState: { store, resolveTargetId: () => 'cellapp#a', resolveRootId: () => null },
        noteEngineDigest: (...args) => digests.push(args)
      }
    );
    try {
      lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/base/Account.py' } as never);
      clock.tick();
      await flush();
      expect(digests).toHaveLength(0);
      expect(store.files({ rootId: '/ws', targetId: 'cellapp#a' })).toEqual([]);
    } finally {
      disposeAll(context);
    }
  });

  it('applied 核验结算句柄:装配释放时一并清掉', async () => {
    configurationOverrides.set('kbengine', { hotReload: { enabled: true, actionName: '热更' } });
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const context = makeContext();
    const clock = makeTimers();
    setupHotReload(
      context,
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
      },
      {
        timers: clock.timers,
        targetState: {
          store,
          resolveTargetId: () => 'cellapp#a',
          resolveRootId: () => '/ws',
          readFileContent: async () => 'print(1)'
        },
        now: () => 1000
      }
    );
    const file = '/ws/scripts/base/Account.py';
    lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
    clock.tick();
    await flush();
    expect(store.get({ rootId: '/ws', targetId: 'cellapp#a' }, file)?.outcome).toBe('sent-unverified');
    expect(clock.pending()).toBe(1); // 结算定时器在册
    disposeAll(context);
    expect(clock.pending()).toBe(0); // 释放时清结算句柄
  });
});

// ---------------------------------------------------------------------------
// hotReloadRetryCommand:所发内容不可读的注解面
// ---------------------------------------------------------------------------
describe('hotReloadRetryCommand(重发核验阻塞注解)', () => {
  const makeTimers = (): HotReloadTimerDeps => {
    const handles = new Map<unknown, () => void>();
    return {
      set: callback => {
        const handle = handles.size;
        handles.set(handle, callback);
        return handle;
      },
      clear: handle => {
        handles.delete(handle);
      }
    };
  };

  it('readFileContent 拒绝:回执按传输事实落账,核验阻塞原因注解进明细', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    const key = { rootId: '/ws', targetId: 'cellapp#a' };
    const file = '/ws/scripts/base/Avatar.py';
    store.record(key, file, 'failed', { detail: 'HTTP 500' });
    const result = await resendHotReloadTarget(store, key, {
      runAction: async (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
      },
      resolveActionNameForTarget: () => '热更',
      targetState: {
        store,
        resolveTargetId: () => null,
        resolveRootId: () => '/ws',
        readFileContent: async () => {
          throw new Error('disk gone');
        }
      },
      timers: makeTimers(),
      settleHandles: new Set<unknown>(),
      now: () => 1000
    });
    expect(result.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    const record = store.get(key, file);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('所发内容不可读');
    expect(record?.detail).toContain('digest 无基准');
  });
});

// ---------------------------------------------------------------------------
// languageServiceMetrics:子阶段幂等 stop 与 meta setter/getter
// ---------------------------------------------------------------------------
describe('languageServiceMetrics(操作对象边角)', () => {
  afterEach(() => {
    resetLanguageServiceMetrics();
  });

  it('子阶段 stop 幂等;meta setter 落 pending、getter 直通', () => {
    const operation = startLanguageServiceOperation('file-discovery');
    const stop = operation.startSubPhase('workspace-glob');
    stop();
    stop(); // 二次 stop 直吞
    operation.assetRoot = '/ws';
    operation.documentVersion = 7;
    operation.waitedForInit = true;
    expect(operation.assetRoot).toBe('/ws');
    expect(operation.documentVersion).toBe(7);
    expect(operation.waitedForInit).toBe(true);
    operation.countCacheHit(2);
    operation.end('ok');
    // 计数是模块级聚合(同文件 scanRoots 用例也打点):只断言本用例独有的命中面
    expect(getOperationSummary('file-discovery')).toMatchObject({ cacheHits: 2 });
  });
});

// ---------------------------------------------------------------------------
// pythonTestRunner:pytest 输出判读边角与子进程错误面
// ---------------------------------------------------------------------------
describe('pythonTestRunner(判读与进程边角)', () => {
  it('summary 行把既有节点翻成 failed 并带消息', () => {
    const entries = resolvePytestEntries(
      'test_x.py::test_a PASSED\nFAILED test_x.py::test_a - assert 1 == 2\n',
      [{ id: 'a', file: 'test_x.py', caseName: 'test_a' }]
    );
    expect(entries[0]).toMatchObject({ id: 'a', outcome: 'failed', message: 'assert 1 == 2' });
  });

  it('孤儿 summary 行(前面没有节点行)直接建档', () => {
    const entries = resolvePytestEntries('FAILED test_y.py::test_b - boom\n', [
      { id: 'b', file: 'test_y.py', caseName: 'test_b' }
    ]);
    expect(entries[0]).toMatchObject({ id: 'b', outcome: 'failed', message: 'boom' });
  });

  it('输出有结果但条目没匹配上:如实 errored 未收集到测试', () => {
    const entries = resolvePytestEntries('test_other.py::test_z PASSED\n', [
      { id: 'm', file: 'test_missed.py', caseName: 'test_m' }
    ]);
    expect(entries[0]).toMatchObject({ id: 'm', outcome: 'errored' });
    expect(entries[0].message).toContain('未收集到测试');
  });

  it('spawnTestProcess:stderr 增量入账;命令不存在 code=null 带原因', async () => {
    const warned = await spawnTestProcess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("kode-warn")'],
      cwd: tmpdir()
    });
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain('kode-warn');

    const command = '/nonexistent/kode-python-bin';
    const failed = await spawnTestProcess({ command, args: [], cwd: tmpdir() });
    expect(failed.code).toBeNull();
    expect(failed.stderr).toContain(command);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// pythonParserWorkerHost:postMessage 抛错的派发收口
// ---------------------------------------------------------------------------
describe('pythonParserWorkerHost(派发抛错收口)', () => {
  beforeEach(() => {
    workerState.existsProbe = candidate => candidate.endsWith('pythonParserWorker.js');
  });
  afterEach(() => {
    workerState.existsProbe = undefined;
    workerState.failPostMessage = false;
  });

  it('postMessage 抛错:该任务拒绝并释放队列;线程不死,恢复后续接服务', async () => {
    const loadHost = async (): Promise<typeof import('../src/pythonParserWorkerHost')> => {
      vi.resetModules();
      workerState.instances.length = 0;
      return import('../src/pythonParserWorkerHost');
    };
    workerState.failPostMessage = true;
    const host = await loadHost();
    const bigContent = 'x'.repeat(host.PYTHON_WORKER_PARSE_THRESHOLD + 1);
    const parsedStub = {
      classes: [],
      imports: new Map(),
      instanceAssignments: []
    } as unknown as import('../src/pythonParser').ParsedPythonFile;
    await expect(host.parsePythonFileResponsive(bigContent, '/post-fail.py', 1)).rejects.toThrow('postMessage blew up');

    workerState.failPostMessage = false; // 同一 worker 存活:下一任务照常派发
    const next = host.parsePythonFileResponsive(bigContent, '/post-ok.py', 2);
    const worker = workerState.instances[0];
    worker.emit('message', { id: worker.posted[0].id, revision: 2, parsed: parsedStub });
    await expect(next).resolves.toMatchObject({ revision: 2 });
  });
});

// ---------------------------------------------------------------------------
// receiverNoneDiagnostics:方法界/别名 guard/早退块/异步提供器
// ---------------------------------------------------------------------------
describe('receiverNoneDiagnostics(扫描边角)', () => {
  const py = (lines: string[]): string => lines.join('\n');

  it('类体内首方法之前与类外引用:无方法界即不评估 guard(不报也不炸)', () => {
    expect(computeReceiverNoneFindings(py(['class Avatar:', '    self.cell.tick()', '']), '/a.py')).toEqual([]);
    expect(computeReceiverNoneFindings(py(['self.cell.tick()']), '/b.py')).toEqual([]);
  });

  it('别名赋值行入扫描账;同行 if 别名 guard 算护住', () => {
    const src = py([
      'class Avatar:',
      '    def onAlias(self):',
      '        cell = self.cell',
      '        if cell: self.cell.send()',
      ''
    ]);
    expect(computeReceiverNoneFindings(src, '/c.py')).toEqual([]);
  });

  it('早退 guard 块内没有 return/raise:不认账,照报', () => {
    const src = py([
      'class Avatar:',
      '    def onTail(self):',
      '        if self.cell is None:',
      '            self.cell.notify()',
      ''
    ]);
    const findings = computeReceiverNoneFindings(src, '/d.py');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ receiver: 'cell', kind: 'receiver-none' });
  });

  it('异步面:对象形态 preparsed 直接用;提供器给 null 本轮中止', async () => {
    const src = py(['class Avatar:', '    def onTick(self):', '        self.cell.tick()', '']);
    const parsed = parsePythonFile(src, '/e.py');
    await expect(computeReceiverNoneFindingsAsync(src, '/e.py', undefined, parsed)).resolves.toHaveLength(1);
    await expect(computeReceiverNoneFindingsAsync(src, '/e.py', undefined, () => null)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// debugConfig:默认 debugpy 预检链 / startDebugging 抛错的附加失败面
// ---------------------------------------------------------------------------
describe('debugConfig(附加边角)', () => {
  class MemoryMemento {
    private readonly map = new Map<string, unknown>();
    get<T>(key: string, defaultValue?: T): T | undefined {
      return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
    }
    update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        this.map.delete(key);
      } else {
        this.map.set(key, value);
      }
      return Promise.resolve();
    }
    keys(): readonly string[] {
      return [...this.map.keys()];
    }
    setKeysForSync(_keys: readonly string[]): void {
      // 内存替身不参与云同步
    }
  }
  const writeDebugJson = (components: Record<string, unknown>): void => {
    memoryFileSystem.set('/tmp/kode-dbg/.kbengine/debug.json', JSON.stringify({ debug: { components } }));
  };
  const setWorkspaceAt = (fsPath: string): void => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }];
  };
  const makeManager = (
    deps: Partial<ConstructorParameters<typeof DebugConfigManager>[1]> = {}
  ): DebugConfigManager =>
    new DebugConfigManager(
      { subscriptions: [], workspaceState: new MemoryMemento() } as unknown as ExtensionContext,
      deps as ConstructorParameters<typeof DebugConfigManager>[1]
    );
  const flushAsync = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    memoryFileSystem.reset();
    windowState.reset();
  });
  afterEach(() => {
    memoryFileSystem.reset();
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
  });

  it('端口模式附加:startDebugging 抛错经错误通道回执 false', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ cellapp: { debugpyPort: 5679 } });
    const manager = makeManager({ probeTcpPort: async () => ({ open: true }) });
    await flushAsync();
    const debugish = stubDebug as unknown as Record<string, unknown>;
    const original = debugish.startDebugging;
    debugish.startDebugging = async (): Promise<boolean> => {
      throw new Error('attach exploded');
    };
    try {
      expect(await manager.attachToComponent('cellapp')).toBe(false);
      expect(messages.error).toEqual(['附加调试失败: Error: attach exploded']);
    } finally {
      debugish.startDebugging = original;
    }
  }, 15_000);

  it('端口不通且未注入预检:默认 debugpy 预检链(真解释器探测,永不抛)分诊后如实回 false', async () => {
    setWorkspaceAt('/tmp/kode-dbg');
    writeDebugJson({ cellapp: { debugpyPort: 5679 } });
    const manager = makeManager({ probeTcpPort: async () => ({ open: false, reason: 'refused' }) });
    await flushAsync();
    expect(await manager.attachToComponent('cellapp')).toBe(false);
    expect(messages.warning.length).toBeGreaterThan(0);
  }, 25_000);
});

// ---------------------------------------------------------------------------
// 未能覆盖的行(需要生产线开口才能安全触达,此处如实注记):
// - remoteConnection:140(pickFreeLocalPort 双双失败的 0 口分支:首选口与
//   临时口同时拿不到,无注入口,只能靠端口资源耗尽的竞态)
// - scanRoots:101(resolveDiscoveredConfigRoot 抛错:发现链内部自吞异常,
//   无注入口)、177(排序比较器:包含去重后不可能有两个包含根)
// - hotReload:295(readSentContent 无 reader 分支:调用点已判 reader 在场)、
//   438(def 读取 Promise.all 拒绝分支:每个元素都预 catch)
// - hotReloadRetryCommand:85(handleResponse 无 wiring 分支:sendOptions 仅
//   在 wiring 在场时构造)
// - launchDependencies:72(walk 未知键:依赖边已被 byKey.has 预滤)
// - languageServiceMetrics:181(nearestRank 空样本臂:commitSample 必先压样)
// - kodeCoreGate:421(closeMirroredDocument 非 shadow 带快照臂:离开 shadow
//   必经 stopClient 清空快照)
// ---------------------------------------------------------------------------
