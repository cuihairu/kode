import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectMethodArgTypes,
  DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
  findMethodElementByName,
  KBEngineDefPythonParityCodeActionProvider,
  KBEngineFixedDictWholeReassignCodeActionProvider,
  parseDefAst
} from '../src/languageProviders';
import { FIXED_DICT_NESTED_MUTATION_CODE } from '../src/behaviorKnowledge';
import { makeTextDocument, Position, Range, Uri } from './helpers/vscodeStub';

// codeAction.ts 缺口臂(2026-11-09 覆盖率扫尾):
//   KBEngineDefPythonParityCodeActionProvider 的多条早退/去重/落空臂(非 def
//   文档、区间不相交、方法名为空、同目标去重、目标快照缺失、目标类缺失)、
//   collectMethodArgTypes/findMethodElementByName 的落空臂、fixed-dict provider
//   的取消位与行形态不匹配臂。
//
// 记录的死臂(不以真实 fs/公共 API 强测,附证据):
//   * line 149(KBEngineMethodImplementationCodeActionProvider `if (!ast) return []`):
//     不可达。parseDefAst 与 findDefSymbolInfo 共用 'def-ast' 版本化缓存;若
//     parseDefAst 返回 null(文档非 def / getOrParseDocumentSync 抛错),findDefSymbolInfo
//     (line 143)也返回 null → 已在 line 144 的 `if (!symbolInfo || ...)` 早退,
//     永远到不了 line 149。
//   * line 429(KBEngineReceiverNoneGuardCodeActionProvider `if (!wrap && !guard) continue`):
//     不可达。receiverFromDiagnosticLine(line 413)返回非 null ⟹ 诊断行文本匹配
//     `self.<receiver>.<method>` ⟹ 该行非空 ⟹ buildReceiverNoneGuardEdit(line 847)
//     恒返回非 null(仅空文本/越界/空行返回 null)→ `!wrap && !guard` 恒 false;
//     空文本/空行时 receiverFromDiagnosticLine 返回 null,已在 line 418 早退。

const DEF_TEXT = [
  '<root>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '    </reqPos>',
  '  </BaseMethods>',
  '</root>',
  ''
].join('\n');

/** 类体含 Avatar 的目标 Python(插入点非空) */
const AVATAR_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def existing(self):',
  '        return 1',
  ''
].join('\n');

const cursorOnWord = (text: string, word: string): Position => {
  const offset = text.indexOf(word);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
};

const nameRange = (text: string, word: string): Range => {
  const start = cursorOnWord(text, word);
  return new Range(start, new Position(start.line, start.character + word.length));
};

/** 手造 parity 诊断(code + range + 双向定位面),绕过替身 Diagnostic 缺域 */
const makeParityDiagnostic = (
  range: Range,
  targetFile: string,
  className: string
): {
  code: string;
  range: Range;
  relatedInformation: Array<{ location: { uri: Uri }; message: string }>;
} => ({
  code: DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
  range,
  relatedInformation: [{ location: { uri: Uri.file(targetFile) }, message: className }]
});

const roots: string[] = [];

const buildTargetPy = (content: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ca-gap-'));
  roots.push(root);
  const file = path.join(root, 'Avatar.py');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
};

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('codeAction 缺口臂:parity provider 早退与去重', () => {
  it('非 def 文档(非 kbengine-def 且非 .def)→ 如实空', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const pyDoc = makeTextDocument('x = 1\n', { fileName: '/tmp/a/Hero.py', languageId: 'python' });
    const range = new Range(new Position(0, 0), new Position(0, 4));
    expect(await provider.provideCodeActions(
      pyDoc as never, range, { diagnostics: [] }, undefined
    )).toEqual([]);
  });

  it('诊断区间与请求区间不相交 → 跳过(不猜)', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    const onTickRange = nameRange(DEF_TEXT, 'onTick');
    // 请求区间在别处(行 5 reqPos),诊断在 onTick → 不相交 → 跳过
    const requestRange = nameRange(DEF_TEXT, 'reqPos');
    const diagnostic = makeParityDiagnostic(onTickRange, '/tmp/a/Avatar.py', 'Avatar');
    expect(await provider.provideCodeActions(
      document, requestRange, { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
  });

  it('方法名空(诊断落在空白文本)→ 跳过', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    // 行 1 为空白行,诊断覆盖其 0..1 字符 → getText 为空白 → trim 空
    const content = ['<root>', '', '  <CellMethods>', '    <onTick/>', '  </CellMethods>', '</root>', ''].join('\n');
    const document = makeTextDocument(content, { fileName: '/tmp/a/Avatar.def' }) as never;
    const blankRange = new Range(new Position(1, 0), new Position(1, 1));
    const diagnostic = makeParityDiagnostic(blankRange, '/tmp/a/Avatar.py', 'Avatar');
    expect(await provider.provideCodeActions(
      document, blankRange, { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
  });

  it('同目标同方法名去重:两枚同键诊断只出一条动作', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    const targetFile = buildTargetPy(AVATAR_PY);
    const onTickRange = nameRange(DEF_TEXT, 'onTick');
    const diagnostic = makeParityDiagnostic(onTickRange, targetFile, 'Avatar');
    const actions = (await provider.provideCodeActions(
      document, onTickRange, { diagnostics: [diagnostic, diagnostic] }, undefined
    ))!;
    // 第一条产出,第二条被同键去重跳过(seen.has → continue)
    expect(actions).toHaveLength(1);
  });

  it('目标文件快照缺失(磁盘无该文件)→ 跳过(不猜)', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    const onTickRange = nameRange(DEF_TEXT, 'onTick');
    const missing = path.join(os.tmpdir(), 'kode-ca-gap-no-such', 'Never.py');
    const diagnostic = makeParityDiagnostic(onTickRange, missing, 'Avatar');
    expect(await provider.provideCodeActions(
      document, onTickRange, { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
  });

  it('目标类在文件中不存在 → 插入点算不出,跳过', async () => {
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    // 文件在(快照非空)但类名为 Other,无 Avatar 类 → 插入点 null → 跳过
    const targetFile = buildTargetPy([
      'class Other(kbe.KBEntity):',
      '    def existing(self):',
      '        return 1',
      ''
    ].join('\n'));
    const onTickRange = nameRange(DEF_TEXT, 'onTick');
    const diagnostic = makeParityDiagnostic(onTickRange, targetFile, 'Avatar');
    expect(await provider.provideCodeActions(
      document, onTickRange, { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
  });
});

describe('codeAction 缺口臂:collectMethodArgTypes / findMethodElementByName 落空', () => {
  it('collectMethodArgTypes:非 def 文档 → ast 解析为 null → 空数组', () => {
    const pyDoc = makeTextDocument('x = 1\n', { fileName: '/tmp/a/Hero.py', languageId: 'python' });
    expect(collectMethodArgTypes(pyDoc as never, 'reqPos')).toEqual([]);
  });

  it('collectMethodArgTypes:def 文档中方法名不存在(属性段/缺失)→ 空数组', () => {
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    expect(collectMethodArgTypes(document, 'noSuchMethod')).toEqual([]);
  });

  it('findMethodElementByName:全树无同名方法元素 → null(DFS 落空)', () => {
    const document = makeTextDocument(DEF_TEXT, { fileName: '/tmp/a/Avatar.def' }) as never;
    const ast = parseDefAst(document)!;
    expect(ast).not.toBeNull();
    expect(findMethodElementByName(ast.root, 'noSuchMethod')).toBeNull();
  });
});

describe('codeAction 缺口臂:fixed-dict provider 取消位与行形态不匹配', () => {
  it('取消位 → 空', async () => {
    const provider = new KBEngineFixedDictWholeReassignCodeActionProvider();
    const doc = makeTextDocument('self.cfg["a"] = 1\n', { fileName: '/tmp/a/Hero.py', languageId: 'python' });
    const range = new Range(new Position(0, 0), new Position(0, 16));
    const diagnostic = { code: FIXED_DICT_NESTED_MUTATION_CODE, range };
    expect(await provider.provideCodeActions(
      doc as never, range, { diagnostics: [diagnostic] },
      { isCancellationRequested: true } as never
    )).toEqual([]);
  });

  it('诊断行形态不匹配(无下标赋值)→ 编辑产出 null → 跳过', async () => {
    const provider = new KBEngineFixedDictWholeReassignCodeActionProvider();
    // 行形态 `self.hp = 5` 无 `[...]` 下标组 → buildFixedDictWholeReassignEdit null
    const doc = makeTextDocument('self.hp = 5\n', { fileName: '/tmp/a/Hero.py', languageId: 'python' });
    const range = new Range(new Position(0, 0), new Position(0, 10));
    const diagnostic = { code: FIXED_DICT_NESTED_MUTATION_CODE, range };
    expect(await provider.provideCodeActions(
      doc as never, range, { diagnostics: [diagnostic] }, undefined
    )).toEqual([]);
  });
});
