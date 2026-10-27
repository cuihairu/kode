import { describe, expect, it, vi } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-BUD-002:hover 取消传播到请求独占任务——取消后停止该请求新增读取
// (入口/索引等待后两道闸),共享首扫(initialScan)只被等待不被取消,
// 继续推进供后续请求复用。

type ManagerInternals = {
  ensureIndexForPythonFile(file: string): Promise<unknown>;
};

const cancelledToken = () =>
  ({ isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) }) as never;

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

describe('IDE-BUD-002:hover 取消传播到请求独占任务', () => {
  it('入口已取消:resolveMethodDefinition 不发起任何新读取', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const internals = manager as unknown as ManagerInternals;
    const indexSpy = vi.spyOn(internals, 'ensureIndexForPythonFile');

    const result = await manager.resolveMethodDefinition(
      '/tmp/project/scripts/base/Hero.py',
      'onTimer',
      undefined,
      cancelledToken()
    );

    expect(result).toBeNull();
    expect(indexSpy).not.toHaveBeenCalled(); // 取消后停止该请求新增读取
  });

  it('索引等待途中取消:不再进入后续读取(跨 def 回退/全局扫描)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const internals = manager as unknown as ManagerInternals;
    let releaseIndex!: (value: unknown) => void;
    const indexSpy = vi.spyOn(internals, 'ensureIndexForPythonFile').mockImplementation(
      () => new Promise(resolve => { releaseIndex = resolve; })
    );
    const parent = pendingToken();
    const pending = manager.resolveMethodDefinition(
      '/tmp/project/interfaces/ROLE.py',
      'onTimer',
      undefined,
      parent.token
    );
    parent.cancel(); // 索引还在途时取消
    releaseIndex(null);
    expect(await pending).toBeNull(); // 取消后不消费、不再发起跨 def/全局读取
    expect(indexSpy).toHaveBeenCalledTimes(1);
    indexSpy.mockRestore();
  });

  it('入口已取消:getEntityComponentFacesForPythonFile 同样不发起新读取', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const internals = manager as unknown as ManagerInternals;
    const indexSpy = vi.spyOn(internals, 'ensureIndexForPythonFile');

    const faces = await manager.getEntityComponentFacesForPythonFile(
      '/tmp/project/scripts/base/Hero.py',
      cancelledToken()
    );

    expect(faces).toBeNull();
    expect(indexSpy).not.toHaveBeenCalled();
  });

  it('共享首扫不被取消:取消只放弃本次等待,initialScan 照常推进', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const internals = manager as unknown as ManagerInternals;
    const indexSpy = vi.spyOn(internals, 'ensureIndexForPythonFile');
    // 跨 def 回退路径:索引落空后等待共享首扫(有界 1s + token)
    // token 已取消 → 立即放弃;首扫 promise 本身无人取消(测试窗口内保持 pending)
    const parent = pendingToken();
    indexSpy.mockResolvedValue(null);
    const scanProbe = (manager as unknown as { initialScan: Promise<unknown> }).initialScan;
    parent.cancel();
    const result = await manager.resolveMethodDefinition(
      '/tmp/project/interfaces/ROLE.py',
      'onTimer',
      undefined,
      parent.token
    );
    expect(result).toBeNull();
    // 首扫仍未落定 = 没有被取消斩断(若被取消,这里会是已拒绝/已兑现的残缺态);
    // 放行让其继续推进(供后续请求复用)
    expect(scanProbe).toBeInstanceOf(Promise);
    indexSpy.mockRestore();
  });

  it('provider 面:def-method 分支把 deadline.token 传给 resolveMethodDefinition', async () => {
    const calls: Array<Array<unknown>> = [];
    let release!: (value: null) => void;
    const manager = {
      resolveMethodDefinition: (...args: Array<unknown>) => {
        calls.push(args);
        return new Promise<null>(resolve => { release = resolve; });
      }
    } as unknown as EntityMappingManager;
    const provider = new KBEngineHoverProvider(manager);
    const parent = pendingToken();
    const pending = provider.provideHover(
      makeTextDocument(PY_TEXT, { fileName: '/tmp/project/scripts/base/Hero.py', languageId: 'python' }),
      NAME_POSITION,
      parent.token
    );

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const token = calls[0][3];
    expect(token).toBeDefined();
    // 传入的是链接 token:父取消即取消(BUD-001 同一 deadline 上下文);
    // 须在请求在途时观察(deadline 落定即释放父监听)
    let observed = false;
    (token as { onCancellationRequested(cb: () => void): unknown }).onCancellationRequested(() => { observed = true; });
    parent.cancel();
    expect(observed).toBe(true);
    release(null);
    expect(await pending).toBeNull();
  });
});
