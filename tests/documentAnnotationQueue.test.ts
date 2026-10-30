import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  queueDocumentReturnAnnotations,
  releaseDocumentReturnAnnotations,
  flushPendingDocumentReturnAnnotationsForTests,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnTypeFromSnapshot
} from '../src/pythonReturnTypeInference';

// 2026-10-28 审核整改(HOV-011/009):每个 Python 编辑事件都在
// onDidChangeTextDocument 里同步整文件提取注解(889KB ≈ 120ms 阻塞事件
// 循环);快照面又在查赋值候选之前就先更新文档桶(无赋值的 hover 也白做
// 全文件提取)。整改:编辑走队列(同文件版本去重,宏任务冲刷,让出式提取),
// 快照面先查候选再更新桶;关文档取消在途更新(不复活已弃桶)。

const ROOT = '/ws/project';

const temporaryDirectories: string[] = [];

afterEach(() => {
  resetPythonReturnAnnotationCache();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

const fileKey = (name: string): string => `file:///ws/${name}`;

describe('2026-10-28 审核整改:文档注解桶走队列不占编辑同步路径', () => {
  it('编辑事件不触发同步提取:queue 后桶未更新,冲刷后才入桶', async () => {
    const source = vi.fn(() => 'def get_data() -> NEW:\n    pass\n');
    queueDocumentReturnAnnotations(ROOT, { fileKey: fileKey('a.py'), version: 1, source });
    // 编辑同步路径上桶必须还不可见(原文未改的旧口径)
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', ROOT)).toBeNull();
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', ROOT))
      .toMatchObject({ annotation: 'NEW' });
  });

  it('同文件连续编辑版本去重:只按最新版本提取一次', async () => {
    const sources: string[] = [];
    queueDocumentReturnAnnotations(ROOT, { fileKey: fileKey('b.py'), version: 1, source: () => { sources.push('v1'); return 'def f() -> V1:\n    pass\n'; } });
    queueDocumentReturnAnnotations(ROOT, { fileKey: fileKey('b.py'), version: 2, source: () => { sources.push('v2'); return 'def f() -> V2:\n    pass\n'; } });
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(sources).toEqual(['v2']); // v1 被合并,只提取最新版本
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = f()'], 0, 'x', ROOT))
      .toMatchObject({ annotation: 'V2' });
  });

  it('大文件提取让出事件循环:提取期间定时器可响应(事件循环延迟验证)', async () => {
    // 模拟审计的 889KB 级文件:20 万行签名,同步整文件提取会阻塞整个宏任务
    const bigSource = Array.from({ length: 200000 }, (_, i) => `def f${i}() -> T${i}:`).join('\n');
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 0);
    try {
      await queueAndFlush(ROOT, fileKey('big.py'), 1, () => bigSource);
    } finally {
      clearInterval(interval);
    }
    expect(ticks).toBeGreaterThan(0); // 提取过程中事件循环在跑(定时器响应)
  }, 30000); // 断言只看定时器是否响应;覆盖率插桩+全量并行下同一分片提取更慢,放宽墙钟

  it('关文档取消在途更新:弃桶后不复活', async () => {
    queueDocumentReturnAnnotations(ROOT, { fileKey: fileKey('c.py'), version: 1, source: () => 'def f() -> X:\n    pass\n' });
    releaseDocumentReturnAnnotations(ROOT, fileKey('c.py')); // 关文档弃桶
    await flushPendingDocumentReturnAnnotationsForTests();
    expect(resolveLocalVariableReturnTypeFromSnapshot(['x = f()'], 0, 'x', ROOT)).toBeNull();
  });
});

describe('2026-10-28 审核整改:快照面先查赋值候选再更新桶(HOV-009)', () => {
  it('hover 无赋值候选时不提取全文(source 不被调用)', () => {
    const source = vi.fn(() => 'def f() -> X:\n    pass\n');
    const resolved = resolveLocalVariableReturnTypeFromSnapshot(['hover nothing'], 0, 'word', ROOT, {
      fileKey: fileKey('d.py'),
      version: 1,
      source
    });
    expect(resolved).toBeNull();
    expect(source).not.toHaveBeenCalled();
  });
});

async function queueAndFlush(root: string, key: string, version: number, source: () => string): Promise<void> {
  queueDocumentReturnAnnotations(root, { fileKey: key, version, source });
  await flushPendingDocumentReturnAnnotationsForTests();
}
