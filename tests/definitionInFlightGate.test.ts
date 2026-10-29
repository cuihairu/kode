import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonDefinitionProvider, setDefinitionInFlightGateForTests } from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-REV-033:定义跳转在途闸(测试面)——provider 过入口守卫后、出结果前
// 的确定性在途窗口:门内取消=开始后完成前取消(不靠竞速);预取消 token
// 不进闸(入口守卫先行);放行后重查取消,晚到的取消不再触发任何查找工作。

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

const cancelledToken = () =>
  ({ isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) }) as never;

const PY_TEXT = 'class Hero:\n    def onTimer(self):\n        pass\n';
const NAME_POSITION = new Position(1, 10);

interface GateHandle {
  entered: Promise<void>;
  release(): void;
}

const installGate = (): GateHandle => {
  let markEntered!: () => void;
  let releaseGate!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseGate = resolve; });
  setDefinitionInFlightGateForTests(() => {
    markEntered();
    return release.then(() => { setDefinitionInFlightGateForTests(null); });
  });
  return { entered, release: () => { releaseGate(); } };
};

afterEach(() => {
  setDefinitionInFlightGateForTests(null);
});

describe('定义跳转在途闸(IDE-REV-033 测试面)', () => {
  const makeProvider = (): PythonDefinitionProvider =>
    new PythonDefinitionProvider(new EntityMappingManager({ subscriptions: [] } as never));

  it('门内取消=开始后完成前取消:在途可见、放行后重查取消零工作返回', async () => {
    const provider = makeProvider();
    const gate = installGate();
    const handle = pendingToken();
    const definitionPromise = provider.provideDefinition(makeTextDocument(PY_TEXT), NAME_POSITION, handle.token);
    await gate.entered;
    let settled = false;
    void Promise.resolve(definitionPromise).then(() => { settled = true; }, () => { settled = true; });
    // 门真在挂起:跨宏任务窗结果仍不可能落定(不挂起的闸会被下游几毫秒跑完)
    await new Promise(resolve => { setTimeout(resolve, 25); });
    expect(settled).toBe(false);
    handle.cancel();
    gate.release();
    const definition = await definitionPromise;
    expect(definition).toBeNull();
  });

  it('预取消不进闸:入口守卫先于闸,零工作直接返回', async () => {
    const provider = makeProvider();
    let gateFired = false;
    setDefinitionInFlightGateForTests(() => {
      gateFired = true;
      setDefinitionInFlightGateForTests(null);
      return Promise.resolve();
    });
    const definition = await provider.provideDefinition(makeTextDocument(PY_TEXT), NAME_POSITION, cancelledToken());
    expect(definition).toBeNull();
    expect(gateFired).toBe(false);
  });

  it('释放清闸后重入走原路径:同一 provider 后续跳转不再被闸挂住', async () => {
    const provider = makeProvider();
    const gate = installGate();
    const first = provider.provideDefinition(makeTextDocument(PY_TEXT), NAME_POSITION);
    await gate.entered;
    gate.release();
    await first;
    const second = provider.provideDefinition(makeTextDocument(PY_TEXT), NAME_POSITION);
    const outcome = await Promise.race([
      Promise.resolve(second).then(() => 'settled', () => 'settled'),
      new Promise<string>(resolve => { setImmediate(() => resolve('pending')); })
    ]);
    expect(outcome).toBe('settled');
  });
});
