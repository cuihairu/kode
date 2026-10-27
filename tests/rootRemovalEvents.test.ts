import { describe, expect, it } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { createRootRemovalNotifier } from '../src/rootRemovalEvents';

// IDE-SNP-009:统一移除根通知——工作区根被移除时,一个通知源向全部消费索引
// 广播同一根移除事件;各消费索引定向摘除该根记录,不依靠各自 TTL/重扫自愈。

type ClassIndexInternals = {
  updateFile(file: string, content: string, version: number): void;
  byName: Map<string, Array<{ filePath: string }>>;
  fileCache: Map<string, unknown>;
};

describe('IDE-SNP-009:统一移除根通知', () => {
  it('一次 emit 同步广播给全部订阅者,各收到同一根路径恰一次', () => {
    const notifier = createRootRemovalNotifier();
    const seenEntity: string[] = [];
    const seenPython: string[] = [];
    notifier.subscribe(event => { seenEntity.push(event.rootPath); });
    notifier.subscribe(event => { seenPython.push(event.rootPath); });

    notifier.emit('/ws/B');
    expect(seenEntity).toEqual(['/ws/B']);
    expect(seenPython).toEqual(['/ws/B']); // 同一事件,消费端同步可用

    notifier.emit('/ws/B');
    expect(seenEntity).toEqual(['/ws/B', '/ws/B']); // 每次 emit 都是独立通知,不吞
  });

  it('退订后不再收;dispose 后 emit 不投递', () => {
    const notifier = createRootRemovalNotifier();
    const seen: string[] = [];
    const unsubscribe = notifier.subscribe(event => { seen.push(event.rootPath); });

    notifier.emit('/ws/A');
    unsubscribe();
    notifier.emit('/ws/A');
    expect(seen).toEqual(['/ws/A']);

    notifier.dispose();
    notifier.emit('/ws/A');
    expect(seen).toEqual(['/ws/A']);
  });

  it('pythonClassIndex.removeRoot 定向摘除该根,其余根与版本口径原样保留', async () => {
    const index = new PythonClassIndex() as unknown as ClassIndexInternals & PythonClassIndex;
    index.updateFile('/ws/A/a.py', 'class Shared:\n    pass\n\nclass OnlyA:\n    pass\n', 1);
    index.updateFile('/ws/B/b.py', 'class Shared:\n    pass\n\nclass OnlyB:\n    pass\n', 1);
    const beforeClasses = index.getIndexVersion('classes');
    const beforeMro = index.getIndexVersion('mro');

    expect((await index.findClassesByName('Shared')).map(cls => cls.filePath).sort())
      .toEqual(['/ws/A/a.py', '/ws/B/b.py']);

    const removed = index.removeRoot('/ws/B');

    expect(removed).toBe(1);
    expect(index.byName.get('Shared')?.map(cls => cls.filePath)).toEqual(['/ws/A/a.py']);
    expect(index.byName.has('OnlyB')).toBe(false);
    expect(index.byName.has('OnlyA')).toBe(true);
    expect(index.fileCache.has('/ws/B/b.py')).toBe(false);
    expect(index.fileCache.has('/ws/A/a.py')).toBe(true);
    // 摘除是显式版本事件:五轴口径前进(消费端可判定过期),非 TTL 静默过期
    expect(index.getIndexVersion('classes')).toBeGreaterThan(beforeClasses);
    expect(index.getIndexVersion('mro')).toBeGreaterThan(beforeMro);
    // 留存根的查询仍即时可用,不需要重扫自愈
    expect((await index.findClassesByName('OnlyA')).map(cls => cls.filePath)).toEqual(['/ws/A/a.py']);
  });

  it('前缀安全:/ws 摘除不误伤 /wsX 下的同前缀文件', async () => {
    const index = new PythonClassIndex() as unknown as ClassIndexInternals & PythonClassIndex;
    index.updateFile('/ws/A/a.py', 'class InRoot:\n    pass\n', 1);
    index.updateFile('/wsX/x.py', 'class PrefixTrap:\n    pass\n', 1);

    const removed = index.removeRoot('/ws');

    expect(removed).toBe(1);
    expect(index.byName.has('InRoot')).toBe(false);
    expect((await index.findClassesByName('PrefixTrap')).map(cls => cls.filePath))
      .toEqual(['/wsX/x.py']);
  });

  it('未知根是空操作:不摘任何记录,版本不虚进', () => {
    const index = new PythonClassIndex() as unknown as ClassIndexInternals & PythonClassIndex;
    index.updateFile('/ws/A/a.py', 'class Keep:\n    pass\n', 1);
    const beforeClasses = index.getIndexVersion('classes');

    expect(index.removeRoot('/nonexistent')).toBe(0);
    expect(index.byName.has('Keep')).toBe(true);
    expect(index.getIndexVersion('classes')).toBe(beforeClasses);
  });
});
