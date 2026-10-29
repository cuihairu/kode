import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import {
  guardConnectionFactoryWithQueryLifecycle,
  guardExecutorWithQueryLifecycle,
  QueryCancelledError,
  QueryTimeoutError,
  type QueryGuard
} from '../src/databaseQueryLifecycleIntegration';
import type { DriftConnectionFactory, DriftQueryExecutor, QueryResult } from '../src/databaseDrift';
import { runTablePreviewCommand } from '../src/databaseTablePreviewCommand';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// IDE-REV-017 查询生命周期接线:守卫包装(建连+每条查询)的超时/取消立返、
// 释放恰一次(close/destroy 分路)、终态拒新查询、建连晚落地不漏;命令级
// (activate 真装配)用静默 TCP 端点让真 mysql2 挂在建连——真实命令触发
// 真实慢端点,限时到点即按原因返回,不永久等待。

const RESULT: QueryResult = { columns: [{ name: 'T' }], rows: [{ T: 'tbl_x' }] };

/** 手动放行的查询/建连:永不结算 = 真实慢查询的确定性替身 */
const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(inner => {
    resolve = inner;
  });
  return { promise, resolve };
};

const countingExecutor = (extra?: { destroy?: () => Promise<void> }): {
  executor: DriftQueryExecutor;
  calls: { sql: string[]; close: number; destroy: number };
} => {
  const calls = { sql: [] as string[], close: 0, destroy: 0 };
  return {
    calls,
    executor: {
      runQuery: async (sql: string): Promise<QueryResult> => {
        calls.sql.push(sql);
        return RESULT;
      },
      close: async (): Promise<void> => {
        calls.close += 1;
      },
      ...(extra?.destroy
        ? {
            destroy: async (): Promise<void> => {
              calls.destroy += 1;
              await extra.destroy();
            }
          }
        : {})
    }
  };
};

const fastGuard = (over: Partial<QueryGuard> = {}): QueryGuard => ({
  timeoutMs: 60,
  isCancelled: () => false,
  pollMs: 5,
  releaseDeadlineMs: 60,
  ...over
});

describe('guardExecutorWithQueryLifecycle(查询面)', () => {
  it('快查询原样透传,close 恰一次', async () => {
    const { executor, calls } = countingExecutor();
    const guarded = guardExecutorWithQueryLifecycle(executor, fastGuard());
    await expect(guarded.runQuery('SHOW TABLES')).resolves.toEqual(RESULT);
    await expect(guarded.runQuery('SELECT 1')).resolves.toEqual(RESULT);
    expect(calls.sql).toEqual(['SHOW TABLES', 'SELECT 1']);
    await guarded.close();
    await guarded.close();
    expect(calls.close).toBe(1);
  });

  it('底层失败原样抛(错误同一实例),释放走 close', async () => {
    const failure = new Error('dead port');
    const executor: DriftQueryExecutor = {
      runQuery: async () => {
        throw failure;
      },
      close: async () => undefined
    };
    const guarded = guardExecutorWithQueryLifecycle(executor, fastGuard());
    await expect(guarded.runQuery('SHOW TABLES')).rejects.toBe(failure);
  });

  it('挂死查询超时:立即带原因抛;永不结算走 destroy,不再 close', async () => {
    const hang = deferred<QueryResult>();
    const { executor, calls } = countingExecutor({ destroy: async () => undefined });
    executor.runQuery = () => hang.promise;
    const guarded = guardExecutorWithQueryLifecycle(executor, fastGuard());
    const attempt = guarded.runQuery('SHOW TABLES');
    await expect(attempt).rejects.toBeInstanceOf(QueryTimeoutError);
    await expect(attempt).rejects.toThrow(/查询超时.*超过 60ms 上限.*连接已释放.*SHOW TABLES/);
    await guarded.close(); // 等 releaseTail:deadline 到点 destroyOnce 已跑
    expect(calls.destroy).toBe(1);
    expect(calls.close).toBe(0);
  });

  it('挂死查询超时(无 destroy 面):退回 close 恰一次', async () => {
    const hang = deferred<QueryResult>();
    const { executor, calls } = countingExecutor();
    executor.runQuery = () => hang.promise;
    const guarded = guardExecutorWithQueryLifecycle(executor, fastGuard());
    await expect(guarded.runQuery('SELECT 1')).rejects.toBeInstanceOf(QueryTimeoutError);
    await guarded.close();
    expect(calls.close).toBe(1);
  });

  it('用户取消:带原因抛;底层随后结算,close 在结算后恰一次', async () => {
    const settle = deferred<QueryResult>();
    const { executor, calls } = countingExecutor();
    executor.runQuery = () => settle.promise;
    let cancelled = false;
    const guarded = guardExecutorWithQueryLifecycle(
      executor,
      fastGuard({ isCancelled: () => cancelled, releaseDeadlineMs: 500 })
    );
    const attempt = guarded.runQuery('SHOW TABLES');
    setTimeout(() => {
      cancelled = true;
    }, 10);
    await expect(attempt).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(attempt).rejects.toThrow(/查询已取消.*用户取消.*连接已释放/);
    expect(calls.close).toBe(0); // 未结算不先关(释放上限 500ms,断言窗口内不误触兜底)
    settle.resolve(RESULT); // 底层结算
    await guarded.close(); // close() 等在途释放完成
    expect(calls.close).toBe(1);
  });

  it('终态后不再收新查询:如实拒绝', async () => {
    const hang = deferred<QueryResult>();
    const { executor } = countingExecutor();
    executor.runQuery = () => hang.promise;
    const guarded = guardExecutorWithQueryLifecycle(executor, fastGuard());
    await expect(guarded.runQuery('SHOW TABLES')).rejects.toBeInstanceOf(QueryTimeoutError);
    await expect(guarded.runQuery('SELECT 1')).rejects.toThrow('连接已被上一条查询的超时/取消释放');
  });
});

describe('guardConnectionFactoryWithQueryLifecycle(建连面)', () => {
  it('快建连:守卫执行器返回,后续查询照常', async () => {
    const { executor, calls } = countingExecutor();
    const factory: DriftConnectionFactory = async () => executor;
    const guardedFactory = guardConnectionFactoryWithQueryLifecycle(factory, fastGuard());
    const guarded = await guardedFactory({} as never);
    await expect(guarded.runQuery('SHOW TABLES')).resolves.toEqual(RESULT);
    await guarded.close();
    expect(calls.close).toBe(1);
  });

  it('建连失败原样抛(错误同一实例)', async () => {
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:3307');
    const factory: DriftConnectionFactory = async () => {
      throw failure;
    };
    const guardedFactory = guardConnectionFactoryWithQueryLifecycle(factory, fastGuard());
    await expect(guardedFactory({} as never)).rejects.toBe(failure);
  });

  it('建连挂死超时:立即带原因抛(建连阶段)', async () => {
    const hang = deferred<DriftQueryExecutor>();
    const factory: DriftConnectionFactory = () => hang.promise;
    const guardedFactory = guardConnectionFactoryWithQueryLifecycle(factory, fastGuard());
    const attempt = guardedFactory({} as never);
    await expect(attempt).rejects.toBeInstanceOf(QueryTimeoutError);
    await expect(attempt).rejects.toThrow(/查询超时.*连接已释放:建连/);
  });

  it('建连取消:带原因抛', async () => {
    const hang = deferred<DriftQueryExecutor>();
    const factory: DriftConnectionFactory = () => hang.promise;
    const guardedFactory = guardConnectionFactoryWithQueryLifecycle(
      factory,
      fastGuard({ isCancelled: () => true })
    );
    await expect(guardedFactory({} as never)).rejects.toBeInstanceOf(QueryCancelledError);
  });

  it('命令退出后建连才落地:兜底关掉,不漏连接(恰一次)', async () => {
    const hang = deferred<DriftQueryExecutor>();
    const factory: DriftConnectionFactory = () => hang.promise;
    const guardedFactory = guardConnectionFactoryWithQueryLifecycle(factory, fastGuard());
    await expect(guardedFactory({} as never)).rejects.toBeInstanceOf(QueryTimeoutError);
    const { executor, calls } = countingExecutor();
    hang.resolve(executor); // 晚落地
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls.close).toBe(1); // connecting 的 closeIfAsked 收尾
  });
});

describe('runTablePreviewCommand · 守卫连接(编排面)', () => {
  const previewHarness = (connection: DriftQueryExecutor, guard: QueryGuard) => {
    const errors: string[] = [];
    const infos: string[] = [];
    const channelLines: string[] = [];
    const inputPrompts: string[] = [];
    return {
      errors,
      infos,
      channelLines,
      inputPrompts,
      run: () =>
        runTablePreviewCommand({
          resolveConnection: () => ({ profileId: 'p1', config: {} as never }),
          createConnection: guardConnectionFactoryWithQueryLifecycle(async () => connection, guard),
          showQuickPick: async () => undefined,
          showInputBox: async options => {
            inputPrompts.push(options.prompt);
            return undefined;
          },
          showInformationMessage: message => {
            infos.push(message);
            return undefined;
          },
          showErrorMessage: message => {
            errors.push(message);
            return undefined;
          },
          channel: {
            appendLine: line => {
              channelLines.push(line);
            },
            show: () => undefined
          }
        })
    };
  };

  it('SHOW TABLES 挂死:命令按超时原因返回,通道不写,连接释放', async () => {
    const hang = deferred<QueryResult>();
    const { executor, calls } = countingExecutor();
    executor.runQuery = () => hang.promise;
    const harness = previewHarness(executor, fastGuard());
    await harness.run();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain('数据库预览失败');
    expect(harness.errors[0]).toContain('查询超时');
    expect(harness.channelLines).toHaveLength(0);
    expect(calls.close).toBe(1); // finally close 经守卫:退回 close 恰一次
  });

  it('SHOW TABLES 期间用户取消:命令按取消原因返回,不弹手输面', async () => {
    const hang = deferred<QueryResult>();
    const { executor } = countingExecutor();
    executor.runQuery = () => hang.promise;
    let cancelled = false;
    const harness = previewHarness(executor, fastGuard({ isCancelled: () => cancelled }));
    setTimeout(() => {
      cancelled = true;
    }, 10);
    await harness.run();
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain('数据库预览失败');
    expect(harness.errors[0]).toContain('查询已取消');
    expect(harness.inputPrompts).toHaveLength(0); // 不退手输面
  });
});

describe('命令(activate 真装配)· 静默 TCP 端点 = 真实慢数据库', () => {
  let root = '';
  let originalActiveTextEditor: unknown;
  let slowServer: net.Server | null = null;
  const sockets = new Set<net.Socket>();

  /** 接受连接但永不回握手包:mysql2 挂在建连,命令只能靠超时/取消返回 */
  const startSilentServer = async (): Promise<number> =>
    new Promise(resolve => {
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      slowServer = server;
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

  const writeEngineDefaults = (host: string, port: number, timeoutMs: number): void => {
    const engine = path.join(root, 'kbe', 'res', 'server');
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(
      path.join(engine, 'kbengine_defaults.xml'),
      [
        '<defaults>',
        '  <dbmgr>',
        '    <databaseInterfaces>',
        '      <default>',
        `        <host>${host}</host>`,
        `        <port>${port}</port>`,
        '        <databaseName>game_db</databaseName>',
        '        <auth>',
        '          <username>game</username>',
        '          <encrypt>false</encrypt>',
        '          <password>kbe</password>',
        '        </auth>',
        '      </default>',
        '    </databaseInterfaces>',
        '  </dbmgr>',
        '</defaults>'
      ].join('\n'),
      'utf8'
    );
    configurationOverrides.set('kbengine', {
      binPath: `${root}/kbe/bin/server`,
      databaseQueryTimeoutMs: timeoutMs
    });
  };

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-query-lifecycle-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalActiveTextEditor = (stubWindow as unknown as Record<string, unknown>).activeTextEditor;
  });

  afterEach(async () => {
    configurationOverrides.clear();
    const windowish = stubWindow as unknown as Record<string, unknown>;
    if (originalActiveTextEditor === undefined) {
      delete windowish.activeTextEditor;
    } else {
      windowish.activeTextEditor = originalActiveTextEditor;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => {
      if (!slowServer) {
        resolve();
        return;
      }
      slowServer.close(() => resolve());
    });
    slowServer = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const activateAndWait = async (): Promise<void> => {
    activate({ subscriptions: [], extensionUri: Uri.file('/workspace/ext') } as ExtensionContext);
    await new Promise(resolve => setTimeout(resolve, 100));
  };

  it('previewTable:静默端点上到点返回超时原因,不永久等待', async () => {
    const port = await startSilentServer();
    writeEngineDefaults('127.0.0.1', port, 150);
    await activateAndWait();

    await commands.executeCommand('kbengine.database.previewTable');

    expect(messages.error.length).toBeGreaterThan(0);
    expect(messages.error.at(-1)).toContain('数据库预览失败');
    expect(messages.error.at(-1)).toContain('查询超时');
    const preview = windowState.channels.find(channel => channel.name.includes('数据库预览'));
    expect(preview?.lines.join('') ?? '').not.toContain('表预览');
  });

  it('checkDrift:静默端点上到点降级为未校验,原因带超时', async () => {
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(
      path.join(defDir, 'Hero.def'),
      ['<root>', '  <Properties>', '    <hp>', '      <Type>UINT32</Type>', '    </hp>', '  </Properties>', '</root>'].join('\n'),
      'utf8'
    );
    const port = await startSilentServer();
    writeEngineDefaults('127.0.0.1', port, 150);
    await activateAndWait();

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');

    const text = windowState.channels.map(channel => channel.lines.join('')).join('');
    expect(text).toContain('未校验:连不上数据库');
    expect(text).toContain('查询超时');
    expect(messages.info.at(-1)).toContain('数据库漂移未校验:Hero');
  });
});
