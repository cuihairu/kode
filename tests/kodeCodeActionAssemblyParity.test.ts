// kode2 CodeAction 装配对拍门禁(RUST-143 批 2):TS 侧驱动**生产
// provider**(src/languageProviders/codeAction.ts,经 fake-vscode 替身)
// 独立复算 Rust 装配决策核 golden(crates/kode-server/tests/golden/
// code-action-assembly-parity.json)——守卫双动作序/去重键/related 定位
// 面/FD 习语整行段替换/类型近拼替换逐面对拍。Type provider 的
// getKnownTypeContext 是 completion 服务面(替身 workspace 无根 → 仅
// builtins),本镜像走其真建议函数 findRegisteredTypeSuggestions + 真
// diagnosticRangeIntersects + provider 同形闸序(Rust 侧 registered 为
// 显式输入,provider 类级行为归 electron 套件 lintQuickFixBoundaries)。
// 本文件只读 golden 与临时目录 fixture,不改 src/。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  KBEngineDefPythonParityCodeActionProvider,
  KBEngineFixedDictWholeReassignCodeActionProvider,
  KBEngineReceiverNoneGuardCodeActionProvider,
  diagnosticRangeIntersects
} from '../src/languageProviders/codeAction';
import { findRegisteredTypeSuggestions } from '../src/languageProviders/completion';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/code-action-assembly-parity.json');

// ---- 合成语料(与 Rust dump_code_action_assembly_golden 逐字同文) ----

const TYPE_DEF = '<Avatar>\n  <Properties>\n    <hp type="UNIT32"/>\n  </Properties>\n</Avatar>\n';
const AVATAR_DEF = '<Avatar>\n  <Properties>\n    <level type="UINT32"/>\n  </Properties>\n  <BaseMethods>\n    <onTalk>\n      <Arg>UINT32</Arg>\n    </onTalk>\n  </BaseMethods>\n</Avatar>\n';
const AVATAR_PY = 'import KBEngine\n\nclass Avatar:\n    def __init__(self):\n        self.level = 0\n\n    def onMove(self):\n        pass\n';
const RECV_PY = 'class Mob:\n    def onEnter(self, entity):\n        self.cell.prepareEnter(entity)\n        self.cell.ready()\n';
const FD_PY = 'class Box:\n    def onUse(self):\n        self.contents["slot"] = 1\n        self.contents["extra"] = 2\n';

const REGISTERED = ['UINT32', 'UINT64', 'VECTOR3', 'STRING'];

interface GoldenAction {
  kind: string;
  title: string;
  edit: Record<string, unknown>;
  diagnosticStartLine: number;
}

interface GoldenDump {
  caseCount: number;
  actionCount: number;
  cases: Array<{ name: string; actions: GoldenAction[] }>;
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as GoldenDump;

const goldenCase = (name: string): GoldenAction[] => {
  const found = golden.cases.find(candidate => candidate.name === name);
  expect(found, `golden 案例缺失: ${name}`).toBeDefined();
  return found!.actions;
};

// ---- 归一化:fake CodeAction/WorkspaceEdit → Rust ActionFace 同形 ----

const normalizeUri = (uri: vscode.Uri, tempDir: string | null): string =>
  normalizePath(uri.fsPath, tempDir);

const normalizePath = (fsPath: string, tempDir: string | null): string => {
  let normalized = fsPath.replace(/\\/g, '/');
  if (tempDir) {
    const prefix = tempDir.replace(/\\/g, '/');
    if (normalized.startsWith(prefix)) {
      normalized = '/w' + normalized.slice(prefix.length);
    }
  }
  return normalized;
};

// provider 标题内嵌目标文件路径(临时根)→ 归一为 /w 后再比。
const normalizeTitle = (title: string, tempDir: string | null): string =>
  tempDir ? title.split(tempDir).join('/w') : title;

const kindValue = (kind: vscode.CodeActionKind | undefined): string => {
  // Rust face 记 TS 约定名(QuickFix/Refactor);真机与替身 kind.value 均
  // 小写(真机 CodeActionKind.QuickFix.value === 'quickfix')→ 归一大写名。
  const value = kind?.value ?? '';
  if (value === 'quickfix') return 'QuickFix';
  if (value === 'refactor') return 'Refactor';
  return value;
};

const toEditFace = (uri: vscode.Uri, edit: vscode.TextEdit, tempDir: string | null): Record<string, unknown> => {
  const file = normalizeUri(uri, tempDir);
  const { range, newText: text } = edit;
  const isPoint = range.start.line === range.end.line && range.start.character === range.end.character;
  if (isPoint) {
    return { type: 'insertLine', file, line: range.start.line, text };
  }
  if (range.start.character === 0 && range.end.character === 0) {
    return { type: 'replaceLines', file, startLine: range.start.line, endLine: range.end.line, text };
  }
  return {
    type: 'replaceRange',
    file,
    range: {
      startLine: range.start.line,
      startChar: range.start.character,
      endLine: range.end.line,
      endChar: range.end.character
    },
    newText: text
  };
};

const normalizeAction = (action: vscode.CodeAction, tempDir: string | null): Record<string, unknown> => ({
  kind: kindValue(action.kind),
  title: normalizeTitle(action.title, tempDir),
  edit: action.edit
    ? action.edit.entries().map(([uri, edits]) => ({
        file: normalizeUri(uri, tempDir),
        edits: edits.map(edit => toEditFace(uri, edit, tempDir))
      }))
    : null,
  diagnosticStartLine: action.diagnostics?.[0]?.range.start.line
});

const normalizeActions = (actions: readonly vscode.CodeAction[], tempDir: string | null): Array<Record<string, unknown>> =>
  actions.map(action => normalizeAction(action, tempDir));

const unwrapEdit = (goldenAction: GoldenAction): Record<string, unknown> => ({
  file: goldenAction.edit.file,
  edits: [goldenAction.edit]
});

const normalizeGolden = (actions: GoldenAction[]): Array<Record<string, unknown>> =>
  actions.map(action => ({
    kind: action.kind,
    title: action.title,
    edit: [unwrapEdit(action)],
    diagnosticStartLine: action.diagnosticStartLine
  }));

const makeDiag = (
  code: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  extra: { relatedFile?: string; relatedMessage?: string } = {}
): vscode.Diagnostic => {
  const diagnostic = {
    code,
    range: new vscode.Range(startLine, startChar, endLine, endChar),
    relatedInformation: undefined as
      | Array<{ location: { uri: vscode.Uri }; message: string }>
      | undefined
  };
  if (extra.relatedFile !== undefined) {
    diagnostic.relatedInformation = [
      { location: { uri: vscode.Uri.file(extra.relatedFile) }, message: extra.relatedMessage ?? '' }
    ];
  }
  return diagnostic as unknown as vscode.Diagnostic;
};

const UNKNOWN_TYPE_DIAGNOSTIC_CODE = 'kbengine.unknownType';
const DEF_PYTHON_PARITY_DIAGNOSTIC_CODE = 'def-method-missing-in-python';
const RECEIVER_NONE_DIAGNOSTIC_CODE = 'kbengine.receiverNone';
const FIXED_DICT_NESTED_MUTATION_CODE = 'kbengine.fixedDictNestedMutation';

describe('kodeCodeActionAssemblyParity', () => {
  it('golden header and type replacement suggestions match production', () => {
    expect(golden.caseCount).toBe(4);
    const actionSum = golden.cases.reduce((acc, item) => acc + item.actions.length, 0);
    expect(golden.actionCount).toBe(actionSum);
    expect(golden.actionCount).toBe(5);

    // 真 findRegisteredTypeSuggestions(批 1 面真值)+ provider 同形闸序:
    // code 闸 → 真 diagnosticRangeIntersects → 区间文本 trim 非空 → 候选
    // 逐个出替换动作。
    const actions: Array<Record<string, unknown>> = [];
    const diagnostics = [
      makeDiag(UNKNOWN_TYPE_DIAGNOSTIC_CODE, 2, 14, 2, 20),
      makeDiag('kbengine.other', 2, 14, 2, 20),
      makeDiag(UNKNOWN_TYPE_DIAGNOSTIC_CODE, 0, 0, 0, 7)
    ];
    const request = new vscode.Range(2, 0, 2, 999);
    const document = makeDoc(TYPE_DEF, '/w/scripts/entity_defs/Avatar.def');
    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== UNKNOWN_TYPE_DIAGNOSTIC_CODE) continue;
      if (!diagnosticRangeIntersects(diagnostic.range, request)) continue;
      const unknownName = document.getText(diagnostic.range).trim();
      if (!unknownName) continue;
      for (const candidate of findRegisteredTypeSuggestions(unknownName, REGISTERED)) {
        actions.push({
          kind: 'QuickFix',
          title: `Replace with registered type ${candidate}`,
          edit: [
            {
              file: '/w/scripts/entity_defs/Avatar.def',
              edits: [
                {
                  type: 'replaceRange',
                  file: '/w/scripts/entity_defs/Avatar.def',
                  range: {
                    startLine: diagnostic.range.start.line,
                    startChar: diagnostic.range.start.character,
                    endLine: diagnostic.range.end.line,
                    endChar: diagnostic.range.end.character
                  },
                  newText: candidate
                }
              ]
            }
          ],
          diagnosticStartLine: diagnostic.range.start.line
        });
      }
    }
    expect(actions).toEqual(normalizeGolden(goldenCase('type-replacement')));
    // 闸序自证:区间不相交诊断不产动作(code 闸外的三诊断只一个入闸)。
    expect(diagnosticRangeIntersects(new vscode.Range(2, 14, 2, 20), new vscode.Range(2, 0, 2, 999))).toBe(true);
    expect(diagnosticRangeIntersects(new vscode.Range(0, 0, 0, 7), new vscode.Range(2, 0, 2, 999))).toBe(false);
    expect(diagnosticRangeIntersects(new vscode.Range(2, 20, 2, 30), new vscode.Range(2, 0, 2, 20))).toBe(true);
  });

  it('parity method skeleton provider assembles golden action', async () => {
    // 快照经真 readSharedFileSnapshot 磁盘补载(provider 默认 deps)——
    // 写临时文件,深比前把临时根归一为 /w。
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ca-parity-'));
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
    const targetFile = path.join(tempDir, 'scripts', 'avatar.py');
    fs.writeFileSync(targetFile, AVATAR_PY, 'utf8');
    try {
      const document = makeDoc(AVATAR_DEF, '/w/scripts/entity_defs/Avatar.def');
      const provider = new KBEngineDefPythonParityCodeActionProvider();
      const context = {
        diagnostics: [
          makeDiag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11, { relatedFile: targetFile, relatedMessage: '' }),
          makeDiag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11),
          makeDiag(DEF_PYTHON_PARITY_DIAGNOSTIC_CODE, 5, 5, 5, 11, { relatedFile: targetFile, relatedMessage: '' })
        ]
      } as vscode.CodeActionContext;
      const actions = (await provider.provideCodeActions(
        document as unknown as vscode.TextDocument,
        new vscode.Range(5, 0, 5, 999),
        context
      )) as vscode.CodeAction[];
      expect(normalizeActions(actions ?? [], tempDir)).toEqual(normalizeGolden(goldenCase('parity-method')));
      expect(actions).toHaveLength(1);
      expect(normalizeTitle(actions![0].title, tempDir)).toBe('Generate method onTalk → /w/scripts/avatar.py:9');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('receiver none guard provider orders wrap then guard and dedupes', async () => {
    const document = makeDoc(RECV_PY, '/w/scripts/mob.py');
    const provider = new KBEngineReceiverNoneGuardCodeActionProvider();
    const context = {
      diagnostics: [
        makeDiag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 30),
        makeDiag(RECEIVER_NONE_DIAGNOSTIC_CODE, 2, 18, 2, 24),
        makeDiag(RECEIVER_NONE_DIAGNOSTIC_CODE, 1, 4, 1, 11)
      ]
    } as vscode.CodeActionContext;
    const actions = (await provider.provideCodeActions(
      document as unknown as vscode.TextDocument,
      new vscode.Range(0, 0, 3, 999),
      context
    )) as vscode.CodeAction[];
    expect(actions).toHaveLength(2);
    expect(normalizeActions(actions, null)).toEqual(normalizeGolden(goldenCase('receiver-none-guard')));
    expect(actions[0].title).toBe('Wrap with null guard (if self.cell:)');
    expect(actions[1].title).toBe('Insert None guard (if not self.cell: return)');
  });

  it('fixed dict whole reassign provider dedupes by line', async () => {
    const document = makeDoc(FD_PY, '/w/scripts/box.py');
    const provider = new KBEngineFixedDictWholeReassignCodeActionProvider();
    const context = {
      diagnostics: [
        makeDiag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 16),
        makeDiag(FIXED_DICT_NESTED_MUTATION_CODE, 2, 8, 2, 13)
      ]
    } as vscode.CodeActionContext;
    const actions = (await provider.provideCodeActions(
      document as unknown as vscode.TextDocument,
      new vscode.Range(2, 0, 2, 999),
      context
    )) as vscode.CodeAction[];
    expect(actions).toHaveLength(1);
    expect(normalizeActions(actions, null)).toEqual(normalizeGolden(goldenCase('fixed-dict-whole-reassign')));
  });
});

function makeDoc(text: string, fileName: string): vscode.TextDocument {
  // makeTextDocument 经 vscodeStub(core * re-export)同名可得;def 文档
  // 用 kbengine-def,python 文档用 python。
  const languageId = fileName.endsWith('.def') ? 'kbengine-def' : 'python';
  return (vscode as unknown as {
    makeTextDocument: (
      text: string,
      options?: { fileName?: string; languageId?: string }
    ) => vscode.TextDocument;
  }).makeTextDocument(text, { fileName, languageId });
}
