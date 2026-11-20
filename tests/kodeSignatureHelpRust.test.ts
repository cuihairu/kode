// RUST-140 批 3 接线(kode-server textDocument/signatureHelp def 方法签名面)
// TS 侧钉子:①桥契约——serveSignatureHelpFromRust 的 .py 文档门、载荷
// (textDocument/position)、回包 {signature, activeParameter} 双键整面校验
// (label/parameters/documentation/definition 四件 + 非负整数活动形参),
// 任一畸形 → null 不部分采用;②provider 切流——KBEngineSignatureHelpProvider
// 消费 SignatureHelpFace 直构 vscode.SignatureHelp,Rust 面不可用时回 TS
// 既有 entityMapping 链(无门/serve 抛错皆回退,不部分采用)。
// 决策核面真值由 crates/kode-server/tests/signature_help_dispatch.rs
// LSP 级门禁钉(label/段闸/clamp 零形参臂)。
import { afterEach, describe, expect, it } from 'vitest';
import { makeTextDocument, Position } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';
import { KBEngineSignatureHelpProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  serveSignatureHelpFromRust,
  setKodeCoreShadowGate,
  type SignatureHelpResultFace
} from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

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

const PY_DOC_PATH = '/tmp/ws/scripts/cell/Avatar.py';

const FACE: SignatureHelpResultFace = {
  signature: {
    label: 'def onTalk(self, arg1: int, arg2: str)',
    parameters: ['arg1: int', 'arg2: str'],
    documentation: '此调用是实体 def 声明的 CellMethods 方法(接收者 self.CellMethods)',
    definition: {
      file: '/tmp/ws/scripts/entity_defs/Avatar.def',
      line: 8,
      section: 'CellMethods',
      exposed: false
    }
  },
  activeParameter: 1
};

const pyDocument = (text = '        self.cell.onTalk(1, 2)\n'): MinimalTextDocument =>
  makeTextDocument(text, { fileName: PY_DOC_PATH, languageId: 'python', version: 1 });

describe('serveSignatureHelpFromRust 桥契约', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:py 文档先镜像再请求,载荷带 textDocument/position', async () => {
    const doc = pyDocument();
    const { gate, served } = makeServingGate(FACE);
    setKodeCoreShadowGate(gate);
    const result = await serveSignatureHelpFromRust(doc, { line: 0, character: 27 });
    expect(result).toEqual(FACE);
    expect(served).toHaveLength(1);
    expect(served[0].method).toBe('textDocument/signatureHelp');
    expect(served[0].params).toEqual({
      textDocument: { uri: PY_DOC_PATH },
      position: { line: 0, character: 27 }
    });
  });

  it('非 .py 文档/无门/门关 → null 且零请求', async () => {
    const defDoc = makeTextDocument('<root/>', {
      fileName: '/tmp/ws/scripts/entity_defs/Avatar.def',
      languageId: 'kbengine-def',
      version: 1
    }) as unknown as MinimalTextDocument;
    setKodeCoreShadowGate(null);
    expect(await serveSignatureHelpFromRust(pyDocument(), { line: 0, character: 0 })).toBeNull();
    const { gate, served } = makeServingGate(FACE);
    setKodeCoreShadowGate(gate);
    expect(await serveSignatureHelpFromRust(defDoc, { line: 0, character: 0 })).toBeNull();
    const off = makeServingGate(FACE, { serving: false });
    setKodeCoreShadowGate(off.gate);
    expect(await serveSignatureHelpFromRust(pyDocument(), { line: 0, character: 0 })).toBeNull();
    expect(served).toEqual([]);
    expect(off.served).toEqual([]);
  });

  it('取消位先判 → null 且零请求', async () => {
    const { gate, served } = makeServingGate(FACE);
    setKodeCoreShadowGate(gate);
    expect(
      await serveSignatureHelpFromRust(
        pyDocument(),
        { line: 0, character: 27 },
        () => true
      )
    ).toBeNull();
    expect(served).toEqual([]);
  });

  it('serve 抛错 → null(调用方回 TS 既有实现)', async () => {
    setKodeCoreShadowGate(makeServingGate(FACE, { serveError: true }).gate);
    expect(
      await serveSignatureHelpFromRust(pyDocument(), { line: 0, character: 27 })
    ).toBeNull();
  });

  it('应答畸形(face 四件缺键/definition 缺键/activeParameter 越形)→ 整面作废', async () => {
    const doc = pyDocument();
    const badCases: unknown[] = [
      { activeParameter: 0 },
      { signature: { parameters: [], documentation: 'd', definition: FACE.signature.definition }, activeParameter: 0 },
      { signature: { ...FACE.signature, parameters: ['arg1', 42] }, activeParameter: 0 },
      { signature: { ...FACE.signature, documentation: 7 }, activeParameter: 0 },
      { signature: { ...FACE.signature, definition: { file: '/a.def', line: 1, section: 'CellMethods' } }, activeParameter: 0 },
      { signature: { ...FACE.signature }, activeParameter: 1.5 },
      { signature: { ...FACE.signature }, activeParameter: -1 },
      { signature: { ...FACE.signature }, activeParameter: '1' },
      { signature: 'face', activeParameter: 0 },
      'nope'
    ];
    for (const bad of badCases) {
      setKodeCoreShadowGate(makeServingGate(bad).gate);
      expect(await serveSignatureHelpFromRust(doc, { line: 0, character: 27 })).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });

  it('应答 null(该位置无签名)→ null 透传(调用方回 TS 链同判)', async () => {
    setKodeCoreShadowGate(makeServingGate(null).gate);
    expect(
      await serveSignatureHelpFromRust(pyDocument(), { line: 0, character: 27 })
    ).toBeNull();
  });
});

describe('signatureHelp provider 切流', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  const managerOf = (
    locations: Record<string, { defFile: string; line: number; section: string; exposed: boolean; declaredArgs?: string[] }>,
    calls: Array<{ file: string; method: string; section?: string }>
  ) =>
    ({
      resolveMethodDefinition: (file: string, method: string, section?: string) => {
        calls.push({ file, method, section });
        const location = locations[method];
        return Promise.resolve(location ? { ...location, identity: { symbolName: method } } : null);
      }
    }) as unknown as EntityMappingManager;

  it('Rust face → SignatureHelp 直构(label/parameters/documentation/activeParameter)', async () => {
    const calls: Array<{ method: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(managerOf({}, calls));
    const doc = pyDocument();
    setKodeCoreShadowGate(makeServingGate(FACE).gate);
    const help = await provider.provideSignatureHelp(doc, new Position(0, 27));
    expect(help).not.toBeNull();
    // Rust 面命中即走薄壳直构:entityMapping 链零请求
    expect(calls).toHaveLength(0);
    expect(help!.signatures).toHaveLength(1);
    expect(help!.signatures[0].label).toBe(FACE.signature.label);
    expect(help!.signatures[0].parameters.map(p => p.label)).toEqual(FACE.signature.parameters);
    const documentation = help!.signatures[0].documentation as { value: string };
    expect(documentation.value).toContain('接收者 self.CellMethods');
    expect(help!.activeSignature).toBe(0);
    expect(help!.activeParameter).toBe(1);
  });

  it('serve 抛错 → 回 TS 既有 entityMapping 链(签名照出,clamp 同口径)', async () => {
    const calls: Array<{ method: string; section?: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(
      managerOf(
        {
          onTalk: {
            defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
            line: 8,
            section: 'CellMethods',
            exposed: true,
            declaredArgs: ['UINT32', 'STRING']
          }
        },
        calls
      )
    );
    setKodeCoreShadowGate(makeServingGate(FACE, { serveError: true }).gate);
    const help = await provider.provideSignatureHelp(pyDocument(), new Position(0, 27));
    expect(help).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('onTalk');
    expect(calls[0].section).toBe('CellMethods');
    expect(help!.signatures[0].label).toBe('def onTalk(self, arg1: int, arg2: str)');
    expect(help!.activeParameter).toBe(1);
  });

  it('无门 → 回 TS 既有实现(行为与既有用例同链)', async () => {
    const calls: Array<{ method: string }> = [];
    const provider = new KBEngineSignatureHelpProvider(
      managerOf(
        {
          onTalk: {
            defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
            line: 8,
            section: 'CellMethods',
            exposed: false,
            declaredArgs: ['UINT32']
          }
        },
        calls
      )
    );
    setKodeCoreShadowGate(null);
    const help = await provider.provideSignatureHelp(pyDocument(), new Position(0, 27));
    expect(help).not.toBeNull();
    expect(help!.signatures[0].label).toBe('def onTalk(self, arg1: int)');
    expect(help!.activeParameter).toBe(0);
  });

  it('非 python/无 manager → null(原有门,零请求)', async () => {
    const { gate, served } = makeServingGate(FACE);
    setKodeCoreShadowGate(gate);
    const defDoc = makeTextDocument('<root/>', {
      fileName: '/tmp/ws/scripts/entity_defs/Avatar.def',
      languageId: 'kbengine-def',
      version: 1
    }) as unknown as MinimalTextDocument;
    expect(
      await new KBEngineSignatureHelpProvider(managerOf({}, [])).provideSignatureHelp(
        defDoc,
        new Position(0, 0)
      )
    ).toBeNull();
    expect(
      await new KBEngineSignatureHelpProvider().provideSignatureHelp(
        pyDocument(),
        new Position(0, 27)
      )
    ).toBeNull();
    expect(served).toEqual([]);
  });
});
