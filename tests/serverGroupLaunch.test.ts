import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineServerManager, SERVER_COMPONENTS, type GroupTargetRequest } from '../src/serverManager';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import { FakeComponentBin } from './sim/fakeComponentBin';

// IDE-RUN-006 按依赖就绪顺序启动一组目标:startTargetGroup 先拓扑定序
// (环→零启动),逐目标等依赖「在册且 Running」才启动;前置失败(退出/放弃
// 就绪等待/启动失败)时依赖它的后续启动不继续,失败沿组传染。进程为真实
// 回环子进程,依赖就绪经真实宽限期/探针推进,零 mock。

interface ConfigTable {
  [key: string]: unknown;
}

const configTable: ConfigTable = {};
const channels: Array<{ name: string; lines: string[]; disposed: boolean }> = [];
const messages = { info: [] as string[], warning: [] as string[], error: [] as string[] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const patchedKeys = [
  'createOutputChannel',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

let root = '';
let currentManager: KBEngineServerManager | undefined;

const until = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

const makeManager = (): KBEngineServerManager => {
  const manager = new KBEngineServerManager({} as unknown as vscode.ExtensionContext);
  currentManager = manager;
  return manager;
};

let bin: FakeComponentBin;

beforeAll(() => {
  windowish.createOutputChannel = (name: string) => {
    const channel = { name, lines: [] as string[], disposed: false };
    channels.push(channel);
    return {
      append: (value: string) => {
        channel.lines.push(value);
      },
      appendLine: (value: string) => {
        channel.lines.push(`${value}\n`);
      },
      show: () => undefined,
      dispose: () => {
        channel.disposed = true;
      }
    };
  };
  const record = (bucket: string[]) => async (message: string) => {
    bucket.push(message);
    return undefined;
  };
  windowish.showInformationMessage = record(messages.info);
  windowish.showWarningMessage = record(messages.warning);
  windowish.showErrorMessage = record(messages.error);

  (stubWorkspace as unknown as Record<string, unknown>).getConfiguration = () => ({
    get: (key: string, defaultValue: unknown) =>
      key in configTable ? configTable[key] : defaultValue
  });
});

afterAll(() => {
  for (const key of patchedKeys) {
    delete windowish[key];
  }
  delete (stubWorkspace as unknown as Record<string, unknown>).getConfiguration;
});

beforeEach(async () => {
  bin = await FakeComponentBin.create();
  root = bin.root;
  fs.mkdirSync(path.join(root, 'ws', 'cfg'), { recursive: true });

  configTable.binPath = bin.binPath;
  configTable.assetsRoot = path.join(root, 'ws', 'cfg');

  channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;

  stubWorkspace.workspaceFolders = [
    { uri: { fsPath: path.join(root, 'ws') } as vscode.Uri, name: 'ws', index: 0 }
  ];
});

afterEach(async () => {
  const running = currentManager?.getRunningServers();
  if (running) {
    for (const server of running.values()) {
      try {
        server.process.kill('SIGKILL');
      } catch {
        // 进程已退出
      }
    }
    await until(
      () => (currentManager as KBEngineServerManager).getRunningServers().size === 0,
      2000
    ).catch(() => undefined);
  }
  currentManager = undefined;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('KBEngineServerManager.startTargetGroup', () => {
  it('starts a group in dependency-readiness order regardless of input order', async () => {
    bin.write('machine', { kind: 'run' });
    bin.write('dbmgr', { kind: 'run' });
    const manager = makeManager();

    const report = await manager.startTargetGroup([{ component: 'dbmgr' }, { component: 'machine' }]);

    // 输入 dbmgr 在前,启动序仍是 machine → dbmgr
    expect(report.cycle).toBeUndefined();
    expect(report.outcomes.map(outcome => outcome.key)).toEqual(['machine', 'dbmgr']);
    expect(report.outcomes.every(outcome => outcome.outcome === 'started')).toBe(true);

    // machine 是 dbmgr 的依赖:dbmgr 启动时 machine 必已 Running
    expect(manager.getServerStatus('machine')).toBe('running');
    await until(() => manager.getServerStatus('dbmgr') === 'running');
    expect(manager.getRunningServers().size).toBe(2);
  }, 15000);

  it('does not continue dependents when a prerequisite process fails', async () => {
    // machine 启动即退(exit 3):依赖它的 dbmgr 不得继续启动
    bin.write('machine', { kind: 'exit', code: 3 });
    bin.write('dbmgr', { kind: 'run' });
    const manager = makeManager();

    const report = await manager.startTargetGroup([{ component: 'machine' }, { component: 'dbmgr' }]);

    const dbmgr = report.outcomes.find(outcome => outcome.key === 'dbmgr');
    expect(dbmgr?.outcome).toBe('dependency-failed');
    expect(dbmgr?.dependency).toBe('machine');
    // dbmgr 从未被启动:进程表无记录,bin 里也不会有它的进程
    expect(manager.getRunningServers().has('dbmgr')).toBe(false);
    expect(manager.getRunningServers().size).toBe(0);
  }, 15000);

  it('reports a cycle and starts nothing', async () => {
    bin.write('baseapp', { kind: 'run' });
    bin.write('cellapp', { kind: 'run' });
    const manager = makeManager();

    const report = await manager.startTargetGroup([
      { component: 'baseapp', dependsOn: ['cellapp'] },
      { component: 'cellapp', dependsOn: ['baseapp'] }
    ]);

    expect(report.cycle).toEqual(['baseapp', 'cellapp', 'baseapp']);
    expect(report.outcomes).toEqual([]);
    expect(manager.getRunningServers().size).toBe(0);
  }, 10000);

  it('times out a dependent whose external dependency never becomes ready', async () => {
    bin.write('dbmgr', { kind: 'run' });
    const manager = makeManager();

    const report = await manager.startTargetGroup(
      [{ component: 'dbmgr', dependsOn: ['machine'] }],
      { dependencyTimeoutMs: 1000 }
    );

    const dbmgr = report.outcomes.find(outcome => outcome.key === 'dbmgr');
    expect(dbmgr?.outcome).toBe('dependency-timeout');
    expect(dbmgr?.dependency).toBe('machine');
    expect(manager.getRunningServers().size).toBe(0);
  }, 10000);

  it('treats a prerequisite that gave up its readiness wait as failed', async () => {
    // machine 常驻但探针永不通过,readinessTimeoutMs 1000 放弃等待(停在 Starting)
    bin.write('machine', { kind: 'run' });
    bin.write('dbmgr', { kind: 'run' });
    const manager = makeManager();

    const report = await manager.startTargetGroup(
      [
        { component: 'machine', readinessProbe: async () => false },
        { component: 'dbmgr' }
      ],
      { readinessTimeoutMs: 1000, dependencyTimeoutMs: 8000 }
    );

    const machine = report.outcomes.find(outcome => outcome.key === 'machine');
    expect(machine?.outcome).toBe('started');
    const dbmgr = report.outcomes.find(outcome => outcome.key === 'dbmgr');
    expect(dbmgr?.outcome).toBe('dependency-failed');
    expect(dbmgr?.dependency).toBe('machine');
    expect(manager.getRunningServers().has('dbmgr')).toBe(false);
    // machine 本体还活着(放弃等待≠杀进程)
    expect(manager.getRunningServers().has('machine')).toBe(true);
  }, 15000);

  it('rejects an unknown component without starting anything', async () => {
    const manager = makeManager();

    const report = await manager.startTargetGroup([{ component: 'ghost' }]);

    const ghost = report.outcomes.find(outcome => outcome.key === 'ghost');
    expect(ghost?.outcome).toBe('not-found');
  }, 8000);
});

describe('KBEngineServerManager.retryTarget', () => {
  it('retries only the failed target and leaves ready instances untouched', async () => {
    // dbmgr 可执行文件先缺失 → spawn-failed;补上后单目标重试成功
    bin.write('machine', { kind: 'run' });
    const manager = makeManager();

    const first = await manager.startTargetGroup([{ component: 'machine' }, { component: 'dbmgr' }]);
    expect(first.outcomes.find(outcome => outcome.key === 'machine')?.outcome).toBe('started');
    expect(first.outcomes.find(outcome => outcome.key === 'dbmgr')?.outcome).toBe('spawn-failed');
    const machinePid = manager.getRunningServers().get('machine')?.pid;

    bin.write('dbmgr', { kind: 'run' });
    const retried = await manager.retryTarget({ component: 'dbmgr' });

    expect(retried.outcome).toBe('started');
    // 已就绪的 machine 未被重复启动:记录连续、pid 不变
    expect(manager.getRunningServers().get('machine')?.pid).toBe(machinePid);
    expect(manager.getServerStatus('machine')).toBe('running');
    expect(manager.getRunningServers().size).toBe(2);
  }, 15000);

  it('reports already-running instead of restarting a registered target', async () => {
    bin.write('machine', { kind: 'run' });
    const manager = makeManager();

    await manager.startTargetGroup([{ component: 'machine' }]);
    const machinePid = manager.getRunningServers().get('machine')?.pid;
    expect(machinePid).toBeGreaterThan(0);

    // 对在册目标发起单目标重试:如实报 already-running,不杀不重启
    const retried = await manager.retryTarget({ component: 'machine' });
    expect(retried.outcome).toBe('already-running');
    expect(manager.getRunningServers().get('machine')?.pid).toBe(machinePid);
    await until(() => manager.getServerStatus('machine') === 'running');
  }, 10000);

  it('retries a dependency-failed target after its prerequisite is started separately', async () => {
    // machine 起即退 → dbmgr dependency-failed;修好 machine 单独启动后,
    // 只重试 dbmgr:machine 不在重试面内(仍只启动过一次)
    bin.write('machine', { kind: 'exit', code: 3 });
    bin.write('dbmgr', { kind: 'run' });
    const manager = makeManager();

    const first = await manager.startTargetGroup([{ component: 'machine' }, { component: 'dbmgr' }]);
    expect(first.outcomes.find(outcome => outcome.key === 'dbmgr')?.outcome).toBe('dependency-failed');

    bin.write('machine', { kind: 'run' });
    expect(await manager.startComponent(
      SERVER_COMPONENTS.find(component => component.name === 'machine') as never
    )).toBe(true);
    const machinePid = manager.getRunningServers().get('machine')?.pid;

    const retried = await manager.retryTarget(
      { component: 'dbmgr' },
      { dependencyTimeoutMs: 8000 }
    );
    expect(retried.outcome).toBe('started');
    // machine 只被重试路径之外的那一次启动占用:pid 未变
    expect(manager.getRunningServers().get('machine')?.pid).toBe(machinePid);
    expect(manager.getRunningServers().size).toBe(2);
  }, 20000);
});
