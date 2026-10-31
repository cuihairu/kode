import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDocumentLines,
  getOrParseDocument,
  getOrParseDocumentSync,
  getStoredSnapshotCount,
  normalizeDocumentKey,
  peekDocumentSnapshot,
  releaseAllDocumentSnapshots,
  releaseDocument,
  releaseDocumentsUnderRoot,
  updateDocumentSnapshot
} from '../src/documentStore';
import { resetLanguageServiceMetrics, getOperationSummary } from '../src/languageServiceMetrics';
import {
  clearParsedDocumentCacheForTests,
  getParsedDocumentCacheStats,
  parseDefDocument
} from '../src/defParser';
import { makeTextDocument, Uri } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './fake-vscode/core';

// PR2 文档快照与解析缓存(评审 docs/review/2026-10-22 §3.1)测试锁定:
// ①URI 规范化;②版本号+文本+行索引;③内存优先(磁盘不得覆盖编辑缓冲区);
// ④同版本只解析一次 + 解析中再编辑旧结果不覆盖新版本;⑤关文档释放不泄漏。

const docOf = (
  text: string,
  options?: { fileName?: string; languageId?: string; version?: number }
) => {
  const document = makeTextDocument(text, {
    fileName: options?.fileName,
    languageId: options?.languageId
  }) as MinimalTextDocument & { version?: number };
  document.version = options?.version;
  return document;
};

/** 直接构造 uri 面(绕开 fake Uri.parse 对 file scheme 的拼写保留),测规范化本身 */
const uriOf = (spec: string, fsPath: string) => ({
  toString: () => spec,
  fsPath
});

/** 与 docOf 同文本同版本的裸文档(模拟「同一文件的另一个文档实例」) */
const twinOf = (document: MinimalTextDocument & { version?: number }) => ({
  uri: { toString: () => `file://${document.uri.fsPath}`, fsPath: document.uri.fsPath },
  version: document.version,
  getText: () => document.getText()
});

const tmpFile = (dir: string, name: string, content: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe('documentStore URI 规范化', () => {
  beforeEach(() => releaseAllDocumentSnapshots());
  afterEach(() => releaseAllDocumentSnapshots());

  it('同一 fsPath 的不同 URI 拼写归并到同一快照键', () => {
    const viaFile = normalizeDocumentKey(Uri.file('/a/B/c.def'));
    const viaSpec = normalizeDocumentKey(uriOf('file:///a/B/c.def', '/a/B/c.def'));
    expect(viaFile).toBe(viaSpec);
    expect(viaFile).toBe('/a/B/c.def');
  });

  it('冗余分隔符与 . 段归一,大小写不动(POSIX 语义)', () => {
    expect(normalizeDocumentKey(Uri.file('/a//b/./c.py'))).toBe('/a/b/c.py');
    expect(normalizeDocumentKey(Uri.file('/a/B/c.py'))).not.toBe(normalizeDocumentKey(Uri.file('/a/b/c.py')));
  });

  it('文件快照与语义索引使用相同路径身份', async () => {
    const { normalizeLookupPath } = await import('../src/definitionSemantics');
    for (const fsPath of ['/project/A/Hero.def', '/project/a/Hero.def', 'C:\\Work\\Hero.py', 'c:/WORK/./hero.py']) {
      expect(normalizeDocumentKey(uriOf('file:///source', fsPath))).toBe(normalizeLookupPath(fsPath));
    }
    expect(normalizeDocumentKey(uriOf('file:///a', '/project/A/Hero.def')))
      .not.toBe(normalizeDocumentKey(uriOf('file:///b', '/project/a/Hero.def')));
    expect(normalizeDocumentKey(uriOf('file:///a', 'C:\\Work\\Hero.py')))
      .toBe(normalizeDocumentKey(uriOf('file:///b', 'c:/work/hero.py')));
  });

  it('非 file scheme 按原样记账(schema 隔离)', () => {
    const virtual = normalizeDocumentKey(uriOf('kbengine-db-schema:/Hero.schema', '/Hero.schema'));
    expect(virtual).toBe('kbengine-db-schema:/Hero.schema');
  });

  it('不同拼写共享同一份快照(第二次 update 不新建条目)', () => {
    const document = docOf('a\nb\n', { fileName: '/x/A.def', version: 1 });
    updateDocumentSnapshot(document);
    expect(getStoredSnapshotCount()).toBe(1);
    const lines = getDocumentLines(twinOf(document));
    expect(lines).toEqual(['a', 'b', '']);
    expect(getStoredSnapshotCount()).toBe(1);
  });
});

describe('documentStore 版本/文本/行索引', () => {
  beforeEach(() => releaseAllDocumentSnapshots());
  afterEach(() => releaseAllDocumentSnapshots());

  it('行索引与 getText().split(/\\r?\\n/) 完全一致(含 \\r\\n)', () => {
    for (const text of ['a\nb\nc\n', 'a\r\nb\r\nc\r\n', 'a\nb', '', '\n\n']) {
      const document = docOf(text, { fileName: '/l/A.py', version: 3 });
      updateDocumentSnapshot(document);
      expect(getDocumentLines(document)).toEqual(text.split(/\r?\n/));
      releaseDocument(document);
    }
  });

  it('同版本重复取行不重建(数组引用稳定),版本前进后重建', () => {
    const document = docOf('x = 1\ny = 2\n', { fileName: '/l/B.py', version: 1 });
    updateDocumentSnapshot(document);
    const first = getDocumentLines(document);
    expect(getDocumentLines(document)).toBe(first);
    document.version = 2;
    // 版本前进但替身文本未变:重建后内容等价(替身 getText 不变)
    const second = getDocumentLines(document);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('快照暴露版本号/解析态/最近成功解析版本', async () => {
    const document = docOf('v', { fileName: '/l/C.py', version: 7 });
    await getOrParseDocument(document, () => 'parsed');
    const snapshot = peekDocumentSnapshot(document);
    expect(snapshot?.version).toBe(7);
    expect(snapshot?.parseState).toBe('parsed');
    expect(snapshot?.lastGoodParseVersion).toBe(7);
  });
});

describe('documentStore 内存优先规则', () => {
  let root = '';
  beforeEach(() => {
    releaseAllDocumentSnapshots();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-docstore-'));
  });
  afterEach(() => {
    releaseAllDocumentSnapshots();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('编辑缓冲区与磁盘内容不同时,快照以缓冲区为准', () => {
    const filePath = tmpFile(root, 'Avatar.py', 'class Avatar_Disk:\n    pass\n');
    const document = docOf('class Avatar_Editor:\n    pass\n', {
      fileName: filePath,
      languageId: 'python',
      version: 12
    });
    updateDocumentSnapshot(document);
    // 磁盘上仍是旧内容,快照文本必须是编辑缓冲区内容
    expect(peekDocumentSnapshot(document)?.text).toBe('class Avatar_Editor:\n    pass\n');
    expect(peekDocumentSnapshot(document)?.text).not.toBe(fs.readFileSync(filePath, 'utf8'));
    // 行索引同样来自缓冲区
    expect(getDocumentLines(document)[0]).toBe('class Avatar_Editor:');
  });

  it('磁盘文件随后被改写也不影响快照(构造上不读盘)', () => {
    const filePath = tmpFile(root, 'Mob.py', '# disk v1\n');
    const document = docOf('# editor v1\n', { fileName: filePath, version: 1 });
    updateDocumentSnapshot(document);
    fs.writeFileSync(filePath, '# disk v2 completely different\n');
    expect(getDocumentLines(document)).toEqual(['# editor v1', '']);
  });
});

describe('documentStore 同版本只解析一次', () => {
  beforeEach(() => {
    releaseAllDocumentSnapshots();
    resetLanguageServiceMetrics();
  });
  afterEach(() => {
    releaseAllDocumentSnapshots();
    resetLanguageServiceMetrics();
  });

  it('同版本多次 getOrParse 只调用一次 parse,其余命中缓存', async () => {
    const document = docOf('x', { fileName: '/p/A.def', version: 1 });
    let parseCalls = 0;
    const first = await getOrParseDocument(document, () => { parseCalls += 1; return { ok: 1 }; });
    const second = await getOrParseDocument(document, () => { parseCalls += 1; return { ok: 2 }; });
    expect(parseCalls).toBe(1);
    expect(second).toBe(first);
  });

  it('无版本替身每次现解析不缓存,xml 与其他扩展名的 fileKind 各归其类', async () => {
    const noVersion = docOf('x', { fileName: '/p/NoVer.py' });
    let parseCalls = 0;
    const first = await getOrParseDocument(noVersion, () => { parseCalls += 1; return 'a'; });
    const second = await getOrParseDocument(noVersion, () => { parseCalls += 1; return 'b'; });
    expect(parseCalls).toBe(2);
    expect(first).toBe('a');
    expect(second).toBe('b');

    const xmlDoc = docOf('<root/>', { fileName: '/p/extra.xml', version: 1 });
    await getOrParseDocument(xmlDoc, () => 'xml');
    const otherDoc = docOf('plain', { fileName: '/p/readme.txt', version: 1 });
    await getOrParseDocument(otherDoc, () => 'other');
    const entitiesDoc = docOf('<root/>', { fileName: '/p/entities.xml', version: 1 });
    await getOrParseDocument(entitiesDoc, () => 'entities');
    const typesDoc = docOf('<root/>', { fileName: '/p/types.xml', version: 1 });
    await getOrParseDocument(typesDoc, () => 'types');
  });

  it('版本前进后重新解析,新旧结果分开记账', async () => {
    const document = docOf('v1', { fileName: '/p/B.def', version: 1 });
    const results: string[] = [];
    results.push(await getOrParseDocument(document, text => `parsed:${text}`));
    document.version = 2;
    results.push(await getOrParseDocument(document, text => `parsed:${text}`));
    expect(results).toEqual(['parsed:v1', 'parsed:v1']); // 替身文本未变,但两次都真解析了
    const summary = getOperationSummary('document-parse');
    expect(summary?.cacheMisses).toBe(2);
    expect(summary?.cacheHits).toBe(0);
  });

  it('解析进行中的重复请求合并到同一 in-flight Promise(只解析一次)', async () => {
    const document = docOf('x', { fileName: '/p/C.def', version: 5 });
    let parseCalls = 0;
    let releaseParse!: () => void;
    const gate = new Promise<void>(resolve => { releaseParse = resolve; });
    const taskA = getOrParseDocument(document, async () => {
      parseCalls += 1;
      await gate;
      return 'slow-result';
    });
    const taskB = getOrParseDocument(document, async () => {
      parseCalls += 1;
      return 'fast-result';
    });
    releaseParse();
    expect(await taskA).toBe('slow-result');
    expect(await taskB).toBe('slow-result'); // B 合并进 A 的 in-flight
    expect(parseCalls).toBe(1);
    const summary = getOperationSummary('document-parse');
    expect(summary?.cacheHits).toBe(1); // B 记一次命中
    expect(summary?.cacheMisses).toBe(1); // A 记一次未命中
  });

  it('解析期间文档前进到新版本:旧结果不写入快照,新版本状态不被覆盖', async () => {
    const document = docOf('v1-text', { fileName: '/p/D.def', version: 1 });
    let releaseParse!: () => void;
    const gate = new Promise<void>(resolve => { releaseParse = resolve; });
    const slowV1 = getOrParseDocument(document, async () => {
      await gate;
      return 'STALE-V1';
    });
    // v1 解析还在进行中:用户继续编辑 → 版本 2
    document.version = 2;
    updateDocumentSnapshot(document);
    releaseParse();
    expect(await slowV1).toBe('STALE-V1'); // 调用方拿到返回值(语义与 await 一致)
    const snapshot = peekDocumentSnapshot(document);
    expect(snapshot?.lastGoodParseVersion).not.toBe(1); // 旧结果未记账
    expect(snapshot?.parseState).not.toBe('parsed');
    // v2 首次解析真跑(未被 v1 结果污染)
    const parsed = await getOrParseDocument(document, () => 'V2-FRESH');
    expect(parsed).toBe('V2-FRESH');
  });

  it('解析失败不入缓存:下一次调用重新解析(可恢复)', async () => {
    const document = docOf('x', { fileName: '/p/E.def', version: 1 });
    let attempts = 0;
    const first = getOrParseDocument(document, () => {
      attempts += 1;
      throw new Error('boom');
    });
    await expect(first).rejects.toThrow('boom');
    expect(peekDocumentSnapshot(document)?.parseState).toBe('idle');
    const second = await getOrParseDocument(document, () => {
      attempts += 1;
      return 'recovered';
    });
    expect(attempts).toBe(2);
    expect(second).toBe('recovered');
  });
});

describe('documentStore 同步解析缓存(诊断 def AST 面)', () => {
  beforeEach(() => {
    releaseAllDocumentSnapshots();
    resetLanguageServiceMetrics();
  });
  afterEach(() => {
    releaseAllDocumentSnapshots();
    resetLanguageServiceMetrics();
  });

  it('同版本命中缓存,版本前进重解析', () => {
    const document = docOf('<Entity/>', { fileName: '/p/F.def', version: 1 });
    let parseCalls = 0;
    const parse = () => ({ parseCalls: (parseCalls += 1) });
    const first = getOrParseDocumentSync(document, parse, 'test-ast');
    const second = getOrParseDocumentSync(document, parse, 'test-ast');
    expect(parseCalls).toBe(1);
    expect(second.result).toBe(first.result);
    expect(second.cacheHit).toBe(true);
    document.version = 2;
    const third = getOrParseDocumentSync(document, parse, 'test-ast');
    expect(parseCalls).toBe(2);
    expect(third.cacheHit).toBe(false);
  });

  it('不同命名空间互不串位', () => {
    const document = docOf('x', { fileName: '/p/G.def', version: 1 });
    const a = getOrParseDocumentSync(document, () => 'ast', 'ast-a');
    const b = getOrParseDocumentSync(document, () => 'other', 'ast-b');
    expect(a.result).toBe('ast');
    expect(b.result).toBe('other');
  });

  it('无版本替身每次现解析(与旧行为同价)', () => {
    const document = docOf('x', { fileName: '/p/H.def' });
    let parseCalls = 0;
    getOrParseDocumentSync(document, () => { parseCalls += 1; return 1; }, 'test');
    getOrParseDocumentSync(document, () => { parseCalls += 1; return 1; }, 'test');
    expect(parseCalls).toBe(2);
  });
});

describe('documentStore 快照释放', () => {
  beforeEach(() => {
    releaseAllDocumentSnapshots();
    clearParsedDocumentCacheForTests();
  });
  afterEach(() => releaseAllDocumentSnapshots());

  it('关文档释放:快照/行索引/解析缓存整体消失', async () => {
    const document = docOf('x\ny\n', { fileName: '/r/A.def', version: 1 });
    await getOrParseDocument(document, () => 'p');
    expect(getStoredSnapshotCount()).toBe(1);
    releaseDocument(document);
    expect(getStoredSnapshotCount()).toBe(0);
    expect(peekDocumentSnapshot(document)).toBeNull();
  });

  it('根移除释放该根下全部快照与解析缓存,其余根原样保留(IDE-RES-008)', async () => {
    const removed = docOf('removed source\n', { fileName: '/ws/gone/A.entities.xml', version: 1 });
    const nested = docOf('nested\n', { fileName: '/ws/gone/sub/B.py', version: 1 });
    const kept = docOf('kept source\n', { fileName: '/ws/kept/C.def', version: 2 });
    await getOrParseDocument(removed, () => 'entities-analysis');
    await getOrParseDocument(nested, () => 'py-ast');
    await getOrParseDocument(kept, () => 'def-ast');
    expect(getStoredSnapshotCount()).toBe(3);

    const released = releaseDocumentsUnderRoot('/ws/gone');
    expect(released).toBe(2);
    expect(getStoredSnapshotCount()).toBe(1);
    expect(peekDocumentSnapshot(removed)).toBeNull();
    expect(peekDocumentSnapshot(nested)).toBeNull();
    // 留存根不受影响(快照文本原样含结尾换行)
    expect(peekDocumentSnapshot(kept)?.text).toBe('kept source\n');

    // 前缀不误伤:移除 /ws 不该被 /wsX 拼写干扰,反之亦然
    const sibling = docOf('sibling\n', { fileName: '/ws/goneX/D.py', version: 1 });
    updateDocumentSnapshot(sibling);
    expect(releaseDocumentsUnderRoot('/ws/gone')).toBe(0);
    expect(peekDocumentSnapshot(sibling)).not.toBeNull();
    releaseDocument(sibling);
  });

  it('根移除同时释放 defParser 全局解析缓存中该根文本(R2-F12/IDE-AUD-048)', async () => {
    const text = '<root><Properties/></root>';
    // 先经 defParser 解析,填充全局内容键缓存
    parseDefDocument(text);
    expect(getParsedDocumentCacheStats().entries).toBe(1);
    const document = docOf(text, { fileName: '/ws/gone/A.def', version: 1 });
    updateDocumentSnapshot(document);
    expect(getStoredSnapshotCount()).toBe(1);

    const released = releaseDocumentsUnderRoot('/ws/gone');
    expect(released).toBe(1);
    // 旧码:releaseDocumentsUnderRoot 只清 documentStore,defParser 缓存仍持有
    // 该文本(R2-F12 实测释放文档 1 个,XML cache 仍 entries=1);
    // 新码:该根文档文本一并逐出,不以 8 条/8MiB 预算当释放。
    expect(getParsedDocumentCacheStats().entries).toBe(0);
  });

  it('同键不同拼写释放同一份快照', () => {
    const document = docOf('x', { fileName: '/r/B.def', version: 1 });
    updateDocumentSnapshot(document);
    releaseDocument(twinOf(document));
    expect(getStoredSnapshotCount()).toBe(0);
  });
});
