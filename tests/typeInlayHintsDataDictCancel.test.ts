import { describe, expect, it } from 'vitest';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  Position,
  Range,
  configurationOverrides,
  makeTextDocument
} from './helpers/vscodeStub';

/**
 * RUST-004 判据面:冷索引在飞时 inlay 读点查询可取消(AUD-072 同款竞速)。
 *
 * 靶子是 collectDataDictHints 里读点路径的 `await this.dataDictIndex.ensureStarted()`
 * 旧形——不接 token,宿主换页/关文档时调用仍挂着等整轮扫描结束。
 *
 * 钉法要点:**预取消的 token 不构成 prove**——旧实现入口也有
 * `token.isCancellationRequested` 早退,两者行为不可分。必须用**挂死索引**
 * (ensureStarted 永不 resolve)+ 中途取消:竞速生效则调用先于索引就绪返回;
 * 回归旧形则调用永远挂起,测试以超时红。
 *
 * 另钉 `ensureStartedCalls === 1`:证明调用真的抵达了读点门(而非因无别名/
 * 开关关闭等早退假绿)。
 */

interface PendingToken {
  token: never;
  cancel: () => void;
}

const pendingToken = (): PendingToken => {
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

const managerStub = {
  resolvePropertyDefinitionInfo: () => Promise.resolve(null),
  resolveMethodDefinition: () => Promise.resolve(null)
} as unknown as EntityMappingManager;

describe('数据字典读点 inlay:冷索引等待可取消(RUST-004)', () => {
  it('索引挂死时中途取消 → 调用即返,读点 hint 弃、写点 hint 保留', async () => {
    configurationOverrides.delete('kbengine');
    configurationOverrides.delete('kbengine.python');
    let ensureStartedCalls = 0;
    const hungIndex = {
      ensureStarted: () => {
        ensureStartedCalls += 1;
        return new Promise<void>(() => undefined);
      }
    } as never;
    const provider = new PythonTypeInlayHintsProvider(managerStub, hungIndex);
    // 行1 写点(纯行面,不需索引);行2 读点(需索引 → 抵达冷索引门)
    const document = makeTextDocument(
      'import KBEngine\nKBEngine.globalData["w"] = 1\nx = KBEngine.globalData.get("w")\n',
      { fileName: '/tmp/ws/scripts/base/A.py', languageId: 'python' }
    );
    const range = new Range(new Position(0, 0), new Position(2, 0));

    const harness = pendingToken();
    const pending = provider.provideInlayHints(document as never, range, harness.token);
    // 竞速订阅发生在微任务里:先让一个宏任务过去,确保 onCancellationRequested
    // 已注册,再取消——否则 token 旗标先置位走的是入口预检路径,测不到竞速面。
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.cancel();

    const hints = await Promise.race([
      pending as Promise<unknown[]>,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('inlay 仍挂在 ensureStarted:取消未生效')),
          2000
        )
      )
    ]);

    // 抵达过读点门(不是别名/开关早退);索引仍未就绪(挂死)但调用已返回
    expect(ensureStartedCalls).toBe(1);
    const positions = (hints as Array<{ position: { line: number } }>).map(h => h.position.line);
    // 读点 hint 因取消被弃;写点 hint 不需索引、保留
    expect(positions).not.toContain(2);
    expect(hints).toHaveLength(1);
  });
});
