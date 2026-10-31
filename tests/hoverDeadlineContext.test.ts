import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  clearRecentHoverTimeouts,
  createHoverRequestDeadline,
  getRecentHoverTimeouts,
  setHoverBudgetLogHub
} from '../src/hoverBudget';
import {
  configurationOverrides,
  makeTextDocument,
  Position
} from './helpers/vscodeStub';

// IDE-BUD-001:hover 请求统一截止时间上下文——一次请求一个 deadline:绝对
// 时刻 + 链接 token,全分支共享(各层用 remainingMs() 而非各起满额预算窗);
// 同步路径只在段口协作检查,不得被宣称已可抢占。

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const tick = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

const PY_TEXT = 'class Hero:\n    def onTimer(self):\n        pass\n';
const NAME_POSITION = new Position(1, 10);

const makeManager = (
  resolveMethodDefinition: (...args: unknown[]) => Promise<unknown>
): EntityMappingManager =>
  ({ resolveMethodDefinition }) as unknown as EntityMappingManager;

const neverToken = () =>
  ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }) as never;

const cancelableToken = () => {
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

beforeEach(() => {
  clearRecentHoverTimeouts();
  setHoverBudgetLogHub(null);
});

afterEach(() => {
  configurationOverrides.delete('kbengine');
});

describe('IDE-BUD-001:createHoverRequestDeadline', () => {
  it('到期是纯时间判定,不自动取消 token;remainingMs 单调递减', async () => {
    const deadline = createHoverRequestDeadline(neverToken(), 15);
    expect(deadline.budgetMs).toBe(15);
    expect(deadline.remainingMs()).toBeLessThanOrEqual(15);
    expect(deadline.isExpired()).toBe(false);

    await tick(20);

    expect(deadline.remainingMs()).toBeLessThanOrEqual(0);
    expect(deadline.isExpired()).toBe(true);
    // 预算由层闸强制(层计时器记账);本体不自动取消 token——取消传播进
    // 请求独占工作是 IDE-BUD-002 的面
    expect(deadline.token.isCancellationRequested).toBe(false);
    deadline.dispose();

    const held = createHoverRequestDeadline(neverToken(), 15);
    held.dispose(); // 请求落定即释放(清父监听)
    await tick(25);
    expect(held.token.isCancellationRequested).toBe(false);
  });

  it('budgetMs<=0 不设闸:remainingMs 恒 0、isExpired 恒 false、token 永不自动取消', async () => {
    const deadline = createHoverRequestDeadline(neverToken(), 0);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.isExpired()).toBe(false);
    await tick(15);
    expect(deadline.isExpired()).toBe(false);
    expect(deadline.token.isCancellationRequested).toBe(false);
    deadline.dispose();
  });

  it('父 token 取消立即传播到链接 token', () => {
    const parent = cancelableToken();
    const deadline = createHoverRequestDeadline(parent.token, 5000);
    let observed = false;
    deadline.token.onCancellationRequested(() => { observed = true; });
    parent.cancel();
    expect(deadline.token.isCancellationRequested).toBe(true);
    expect(observed).toBe(true);
    deadline.dispose();
  });

  it('无父 token 也可创建(纯预算闸),父缺席不抛', () => {
    const deadline = createHoverRequestDeadline(undefined, 100);
    expect(deadline.token.isCancellationRequested).toBe(false);
    deadline.dispose();
  });
});

describe('IDE-BUD-001:hover 分支共享同一 deadline/token', () => {
  it('预算到期:统一 deadline 截断慢层,layer 记账口径不变', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    const slow = deferred<never>();
    const provider = new KBEngineHoverProvider(makeManager(() => slow.promise));
    const startedAt = Date.now();
    const result = await provider.provideHover(
      makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' }),
      NAME_POSITION
    );
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result).toBeNull();
    expect(getRecentHoverTimeouts().map(record => record.layer)).toEqual(['hover:def-method']);
    slow.resolve(null as never);
  });

  it('父 token 中途取消:def-method 分支快速返回 null,不记超时(取消 ≠ 超预算)', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 5000 });
    const slow = deferred<never>();
    const provider = new KBEngineHoverProvider(makeManager(() => slow.promise));
    const parent = cancelableToken();
    const pending = provider.provideHover(
      makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' }),
      NAME_POSITION,
      parent.token
    );
    await tick(10);
    parent.cancel();
    const startedAt = Date.now();
    expect(await pending).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(getRecentHoverTimeouts()).toEqual([]); // 取消路径不冒充预算超时
    slow.resolve(null as never);
  });

  it('预算 0(关闸):取消仍即时生效,未取消时等待与既有口径一致', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 0 });
    const slow = deferred<never>();
    const provider = new KBEngineHoverProvider(makeManager(() => slow.promise));
    const parent = cancelableToken();
    const pending = provider.provideHover(
      makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' }),
      NAME_POSITION,
      parent.token
    );
    await tick(10);
    parent.cancel();
    expect(await pending).toBeNull();
    slow.resolve(null as never);
  });
});

describe('R2-F18:预算到期传播取消到请求独占 token', () => {
  // 验收:预算返回空后原请求不继续新增读取/排队;共享索引与仍有等待者的
  // 计算继续;实际在途依赖 token 收到取消——不能仅验证前台返回时间。

  it('cancel():显式取消链接 token(预算到期传播面)', () => {
    const deadline = createHoverRequestDeadline(neverToken(), 5000);
    let observed = false;
    deadline.token.onCancellationRequested(() => { observed = true; });
    deadline.cancel();
    expect(deadline.token.isCancellationRequested).toBe(true);
    expect(observed).toBe(true);
    deadline.dispose();
  });

  it('无其他等待者:预算到期后底层独占 token 收到取消(内层 race 传 onStop)', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 20 });
    let capturedToken: { isCancellationRequested: boolean } | null = null;
    const never = new Promise<null>(() => undefined);
    const manager = {
      resolveMethodDefinition: (...args: Array<unknown>) => {
        capturedToken = args[3] as never;
        return never;
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);

    const result = await provider.provideHover(
      makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' }),
      NAME_POSITION
    );

    expect(result).toBeNull();
    expect(capturedToken).not.toBeNull();
    expect(capturedToken!.isCancellationRequested).toBe(true);
  });

  it('有等待者:预算到期取消自己,共享计算不被斩断', async () => {
    configurationOverrides.set('kbengine', { 'hover.asyncBudgetMs': 40 });
    let capturedToken: { isCancellationRequested: boolean } | null = null;
    const never = new Promise<null>(() => undefined);
    const manager = {
      resolveMethodDefinition: (...args: Array<unknown>) => {
        capturedToken = args[3] as never;
        return never;
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const document = makeTextDocument(PY_TEXT, {
      fileName: '/tmp/project/scripts/base/Hero.py',
      languageId: 'python'
    });
    const waiterB = cancelableToken();

    const pendingA = provider.provideHover(document, NAME_POSITION);
    const pendingB = provider.provideHover(document, NAME_POSITION, waiterB.token); // 同点合并

    await tick(60); // A 的预算到期,B 还在等
    expect(await pendingA).toBeNull();
    // 共享 token 未被 A 的预算到期斩断(B 仍在等)——共享索引/计算继续
    expect(capturedToken!.isCancellationRequested).toBe(false);
    await pendingB;
  });
});
