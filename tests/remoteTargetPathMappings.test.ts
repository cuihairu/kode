import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DebugConfigManager, readRemoteTargets } from '../src/debugConfig';
import type * as vscode from 'vscode';
import {
  debug as stubDebug,
  window as stubWindow,
  workspace as stubWorkspace,
  Uri
} from './helpers/vscodeStub';
import { configurationOverrides } from './fake-vscode/workspaceState';

// IDE-DBG-002 远程目标路径映射:remoteTargets 条目可带 localRoot/remoteRoot,
// 成对提供才生成 pathMappings(launch.json 的 order-2 远程条目与 attachRemote
// 的即席附加配置同口径);缺一侧/空串/非字符串一律整对不落,保持省略——
// 映射需要两侧,半配不猜。

interface QuickPickLike {
  label: string;
  description?: string;
}

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = ['showInformationMessage', 'showQuickPick'];
const infoQueue: Array<string | undefined> = [];
const pickQueue: Array<QuickPickLike | undefined> = [];
const debugCalls: Array<Record<string, unknown>> = [];

const setRemoteTargets = (targets: unknown[]): void => {
  configurationOverrides.set('kbengine', { 'debug.remoteTargets': targets });
};

const makeManager = () =>
  new DebugConfigManager({ subscriptions: [] } as unknown as vscode.ExtensionContext);

const setWorkspaceAt = (fsPath: string): void => {
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(fsPath), name: 'ws', index: 0 }];
};

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInformationMessage = async (message: string) => {
    void message;
    return infoQueue.shift();
  };
  windowish.showQuickPick = async (items: QuickPickLike[]) => {
    void items;
    return pickQueue.shift();
  };
  (stubDebug as unknown as Record<string, unknown>).startDebugging = async (
    _folder: unknown,
    config: Record<string, unknown>
  ) => {
    debugCalls.push(config);
    return true;
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    if (originalWindow[key] === undefined) {
      delete windowish[key];
    } else {
      windowish[key] = originalWindow[key];
    }
  }
});

beforeEach(() => {
  infoQueue.length = 0;
  pickQueue.length = 0;
  debugCalls.length = 0;
  configurationOverrides.delete('kbengine');
  setWorkspaceAt('/tmp/kode-remote-map');
});

describe('readRemoteTargets 路径映射字段(DBG-002)', () => {
  it('成对提供:localRoot/remoteRoot 原样进清单', () => {
    setRemoteTargets([
      { name: '外网', host: '10.0.0.8', port: 6666, localRoot: '/ws', remoteRoot: '/data/assets' }
    ]);
    expect(readRemoteTargets()).toEqual([
      { name: '外网', host: '10.0.0.8', port: 6666, localRoot: '/ws', remoteRoot: '/data/assets' }
    ]);
  });

  it('缺一侧/空串/非字符串:整对不落(不猜半配)', () => {
    setRemoteTargets([
      { name: '只有本地', host: '10.0.0.8', localRoot: '/ws' },
      { name: '只有远端', host: '10.0.0.9', remoteRoot: '/data' },
      { name: '空串', host: '10.0.0.10', localRoot: '  ', remoteRoot: '/data' },
      { name: '非字符串', host: '10.0.0.11', localRoot: 42, remoteRoot: '/data' }
    ]);
    const targets = readRemoteTargets();
    expect(targets.map(target => target.name)).toEqual(['只有本地', '只有远端', '空串', '非字符串']);
    for (const target of targets) {
      expect(target.localRoot).toBeUndefined();
      expect(target.remoteRoot).toBeUndefined();
    }
  });

  it('未提供映射字段:条目照收,无 localRoot/remoteRoot 键', () => {
    setRemoteTargets([{ name: '外网', host: '10.0.0.8' }]);
    expect(readRemoteTargets()).toEqual([{ name: '外网', host: '10.0.0.8', port: 5678 }]);
  });
});

describe('launch 生成远程条目 pathMappings(DBG-002)', () => {
  it('目标带成对映射:order-2 条目写 pathMappings=该目标的两侧', () => {
    setRemoteTargets([
      { name: '外网', host: '10.0.0.8', port: 6666, localRoot: '/ws', remoteRoot: '/data/assets' }
    ]);
    const configurations = makeManager().generateLaunchConfigurations();
    const remote = configurations.filter(
      (item: { name: string }) => item.name === 'KBEngine: Python attach 外网 (remote)'
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].pathMappings).toEqual([{ localRoot: '/ws', remoteRoot: '/data/assets' }]);
  });

  it('目标无映射:条目照旧不写 pathMappings(既有面)', () => {
    setRemoteTargets([{ name: '外网', host: '10.0.0.8', port: 6666 }]);
    const configurations = makeManager().generateLaunchConfigurations();
    const remote = configurations.filter(
      (item: { name: string }) => item.name === 'KBEngine: Python attach 外网 (remote)'
    );
    expect(remote).toHaveLength(1);
    expect(remote[0].pathMappings).toBeUndefined();
  });
});

describe('attachRemote 即席附加 pathMappings(DBG-002)', () => {
  it('目标带成对映射:附加配置写 pathMappings', async () => {
    setRemoteTargets([
      { name: '外网', host: '10.0.0.8', localRoot: '/ws', remoteRoot: '/data/assets' }
    ]);
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');

    expect(await makeManager().attachRemote()).toBe(true);
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].pathMappings).toEqual([{ localRoot: '/ws', remoteRoot: '/data/assets' }]);
  });

  it('目标无映射:附加配置不写 pathMappings(既有面)', async () => {
    setRemoteTargets([{ name: '外网', host: '10.0.0.8' }]);
    pickQueue.push({ label: '外网', description: '10.0.0.8:5678' });
    infoQueue.push('开始附加');

    expect(await makeManager().attachRemote()).toBe(true);
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].pathMappings).toBeUndefined();
  });
});
