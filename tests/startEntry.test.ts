// UX-REVIEW-002b/002c 侧栏「开始」入口:项目识别的可观察状态 + 按状态的
// 真实可执行操作。状态机验收:识别中/未找到/失败/就绪四态可辨,空列表不冒充
// 就绪;陈旧根结果一律弃置,后台旧扫描不得覆盖新工作区状态;失败保留原始
// 错误诊断价值。视图验收:条目全部指向既有真实命令,状态说明条目不装按钮。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveStartEntryOutcome,
  getStartEntryState,
  resetStartEntryStateForTests,
  setStartEntryState,
  StartEntryController,
  StartEntryProvider,
  type StartEntryState
} from '../src/startEntry';
import { resetDiscoveryState } from '../src/workspaceDiscovery';

let rootA = '';
let rootB = '';

const makeReadyFixture = (root: string): void => {
  fs.mkdirSync(path.join(root, 'entity_defs'));
  fs.writeFileSync(path.join(root, 'entity_defs', 'Avatar.def'), '[Avatar]\n');
};

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

/** 手工事件源:匹配 vscode.Event 形参(订阅登记 + 手动 fire) */
const makeFolderChangeEvent = (): { event: (cb: () => void) => { dispose(): void }; fire: () => void } => {
  const listeners: Array<() => void> = [];
  return {
    event: cb => {
      listeners.push(cb);
      return { dispose: () => void listeners.splice(listeners.indexOf(cb), 1) };
    },
    fire: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
};

const drain = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  resetStartEntryStateForTests();
  resetDiscoveryState();
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-start-a-'));
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-start-b-'));
});

afterEach(() => {
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

describe('StartEntry 状态机(UX-REVIEW-002b)', () => {
  it('未打开工作区落 no-workspace,不探测不扫描', async () => {
    const controller = new StartEntryController({
      getWorkspaceRoot: () => null,
      runDiscovery: async () => undefined
    });
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('no-workspace');
    expect(state.workspaceRoot).toBeNull();
  });

  it('识别成功且 entity_defs 唯一命中 → ready,detail 为空', async () => {
    makeReadyFixture(rootA);
    let discovered = '';
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async root => {
        discovered = root;
      }
    });
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('ready');
    expect(state.workspaceRoot).toBe(rootA);
    expect(state.detail).toBe('');
    expect(discovered).toBe(rootA);
  });

  it('扫描完成但零命中 → not-found,如实列出缺失锚点,不以空列表冒充就绪', async () => {
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => undefined
    });
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('not-found');
    expect(state.workspaceRoot).toBe(rootA);
    expect(state.detail).toContain('entity_defs');
    expect(state.detail).toContain('entities.xml');
    expect(state.detail).toContain('types.xml');
  });

  it('识别流程抛错 → failed 并保留原始错误信息,不再无声吞掉', async () => {
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => {
        throw new Error('scan exploded');
      }
    });
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('failed');
    expect(state.workspaceRoot).toBe(rootA);
    expect(state.detail).toBe('scan exploded');
  });

  it('deriveStartEntryOutcome 直接推导:有 entity_defs 即 ready,空目录列出全部缺失', () => {
    expect(deriveStartEntryOutcome(rootA).kind).toBe('not-found');
    makeReadyFixture(rootA);
    resetDiscoveryState();
    const ready = deriveStartEntryOutcome(rootA);
    expect(ready.kind).toBe('ready');
    expect(ready.detail).toBe('');
  });

  it('根级读取失败(目录被删/无权限)落 failed 并带原始错误,不与无匹配混谈', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-start-gone-'));
    fs.rmSync(gone, { recursive: true, force: true });
    resetDiscoveryState();
    expect(deriveStartEntryOutcome(gone).kind).toBe('failed');
    expect(deriveStartEntryOutcome(gone).detail).toContain('ENOENT');

    const controller = new StartEntryController({
      getWorkspaceRoot: () => gone,
      runDiscovery: async () => undefined
    });
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('failed');
    expect(state.detail).toContain('ENOENT');
  });

  it('根切换后在途旧结果被弃置,新根识别落新状态,旧结论不覆盖', async () => {
    makeReadyFixture(rootA);
    makeReadyFixture(rootB);
    const gate = deferred<void>();
    const folderChange = makeFolderChangeEvent();
    let currentRoot = rootA;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => currentRoot,
      runDiscovery: root => (root === rootA ? gate.promise : Promise.resolve()),
      onDidChangeWorkspaceFolders: folderChange.event
    });
    const rootAEval = controller.retry();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'scanning', workspaceRoot: rootA });

    currentRoot = rootB;
    folderChange.fire();
    await drain();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'ready', workspaceRoot: rootB });

    gate.resolve();
    await rootAEval;
    const state = getStartEntryState();
    expect(state.workspaceRoot).toBe(rootB);
    expect(state.kind).toBe('ready');
  });

  it('同根识别在途时重入直接忽略,不叠扫', async () => {
    makeReadyFixture(rootA);
    const gate = deferred<void>();
    let calls = 0;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: () => {
        calls += 1;
        return gate.promise;
      }
    });
    const first = controller.retry();
    await drain();
    const second = controller.retry();
    await drain();
    expect(calls).toBe(1);
    gate.resolve();
    await first;
    await second;
    expect(getStartEntryState().kind).toBe('ready');
  });

  it('onDiscoverySettled 只在结论落地时回调;失败也回调并带原始错误', async () => {
    const settled: Array<{ root: string; kind: string; detail: string }> = [];
    makeReadyFixture(rootA);
    const okController = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => undefined,
      onDiscoverySettled: (root, kind, detail) => {
        settled.push({ root, kind, detail });
      }
    });
    await okController.retry();
    expect(settled).toEqual([{ root: rootA, kind: 'ready', detail: '' }]);

    resetStartEntryStateForTests();
    const failController = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => {
        throw new Error('disk gone');
      },
      onDiscoverySettled: (root, kind, detail) => {
        settled.push({ root, kind, detail });
      }
    });
    await failController.retry();
    expect(settled[1]).toEqual({ root: rootA, kind: 'failed', detail: 'disk gone' });
  });
});

describe('StartEntry 视图(UX-REVIEW-002c)', () => {
  const render = (currentRoot: string | null): StartEntryProvider['getChildren'] extends () => infer R ? R : never => {
    const provider = new StartEntryProvider({ getWorkspaceRoot: () => currentRoot });
    return provider.getChildren();
  };

  it('no-workspace:说明条目 + 打开文件夹真实命令', () => {
    setStartEntryState({ kind: 'no-workspace', workspaceRoot: null, detail: '' });
    const items = render(null);
    expect(items.map(item => item.label)).toEqual(['No workspace open', 'Open Folder…']);
    expect(items[0].command).toBeUndefined();
    expect(items[1].command).toMatchObject({ command: 'workbench.action.files.openFolder' });
  });

  it('scanning:只显示识别中说明,不装不可执行的假按钮', () => {
    setStartEntryState({ kind: 'scanning', workspaceRoot: rootA, detail: '' });
    const items = render(rootA);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Identifying KBEngine project…');
    expect(items[0].command).toBeUndefined();
  });

  it('not-found:缺失锚点如实展示 + 报告/重试两个真实命令', () => {
    const state: StartEntryState = {
      kind: 'not-found',
      workspaceRoot: rootA,
      detail: 'entity_defs, entities.xml, types.xml'
    };
    setStartEntryState(state);
    const items = render(rootA);
    expect(items[0].label).toBe('No KBEngine project found');
    expect(items[0].description).toBe(state.detail);
    expect(items[0].command).toBeUndefined();
    expect(items.map(item => item.command?.command)).toEqual([
      undefined,
      'kbengine.discovery.report',
      'kbengine.start.retryDiscovery'
    ]);
    expect(items.some(item => item.label === 'View entities')).toBe(false);
  });

  it('failed:原始错误保留在说明里(诊断价值),动作与 not-found 同面', () => {
    setStartEntryState({ kind: 'failed', workspaceRoot: rootA, detail: 'EACCES: permission denied' });
    const items = render(rootA);
    expect(items[0].label).toBe('Project identification failed');
    expect(items[0].description).toBe('EACCES: permission denied');
    expect(items.map(item => item.command?.command)).toEqual([
      undefined,
      'kbengine.discovery.report',
      'kbengine.start.retryDiscovery'
    ]);
  });

  it('ready:就绪说明 + 查看实体/检查报告/启动调试三个真实命令', () => {
    setStartEntryState({ kind: 'ready', workspaceRoot: rootA, detail: '' });
    const items = render(rootA);
    expect(items[0].label).toBe('Project ready');
    expect(items[0].command).toBeUndefined();
    expect(items.map(item => item.command?.command)).toEqual([
      undefined,
      'kbengine.entity.open',
      'kbengine.discovery.report',
      'kbengine.debug.start'
    ]);
  });

  it('陈旧守卫:状态根 ≠ 当前根时按识别中渲染,旧结论不得顶替新根', () => {
    setStartEntryState({ kind: 'ready', workspaceRoot: rootA, detail: '' });
    const items = render(rootB);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Identifying KBEngine project…');
    expect(items[0].command).toBeUndefined();
  });

  it('状态变更触发 onDidChangeTreeData,视图随之刷新', () => {
    const provider = new StartEntryProvider({ getWorkspaceRoot: () => null });
    const fired: Array<unknown> = [];
    provider.onDidChangeTreeData(element => {
      fired.push(element);
    });
    setStartEntryState({ kind: 'scanning', workspaceRoot: rootA, detail: '' });
    expect(fired).toHaveLength(1);
    expect(provider.getChildren()[0].label).toBe('Identifying KBEngine project…');
  });

  it('控制器注册视图 provider 并推入订阅;重试命令走同一状态机', async () => {
    makeReadyFixture(rootA);
    const registered: unknown[] = [];
    const pushed: unknown[] = [];
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => undefined,
      registerTreeDataProvider: provider => {
        registered.push(provider);
        return { dispose: () => undefined };
      },
      subscriptions: { push: disposable => void pushed.push(disposable) }
    });
    await controller.retry();
    expect(registered).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect((registered[0] as StartEntryProvider).getChildren()[0].label).toBe('Project ready');
  });
});
