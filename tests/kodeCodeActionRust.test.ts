// RUST-143 批 3 接线(kode-server textDocument/codeAction 四族装配)
// TS 侧钉子:①桥契约——serveCodeActionsFromRust 的族×文档类门(def 族只在
// .def、py 族只在 .py、未知族拒绝)、载荷(params 含 registered/snapshotText
// 两个 TS 装配入参 + diagnostics 投影)、回包整面校验;②provider 切流——
// 四个 provider 消费 ActionFace(title 按族选模板按位插值 titleParams、
// EditFace 三态直投影 WorkspaceEdit、diagnosticStartLine 配对诊断),Rust
// 面不可用时回 TS 既有实现(无门/serve 抛错皆回退,不部分采用)。
// 四族装配决策面形状由 crates/kode-server/tests/code_action_dispatch.rs
// LSP 级门禁钉真值。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Diagnostic,
  DiagnosticSeverity,
  makeTextDocument,
  Position,
  Range,
  Uri
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';
import {
  DEF_PYTHON_PARITY_DIAGNOSTIC_CODE,
  KBEngineDefPythonParityCodeActionProvider,
  KBEngineFixedDictWholeReassignCodeActionProvider,
  KBEngineReceiverNoneGuardCodeActionProvider,
  KBEngineTypeCodeActionProvider,
  RECEIVER_NONE_DIAGNOSTIC_CODE,
  UNKNOWN_TYPE_DIAGNOSTIC_CODE
} from '../src/languageProviders';
import { FIXED_DICT_NESTED_MUTATION_CODE } from '../src/backend/behaviorKnowledge';
import {
  serveCodeActionsFromRust,
  setKodeCoreShadowGate,
  type CodeActionFace
} from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

/** 桩 CodeAction 形状(esbuild 不吃深嵌内联泛型,提出别名) */
interface StubTextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

interface StubCodeAction {
  title: string;
  diagnostics?: unknown[];
  edit?: { entries(): Array<[Uri, StubTextEdit[]]> };
}

/** 桩 gate:serveInRust 按 scripted 回包;记录调用面供载荷断言。 */
const makeServingGate = (
  scripted: unknown,
  options?: { serving?: boolean; serveError?: boolean }
): { gate: KodeCoreGate; served: Array<{ method: string; params: Record<string, unknown> }> } => {
  const served: Array<{ method: string; params: Record<string, unknown> }> = [];
  const gate = {
    serveFromRust: () => options?.serving ?? true,
    mirrorDocument: async () => undefined,
    serveInRust: async (method: string, params: unknown) => {
      served.push({ method, params: params as Record<string, unknown> });
      if (options?.serveError) {
        throw new Error('rust serve failed');
      }
      return scripted;
    }
  } as unknown as KodeCoreGate;
  return { gate, served };
};

const DEF_DOC_PATH = '/tmp/ws/scripts/entity_defs/Hero.def';
const PY_DOC_PATH = '/tmp/ws/scripts/cell/Mob.py';

const DEF_TEXT = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINIT16 </Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const PY_TEXT = [
  'class Mob:',
  '    def onEnter(self, entity):',
  '        self.cell.ready()',
  ''
].join('\n');

const defDocument = (): MinimalTextDocument =>
  makeTextDocument(DEF_TEXT, { fileName: DEF_DOC_PATH, languageId: 'kbengine-def', version: 1 });

const pyDocument = (): MinimalTextDocument =>
  makeTextDocument(PY_TEXT, { fileName: PY_DOC_PATH, languageId: 'python', version: 1 });

const TYPE_FACE: CodeActionFace = {
  kind: 'QuickFix',
  title: 'Replace with registered type UINT16',
  edit: {
    type: 'replaceRange',
    file: DEF_DOC_PATH,
    range: { startLine: 3, startChar: 13, endLine: 3, endChar: 20 },
    newText: 'UINT16'
  },
  diagnosticStartLine: 3,
  titleParams: ['UINT16']
};

const PARITY_FACE: CodeActionFace = {
  kind: 'QuickFix',
  title: 'Generate method onTalk → /tmp/ws/scripts/avatar.py:9',
  edit: {
    type: 'insertLine',
    file: '/tmp/ws/scripts/avatar.py',
    line: 3,
    text: '\n    def onTalk(self, arg0: int) -> None:\n        raise NotImplementedError\n'
  },
  diagnosticStartLine: 2,
  titleParams: ['onTalk', '/tmp/ws/scripts/avatar.py', '9']
};

const RECEIVER_FACES: CodeActionFace[] = [
  {
    kind: 'QuickFix',
    title: 'Wrap with null guard (if self.cell:)',
    edit: {
      type: 'replaceLines',
      file: PY_DOC_PATH,
      startLine: 2,
      endLine: 3,
      text: '        if self.cell:\n            self.cell.ready()\n'
    },
    diagnosticStartLine: 2,
    titleParams: ['cell']
  },
  {
    kind: 'QuickFix',
    title: 'Insert None guard (if not self.cell: return)',
    edit: {
      type: 'insertLine',
      file: PY_DOC_PATH,
      line: 2,
      text: '        if not self.cell:\n            return\n'
    },
    diagnosticStartLine: 2,
    titleParams: ['cell']
  }
];

const FIXED_DICT_FACE: CodeActionFace = {
  kind: 'QuickFix',
  title: 'Whole reassign: rewrite FIXED_DICT sub-key assignment as top-level assignment',
  edit: {
    type: 'replaceLines',
    file: PY_DOC_PATH,
    startLine: 2,
    endLine: 3,
    text: '        _fd = self.contents\n        _fd["slot"] = 1\n        self.contents = _fd\n'
  },
  diagnosticStartLine: 2,
  titleParams: []
};

const diagnosticAt = (
  code: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  related?: { file: string; message: string }
): unknown => {
  const base = {
    code,
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    },
    severity: 0,
    message: 'stub',
    ...(related
      ? { relatedInformation: [{ location: { uri: Uri.file(related.file) }, message: related.message }] }
      : {})
  };
  return base;
};

describe('serveCodeActionsFromRust 桥契约', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:def 族先镜像再请求,载荷带 registered/snapshotText/诊断投影', async () => {
    const doc = defDocument();
    const { gate, served } = makeServingGate([TYPE_FACE]);
    setKodeCoreShadowGate(gate);
    const result = await serveCodeActionsFromRust(doc, {
      family: 'typeReplacement',
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
      diagnostics: [
        {
          code: UNKNOWN_TYPE_DIAGNOSTIC_CODE,
          range: {
            start: { line: 3, character: 13 },
            end: { line: 3, character: 20 }
          },
          relatedFile: '/tmp/ws/scripts/entity_defs/Base.def',
          relatedMessage: 'Hero'
        }
      ],
      registered: ['UINT16', 'UINT32'],
      snapshotText: null
    });
    expect(result).toEqual([TYPE_FACE]);
    expect(served).toHaveLength(1);
    expect(served[0].method).toBe('textDocument/codeAction');
    expect(served[0].params).toEqual({
      textDocument: { uri: DEF_DOC_PATH },
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
      family: 'typeReplacement',
      registered: ['UINT16', 'UINT32'],
      snapshotText: null,
      diagnostics: [
        {
          code: UNKNOWN_TYPE_DIAGNOSTIC_CODE,
          range: {
            start: { line: 3, character: 13 },
            end: { line: 3, character: 20 }
          },
          relatedFile: '/tmp/ws/scripts/entity_defs/Base.def',
          relatedMessage: 'Hero'
        }
      ]
    });
  });

  it('ok:py 族(receiverNone)只在 .py 文档放行', async () => {
    const doc = pyDocument();
    const { gate, served } = makeServingGate(RECEIVER_FACES);
    setKodeCoreShadowGate(gate);
    const result = await serveCodeActionsFromRust(doc, {
      family: 'receiverNone',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } },
      diagnostics: [diagnosticAt(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 23)],
      registered: [],
      snapshotText: null
    });
    expect(result).toEqual(RECEIVER_FACES);
    expect(served[0].params).toMatchObject({ family: 'receiverNone' });
  });

  it('族×文档类不匹配/未知族/无门/门关 → null 且零请求', async () => {
    const defDoc = defDocument();
    const pyDoc = pyDocument();
    const input = {
      family: 'typeReplacement',
      range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
      diagnostics: [],
      registered: [],
      snapshotText: null
    };
    setKodeCoreShadowGate(null);
    expect(await serveCodeActionsFromRust(defDoc, input)).toBeNull();
    const { gate, served } = makeServingGate([TYPE_FACE]);
    setKodeCoreShadowGate(gate);
    // def 族落在 python 文档
    expect(
      await serveCodeActionsFromRust(pyDoc, input)
    ).toBeNull();
    // py 族落在 def 文档
    expect(
      await serveCodeActionsFromRust(defDoc, { ...input, family: 'fixedDict' })
    ).toBeNull();
    // 未知族(诚实拒绝,不静默空数组)
    expect(
      await serveCodeActionsFromRust(defDoc, { ...input, family: 'magicFamily' })
    ).toBeNull();
    // 门关
    const off = makeServingGate([TYPE_FACE], { serving: false });
    setKodeCoreShadowGate(off.gate);
    expect(await serveCodeActionsFromRust(defDoc, input)).toBeNull();
    expect(served).toEqual([]);
    expect(off.served).toEqual([]);
  });

  it('取消位先判 → 零请求', async () => {
    const doc = defDocument();
    const { gate, served } = makeServingGate([TYPE_FACE]);
    setKodeCoreShadowGate(gate);
    const result = await serveCodeActionsFromRust(
      doc,
      {
        family: 'typeReplacement',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
        diagnostics: [],
        registered: [],
        snapshotText: null
      },
      () => true
    );
    expect(result).toBeNull();
    expect(served).toEqual([]);
  });

  it('serve 抛错 → null(调用方回 TS 既有实现)', async () => {
    const doc = defDocument();
    setKodeCoreShadowGate(makeServingGate([TYPE_FACE], { serveError: true }).gate);
    expect(
      await serveCodeActionsFromRust(doc, {
        family: 'typeReplacement',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
        diagnostics: [],
        registered: [],
        snapshotText: null
      })
    ).toBeNull();
  });

  it('应答畸形(缺 kind/缺 title/edit 三态缺键/titleParams 非串/非数组)→ 整面作废', async () => {
    const doc = defDocument();
    // 线上面是数组:非数组成员(单对象/字符串/包壳)与非数组应答各有臂,
    // 数组里夹一条坏 face 也整面作废(不部分采用)。
    const badCases: unknown[] = [
      [{ title: 't', edit: TYPE_FACE.edit, diagnosticStartLine: 3, titleParams: [] }],
      [{ kind: 'QuickFix', edit: TYPE_FACE.edit, diagnosticStartLine: 3, titleParams: [] }],
      [{ kind: 'QuickFix', title: 't', diagnosticStartLine: 3, titleParams: [] }],
      [
        {
          kind: 'QuickFix',
          title: 't',
          edit: { type: 'replaceRange', file: DEF_DOC_PATH, range: { startLine: 1 }, newText: 'x' },
          diagnosticStartLine: 3,
          titleParams: []
        }
      ],
      [
        {
          kind: 'QuickFix',
          title: 't',
          edit: { type: 'insertLine', file: DEF_DOC_PATH, line: '3', text: 'x' },
          diagnosticStartLine: 3,
          titleParams: []
        }
      ],
      [{ ...TYPE_FACE, diagnosticStartLine: '3' }],
      [{ ...TYPE_FACE, titleParams: [42] }],
      { codeAction: TYPE_FACE },
      'nope'
    ];
    for (const bad of badCases) {
      setKodeCoreShadowGate(makeServingGate(bad).gate);
      expect(
        await serveCodeActionsFromRust(doc, {
          family: 'typeReplacement',
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } },
          diagnostics: [],
          registered: [],
          snapshotText: null
        })
      ).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });
});

describe('codeAction provider 切流', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('typeReplacement:Rust face → l10n 标题插值 + 定点替换编辑 + 配对诊断', async () => {
    const provider = new KBEngineTypeCodeActionProvider();
    const doc = defDocument();
    const diagnostic = diagnosticAt(UNKNOWN_TYPE_DIAGNOSTIC_CODE, 3, 13, 3, 20) as never;
    setKodeCoreShadowGate(makeServingGate([TYPE_FACE]).gate);
    const actions = await provider.provideCodeActions(
      doc as never,
      // 整行请求区间(覆盖诊断)
      { start: { line: 3, character: 0 }, end: { line: 3, character: 40 } } as never,
      { diagnostics: [diagnostic] } as never,
      undefined
    );
    expect(actions).toHaveLength(1);
    const action = actions[0] as unknown as StubCodeAction;
    expect(action.title).toBe('Replace with registered type UINT16');
    expect(action.diagnostics).toEqual([diagnostic]);
    const [uri, edits] = action.edit.entries()[0];
    expect(uri.fsPath).toBe(DEF_DOC_PATH);
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start).toEqual({ line: 3, character: 13 });
    expect(edits[0].range.end).toEqual({ line: 3, character: 20 });
    expect(edits[0].newText).toBe('UINT16');
  });

  it('parityMethod:Rust face → 跨文件插行编辑,快照入参=真盘内容', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ca-rust-'));
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
    const targetFile = path.join(tempDir, 'scripts', 'avatar.py');
    const snapshotText = '\nimport KBEngine\n\nclass Avatar:\n    pass\n';
    fs.writeFileSync(targetFile, snapshotText, 'utf8');
    try {
      const provider = new KBEngineDefPythonParityCodeActionProvider();
      const doc = makeTextDocument(
        '<root>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n    </onTalk>\n  </BaseMethods>\n</root>\n',
        { fileName: DEF_DOC_PATH, languageId: 'kbengine-def', version: 1 }
      );
      const diagnostic = diagnosticAt(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 2, 4, 2, 10, {
        file: targetFile,
        message: 'Avatar'
      }) as never;
      const { gate, served } = makeServingGate([{ ...PARITY_FACE, edit: { ...PARITY_FACE.edit, file: targetFile }, titleParams: ['onTalk', targetFile, '9'], title: `Generate method onTalk → ${targetFile}:9` }]);
      setKodeCoreShadowGate(gate);
      const actions = (await provider.provideCodeActions(
        doc as never,
        { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } } as never,
        { diagnostics: [diagnostic] } as never,
        undefined
      )) as unknown as StubCodeAction[];
      expect(actions).toHaveLength(1);
      expect(actions[0].title).toBe(`Generate method onTalk → ${targetFile}:9`);
      const [uri, edits] = actions[0].edit.entries()[0];
      expect(uri.fsPath).toBe(targetFile);
      expect(edits[0].range.start).toEqual({ line: 3, character: 0 });
      expect(edits[0].newText).toBe(PARITY_FACE.edit.type === 'insertLine' ? PARITY_FACE.edit.text : '');
      expect(served).toHaveLength(1);
      expect(served[0].params).toMatchObject({ family: 'parityMethod', snapshotText });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('receiverNone:Rust wrap+guard 双面 → 同诊断配对钳位复用,编辑序不翻', async () => {
    const provider = new KBEngineReceiverNoneGuardCodeActionProvider();
    const doc = pyDocument();
    const diagnostic = diagnosticAt(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 23) as never;
    setKodeCoreShadowGate(makeServingGate(RECEIVER_FACES).gate);
    const actions = (await provider.provideCodeActions(
      doc as never,
      { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } } as never,
      { diagnostics: [diagnostic] } as never,
      undefined
    )) as unknown as StubCodeAction[];
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toBe('Wrap with null guard (if self.cell:)');
    expect(actions[1].title).toBe('Insert None guard (if not self.cell: return)');
    // 两面同一诊断(同行钳位复用,不落空)
    expect(actions[0].diagnostics).toEqual([diagnostic]);
    expect(actions[1].diagnostics).toEqual([diagnostic]);
    const [, wrapEdits] = actions[0].edit.entries()[0];
    expect(wrapEdits[0].range.start).toEqual({ line: 2, character: 0 });
    expect(wrapEdits[0].range.end).toEqual({ line: 3, character: 0 });
    expect(wrapEdits[0].newText).toContain('if self.cell:');
    const [, guardEdits] = actions[1].edit.entries()[0];
    expect(guardEdits[0].range.start).toEqual({ line: 2, character: 0 });
    expect(guardEdits[0].range.end).toEqual({ line: 2, character: 0 });
    expect(guardEdits[0].newText).toContain('if not self.cell:');
  });

  it('fixedDict:Rust face → 整行段替换 + 固定标题(空 titleParams)', async () => {
    const provider = new KBEngineFixedDictWholeReassignCodeActionProvider();
    const doc = makeTextDocument(
      'class Box:\n    def onUse(self):\n        self.contents["slot"] = 1\n',
      { fileName: PY_DOC_PATH, languageId: 'python', version: 1 }
    );
    const diagnostic = diagnosticAt(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 34) as never;
    setKodeCoreShadowGate(makeServingGate([FIXED_DICT_FACE]).gate);
    const actions = (await provider.provideCodeActions(
      doc as never,
      { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } } as never,
      { diagnostics: [diagnostic] } as never,
      undefined
    )) as unknown as StubCodeAction[];
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe(
      'Whole reassign: rewrite FIXED_DICT sub-key assignment as top-level assignment'
    );
    const [, edits] = actions[0].edit.entries()[0];
    expect(edits[0].range.start).toEqual({ line: 2, character: 0 });
    expect(edits[0].range.end).toEqual({ line: 3, character: 0 });
    expect(edits[0].newText).toContain('self.contents = _fd');
  });

  it('serve 抛错 → 回 TS 既有实现:真文本 receiver 走查仍出双守卫', async () => {
    const provider = new KBEngineReceiverNoneGuardCodeActionProvider();
    const doc = pyDocument();
    const diagnostic = new Diagnostic(
      new Range(new Position(2, 18), new Position(2, 23)),
      'self.cell 可能为 None…',
      DiagnosticSeverity.Warning
    );
    diagnostic.code = RECEIVER_NONE_DIAGNOSTIC_CODE;
    setKodeCoreShadowGate(makeServingGate(RECEIVER_FACES, { serveError: true }).gate);
    const actions = (await provider.provideCodeActions(
      doc as never,
      { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } } as never,
      { diagnostics: [diagnostic] } as never,
      undefined
    )) as unknown as StubCodeAction[];
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toContain('Wrap with null guard');
    expect(actions[1].title).toContain('Insert None guard');
  });

  it('无门 → 回 TS 既有实现(零请求,行为与既有用例同链)', async () => {
    const provider = new KBEngineReceiverNoneGuardCodeActionProvider();
    const doc = pyDocument();
    const diagnostic = new Diagnostic(
      new Range(new Position(2, 18), new Position(2, 23)),
      'self.cell 可能为 None…',
      DiagnosticSeverity.Warning
    );
    diagnostic.code = RECEIVER_NONE_DIAGNOSTIC_CODE;
    setKodeCoreShadowGate(null);
    const actions = (await provider.provideCodeActions(
      doc as never,
      { start: { line: 2, character: 0 }, end: { line: 2, character: 40 } } as never,
      { diagnostics: [diagnostic] } as never,
      undefined
    )) as unknown as StubCodeAction[];
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toContain('if self.cell:');
    expect(actions[1].title).toContain('if not self.cell:');
  });
});
