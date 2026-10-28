import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findRegisteredTypeSuggestions,
  KBEngineTypeCodeActionProvider,
  UNKNOWN_TYPE_DIAGNOSTIC_CODE,
  validateDocument
} from '../src/languageProviders';
import {
  CodeActionKind,
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// IDE-NAV-013:未知类型诊断的修正候选(Code Action)。验收口径:仅提供已
// 注册类型(内建+types.xml 自定义+实体)的近似可核对替换(大小写归一后
// 编辑距离≤2,按距排序截 5),不自动创建 types.xml 声明;非未知类型诊断
// 不出候选;取消位空。诊断带稳定 code kbengine.unknownType 供 provider 对账。

const DEF_TEXT = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINIT16</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

let wsRoot = '';

const defDocument = (): MinimalTextDocument =>
  makeTextDocument(DEF_TEXT, {
    fileName: path.join(wsRoot, 'scripts', 'entity_defs', 'Avatar.def')
  });

/** 未知类型诊断(UINIT16 在 0 基行 3,列 12..19——与 validator 按值文本定界一致) */
const unknownTypeDiagnostic = (): Diagnostic => {
  const diagnostic = new Diagnostic(
    new Range(new Position(3, 12), new Position(3, 19)),
    `自定义类型 UINIT16 未在 types.xml 中注册，请先在 types.xml 注册后再引用`,
    DiagnosticSeverity.Error
  );
  diagnostic.code = UNKNOWN_TYPE_DIAGNOSTIC_CODE;
  return diagnostic;
};

beforeAll(() => {
  // test3 的 validateDocument 同链需要真实 workspace 根:无根/空 types.xml 时
  // resolveCustomTypeReference 判 unverifiable 不出诊断,故这里造真树。
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nav013-'));
  const write = (relative: string, content: string) => {
    const target = path.join(wsRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  write('scripts/entities.xml', [
    '<root>',
    '  <Avatar hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ].join('\n'));
  // customTypes 非空是 missingTypeRegistration 分支的前提(空集合走 unverifiable)
  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '</root>'
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(wsRoot, { recursive: true, force: true });
});

describe('未知类型诊断修正候选(IDE-NAV-013)', () => {
  it('纯函数:近似已注册类型可核对——近拼/大小写变体入选,无关名不入选,截 5', () => {
    const registered = ['UINT16', 'UINT32', 'VECTOR3', 'FIXED_DICT'];
    // 近拼:UINIT16 → UINT16(编辑距离 1);UINT32 距 3 出局
    expect(findRegisteredTypeSuggestions('UINIT16', registered)).toEqual(['UINT16']);
    // 大小写变体:uint16 归一后距 0 排最前;UINT32 恰距 2(1→3、6→2 两替换)
    // 属阈内合法入选
    expect(findRegisteredTypeSuggestions('uint16', registered)).toEqual(['UINT16', 'UINT32']);
    // 无近似:不猜
    expect(findRegisteredTypeSuggestions('ZZWOLF', registered)).toEqual([]);
    // 截 5:7 个同为距离 1 的候选只出前 5(按名稳定排序)
    const many = ['AB1', 'AB2', 'AB3', 'AB4', 'AB5', 'AB6', 'AB7'];
    expect(findRegisteredTypeSuggestions('AB', many)).toHaveLength(5);
    expect(findRegisteredTypeSuggestions('AB', many)).toEqual(['AB1', 'AB2', 'AB3', 'AB4', 'AB5']);
  });

  it('provider:仅出已注册替换编辑,不建声明;非未知诊断/取消位不出', () => {
    const provider = new KBEngineTypeCodeActionProvider();
    const document = defDocument();
    const diagnostic = unknownTypeDiagnostic();
    const actions = provider.provideCodeActions(
      document,
      diagnostic.range,
      { diagnostics: [diagnostic] },
      undefined
    )!;

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThanOrEqual(5);
    expect(actions[0].title).toContain('UINT16');
    expect(actions[0].kind).toBe(CodeActionKind.QuickFix);

    for (const action of actions) {
      // 不自动创建声明:每个候选都是本文档内的替换编辑,无 command,
      // 不触碰 types.xml(任何其它文件)
      expect(action.command, '不出命令型动作(不代建声明)').toBeUndefined();
      expect(action.edit).toBeDefined();
      const entries = action.edit!.entries();
      expect(entries.length).toBe(1);
      const [uri, edits] = entries[0];
      expect(uri.toString()).toBe(document.uri.toString());
      expect(edits).toHaveLength(1);
      expect(edits[0].range.start).toEqual(diagnostic.range.start);
      expect(edits[0].range.end).toEqual(diagnostic.range.end);
    }
    // 候选名一律来自已注册集合(可核对):UINT16 入选,未知名自身不入选
    const candidates = actions.map(action => action.edit!.entries()[0][1][0].newText as string);
    expect(candidates).toContain('UINT16');
    expect(candidates).not.toContain('UINIT16');

    // 非未知类型诊断(无 code)→ 不出候选
    const plainDiagnostic = new Diagnostic(
      diagnostic.range, '别的诊断', DiagnosticSeverity.Warning
    );
    expect(provider.provideCodeActions(
      document, diagnostic.range, { diagnostics: [plainDiagnostic] }, undefined
    )).toEqual([]);

    // 取消位 → 空
    expect(provider.provideCodeActions(
      document, diagnostic.range, { diagnostics: [diagnostic] },
      { isCancellationRequested: true } as never
    )).toEqual([]);
  });

  it('诊断面:未知类型诊断带稳定 code,provider 与 validateDocument 同链', () => {
    const document = defDocument();
    const collection = new DiagnosticCollection();
    const originalFolders = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    try {
      validateDocument(document as never, collection);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
    }
    const diagnostics = collection.get(document.uri);
    const unknown = diagnostics.find(d => d.code === UNKNOWN_TYPE_DIAGNOSTIC_CODE);
    expect(unknown, '未知类型诊断带稳定 code').toBeDefined();
    expect(unknown!.message).toContain('UINIT16');

    // 同链:validator 的诊断直接喂 provider 出候选
    const provider = new KBEngineTypeCodeActionProvider();
    const actions = provider.provideCodeActions(
      document, unknown!.range, { diagnostics }, undefined
    )!;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].title).toContain('UINT16');
  });
});
