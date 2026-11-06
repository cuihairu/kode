import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { createFileChangeMetaResolver, type FileChangeMetaDeps } from '../src/fileChangeMeta';
import { normalizeFileIdentity } from '../src/pathIdentity';

// 审核整改(commit-review-gate FAIL 四条)的回归面:
// ① 进程归属的根必须与文件走同一把身份键(Windows 盘符/UNC 大小写不一致会假 unresolved);
// ② 缓存键带路径形态(scriptRoot 热切换不得回吐过期的 module/process);
// ③ 缓存容量 LRU 封顶(长会话不无限涨,淘汰只花一次读);
// ④ sha256 = 读取时点快照的字段契约(零 stat 契约优先,边界如实断言)。
// 字段面/记忆化主口径仍归 tests/fileChangeMeta.test.ts,本文件只补这四条边界。

const sha256Of = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** 恒定内容的注入 IO:读恒成功、stat 恒给定版本(失败面归主测试文件) */
const fixedDeps = (
  scriptRoot: () => string,
  content: string,
  statToken: { mtimeMs: number; size: number },
  assetsRoot = (): string => ''
): { deps: FileChangeMetaDeps; reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      scriptRoot,
      assetsRoot,
      readFile: async (file: string): Promise<Buffer> => {
        reads.push(file);
        return Buffer.from(content, 'utf8');
      },
      stat: async (): Promise<{ mtimeMs: number; size: number }> => statToken
    }
  };
};

describe('fileChangeMeta 整改:进程归属的根归一(Windows/UNC/根目录)', () => {
  it('Windows 盘符:根大小写混写、身份键小写化,仍判得出 cellapp', async () => {
    const { deps } = fixedDeps(() => 'C:\\Proj\\Scripts', 'class Foo: pass\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);

    const meta = await resolver.metaFor({
      fsPath: 'C:\\Proj\\Scripts\\cell\\Foo.py',
      identity: normalizeFileIdentity('C:\\Proj\\Scripts\\cell\\Foo.py'),
      kind: 'change',
      version: '1:1'
    });

    // 整改前:根只 toPosix 不小写 → `C:/Proj/Scripts` 对不上 `c:/proj/...` 假 unresolved
    expect(meta.processKind).toBe('cellapp');
    expect(meta.processSource).toBe('path');
    expect(meta.module).toBe('cell.Foo');
  });

  it('UNC 路径:根与文件同走 normalizeFileIdentity,归属与模块都解得出', async () => {
    const { deps } = fixedDeps(() => '\\\\server\\share\\scripts', 'class Foo: pass\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);
    const file = '\\\\server\\share\\scripts\\cell\\Foo.py';

    const meta = await resolver.metaFor({
      fsPath: file,
      identity: normalizeFileIdentity(file),
      kind: 'change',
      version: '1:1'
    });

    expect(meta.processKind).toBe('cellapp');
    expect(meta.module).toBe('cell.Foo');
  });

  it('脚本根为 `/`:归一后只剩一个斜杠,不许被 trim 成空串而整片 unresolved', async () => {
    const { deps } = fixedDeps(() => '/', 'class Foo: pass\n', { mtimeMs: 1, size: 1 });
    const resolver = createFileChangeMetaResolver(deps);

    const meta = await resolver.metaFor({
      fsPath: '/cell/Foo.py',
      identity: normalizeFileIdentity('/cell/Foo.py'),
      kind: 'change',
      version: '1:1'
    });

    expect(meta.processKind).toBe('cellapp');
    expect(meta.processSource).toBe('path');
  });
});

describe('fileChangeMeta 整改:缓存键带路径形态(热切换不过期)', () => {
  it('同一文件同一切版本下切 scriptRoot:模块名/归属重算,不回吐旧对象', async () => {
    let root = '/ws/scripts';
    const { deps, reads } = fixedDeps(() => root, 'class Foo: pass\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);
    const event = {
      fsPath: '/ws/scripts/cell/Foo.py',
      identity: normalizeFileIdentity('/ws/scripts/cell/Foo.py'),
      kind: 'change' as const,
      version: '1:1'
    };

    const before = await resolver.metaFor(event);
    expect(before.module).toBe('cell.Foo');
    expect(before.processKind).toBe('cellapp');

    root = '/ws'; // 配置热切换:同一文件现在是 scripts/cell/Foo.py
    const after = await resolver.metaFor(event);

    expect(after.module, '切根后必须重算模块名,不许命中旧缓存').toBe('scripts.cell.Foo');
    expect(after.processKind).toBe('cellapp');
    expect(after).not.toBe(before);
    expect(reads, '换键即重读(低频事件,一次读换字段不过期)').toHaveLength(2);
    // 同根同版本仍是同一对象(主测试的 toBe 契约不受影响)
    expect(await resolver.metaFor(event)).toBe(after);
  });

  it('同一身份键的两种路径写法各归各:fsPath 原样保留,不互相冒充', async () => {
    const { deps } = fixedDeps(() => '/ws/assets/scripts', 'class A: pass\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);

    const dotted = await resolver.metaForPath('/ws/assets/scripts/./cell/A.py');
    const clean = await resolver.metaForPath('/ws/assets/scripts/cell/A.py');

    expect(normalizeFileIdentity('/ws/assets/scripts/./cell/A.py'))
      .toBe(normalizeFileIdentity('/ws/assets/scripts/cell/A.py')); // 同一 identity
    expect(dotted.fsPath).toBe('/ws/assets/scripts/./cell/A.py');
    expect(clean.fsPath).toBe('/ws/assets/scripts/cell/A.py');
    expect(clean).not.toBe(dotted); // 路径写法不同 = 不同键,不拿首个 fsPath 冒充
    expect(clean.module).toBe('cell.A');
    // 点段路径按双名称口径拒绝解析(不编造),进程归属走身份键照常解出
    expect(dotted.module).toBeUndefined();
    expect(dotted.processKind).toBe('cellapp');
    expect(clean.processKind).toBe('cellapp');
  });
});

describe('fileChangeMeta 整改:缓存容量 LRU 封顶', () => {
  it('超过 512 条后最久未用的键被淘汰(下次同键事件重读),热键仍命中', async () => {
    const { deps, reads } = fixedDeps(() => '/ws/scripts', 'x = 1\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);
    const eventOf = (version: string) => ({
      fsPath: '/ws/scripts/cell/Foo.py',
      identity: normalizeFileIdentity('/ws/scripts/cell/Foo.py'),
      kind: 'change' as const,
      version
    });

    for (let index = 1; index <= 520; index += 1) {
      await resolver.metaFor(eventOf(`${index}:1`));
    }
    expect(reads, '520 个不同版本 = 520 次读(同版本仍只读一次)').toHaveLength(520);

    await resolver.metaFor(eventOf('520:1')); // 最近用过:仍命中
    expect(reads).toHaveLength(520);

    await resolver.metaFor(eventOf('2:1')); // 最早一批:已淘汰 → 重读一次
    expect(reads).toHaveLength(521);

    await resolver.metaFor(eventOf('2:1')); // 淘汰后重新入键:再命中
    expect(reads).toHaveLength(521);
  });
});

describe('fileChangeMeta 整改:sha256 是读取时点快照(零 stat 契约优先)', () => {
  it('stat 与读之间内容前进:version/size 取 stat 那刻,hash 取读到的内容', async () => {
    const statVersion = '1000:5';
    const newerContent = 'newer content\n'; // 读到的已是第二次写入的字节
    const reads: string[] = [];
    const resolver = createFileChangeMetaResolver({
      scriptRoot: () => '/ws/scripts',
      assetsRoot: () => '',
      readFile: async (file: string): Promise<Buffer> => {
        reads.push(file);
        return Buffer.from(newerContent, 'utf8');
      },
      stat: async () => ({ mtimeMs: 1000, size: 5 })
    });

    const meta = await resolver.metaFor({
      fsPath: '/ws/scripts/cell/Foo.py',
      identity: normalizeFileIdentity('/ws/scripts/cell/Foo.py'),
      kind: 'change'
    });

    // 契约(见 docs/design/file-change-meta.md §3):不为核对多 stat 一次,
    // 故 hash 可能比 version 新;重读只发生在版本 token 变化时。
    expect(reads).toHaveLength(1);
    expect(meta.version).toBe(statVersion);
    expect(meta.size).toBe(5);
    expect(meta.sha256).toBe(sha256Of(newerContent));
    expect(meta.sha256).not.toBe(sha256Of('first write'));
  });
});

describe('fileChangeMeta 整改:同键同 kind 的对象契约与同 token 快照边界', () => {
  it('先 create 再两次 change:两次 change 回同一对象,换回 create 仍是原对象,全程只读一次', async () => {
    const { deps, reads } = fixedDeps(() => '/ws/scripts', 'x = 1\n', {
      mtimeMs: 1,
      size: 1
    });
    const resolver = createFileChangeMetaResolver(deps);
    const base = {
      fsPath: '/ws/scripts/cell/Foo.py',
      identity: normalizeFileIdentity('/ws/scripts/cell/Foo.py'),
      version: '1:1'
    };

    const created = await resolver.metaFor({ ...base, kind: 'create' });
    const firstChange = await resolver.metaFor({ ...base, kind: 'change' });
    const secondChange = await resolver.metaFor({ ...base, kind: 'change' });

    expect(firstChange).not.toBe(created); // 换 kind 换字段,不冒充
    expect(firstChange.kind).toBe('change');
    expect(secondChange, '同键同 kind 恒同一对象(派生对象入册)').toBe(firstChange);
    expect(await resolver.metaFor({ ...base, kind: 'create' })).toBe(created);
    expect(reads, '换 kind 只复制字段,不重读').toHaveLength(1);
  });

  it('同 token 下内容前进:命中缓存不重读(同 token 无法识别内容变化,零 stat 的代价)', async () => {
    let content = 'x = 1\n';
    const reads: string[] = [];
    const resolver = createFileChangeMetaResolver({
      scriptRoot: () => '/ws/scripts',
      assetsRoot: () => '',
      readFile: async (file: string): Promise<Buffer> => {
        reads.push(file);
        return Buffer.from(content, 'utf8');
      },
      stat: async () => ({ mtimeMs: 1000, size: 6 })
    });
    const event = {
      fsPath: '/ws/scripts/cell/Foo.py',
      identity: normalizeFileIdentity('/ws/scripts/cell/Foo.py'),
      kind: 'change' as const,
      version: '1000:6'
    };

    const before = await resolver.metaFor(event);
    content = 'x = 2\n'; // 同 token(mtime:size 没变)的第二次写入
    const after = await resolver.metaFor(event);

    expect(after).toBe(before); // 同键命中:按契约不重读、不重算
    expect(after.sha256).toBe(sha256Of('x = 1\n'));
    expect(reads).toHaveLength(1);
  });
});
