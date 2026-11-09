import { describe, expect, it } from 'vitest';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  enclosingPythonClassAt,
  KBEngineReferencesProvider,
  KBEngineWorkspaceSymbolProvider
} from '../src/languageProviders';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// references.ts 缺口臂(2026-11-09 覆盖率扫尾):py 侧 self 属性引用收录的
// 多段访问早退、类探针抛错回落、文件级探针抛错、双双落空如实 null、收录后
// 取消位;enclosingPythonClassAt 成功臂;工作区符号搜索中取消。
//
// 记录的死臂(不以真实 fs/公共 API 强测,附证据):
//   * line 111(`if (!METHOD_SECTIONS.has(symbolInfo.section)) return null`):
//     不可达。findDefSymbolInfo 经 getSymbolNodeInfo 只返回 DEF_SYMBOL_SECTIONS
//     = {Properties} ∪ METHOD_SECTIONS(shared.ts:85-90)内的段;非 Properties 且
//     非方法段不可能出现,Properties 已在 line 94 处理。
//   * line 115(方法段 `if (!ast) return null`):
//     不可达。parseDefAst 与 findDefSymbolInfo 共用 'def-ast' 版本化缓存;若
//     parseDefAst 返回 null,findDefSymbolInfo(line 74)也返回 null → 已交
//     provideDefSymbolReferences(line 79),永远到不了 line 115。
//   * line 256(enclosingPythonClassAt catch `return undefined`):
//     不可达。parsePythonFile(pythonParser.ts:109)全文无 throw 语句,永不抛错,
//     catch 块无触发路径。
//   * line 372(KBEngineImplementationProvider `if (!ast) return null`):
//     不可达。同 line 115:parseDefAst null ⟹ findDefSymbolInfo null ⟹ 已在
//     line 367 的 `if (!symbolInfo || !METHOD_SECTIONS.has(...))` 早退。

const cancelableToken = () => {
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

const fakeManager = (overrides: Record<string, unknown>): EntityMappingManager =>
  overrides as unknown as EntityMappingManager;

/** 单段 self 属性访问的 py 文档(类内),返回 {doc, line, hpStart} */
const classedPyDoc = (): { doc: ReturnType<typeof makeTextDocument>; line: number; hpStart: number } => {
  const text = 'class Hero:\n    def run(self):\n        self.hp = 1\n';
  const line = 2;
  const hpStart = text.split('\n')[line].indexOf('hp');
  expect(hpStart).toBeGreaterThanOrEqual(0);
  return { doc: makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' }), line, hpStart };
};

describe('references 缺口臂:py 侧 self 属性引用收录', () => {
  it('多段 self 访问(self.pos.x)→ 交回方法/接收者面,如实 null', async () => {
    const provider = new KBEngineReferencesProvider(fakeManager({}));
    const text = 'class Hero:\n    def run(self):\n        self.pos.x = 1\n';
    const line = 2;
    const xStart = text.split('\n')[line].indexOf('.x') + 2;
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    expect(await provider.provideReferences(
      doc as never, new Position(line, xStart), { includeDeclaration: false }, undefined
    )).toBeNull();
  });

  it('类探针抛错 → 回落文件级探针;文件级也抛错 → 如实 null', async () => {
    const manager = fakeManager({
      resolvePropertyDefinitionForClass: async () => { throw new Error('class probe boom'); },
      resolvePropertyDefinition: async () => { throw new Error('file probe boom'); }
    });
    const provider = new KBEngineReferencesProvider(manager);
    const { doc, line, hpStart } = classedPyDoc();
    expect(await provider.provideReferences(
      doc as never, new Position(line, hpStart), { includeDeclaration: false }, undefined
    )).toBeNull();
  });

  it('类探针落空且文件级探针落空 → 如实 null', async () => {
    // 无类文档:enclosingPythonClassAt undefined → 探针跳过,文件级探针返回 null
    const manager = fakeManager({ resolvePropertyDefinition: async () => null });
    const provider = new KBEngineReferencesProvider(manager);
    const text = 'self.hp = 1\n';
    const hpStart = text.indexOf('hp');
    const doc = makeTextDocument(text, { fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python' });
    expect(await provider.provideReferences(
      doc as never, new Position(0, hpStart), { includeDeclaration: false }, undefined
    )).toBeNull();
  });

  it('收录后取消位 → 如实 null(收录面取消不发布)', async () => {
    const { token, cancel } = cancelableToken();
    const manager = fakeManager({
      resolvePropertyDefinitionForClass: async () => ({ defFile: '/tmp/x.py', line: 5 }),
      getIncomingPythonPropertyAccesses: async () => {
        cancel();
        return [];
      }
    });
    const provider = new KBEngineReferencesProvider(manager);
    const { doc, line, hpStart } = classedPyDoc();
    expect(await provider.provideReferences(
      doc as never, new Position(line, hpStart), { includeDeclaration: false }, token
    )).toBeNull();
  });
});

describe('references 缺口臂:enclosingPythonClassAt 成功臂与工作区符号取消', () => {
  it('enclosingPythonClassAt:类内行 → 类名;类外行 → undefined', () => {
    const doc = makeTextDocument('class Hero:\n    def run(self):\n        pass\n', {
      fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python'
    });
    expect(enclosingPythonClassAt(doc as never, 1)).toBe('Hero');
    // 嵌套类:line 2 同时被 Outer 与 Inner 包含 → sort 比较器运行,取最内层
    const nested = makeTextDocument('class Outer:\n    class Inner:\n        def run(self):\n            pass\n', {
      fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python'
    });
    expect(enclosingPythonClassAt(nested as never, 2)).toBe('Inner');
    // 类外行(超出类跨度)→ 无归属,如实 undefined
    const outside = makeTextDocument('class Hero:\n    def run(self):\n        pass\nx = 1\n', {
      fileName: '/tmp/project/scripts/cell/Hero.py', languageId: 'python'
    });
    expect(enclosingPythonClassAt(outside as never, 3)).toBeUndefined();
  });

  it('工作区符号:搜索中取消 → 如实 null', async () => {
    const manager = fakeManager({
      searchDefSymbolsByPrefix: (_query: string, token: { isCancellationRequested: boolean }) => {
        token.isCancellationRequested = true;
        return [];
      }
    });
    const provider = new KBEngineWorkspaceSymbolProvider(manager);
    const token = { isCancellationRequested: false };
    expect(await provider.provideWorkspaceSymbols('reqPos', token as never)).toBeNull();
  });
});
