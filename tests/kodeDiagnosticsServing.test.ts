// 诊断面 rust 服务腿单测(2026-11-08 用户令「直接切到 rust」,最后一片服务面):
// 归并公式(message 键替换自身码 / 保留外来码 / 幂等)、LSP↔vscode 严重级
// 映射、细分开关闸(任一关闭整面回落 TS)、版本护栏、失败回落 TS 面保持。
import { afterEach, describe, expect, it } from 'vitest';

import {
  lspSeverityToVscode,
  mergeRustDiagnosticsFace,
  rustDiagnosticsFaceGateOpen,
  serveRustDiagnosticsFace
} from '../src/languageProviders/validation';
import { getLanguageFeatureConfig } from '../src/languageProviders/shared';
import {
  setKodeCoreShadowGate,
  type LspDiagnosticReportFace
} from '../src/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import {
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  Range,
  makeTextDocument,
  configurationOverrides,
  workspace as stubWorkspace,
  type MinimalTextDocument
} from './helpers/vscodeStub';

afterEach(() => {
  setKodeCoreShadowGate(null);
  configurationOverrides.clear();
});

/** serveRustDiagnosticsFace 是 void fire-and-forget:等 .then 微任务落定再断言 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const defDoc = (text = '<root>\n</root>\n'): MinimalTextDocument =>
  makeTextDocument(text, { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def', languageId: 'kbengine-def' });

const tsFaceOf = (): Diagnostic[] => [
  // TS 自产码(与 Rust 同文案,应让位)
  new Diagnostic(
    new Range(new Position(3, 11), new Position(3, 21)),
    '未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。',
    DiagnosticSeverity.Error
  ),
  // 外来码:missingPythonFile(盘上探测分支,Rust 面没有)应保留
  new Diagnostic(
    new Range(new Position(2, 10), new Position(2, 20)),
    '自定义类型 MY_TYPE 已在 types.xml 中注册，但未找到对应的 user_type Python 文件，请检查 user_type/MY_TYPE.py',
    DiagnosticSeverity.Warning
  )
];

const rustFaceOf = (): LspDiagnosticReportFace => ({
  kind: 'full',
  items: [
    // 同文案未知 Flags(LSP Error=1)—— 替换 TS 版本
    {
      range: { start: { line: 3, character: 11 }, end: { line: 3, character: 21 } },
      severity: 1,
      message: '未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。'
    },
    // Rust 新增码(TS 面没有,如重复定义 Warning=2)
    {
      range: { start: { line: 14, character: 4 }, end: { line: 17, character: 5 } },
      severity: 2,
      message: '属性区块中存在重复定义: dup (Base)'
    }
  ]
});

describe('lspSeverityToVscode 严重级映射', () => {
  it('LSP 1/2/3 → vscode Error/Warning/Information;越界收敛 Error', () => {
    expect(lspSeverityToVscode(1)).toBe(DiagnosticSeverity.Error);
    expect(lspSeverityToVscode(2)).toBe(DiagnosticSeverity.Warning);
    expect(lspSeverityToVscode(3)).toBe(DiagnosticSeverity.Information);
    expect(lspSeverityToVscode(0)).toBe(DiagnosticSeverity.Error);
    expect(lspSeverityToVscode(4)).toBe(DiagnosticSeverity.Error);
  });
});

describe('mergeRustDiagnosticsFace 归并公式', () => {
  it('同文案码让位(Rust 版本落)、外来码保留、新增码并入', () => {
    const merged = mergeRustDiagnosticsFace(tsFaceOf(), rustFaceOf());
    // TS 自产 Flags 码被 Rust 同文案项替换(区间取 Rust 面),missingPythonFile 保留
    expect(merged).toHaveLength(3);
    const flags = merged.find(diagnostic => diagnostic.message.includes('NOT_A_FLAG'));
    expect(flags?.range.start.line).toBe(3);
    expect(flags?.range.start.character).toBe(11);
    expect(flags?.range.end.character).toBe(21);
    expect(flags?.severity).toBe(DiagnosticSeverity.Error);
    const missingPy = merged.find(diagnostic => diagnostic.message.includes('user_type'));
    expect(missingPy?.severity).toBe(DiagnosticSeverity.Warning);
    // 新增码:LSP Warning(2)→ vscode Warning(1)
    const dup = merged.find(diagnostic => diagnostic.message.includes('重复定义'));
    expect(dup?.severity).toBe(DiagnosticSeverity.Warning);
    expect(dup?.range.start.line).toBe(14);
  });

  it('幂等:对归并结果重入同一报告不叠加(重到达稳定)', () => {
    const once = mergeRustDiagnosticsFace(tsFaceOf(), rustFaceOf());
    const twice = mergeRustDiagnosticsFace(once, rustFaceOf());
    expect(twice).toHaveLength(once.length);
    expect(twice.map(diagnostic => diagnostic.message)).toEqual(once.map(diagnostic => diagnostic.message));
  });

  it('同文案冲突:Rust 版本独占(不双报,区间取 Rust 面)', () => {
    const existing = [
      new Diagnostic(
        new Range(new Position(0, 0), new Position(0, 1)),
        '属性区块中存在重复定义: dup (Base)',
        DiagnosticSeverity.Warning
      )
    ];
    const merged = mergeRustDiagnosticsFace(existing, rustFaceOf());
    // 同文案在 rustMessages 键上被整组替换:TS 版本让位,Rust 版本唯一落位
    expect(merged.filter(d => d.message.includes('重复定义'))).toHaveLength(1);
    expect(merged.find(d => d.message.includes('重复定义'))?.range.start.line).toBe(14);
  });

  it('空报告:面原样保留(不产生空集)', () => {
    const existing = tsFaceOf();
    const merged = mergeRustDiagnosticsFace(existing, { kind: 'full', items: [] });
    expect(merged).toHaveLength(existing.length);
  });
});

describe('rustDiagnosticsFaceGateOpen 细分开关闸', () => {
  const KNOBS = [
    'enableStructureDiagnostics',
    'diagnosticsCheckUnknownFlags',
    'diagnosticsCheckUnknownDetailLevels',
    'diagnosticsCheckUnknownTypes',
    'diagnosticsCheckDuplicateDefinitions',
    'diagnosticsCheckMissingPropertyFields'
  ] as const;

  it('默认全开:闸开放', () => {
    expect(rustDiagnosticsFaceGateOpen({ ...getFeatureDefaults() } as never)).toBe(true);
  });

  for (const knob of KNOBS) {
    it(`${knob}=false:闸关闭(整面回落 TS)`, () => {
      const config = { ...getFeatureDefaults(), [knob]: false } as never;
      expect(rustDiagnosticsFaceGateOpen(config)).toBe(false);
    });
  }
});

// getLanguageFeatureConfig 读真实 workspace 配置(替身默认值全开);此处只取
// 一份现值做闸函数的基线(不写 workspace,避免跨用例串扰)。
function getFeatureDefaults(): Record<string, boolean> {
  void stubWorkspace;
  const config = getLanguageFeatureConfig() as unknown as Record<string, boolean>;
  return {
    enableStructureDiagnostics: config.enableStructureDiagnostics,
    diagnosticsCheckUnknownFlags: config.diagnosticsCheckUnknownFlags,
    diagnosticsCheckUnknownDetailLevels: config.diagnosticsCheckUnknownDetailLevels,
    diagnosticsCheckUnknownTypes: config.diagnosticsCheckUnknownTypes,
    diagnosticsCheckDuplicateDefinitions: config.diagnosticsCheckDuplicateDefinitions,
    diagnosticsCheckMissingPropertyFields: config.diagnosticsCheckMissingPropertyFields
  };
}

describe('serveRustDiagnosticsFace 服务腿', () => {
  const RICH_DEF = [
    '<root>',
    '  <Properties>',
    '    <flagsUnknown>',
    '      <Type>UINT32</Type>',
    '      <Flags>NOT_A_FLAG</Flags>',
    '    </flagsUnknown>',
    '  </Properties>',
    '</root>'
  ].join('\n');

  /** 服务轨道替身:记录 mirror/serve 调用,report 可编程 */
  const servingGate = (
    serve: () => Promise<unknown>,
    calls: string[] = []
  ): KodeCoreGate =>
    ({
      mode: 'rust',
      serveFromRust: () => true,
      mirrorDocument: async () => {
        calls.push('mirror');
      },
      serveInRust: async (method: string) => {
        calls.push(method);
        return serve();
      },
      // lint 腿同门消费:静默关闭(不产 findings)
      runInRust: async () => ({ ok: false, reason: 'stub' }),
      // shadow 对拍腿(validateDocument 内 shadowObserveDefDocument 消费)
      compare: async () => undefined
    }) as unknown as KodeCoreGate;

  it('rust 轨道:TS 面落定后 Rust 面异步替换自身码、保留外来码', async () => {
    const calls: string[] = [];
    setKodeCoreShadowGate(servingGate(async () => rustFaceOf(), calls));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    // TS 同步面先落(首绘零延迟)
    const tsFace = tsFaceOf();
    collection.set(doc.uri, tsFace);

    serveRustDiagnosticsFace(doc, collection, {
      ...getFeatureDefaults(),
      enableDiagnostics: true
    } as never);
    expect(collection.get(doc.uri)).toEqual(tsFace); // 同步面未被异步腿抢占
    await flush();

    expect(calls).toEqual(['mirror', 'textDocument/diagnostic']);
    const merged = collection.get(doc.uri);
    // Rust 面两码落位(NOT_A_FLAG 替换 + dup 新增),missingPythonFile 保留
    expect(merged.map(d => d.message)).toEqual([
      '自定义类型 MY_TYPE 已在 types.xml 中注册，但未找到对应的 user_type Python 文件，请检查 user_type/MY_TYPE.py',
      '未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。',
      '属性区块中存在重复定义: dup (Base)'
    ]);
  });

  it('版本前进后到达:不发布过期面(TS 集保持)', async () => {
    setKodeCoreShadowGate(servingGate(async () => rustFaceOf()));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    const tsFace = tsFaceOf();
    collection.set(doc.uri, tsFace);

    serveRustDiagnosticsFace(doc, collection, { ...getFeatureDefaults() } as never);
    doc.version = 2; // 到达前文档前进
    await flush();

    expect(collection.get(doc.uri)).toEqual(tsFace);
  });

  it('Rust 返回 null(非 .def / 上下文外):TS 集保持', async () => {
    setKodeCoreShadowGate(servingGate(async () => null));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    const tsFace = tsFaceOf();
    collection.set(doc.uri, tsFace);

    serveRustDiagnosticsFace(doc, collection, { ...getFeatureDefaults() } as never);
    await flush();
    expect(collection.get(doc.uri)).toEqual(tsFace);
  });

  it('Rust 请求失败:catch 吞掉不抛,TS 集保持', async () => {
    setKodeCoreShadowGate(
      servingGate(async () => {
        throw new Error('rpc failed');
      })
    );
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    const tsFace = tsFaceOf();
    collection.set(doc.uri, tsFace);

    expect(() =>
      serveRustDiagnosticsFace(doc, collection, { ...getFeatureDefaults() } as never)
    ).not.toThrow();
    await flush();
    expect(collection.get(doc.uri)).toEqual(tsFace);
  });

  it('细分开关关闭:零请求(不镜像不派发)', async () => {
    const calls: string[] = [];
    setKodeCoreShadowGate(servingGate(async () => rustFaceOf(), calls));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;

    serveRustDiagnosticsFace(doc, collection, {
      ...getFeatureDefaults(),
      diagnosticsCheckDuplicateDefinitions: false
    } as never);
    await flush();
    expect(calls).toEqual([]);
    expect(collection.get(doc.uri)).toEqual([]);
  });

  it('非服务轨道(serveFromRust=false):零开销直通', async () => {
    const calls: string[] = [];
    setKodeCoreShadowGate({
      mode: 'ts',
      serveFromRust: () => false,
      mirrorDocument: async () => {
        calls.push('mirror');
      },
      serveInRust: async () => {
        calls.push('serve');
        return rustFaceOf();
      }
    } as unknown as KodeCoreGate);
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;

    serveRustDiagnosticsFace(doc, collection, { ...getFeatureDefaults() } as never);
    await flush();
    expect(calls).toEqual([]);
  });

  it('validateDocument 全链:服务轨道下首绘 TS 面、异步归并 Rust 面', async () => {
    const { validateDocument } = await import('../src/languageProviders/validation');
    const calls: string[] = [];
    setKodeCoreShadowGate(servingGate(async () => rustFaceOf(), calls));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;

    validateDocument(doc, collection);
    // 同步:TS 自产 NOT_A_FLAG Error 已落(首绘不空窗)
    const painted = collection.get(doc.uri).map(d => d.message);
    expect(painted.some(message => message.includes('NOT_A_FLAG'))).toBe(true);
    await flush();
    // shadowObserveDefDocument 对拍腿与 lint 腿照常在门上(不因服务腿消失):
    // 对拍腿与服务腿各走一次镜像(同版本第二次是账本 no-op,但门调用都发生)
    expect(calls.filter(call => call === 'mirror')).toHaveLength(2);
    expect(calls.filter(call => call === 'textDocument/diagnostic')).toHaveLength(1);
    // 异步:Rust 面归并完成(同文案替换 + dup 新增)
    const merged = collection.get(doc.uri).map(d => d.message);
    expect(merged).toEqual([
      '未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。',
      '属性区块中存在重复定义: dup (Base)'
    ]);
  });
});
