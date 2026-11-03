// 任务 C-19:def↔Python 方法一致性检查 + 一键生成骨架。
// 验收口径:示例实体(def 有 3 方法/Python 缺 1)→ 恰好 1 条 warning
// (Rust 规则侧 lint_def_python_parity.rs 锁)+ code action 生成后 warning
// 消除(生成后重采集含该方法,集合差归零);已实现方法零误报。
// 本文件锁 TS 侧:骨架生成(签名按 def 类型映射)、pythonParity 采集、
// CodeAction 装配(目标取双向定位面)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  buildPythonMethodSkeletonWithTypes,
  collectDefPythonParityInput,
  entityNameOfDefFile,
  mapDefTypeToPythonAnnotation
} from '../src/defPythonParity';
import {
  DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
  KBEngineDefPythonParityCodeActionProvider
} from '../src/languageProviders';
import { DEF_METHOD_MISSING_DIAGNOSTIC_CODE } from '../src/defMethodConsistency';
import {
  CodeActionKind,
  makeTextDocument,
  Position,
  Range,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// ---------------------------------------------------------------------------
// 骨架生成(签名参数从 def 类型映射)
// ---------------------------------------------------------------------------

describe('def→python 类型注解映射(C-19)', () => {
  it('内建类型 → Python 注解', () => {
    expect(mapDefTypeToPythonAnnotation('UINT32')).toBe('int');
    expect(mapDefTypeToPythonAnnotation('INT64')).toBe('int');
    expect(mapDefTypeToPythonAnnotation('FLOAT')).toBe('float');
    expect(mapDefTypeToPythonAnnotation('STRING')).toBe('str');
    expect(mapDefTypeToPythonAnnotation('BOOL')).toBe('bool');
    expect(mapDefTypeToPythonAnnotation('VECTOR3')).toBe('Vector3');
  });

  it('未识别类型兜底 Any', () => {
    expect(mapDefTypeToPythonAnnotation('CustomType')).toBe('Any');
    expect(mapDefTypeToPythonAnnotation('')).toBe('Any');
  });
});

describe('方法骨架生成(签名按 def 类型)(C-19)', () => {
  it('多参数:argN 名 + 类型注解 + raise NotImplementedError 体', () => {
    expect(buildPythonMethodSkeletonWithTypes('reqPos', ['UINT32', 'VECTOR3'])).toBe(
      '    def reqPos(self, arg0: int, arg1: Vector3) -> None:\n' +
        '        raise NotImplementedError\n'
    );
  });

  it('无参:仅 (self)', () => {
    expect(buildPythonMethodSkeletonWithTypes('onTick', [])).toBe(
      '    def onTick(self) -> None:\n        raise NotImplementedError\n'
    );
  });

  it('pass 体形态(可配)', () => {
    expect(buildPythonMethodSkeletonWithTypes('onDeath', ['INT64'], 'pass')).toBe(
      '    def onDeath(self, arg0: int) -> None:\n        pass\n'
    );
  });

  it('未知类型参数 → Any 注解', () => {
    expect(buildPythonMethodSkeletonWithTypes('apply', ['UNKNOWN_TYPE'])).toBe(
      '    def apply(self, arg0: Any) -> None:\n        raise NotImplementedError\n'
    );
  });
});

// ---------------------------------------------------------------------------
// pythonParity 采集(标准布局 scripts/{base,cell,client}/<实体>.py)
// ---------------------------------------------------------------------------

const AVATAR_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <reqPos>',
  '      <Arg>UINT32</Arg>',
  '      <Arg>VECTOR3</Arg>',
  '    </reqPos>',
  '    <onDeath>',
  '      <Arg>INT64</Arg>',
  '    </onDeath>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

/** base/Avatar.py:已实现 reqPos,缺 onDeath(def 有 3 方法/Python 缺 1) */
const BASE_PY = [
  'class Avatar(kbe.KBEntity):',
  '    def reqPos(self, stamp, pos):',
  '        pass',
  ''
].join('\n');

interface Fixture {
  root: string;
  avatarDef: string;
  basePy: string;
}

const buildWorkspace = (basePyContent: string): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-c19-'));
  const put = (relative: string, content: string): string => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  };
  const avatarDef = put('a/scripts/entity_defs/Avatar.def', AVATAR_DEF);
  const basePy = put('a/scripts/base/Avatar.py', basePyContent);
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return { root, avatarDef, basePy };
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
});

describe('pythonParity 采集(C-19)', () => {
  it('标准布局:实体名 = def 文件名,各段已实现方法收齐', () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const input = collectDefPythonParityInput(ws.avatarDef);
    expect(input).not.toBeNull();
    expect(input!.pythonClass).toBe('Avatar');
    expect(entityNameOfDefFile(ws.avatarDef)).toBe('Avatar');
    // base 段:仅 reqPos(缺 onDeath → 由 Rust 规则集合差产 1 条)
    expect(input!.base).toEqual({
      pythonFile: ws.basePy,
      implementedMethods: ['reqPos']
    });
    // cell/client 段文件不存在 → 省略(该段不核验,零误报)
    expect(input!.cell).toBeUndefined();
    expect(input!.client).toBeUndefined();
  });

  it('非 scripts/entity_defs 布局 → null(Rust 规则零产出)', () => {
    const input = collectDefPythonParityInput('/tmp/random/Avatar.def');
    expect(input).toBeNull();
  });

  it('段文件内无同名类 → 该段省略', () => {
    const ws = buildWorkspace([
      'class Other(kbe.KBEntity):',
      '    def reqPos(self):',
      '        pass',
      ''
    ].join('\n'));
    roots.push(ws.root);
    const input = collectDefPythonParityInput(ws.avatarDef)!;
    expect(input.pythonClass).toBe('Avatar');
    expect(input.base).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CodeAction 装配(仅 def-method-missing-in-python 诊断,目标取双向定位面)
// ---------------------------------------------------------------------------

/** 手造诊断(code + range + relatedInformation),绕过替身 Diagnostic 缺域。 */
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

const editsByPath = (
  workspaceEdit: {
    entries(): Array<[{ fsPath: string }, Array<{ range: { start: Position }; newText: string }>]>;
  },
  filePath: string
): Array<{ range: { start: Position }; newText: string }> => {
  const byPath = new Map(
    workspaceEdit.entries().map(([uri, edits]) => [uri.fsPath, edits] as const)
  );
  return byPath.get(filePath) ?? [];
};

describe('def-method-missing-in-python 一键生成 CodeAction(C-19)', () => {
  it('缺实现方法:类型映射骨架插入类尾,目标文件取自双向定位面', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;

    const onDeathRange = nameRange(AVATAR_DEF, 'onDeath');
    const diagnostic = makeParityDiagnostic(onDeathRange, ws.basePy, 'Avatar');
    const actions = (await provider.provideCodeActions(
      document,
      onDeathRange,
      { diagnostics: [diagnostic] },
      undefined
    ))!;

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.title).toContain('Generate method onDeath');
    expect(action.title).toContain(ws.basePy);
    expect(action.title).toContain(':4');
    expect(action.kind).toBe(CodeActionKind.QuickFix);
    expect(action.diagnostics).toHaveLength(1);

    const edits = editsByPath(action.edit!, ws.basePy);
    expect(edits, '只碰目标 Python 文件').toHaveLength(1);
    expect(edits[0].range.start).toEqual(new Position(3, 0));
    // 签名按 def 类型映射:INT64 → arg0: int;体默认 raise NotImplementedError
    expect(edits[0].newText).toBe(
      '\n    def onDeath(self, arg0: int) -> None:\n        raise NotImplementedError\n'
    );
  });

  it('非匹配 code 不出;缺双向定位面不出', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
    const onDeathRange = nameRange(AVATAR_DEF, 'onDeath');

    // 非匹配 code(如 receiver-none)→ 不出
    const wrongCode = {
      code: 'kbengine.receiverNone',
      range: onDeathRange,
      relatedInformation: [{ location: { uri: Uri.file(ws.basePy) }, message: 'Avatar' }]
    };
    expect(await provider.provideCodeActions(
      document, onDeathRange, { diagnostics: [wrongCode] }, undefined
    )).toEqual([]);

    // 缺双向定位面 → 不出(不猜测目标文件)
    const noRelated = { code: DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, range: onDeathRange };
    expect(await provider.provideCodeActions(
      document, onDeathRange, { diagnostics: [noRelated] }, undefined
    )).toEqual([]);
  });

  // KODE-AUD-002:producer(defMethodConsistency DEF_METHOD_MISSING_DIAGNOSTIC_CODE)
  // 与 Consumer(Provider DEF_PYTHON_PARITY_DIAGNOSTIC_CODE)同值,producer 产的
  // 真实诊断 code 才被 CodeAction 严格比较命中——此前 producer 用
  // kbengine.defMethodMissingInPython 而 Consumer 用 def-method-missing-in-python,
  // 不匹配致 CodeAction 恒空。本用例喂 producer 的 code,断言 CodeAction 非空。
  it('三方 code 统一:producer 诊断 code 被 CodeAction 命中(不恒空)', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
    const onDeathRange = nameRange(AVATAR_DEF, 'onDeath');

    // 三方同值:TS producer code = Provider CodeAction code(单一事实源)。
    expect(DEF_METHOD_MISSING_DIAGNOSTIC_CODE).toBe(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE);
    expect(DEF_METHOD_MISSING_DIAGNOSTIC_CODE).toBe('def-method-missing-in-python');

    // 喂 producer 的 code(真实诊断经 extension.ts:1374 赋此 code)→ 命中。
    const producerDiagnostic = {
      code: DEF_METHOD_MISSING_DIAGNOSTIC_CODE,
      range: onDeathRange,
      relatedInformation: [{ location: { uri: Uri.file(ws.basePy) }, message: 'Avatar' }]
    };
    const actions = (await provider.provideCodeActions(
      document, onDeathRange, { diagnostics: [producerDiagnostic] }, undefined
    ))!;
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toContain('Generate method onDeath');
  });

  it('取消位 → 空', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;
    const onDeathRange = nameRange(AVATAR_DEF, 'onDeath');
    const diagnostic = makeParityDiagnostic(onDeathRange, ws.basePy, 'Avatar');
    expect(await provider.provideCodeActions(
      document, onDeathRange, { diagnostics: [diagnostic] },
      { isCancellationRequested: true } as never
    )).toEqual([]);
  });

  it('生成后一致性自动消除:落盘骨架 → 重采集含该方法', async () => {
    const ws = buildWorkspace(BASE_PY);
    roots.push(ws.root);
    const provider = new KBEngineDefPythonParityCodeActionProvider();
    const document = makeTextDocument(AVATAR_DEF, { fileName: ws.avatarDef }) as never;

    const onDeathRange = nameRange(AVATAR_DEF, 'onDeath');
    const diagnostic = makeParityDiagnostic(onDeathRange, ws.basePy, 'Avatar');
    const actions = (await provider.provideCodeActions(
      document, onDeathRange, { diagnostics: [diagnostic] }, undefined
    ))!;
    const edit = actions[0].edit!;
    // 应用编辑:把骨架写回磁盘(模拟保存)
    const targetEdits = editsByPath(edit, ws.basePy);
    const content = fs.readFileSync(ws.basePy, 'utf-8');
    const insertAt = targetEdits[0].range.start.line;
    const lines = content.split('\n');
    lines.splice(insertAt, 0, targetEdits[0].newText.replace(/^\n/, ''));
    fs.writeFileSync(ws.basePy, lines.join('\n'), 'utf-8');

    // 重采集:onDeath 已实现 → base.implementedMethods 含 onDeath
    // (Rust 集合差归零 → warning 消除,lint_def_python_parity.rs 锁)
    const reInput = collectDefPythonParityInput(ws.avatarDef)!;
    expect(reInput.base!.implementedMethods).toContain('onDeath');
  });
});
