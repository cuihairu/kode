import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  clearRecentHoverTimeouts,
  createWaiterUnionToken,
  setHoverBudgetLogHub
} from '../src/hoverBudget';
import {
  configurationOverrides,
  makeTextDocument,
  Position
} from './helpers/vscodeStub';

// IDE-BUD-008:隔离同点 hover 合并请求的取消——批159 memo 让同点位并发 hover
// 共享一份计算;一个等待者取消不得取消别人还在等的共享计算(共享 token =
// 全部在册等待者的并集:人人取消才取消),单独取消只影响自己的 respond。

const neverToken = () =>
  ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }) as never;

const pendingToken = () => {
  let listener: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(callback: () => void) {
      listener = callback;
      return { dispose: () => { listener = undefined; } };
    }
  };
  return {
    token: token as never,
    cancel: () => { token.isCancellationRequested = true; listener?.(); }
  };
};

const PY_TEXT = 'class Hero:\n    def onTimer(self):\n        pass\n';
const NAME_POSITION = new Position(1, 10);
const DOC = () => makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' });

const HOVER_LOCATION = {
  defFile: '/tmp/project/scripts/entity_defs/Hero.def',
  line: 2,
  section: 'BaseMethods',
  declaredArgs: [] as string[],
  exposed: false
};

beforeEach(() => {
  clearRecentHoverTimeouts();
  setHoverBudgetLogHub(null);
});

afterEach(() => {
  configurationOverrides.delete('kbengine');
});

describe('IDE-BUD-008:createWaiterUnionToken', () => {
  it('取消一个等待者不取消联合 token;人人取消才取消', () => {
    const union = createWaiterUnionToken();
    let cancelled = false;
    union.token.onCancellationRequested(() => { cancelled = true; });

    const waiterA = pendingToken();
    const waiterB = pendingToken();
    union.addWaiter(waiterA.token);
    union.addWaiter(waiterB.token);

    waiterA.cancel();
    expect(union.token.isCancellationRequested).toBe(false); // B 还在等

    waiterB.cancel();
    expect(union.token.isCancellationRequested).toBe(true);
    expect(cancelled).toBe(true);
    union.dispose();
  });

  it('注销后的等待者不再撑住联合 token', () => {
    const union = createWaiterUnionToken();
    const waiterA = pendingToken();
    const removeA = union.addWaiter(waiterA.token);
    const waiterB = pendingToken();
    union.addWaiter(waiterB.token);

    removeA(); // A 拿到结果离开
    waiterA.cancel();
    expect(union.token.isCancellationRequested).toBe(false); // A 已注销,取消无关

    waiterB.cancel();
    expect(union.token.isCancellationRequested).toBe(true);
    union.dispose();
  });

  it('零在册等待者不取消(计算创建与登记之间的窗口安全)', () => {
    const union = createWaiterUnionToken();
    expect(union.token.isCancellationRequested).toBe(false);
    union.dispose();
  });
});

describe('IDE-BUD-008:同点 hover 合并请求的取消隔离', () => {
  it('取消一个等待者:共享计算照常完成,另一个等待者拿到结果', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 5000 });
    let managerToken: { isCancellationRequested: boolean } | null = null;
    let release!: (value: typeof HOVER_LOCATION) => void;
    const manager = {
      resolveMethodDefinition: (...args: Array<unknown>) => {
        managerToken = args[3] as { isCancellationRequested: boolean };
        return new Promise<typeof HOVER_LOCATION>(resolve => { release = resolve; });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const waiterA = pendingToken();
    const waiterB = pendingToken();
    const document = DOC();

    const pendingA = provider.provideHover(document, NAME_POSITION, waiterA.token);
    const pendingB = provider.provideHover(document, NAME_POSITION, waiterB.token); // 同点合并

    waiterA.cancel(); // A 不等了:B 还在等,共享计算不得被取消
    expect(await pendingA).toBeNull();
    expect((managerToken as { isCancellationRequested: boolean }).isCancellationRequested)
      .toBe(false); // 共享 token 未被 A 的取消斩断

    release({ ...HOVER_LOCATION });
    const resultB = await pendingB;
    expect(resultB).not.toBeNull();
    expect(JSON.stringify(resultB)).toContain('BaseMethods');
  });

  it('全部等待者取消:共享计算取消(无孤儿工作)', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 5000 });
    let managerToken: { isCancellationRequested: boolean } | null = null;
    let observedCancelled = false;
    let release!: (value: null) => void;
    const manager = {
      resolveMethodDefinition: (...args: Array<unknown>) => {
        managerToken = args[3] as { isCancellationRequested: boolean };
        (managerToken as { onCancellationRequested(cb: () => void): unknown })
          .onCancellationRequested(() => { observedCancelled = true; });
        return new Promise<null>(resolve => { release = resolve; });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const waiterA = pendingToken();
    const waiterB = pendingToken();
    const document = DOC();

    const pendingA = provider.provideHover(document, NAME_POSITION, waiterA.token);
    const pendingB = provider.provideHover(document, NAME_POSITION, waiterB.token);

    waiterA.cancel();
    waiterB.cancel(); // 人人取消 → 共享计算取消
    expect(await pendingA).toBeNull();
    expect(await pendingB).toBeNull();
    expect(observedCancelled).toBe(true);
    release(null);
  });
});
