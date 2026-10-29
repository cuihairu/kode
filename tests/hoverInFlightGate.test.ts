import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { KBEngineHoverProvider, setHoverInFlightGateForTests } from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// IDE-REV-032:hover 在途闸(测试面)——provider 过入口守卫后、出结果前的
// 确定性在途窗口:门内取消=开始后完成前取消(不靠竞速);预取消 token 不
// 进闸(入口守卫先行);释放清闸后重入走原路径,不残留。

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
  setHoverInFlightGateForTests(() => {
    markEntered();
    return release.then(() => { setHoverInFlightGateForTests(null); });
  });
  return { entered, release: () => { releaseGate(); } };
};

afterEach(() => {
  setHoverInFlightGateForTests(null);
});

describe('hover 在途闸(IDE-REV-032 测试面)', () => {
  it('门内取消=开始后完成前取消:在途可见、放行后按取消语义收口不回内容', async () => {
    const provider = new KBEngineHoverProvider(new EntityMappingManager({ subscriptions: [] } as never));
    const gate = installGate();
    const handle = pendingToken();
    const hoverPromise = provider.provideHover(makeTextDocument(PY_TEXT), NAME_POSITION, handle.token);
    // 请求已开始(provider 到达闸=过入口守卫)且未完成(结果还挂着)
    await gate.entered;
    let settled = false;
    void hoverPromise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    // 在途窗口内斩 token
    handle.cancel();
    gate.release();
    const hover = await hoverPromise;
    expect(hover).toBeNull();
  });

  it('预取消不进闸:入口守卫先于闸,零工作直接返回', async () => {
    const provider = new KBEngineHoverProvider(new EntityMappingManager({ subscriptions: [] } as never));
    let gateFired = false;
    // 按文档惯例自清闸(释放时顺手置 null)——闸若被触发,重入不再撞闸
    setHoverInFlightGateForTests(() => {
      gateFired = true;
      setHoverInFlightGateForTests(null);
      return Promise.resolve();
    });
    const hover = await provider.provideHover(makeTextDocument(PY_TEXT), NAME_POSITION, cancelledToken());
    expect(hover).toBeNull();
    expect(gateFired).toBe(false);
  });

  it('释放清闸后重入走原路径:同一 provider 后续 hover 不再被闸挂住', async () => {
    const provider = new KBEngineHoverProvider(new EntityMappingManager({ subscriptions: [] } as never));
    const gate = installGate();
    const first = provider.provideHover(makeTextDocument(PY_TEXT), NAME_POSITION);
    await gate.entered;
    gate.release();
    await first;
    // 闸已清:第二次调用直接走原路径(不会卡在未安装的闸上)
    const second = provider.provideHover(makeTextDocument(PY_TEXT), NAME_POSITION);
    const outcome = await Promise.race([
      Promise.resolve(second).then(() => 'settled', () => 'settled'),
      new Promise<string>(resolve => { setImmediate(() => resolve('pending')); })
    ]);
    expect(outcome).toBe('settled');
  });
});
