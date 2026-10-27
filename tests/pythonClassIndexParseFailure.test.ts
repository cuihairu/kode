import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 解析失败接缝:把 parsePythonFileResponsive 换成可控实现——parseImpl 为
// undefined 走真实解析(默认),函数则原样交给实现(reject 模拟 worker 崩溃/
// 停用,与读失败(文件被删/不可读)在 loadFile 里原共用同一个 catch)。
const parseState = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => Promise<unknown>)
}));

vi.mock('../src/pythonParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/pythonParserWorkerHost')>();
  return {
    ...actual,
    parsePythonFileResponsive: (...args: unknown[]) => {
      if (parseState.impl) {
        return parseState.impl(...args);
      }
      return (actual.parsePythonFileResponsive as (...a: unknown[]) => Promise<unknown>)(...args);
    }
  };
});

import { PythonClassIndex } from '../src/pythonClassIndex';

type ClassIndexInternals = {
  loadFile(file: string, version: number): Promise<void>;
  updateFile(file: string, content: string, version: number): void;
  schedulePendingScanRetry(): void;
  fileCache: Map<string, { version: number; parsed: { classes: Array<{ name: string; methods: Map<string, unknown> }> } }>;
  pendingScanRetries: Map<string, number>;
  byName: Map<string, Array<{ filePath: string }>>;
  stagedRequests: Map<string, unknown>;
};

// 审核发现:解析失败与文件读取失败共用 catch,解析线程崩溃时会删除仍存在
// 文件的旧类索引而非保留并重试。修复后 loadFile 把两路分流——读失败撤索引
// (僵尸类不得留存),解析失败保留旧索引并登记待补重试(与分块失败同渠道,
// 有界 MAX_SCAN_RETRY_ATTEMPTS)。
describe('PythonClassIndex loadFile 读失败/解析失败分流', () => {
  afterEach(() => {
    parseState.impl = undefined;
  });

  it('解析失败保留仍存在文件的旧类索引并登记待补重试(不删旧索引)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-parsefail-'));
    const file = path.join(root, 'A.py');
    fs.writeFileSync(file, 'class A:\n    pass\n');
    try {
      const index = new PythonClassIndex() as unknown as ClassIndexInternals;
      index.updateFile(file, fs.readFileSync(file, 'utf8'), 1);
      expect(index.fileCache.has(file)).toBe(true);
      expect(index.byName.get('A')?.map(hit => hit.filePath)).toEqual([file]);

      // 解析失败(模拟 worker 崩溃):内容已读到、文件仍在盘
      parseState.impl = async () => { throw new Error('worker crash'); };
      await index.loadFile(file, 1);

      // 修复前:旧类索引被删(byName 空、fileCache 无)——仍存在文件的类不应被删
      expect(index.fileCache.has(file), '解析失败不得删除仍存在文件的索引').toBe(true);
      expect(index.byName.get('A')?.map(hit => hit.filePath), '解析失败不得清空类集')
        .toEqual([file]);
      expect(index.pendingScanRetries.get(file), '解析失败应登记待补重试').toBe(1);

      // 恢复后:重试补解析成功,索引刷新(方法集变更可见),待补清账
      parseState.impl = undefined;
      fs.writeFileSync(file, 'class A:\n    def m(self):\n        pass\n', 'utf8');
      index.schedulePendingScanRetry();
      const start = Date.now();
      while (index.pendingScanRetries.has(file)) {
        if (Date.now() - start > 3000) {
          throw new Error(`待补重试未在 3s 内完成 (pending=${index.pendingScanRetries.size})`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(index.fileCache.has(file)).toBe(true);
      expect(index.byName.get('A')?.map(hit => hit.filePath)).toEqual([file]);
      expect(index.fileCache.get(file)?.parsed.classes[0]?.methods.has('m')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('读失败仍撤旧索引(文件被删/不可读时僵尸类不得留存)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-readfail-'));
    const file = path.join(root, 'B.py');
    fs.writeFileSync(file, 'class B:\n    pass\n');
    const originalRead = fs.promises.readFile;
    try {
      const index = new PythonClassIndex() as unknown as ClassIndexInternals;
      index.updateFile(file, fs.readFileSync(file, 'utf8'), 1);
      expect(index.byName.get('B')?.map(hit => hit.filePath)).toEqual([file]);

      fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
        if (String(args[0]) === file) {
          throw Object.assign(new Error('ENOENT: file not found'), { code: 'ENOENT' });
        }
        return originalRead(...args);
      }) as typeof fs.promises.readFile;
      await index.loadFile(file, 1);

      expect(index.fileCache.has(file), '读失败应撤下不可导航的旧索引').toBe(false);
      expect(index.byName.has('B'), '读失败应清空该类类集').toBe(false);
      expect(index.pendingScanRetries.has(file), '读失败(文件被删)不登记待补重试').toBe(false);
    } finally {
      fs.promises.readFile = originalRead;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
