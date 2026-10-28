import * as fs from 'fs';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  type ServerComponent
} from '../src/serverManager';
import { setActiveProfile } from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';
import type * as vscode from 'vscode';
import { window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import { FakeComponentBin } from './sim/fakeComponentBin';

// IDE-PRJ-012 启动响应 profile 切换:下一次启动按活动 profile 的
// engineRoot(→ kbe/bin/server)与 assetsRoot 解析引擎与配置根;已运行实例
// 的登记(启动快照 binPath/configPath/profileId、pid、状态)不因切换改变。
// 进程为真实回环子进程,KBE_ROOT 与 cwd 经 stdout 回传验证环境随 profile
// 走,零 mock。

interface ConfigTable {
  [key: string]: unknown;
}

const configTable: ConfigTable = {};
const messages = { info: [] as string[], warning: [] as string[], error: [] as string[] };

const windowish = stubWindow as unknown as Record<string, unknown>;
const patchedKeys = [
  'createOutputChannel',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
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

const until = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

let root = '';
let currentManager: KBEngineServerManager | undefined;

const makeManager = (memento?: vscode.Memento): KBEngineServerManager => {
  const manager = new KBEngineServerManager(
    (memento ? { workspaceState: memento } : {}) as unknown as vscode.ExtensionContext
  );
  currentManager = manager;
  return manager;
};

const engineBin = (engineRoot: string): string => path.join(engineRoot, 'kbe', 'bin', 'server');

/** 在引擎布局根下生成假组件可执行文件(echoLines 先打印再常驻) */
const writeEngineExecutable = (engineRoot: string, name: string, echoLines: string[] = []): string => {
  const dir = engineBin(engineRoot);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(
    scriptPath,
    ['#!/usr/bin/env node', ...echoLines, 'setInterval(function () {}, 3600000);'].join('\n'),
    'utf8'
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
};

const machine = SERVER_COMPONENTS.find(component => component.name === 'machine') as ServerComponent;
const dbmgr = SERVER_COMPONENTS.find(component => component.name === 'dbmgr') as ServerComponent;

const pidAlive = (pid: number | undefined): boolean => {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let bin: FakeComponentBin;

beforeAll(() => {
  windowish.createOutputChannel = (name: string) => ({
    name,
    append: () => undefined,
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined
  });
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

describe('active profile launch resolution', () => {
  it('resolves bin, config and executable paths from the active profile', async () => {
    const engA = path.join(root, 'engA');
    const cfgA = path.join(root, 'cfgA');
    fs.mkdirSync(cfgA, { recursive: true });
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profileA = await store.create({ displayName: 'A', assetsRoot: cfgA, engineRoot: engA });
    await setActiveProfile(memento, profileA.id);

    const manager = makeManager(memento);

    expect(manager.getBinPath()).toBe(engineBin(engA));
    expect(manager.getConfigPath()).toBe(cfgA);
    expect(manager.getExecutablePath(machine)).toBe(path.join(engineBin(engA), 'machine'));
  });

  it('keeps the settings chain when no profile is selected', () => {
    const withMemento = makeManager(new MemoryMemento());
    expect(withMemento.getBinPath()).toBe(bin.binPath);
    expect(withMemento.getConfigPath()).toBe(configTable.assetsRoot as string);

    // 极简装配(无 memento)同样回落设置链
    const bare = makeManager();
    expect(bare.getBinPath()).toBe(bin.binPath);
    expect(bare.getConfigPath()).toBe(configTable.assetsRoot as string);
  });

  it('overrides only the fields the profile provides', async () => {
    const engA = path.join(root, 'engA');
    const cfgA = path.join(root, 'cfgA');
    fs.mkdirSync(cfgA, { recursive: true });
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const onlyAssets = await store.create({
      displayName: 'assets-only', assetsRoot: cfgA, engineRoot: ''
    });
    await setActiveProfile(memento, onlyAssets.id);
    const manager = makeManager(memento);

    // engineRoot 为空:引擎面回落设置,配置面用 profile
    expect(manager.getBinPath()).toBe(bin.binPath);
    expect(manager.getConfigPath()).toBe(cfgA);

    const onlyEngine = await store.create({
      displayName: 'engine-only', assetsRoot: '', engineRoot: engA
    });
    await setActiveProfile(memento, onlyEngine.id);

    expect(manager.getBinPath()).toBe(engineBin(engA));
    expect(manager.getConfigPath()).toBe(configTable.assetsRoot as string);
  });

  it('treats a stale selection as absent and falls back to settings', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const doomed = await store.create({
      displayName: 'doomed', assetsRoot: path.join(root, 'gone'), engineRoot: path.join(root, 'gone-eng')
    });
    await setActiveProfile(memento, doomed.id);
    await store.remove(doomed.id);

    const manager = makeManager(memento);

    expect(manager.getBinPath()).toBe(bin.binPath);
    expect(manager.getConfigPath()).toBe(configTable.assetsRoot as string);
  });
});

describe('launch identity across profile switches', () => {
  it('launches with the active profile and keeps running instance identity across a switch', async () => {
    const engA = path.join(root, 'engA');
    const engB = path.join(root, 'engB');
    const cfgA = path.join(root, 'cfgA');
    const cfgB = path.join(root, 'cfgB');
    fs.mkdirSync(cfgA, { recursive: true });
    fs.mkdirSync(cfgB, { recursive: true });
    // machine 回传 KBE_ROOT 与 cwd:环境随 profile 走的直接证据
    const envEcho = [
      'process.stdout.write("KBE_ROOT=" + (process.env.KBE_ROOT || "") + "\\n");',
      'process.stdout.write("CWD=" + process.cwd() + "\\n");'
    ];
    writeEngineExecutable(engA, 'machine', envEcho);
    writeEngineExecutable(engA, 'dbmgr');
    writeEngineExecutable(engB, 'machine', envEcho);
    writeEngineExecutable(engB, 'dbmgr');

    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profileA = await store.create({ displayName: 'A', assetsRoot: cfgA, engineRoot: engA });
    const profileB = await store.create({ displayName: 'B', assetsRoot: cfgB, engineRoot: engB });
    await setActiveProfile(memento, profileA.id);

    const manager = makeManager(memento);
    expect(await manager.startComponent(machine)).toBe(true);

    const first = manager.getRunningServers().get('machine');
    expect(first?.binPath).toBe(engineBin(engA));
    expect(first?.configPath).toBe(cfgA);
    expect(first?.profileId).toBe(profileA.id);
    const firstPid = first?.pid;
    expect(firstPid).toBeGreaterThan(0);
    await until(() => (first?.logs.join('') ?? '').includes(`KBE_ROOT=${engA}`));
    expect(first?.logs.join('')).toContain(`CWD=${cfgA}`);

    // 切换到 profile B:下一次启动才生效
    await setActiveProfile(memento, profileB.id);

    // 已运行实例身份不动:快照、pid、状态、进程本体都保持 A 时的事实
    const afterSwitch = manager.getRunningServers().get('machine');
    expect(afterSwitch?.binPath).toBe(engineBin(engA));
    expect(afterSwitch?.configPath).toBe(cfgA);
    expect(afterSwitch?.profileId).toBe(profileA.id);
    expect(afterSwitch?.pid).toBe(firstPid);
    expect(afterSwitch?.status).not.toBe('stopped');
    expect(pidAlive(firstPid)).toBe(true);

    // 同键再启动:已在册拒绝,不按新 profile 重启
    messages.warning.length = 0;
    expect(await manager.startComponent(machine)).toBe(false);
    expect(messages.warning).toEqual(['Machine 已在运行中']);
    expect(manager.getRunningServers().get('machine')?.pid).toBe(firstPid);

    // 新实例(dbmgr)按所选 profile B 启动
    expect(await manager.startComponent(dbmgr)).toBe(true);
    const dbmgrEntry = manager.getRunningServers().get('dbmgr');
    expect(dbmgrEntry?.binPath).toBe(engineBin(engB));
    expect(dbmgrEntry?.configPath).toBe(cfgB);
    expect(dbmgrEntry?.profileId).toBe(profileB.id);

    // 停掉 machine 再启动:同键重启此刻也用 B(下一次启动语义)
    expect(await manager.stopComponent('machine')).toBe(true);
    await until(() => manager.getRunningServers().size === 1);
    expect(await manager.startComponent(machine)).toBe(true);
    const relaunched = manager.getRunningServers().get('machine');
    expect(relaunched?.binPath).toBe(engineBin(engB));
    expect(relaunched?.configPath).toBe(cfgB);
    expect(relaunched?.profileId).toBe(profileB.id);
    expect(relaunched?.pid).not.toBe(firstPid);
    await until(() => (relaunched?.logs.join('') ?? '').includes(`KBE_ROOT=${engB}`));
    expect(relaunched?.logs.join('')).toContain(`CWD=${cfgB}`);
  }, 20000);
});
