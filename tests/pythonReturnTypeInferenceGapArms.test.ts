import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySavedFileAnnotations,
  collectProjectPythonFilesAsync,
  extractFileReturnAnnotations,
  extractFileReturnAnnotationsAsync,
  getDocumentReturnAnnotationBucketForTests,
  getReturnAnnotationCacheGauge,
  parseLocalAssignmentCall,
  queueDocumentReturnAnnotations,
  removeSavedFileAnnotations,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot,
  updateDocumentReturnAnnotations,
  updateDocumentReturnAnnotationsAsync
} from '../src/backend/pythonReturnTypeInference';

/**
 * Gap-arm coverage for src/backend/pythonReturnTypeInference.ts (baseline uncovered
 * statement start-lines 82, 173, 234, 294, 318, 373, 393, 585, 640, 659, 691,
 * 743, 746, 807, 948).
 *
 * All 15 arms are reachable via the module's public API (with real fs) — no
 * dead arms for this file. Each is exercised deterministically below.
 */

const roots: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn> | { mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  resetPythonReturnAnnotationCache();
});

const setupWorkspace = (): { root: string; put: (relative: string, content: string) => string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pyret-gap-'));
  roots.push(root);
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  return { root, put };
};

describe('parseLocalAssignmentCall no-match arm (82)', () => {
  it('non-assignment / comparison / return lines return null', () => {
    expect(parseLocalAssignmentCall('x == 1')).toBeNull();
    expect(parseLocalAssignmentCall('return data')).toBeNull();
    expect(parseLocalAssignmentCall('foo bar')).toBeNull();
    expect(parseLocalAssignmentCall('x = y = 1')).toBeNull();
  });
});

describe('collectProjectPythonFilesAsync early-return arm (173)', () => {
  it('limit=0 and pre-cancelled token both bail at the visit entry', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'x = 1\n');
    expect(await collectProjectPythonFilesAsync(root, 0)).toEqual([]);
    expect(await collectProjectPythonFilesAsync(root, 20000, { isCancellationRequested: true })).toEqual([]);
  });
});

describe('64-line signature truncation (234 sync, 318 async)', () => {
  const truncSource = (name: string): string => [
    `def ${name}(`,
    ...Array.from({ length: 63 }, () => '    param'),
    'def second() -> SECOND:',
    '    pass'
  ].join('\n');

  it('sync: over-long signature is dropped, following def is kept (234)', () => {
    expect([...extractFileReturnAnnotations(truncSource('first'))]).toEqual([['second', 'SECOND']]);
  });

  it('async: over-long signature is dropped, following def is kept (318)', async () => {
    expect([...await extractFileReturnAnnotationsAsync(truncSource('first'))]).toEqual([['second', 'SECOND']]);
  });

  it('async: incomplete signature does not swallow the following def (294)', async () => {
    const source = 'def broken(\n    x,\ndef next() -> Next:\n    pass\n';
    expect([...await extractFileReturnAnnotationsAsync(source)]).toEqual([['next', 'Next']]);
  });
});

describe('null workspaceRoot no-op arms (373, 393, 585, 640)', () => {
  it('apply / remove / queue / async-update all no-op on null root', async () => {
    const context = { fileKey: 'file:///orphan.py', version: 1, source: () => '' };
    applySavedFileAnnotations(null, '/x/a.py', 'def f() -> T:\n    pass\n');
    removeSavedFileAnnotations(null, '/x/a.py');
    queueDocumentReturnAnnotations(null, context);
    await updateDocumentReturnAnnotationsAsync(null, context);
    // 全部 no-op,无抛无副作用:后续真实 root 查询不受影响
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> OK:\n    pass\n');
    const resolved = await resolveLocalVariableReturnType(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    );
    expect(resolved).toMatchObject({ annotation: 'OK' });
  });
});

describe('updateDocumentReturnAnnotationsAsync superseded-during-extraction (659)', () => {
  it('a newer sync publish during the async yield wins (async v1 does not overwrite v5)', async () => {
    const { root } = setupWorkspace();
    const fileKey = 'file:///doc.py';
    // 大源码让异步提取在 ~16KB 预算处 setImmediate 让出;让出期间同步发布 v5
    const bigSource = 'def get_data() -> OLDER:\n    pass\n' + '# ' + 'x'.repeat(20000) + '\n';
    const pending = updateDocumentReturnAnnotationsAsync(root, { fileKey, version: 1, source: () => bigSource });
    updateDocumentReturnAnnotations(root, { fileKey, version: 5, source: () => 'def get_data() -> NEWER:\n    pass\n' });
    await pending;
    // 若 659 不拦,v1(OLDER)会覆盖 v5 → 桶见 NEWER 证明「期间已入更新版本」生效
    // (批 D:查询不再消费文档桶,机制断言走桶访问器)
    expect(getDocumentReturnAnnotationBucketForTests(root, fileKey)?.annotations.get('get_data'))
      .toBe('NEWER');
  });
});

describe('other-document unannotated shadowing (691, 948)', () => {
  it('a no-annotation def in another open doc lands in shadowedNames; query no longer borrows disk', async () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def shadow_me() -> DISK_VAL:\n    pass\n');
    // 预热磁盘索引(新鲜 DISK_VAL)
    await resolveLocalVariableReturnType(
      ['from svc import shadow_me', 'x = shadow_me()'], 1, 'x', root
    );
    // 另一打开文档显式声明 shadow_me 无注解 → 进入 shadowedNames(691)
    updateDocumentReturnAnnotations(root, {
      fileKey: 'file:///other.py', version: 1, source: () => 'def shadow_me():\n    pass\n'
    });
    // 批 D:查询不再消费文档桶(级联已删)——无绑定候选 → 诚实 null,不借磁盘
    // DISK_VAL;桶机制面仍记 shadowedNames(691 臂由本次发布走到)
    const bucket = getDocumentReturnAnnotationBucketForTests(root, 'file:///other.py');
    expect(bucket?.annotations.has('shadow_me')).toBe(false);
    expect(bucket?.unannotatedNames.has('shadow_me')).toBe(true);
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = shadow_me()'], 0, 'x', root)).toBeNull();
  });
});

describe('build cancellation arms (743, 746)', () => {
  /** 门住读:每次 readFile 后把 token 标记取消(读期取消 → 743 拦截) */
  const cancelOnRead = (token: { isCancellationRequested: boolean }): void => {
    const real = fs.promises.readFile.bind(fs.promises);
    spies.push(vi.spyOn(fs.promises, 'readFile').mockImplementation(
      (async (...args: unknown[]) => {
        token.isCancellationRequested = true;
        return await real(...(args as Parameters<typeof fs.promises.readFile>));
      }) as unknown as typeof fs.promises.readFile
    ));
  };

  it('cancel during the read phase: build aborts before extraction (743), no publish', async () => {
    const { root, put } = setupWorkspace();
    put('a.py', 'def get_data() -> A:\n    pass\n');
    const token = { isCancellationRequested: false };
    cancelOnRead(token);
    const pending = resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root, token);
    expect(await pending).toBeNull();
    expect(getReturnAnnotationCacheGauge().entries).toBe(0);
  });

  it('cancel after reads, during the extraction loop: i>0 iteration bails (746), no publish', async () => {
    const { root, put } = setupWorkspace();
    // file0 大(>16KB 预算,长代码行逐字符迭代)让提取 setImmediate 让出;
    // 注意不能用 `#` 注释行——掩码对注释 O(1) 短路,不消耗预算不产生让出。
    // file1 保证循环有下一轮 746 检查。
    put('file0.py', 'def big() -> BIG:\n    pass\n' + 'value = ' + 'a'.repeat(30000) + '\n');
    put('file1.py', 'def small() -> SMALL:\n    pass\n');
    const token = { isCancellationRequested: false };
    // 最后一次 readFile 完成后调度 setImmediate 置取消:落在 file0 提取让出期间
    const real = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    spies.push(vi.spyOn(fs.promises, 'readFile').mockImplementation(
      (async (...args: unknown[]) => {
        const result = await real(...(args as Parameters<typeof fs.promises.readFile>));
        reads += 1;
        if (reads === 2) setImmediate(() => { token.isCancellationRequested = true; });
        return result;
      }) as unknown as typeof fs.promises.readFile
    ));
    const pending = resolveLocalVariableReturnType(['x = big()'], 0, 'x', root, token);
    expect(await pending).toBeNull();
    expect(getReturnAnnotationCacheGauge().entries).toBe(0);
  });
});

describe('import wildcard / relative-empty skip arms (807)', () => {
  it('from mod import * : binding skipped → honest null(批 D:级联已删,不借磁盘同名)', () => {
    const { root, put } = setupWorkspace();
    put('helpers.py', 'def load_all():\n    pass\n');
    put('unrelated.py', 'def load_all() -> FROM_UNRELATED:\n    pass\n');
    // 预热磁盘索引(命中面仍是磁盘旧值,但查询不再借名)
    return resolveLocalVariableReturnType(
      ['from unrelated import load_all', 'data = load_all()'], 1, 'data', root
    ).then(() => {
      // 807 跳过通配绑定 → 无绑定候选 → 诚实 null(级联删除后不借 unrelated 同名)
      const resolved = resolveLocalVariableReturnTypeFromSnapshot(
        ['from helpers import *', 'data = load_all()'], 1, 'data', root
      );
      expect(resolved).toBeNull();
    });
  });

  it('from . import x (empty module after dot-strip) : binding skipped → honest null(级联已删)', () => {
    const { root, put } = setupWorkspace();
    put('svc.py', 'def get_data() -> DISK:\n    pass\n');
    return resolveLocalVariableReturnType(
      ['from svc import get_data', 'data = get_data()'], 1, 'data', root
    ).then(() => {
      // module 剥点后为空 → !module → continue(807);无绑定候选 → 诚实 null
      const resolved = resolveLocalVariableReturnTypeFromSnapshot(
        ['from . import get_data', 'data = get_data()'], 1, 'data', root
      );
      expect(resolved).toBeNull();
    });
  });
});
