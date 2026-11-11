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
  ENGINE_READY_CONTEXT_KEY,
  getStartEntryState,
  resetStartEntryStateForTests,
  setStartEntryState,
  StartEntryController,
  StartEntryProvider,
  type StartEntryState
} from '../src/startEntry';
import { resetDiscoveryState } from '../src/workspaceDiscovery';
import { contexts } from './fake-vscode/commandRegistry';

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
  it('engineReady context key 跟状态机走:构造落初值,false→ready=true(UX-REVIEW-011②)', async () => {
    contexts.clear();
    // 初值:构造即同步(no-workspace 残留态 → false)
    const emptyController = new StartEntryController({
      getWorkspaceRoot: () => null,
      runDiscovery: async () => undefined
    });
    expect(contexts.get(ENGINE_READY_CONTEXT_KEY)).toBe(false);
    // ready → true
    makeReadyFixture(rootA);
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => undefined
    });
    await controller.retry();
    expect(contexts.get(ENGINE_READY_CONTEXT_KEY)).toBe(true);
    // not-found(空根)→ 回落 false
    const missingController = new StartEntryController({
      getWorkspaceRoot: () => rootB,
      runDiscovery: async () => undefined
    });
    await missingController.retry();
    expect(contexts.get(ENGINE_READY_CONTEXT_KEY)).toBe(false);
    void emptyController;
  });

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
    // UX-REVIEW-011② 起:engineReady 订阅 + provider 注册,两个 disposable
    expect(pushed).toHaveLength(2);
    expect((registered[0] as StartEntryProvider).getChildren()[0].label).toBe('Project ready');
  });
});

// UX-REVIEW-002d 自动化验收半边(真实安装包走查归 UX-REVIEW-009):冷启动、
// 打开/切换/关闭工作区、识别失败恢复、重试与多根工作区;后台旧扫描结果
// 不得覆盖新工作区状态。全部经控制器 + 手工事件源驱动,与激活期同一接线形状。
describe('StartEntry 验收(UX-REVIEW-002d)', () => {
  it('冷启动→打开工作区:无工作区态起步,打开后经识别中落就绪', async () => {
    makeReadyFixture(rootA);
    const folderChange = makeFolderChangeEvent();
    let currentRoot: string | null = null;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => currentRoot,
      runDiscovery: async () => undefined,
      onDidChangeWorkspaceFolders: folderChange.event
    });
    controller.begin();
    await drain();
    expect(getStartEntryState().kind).toBe('no-workspace');

    currentRoot = rootA;
    folderChange.fire();
    await drain();
    await drain();
    const state = getStartEntryState();
    expect(state.kind).toBe('ready');
    expect(state.workspaceRoot).toBe(rootA);
  });

  it('关闭工作区:就绪态随目录关闭如实回落 no-workspace,不残留旧根结论', async () => {
    makeReadyFixture(rootA);
    const folderChange = makeFolderChangeEvent();
    let currentRoot: string | null = rootA;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => currentRoot,
      runDiscovery: async () => undefined,
      onDidChangeWorkspaceFolders: folderChange.event
    });
    controller.begin();
    await drain();
    await drain();
    expect(getStartEntryState().kind).toBe('ready');

    currentRoot = null;
    folderChange.fire();
    await drain();
    const state = getStartEntryState();
    expect(state.kind).toBe('no-workspace');
    expect(state.workspaceRoot).toBeNull();
  });

  it('切换工作区全链:A 就绪→切 B→B 自己的识别落位,视图过渡期渲染识别中', async () => {
    makeReadyFixture(rootA);
    makeReadyFixture(rootB);
    fs.writeFileSync(path.join(rootB, 'entity_defs', 'Boss.def'), '[Boss]\n');
    const gate = deferred<void>();
    const folderChange = makeFolderChangeEvent();
    let currentRoot = rootA;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => currentRoot,
      runDiscovery: root => (root === rootB ? gate.promise : Promise.resolve()),
      onDidChangeWorkspaceFolders: folderChange.event
    });
    controller.begin();
    await drain();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'ready', workspaceRoot: rootA });

    currentRoot = rootB;
    folderChange.fire();
    await drain();
    // 过渡期(B 识别在途):视图不得拿 A 的就绪结论顶替
    const provider = new StartEntryProvider({ getWorkspaceRoot: () => currentRoot });
    expect(provider.getChildren()[0].label).toBe('Identifying KBEngine project…');
    gate.resolve();
    await drain();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'ready', workspaceRoot: rootB });
    expect(provider.getChildren()[0].label).toBe('Project ready');
  });

  it('识别失败恢复:失败→补齐布局→重试→就绪,同一控制器即可恢复', async () => {
    const folderChange = makeFolderChangeEvent();
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => undefined,
      onDidChangeWorkspaceFolders: folderChange.event
    });
    controller.begin();
    await drain();
    await drain();
    expect(getStartEntryState().kind).toBe('not-found');

    // 修复布局(补 entity_defs)后重试:清缓存重扫,not-found → ready
    makeReadyFixture(rootA);
    resetDiscoveryState();
    await controller.retry();
    const state = getStartEntryState();
    expect(state.kind).toBe('ready');
    expect(state.workspaceRoot).toBe(rootA);
  });

  it('失败恢复经视图条目真实可达:failed 态的重试条目指向 retryDiscovery 命令', async () => {
    const controller = new StartEntryController({
      getWorkspaceRoot: () => rootA,
      runDiscovery: async () => {
        throw new Error('first scan fails');
      }
    });
    await controller.retry();
    const provider = new StartEntryProvider({ getWorkspaceRoot: () => rootA });
    const items = provider.getChildren();
    const retryEntry = items.find(item => item.command?.command === 'kbengine.start.retryDiscovery');
    expect(retryEntry).toBeDefined();
  });

  it('多根工作区:主根=folders[0],状态键随主根;次根不参与状态', async () => {
    makeReadyFixture(rootA);
    makeReadyFixture(rootB);
    const folders = [rootA, rootB];
    const controller = new StartEntryController({
      getWorkspaceRoot: () => folders[0] ?? null,
      runDiscovery: async root => {
        // 次根绝不被识别(接线只认主根)
        expect(root).toBe(folders[0]);
      }
    });
    controller.begin();
    await drain();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'ready', workspaceRoot: rootA });
  });

  it('后台旧扫描不覆盖新状态:根切换后旧扫描无论成败都弃置', async () => {
    makeReadyFixture(rootA);
    makeReadyFixture(rootB);
    const gate = deferred<void>();
    const failGate = deferred<void>();
    const folderChange = makeFolderChangeEvent();
    let currentRoot = rootA;
    const controller = new StartEntryController({
      getWorkspaceRoot: () => currentRoot,
      runDiscovery: root => {
        if (root === rootA) {
          // A 的扫描既慢又会失败:即便它最后落地,也不得污染 B 的状态
          return failGate.promise.then(() => {
            throw new Error('late failure for old root');
          });
        }
        return gate.promise;
      },
      onDidChangeWorkspaceFolders: folderChange.event
    });
    controller.begin();
    await drain();
    expect(getStartEntryState()).toMatchObject({ kind: 'scanning', workspaceRoot: rootA });

    currentRoot = rootB;
    folderChange.fire();
    await drain();
    await drain();
    gate.resolve();
    await drain();
    await drain();
    // B 已就绪后,旧根 A 的失败才落地
    expect(getStartEntryState()).toMatchObject({ kind: 'ready', workspaceRoot: rootB });
    failGate.resolve();
    await drain();
    await drain();
    const state = getStartEntryState();
    expect(state.kind).toBe('ready');
    expect(state.workspaceRoot).toBe(rootB);
  });
});
