// 覆盖率补面(validation.ts → 100% 行/99.12% 分支,2026-11-08):真实行为断言。
// 每条 it 锁一个真实分支:诊断开关关闸 / Rust lint 并集消费腿 / 标量与结构
// 校验的未知 Flags(单值+`|` 组合)/未知 DetailLevel/重复定义(属性作用域与
// 非属性段)/缺 Type 与缺 Flags/未注册类型(error+missingPythonFile warning)/
// entities.xml 重复登记诊断。测试不修改 src,只在 /tmp 临时工作区建 defs。
// 唯一未盖分支:validation.ts:127 `diagnostics.get(...) ?? []` 右臂 —— 替身
// DiagnosticCollection.get 缺文件返回 [](真实 vscode 返回 undefined),右臂
// 在测试面结构性不可达;盖它需改替身契约(700+ 用例依赖 [] 回落),不划算。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  validateDocument,
  validateEntitiesXmlDocument,
  validateScalarTagValues,
  validateDefStructure,
  validateTypeNode,
  validateSectionStructure,
  validatePropertyStructure,
  getPropertyFlagScopes,
  normalizePropertyFlag,
  describePropertyScope,
  observeRustDefFindings,
  mergeRustDefFindings,
  toDiagnosticSeverity,
  RUST_LIVE_MERGE_CODES,
  UNKNOWN_TYPE_DIAGNOSTIC_CODE
} from '../src/languageProviders/validation';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import {
  DiagnosticCollection,
  Diagnostic,
  Position,
  Range,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace,
  configurationOverrides
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';
import { parseDefAst } from '../src/languageProviders/shared';

// validation.ts:86-88 的 catch 是纯防御臂:collectDefPythonParityInput 内部
// 读盘(sharedFileSnapshot.readDiskFile)与 parsePythonFile 均自吞异常,真实
// 入参无抛出路径(已核 defPythonParity.ts:93-117 全链)。模块替身让该防御臂
// 可观测(按 parityShouldThrow 开关);仅本文件作用域,其余文件不受影响。
const { parityShouldThrow } = vi.hoisted(() => ({ parityShouldThrow: { value: false } }));
vi.mock('../src/defPythonParity', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/defPythonParity')>();
  return {
    ...actual,
    collectDefPythonParityInput: (file: string) => {
      if (parityShouldThrow.value) {
        throw new Error('boom');
      }
      return actual.collectDefPythonParityInput(file);
    }
  };
});

/** observeRustDefFindings 是 void fire-and-forget:等 .then 微任务落定再断言 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const defDoc = (text: string, fileName = '/tmp/ws/scripts/entity_defs/Avatar.def'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'kbengine-def' });

const RICH_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '      <DetailLevel>FAR</DetailLevel>',
  '    </hp>',
  '    <broken>',
  '      <Flags>BASE</Flags>',
  '    </broken>',
  '    <noFlags>',
  '      <Type>UINT32</Type>',
  '    </noFlags>',
  '    <dup>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </dup>',
  '    <dup>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </dup>',
  '    <flagsCombo>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE | CELL</Flags>',
  '    </flagsCombo>',
  '    <flagsUnknown>',
  '      <Type>UINT32</Type>',
  '      <Flags>NOT_A_FLAG</Flags>',
  '    </flagsUnknown>',
  '    <levelUnknown>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '      <DetailLevel>SUPERFAR</DetailLevel>',
  '    </levelUnknown>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <moveTo>',
  '      <Arg>VECTOR3</Arg>',
  '    </moveTo>',
  '    <moveTo>',
  '      <Arg>VECTOR3</Arg>',
  '    </moveTo>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

describe('validateDocument 诊断开关与结构/标量校验(覆盖率)', () => {
  it('enableDiagnostics=false:delete 诊断不校验', () => {
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    collection.set(doc.uri, [new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 'x', 1)]);
    try {
      validateDocument(doc, collection);
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      configurationOverrides.clear();
    }
  });

  it('enableStructureDiagnostics=false:只跑标量校验,结构重复/缺字段不报', () => {
    configurationOverrides.set('kbengine', { enableStructureDiagnostics: false });
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      validateDocument(doc, collection);
      const messages = collection.get(doc.uri).map(item => item.message);
      // 结构校验臂关闭:重复定义/缺 Type/缺 Flags 不产;标量臂(未知 Flags)仍在
      expect(messages.some(m => m.includes('重复定义'))).toBe(false);
      expect(messages.some(m => m.includes('缺少 <Type>'))).toBe(false);
      expect(messages.some(m => m.includes('未知的 KBEngine Flags 值: NOT_A_FLAG'))).toBe(true);
    } finally {
      configurationOverrides.clear();
    }
  });

  it('富 def:未知 Flags(`|` 组合与单值)/未知 DetailLevel/缺 Type/缺 Flags/重复属性/重复方法/未注册类型', () => {
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      validateDocument(doc, collection);
      const messages = collection.get(doc.uri).map(item => item.message);
      // 未知单值 Flags
      expect(messages).toContain('未知的 KBEngine Flags 值: NOT_A_FLAG。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。');
      // `|` 组合形态(引擎不支持)
      expect(messages).toContain('未知的 KBEngine Flags 值: BASE | CELL。引擎按单个映射值整串查表，不支持 \'|\' 组合形态；请改为单个词表值。');
      // 未知 DetailLevel
      expect(messages).toContain('未知的 DetailLevel: SUPERFAR');
      // 缺 Type 与缺 Flags
      expect(messages).toContain('属性 broken 缺少 <Type> 定义');
      expect(messages).toContain('属性 noFlags 缺少 <Flags> 定义');
      // 重复属性定义(同一作用域)
      expect(messages.some(message => message.includes('属性区块中存在重复定义: dup'))).toBe(true);
      expect(messages.some(message => message.includes('dup 在 属性区块 中已在 Base 作用域定义'))).toBe(true);
      // 重复方法定义(非属性段 → seenSymbols 路径)
      expect(messages.some(message => message.includes('方法区块中存在重复定义: moveTo'))).toBe(true);
      expect(messages.some(message => message.includes('moveTo 在 方法区块 中已定义'))).toBe(true);
    } finally {
      configurationOverrides.clear();
    }
  });

  it('diagnostics.checkUnknownFlags=false:未知 Flags 跳过,DetailLevel 校验不受影响', () => {
    configurationOverrides.set('kbengine', { 'diagnostics.checkUnknownFlags': false });
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      validateDocument(doc, collection);
      const messages = collection.get(doc.uri).map(item => item.message);
      expect(messages.some(m => m.includes('未知的 KBEngine Flags 值'))).toBe(false);
      // DetailLevel 独立开关,不受 Flags 开关影响
      expect(messages).toContain('未知的 DetailLevel: SUPERFAR');
    } finally {
      configurationOverrides.clear();
    }
  });

  it('未注册类型诊断:code=kbengine.unknownType,error 级', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-val-reg-'));
    try {
      const defsDir = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      // 注册一个无关自定义类型(集合非空 → 未注册名走 missingTypeRegistration 分支)
      fs.writeFileSync(
        path.join(defsDir, 'types.xml'),
        '<root>\n  <OtherType><Properties><x><Type>UINT32</Type></x></Properties></OtherType>\n</root>\n',
        'utf8'
      );
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'root', index: 0 } as never];
      const doc = defDoc(
        '<root>\n  <Properties>\n    <p>\n      <Type>NotAType</Type>\n      <Flags>BASE</Flags>\n    </p>\n  </Properties>\n</root>\n',
        path.join(defsDir, 'Avatar.def')
      );
      const collection = new DiagnosticCollection();
      validateDocument(doc, collection);
      const unknown = collection.get(doc.uri).find(item => item.code === UNKNOWN_TYPE_DIAGNOSTIC_CODE);
      expect(unknown).toBeDefined();
      expect(unknown!.message).toContain('自定义类型 NotAType 未在 types.xml 中注册');
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('missingPythonFile 警告:types.xml 注册但 user_type Python 缺失', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-val-mpf-'));
    try {
      const defsDir = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(
        path.join(defsDir, 'types.xml'),
        '<root>\n  <AvatarProps>\n    <implementedBy>AvatarPropsUser</implementedBy>\n    <Properties><y><Type>UINT32</Type></y></Properties>\n  </AvatarProps>\n</root>\n',
        'utf8'
      );
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'root', index: 0 } as never];
      const doc = defDoc(
        '<root>\n  <Properties>\n    <bag>\n      <Type>AvatarProps</Type>\n      <Flags>BASE_AND_CLIENT</Flags>\n    </bag>\n  </Properties>\n</root>\n',
        path.join(defsDir, 'Avatar.def')
      );
      const collection = new DiagnosticCollection();
      validateDocument(doc, collection);
      const messages = collection.get(doc.uri).map(item => item.message);
      expect(messages.some(message => message.includes('自定义类型 AvatarProps 已在 types.xml 中注册，但未找到对应的 user_type Python 文件'))).toBe(true);
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Rust lint 并集消费腿(覆盖率)', () => {
  const rustGate = (findings: unknown): KodeCoreGate =>
    ({
      mode: 'rust',
      runInRust: async () => ({ ok: true, result: { findings } })
    } as unknown as KodeCoreGate);

  it('gate=ts 或无门:直通返回(零消耗)', async () => {
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    // 默认无门(ts 模式)→ 提前 return,collection 不被触碰
    await observeRustDefFindings(doc, collection);
    expect(collection.get(doc.uri)).toEqual([]);
  });

  it('Rust 返回空 findings:不落诊断', async () => {
    setKodeCoreShadowGate(rustGate([]));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      await observeRustDefFindings(doc, collection);
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 返回 ok:false:findings 为 null,不落诊断', async () => {
    setKodeCoreShadowGate({ mode: 'rust', runInRust: async () => ({ ok: false, reason: 'no server' }) } as unknown as KodeCoreGate);
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      await observeRustDefFindings(doc, collection);
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 拒绝:catch 吞掉不抛', async () => {
    setKodeCoreShadowGate({ mode: 'rust', runInRust: async () => { throw new Error('boom'); } } as unknown as KodeCoreGate);
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    try {
      expect(() => observeRustDefFindings(doc, collection)).not.toThrow();
      await flush();
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('版本前进后返回:不发布过期结果', async () => {
    setKodeCoreShadowGate(rustGate([{ check: 'phantom-type', offset: 0, length: 4, message: 'm', severity: 'warning' }]));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    try {
      observeRustDefFindings(doc, collection);
      doc.version = 2;
      await flush();
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('parity 采集抛错(防御臂):catch 吞掉,findings 照常并集', async () => {
    parityShouldThrow.value = true;
    setKodeCoreShadowGate(rustGate([{ check: 'phantom-type', offset: 0, length: 3, message: 'm', severity: 'warning' }]));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    try {
      observeRustDefFindings(doc, collection);
      await flush();
      expect(collection.get(doc.uri).map(item => item.message)).toEqual(['m']);
    } finally {
      parityShouldThrow.value = false;
      setKodeCoreShadowGate(null);
    }
  });

  it('非标准布局(parity null → ?? undefined 右臂):findings 照常并集', async () => {
    setKodeCoreShadowGate(rustGate([{ check: 'phantom-type', offset: 0, length: 3, message: 'm2', severity: 'warning' }]));
    const collection = new DiagnosticCollection();
    // 文件名不含 /scripts/entity_defs/ 标记 → assetsRoot null → collect 返回 null
    const doc = defDoc(RICH_DEF, '/tmp/plain/Avatar.def');
    doc.version = 1;
    try {
      observeRustDefFindings(doc, collection);
      await flush();
      expect(collection.get(doc.uri).map(item => item.message)).toEqual(['m2']);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust findings 命中并集码:并入既有诊断(fire-and-forget 落定后可见)', async () => {
    setKodeCoreShadowGate(rustGate([
      { check: 'phantom-type', offset: 0, length: 3, message: 'phantom warning', severity: 'warning' },
      { check: 'redundant-detail-level', offset: 20, length: 3, message: 'redundant', severity: 'info' }
    ]));
    const collection = new DiagnosticCollection();
    const doc = defDoc(RICH_DEF);
    doc.version = 1;
    // 先落一条既有诊断(mergeRustDefFindings 的 existingKeys 面)
    collection.set(doc.uri, [new Diagnostic(new Range(new Position(0, 0), new Position(0, 3)), 'phantom warning', 1)]);
    try {
      observeRustDefFindings(doc, collection);
      await flush();
      const messages = collection.get(doc.uri).map(item => item.message);
      // 既有同位置同文案不重复;redundant 并入
      expect(messages.filter(m => m === 'phantom warning')).toHaveLength(1);
      expect(messages).toContain('redundant');
      // severity 映射:redundant info → 2
      const redundant = collection.get(doc.uri).find(item => item.message === 'redundant');
      expect(redundant!.severity).toBe(2);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});

describe('mergeRustDefFindings 纯函数(覆盖率)', () => {
  it('非并集码跳过/同键去重/既有键不重复/severity 映射', () => {
    const doc = defDoc(RICH_DEF);
    const findings = [
      { check: 'unknown-type-reference', offset: 0, length: 3, message: 'not in union', severity: 'error' },
      { check: 'phantom-type', offset: 5, length: 3, message: 'dup', severity: 'error' },
      { check: 'phantom-type', offset: 5, length: 3, message: 'dup', severity: 'error' },
      { check: 'invalid-identifier', offset: 10, length: 3, message: 'already in collection', severity: 'warning' }
    ];
    // 既有诊断按 RICH_DEF 真实 offset 10 定位(positionAt 面),与
    // invalid-identifier finding 同位置同文案 → existingKeys 命中跳过。
    const s = doc.positionAt(10);
    const e = doc.positionAt(13);
    const existing = [new Diagnostic(new Range(s, e), 'already in collection', 1)];
    const out = mergeRustDefFindings(doc, findings as never, existing);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('dup');
    expect(out[0].severity).toBe(0); // error → DiagnosticSeverity.Error
    expect(RUST_LIVE_MERGE_CODES.has('phantom-type')).toBe(true);
    expect(RUST_LIVE_MERGE_CODES.has('unknown-type-reference')).toBe(false);
  });

  it('toDiagnosticSeverity:error/warning/info 三档映射', () => {
    expect(toDiagnosticSeverity('error')).toBe(0);
    expect(toDiagnosticSeverity('warning')).toBe(1);
    expect(toDiagnosticSeverity('info')).toBe(2);
  });

  it('related 面:findings 带 related → 构造 relatedInformation(C-19 双向定位)', () => {
    const doc = defDoc(RICH_DEF);
    const findings = [
      { check: 'def-method-missing-in-python', offset: 4, length: 3, message: 'missing in py', severity: 'warning', related: { file: '/tmp/ws/scripts/base/Avatar.py', className: 'Avatar' } }
    ];
    const out = mergeRustDefFindings(doc, findings as never, []);
    expect(out).toHaveLength(1);
    expect(out[0].relatedInformation).toHaveLength(1);
    expect(out[0].relatedInformation![0].message).toBe('Avatar');
    expect(out[0].relatedInformation![0].location.uri.fsPath).toBe('/tmp/ws/scripts/base/Avatar.py');
  });
});

describe('validateScalarTagValues / validateDefStructure 直接面(覆盖率)', () => {
  it('ast 为 null:早退不产诊断', () => {
    const diagnosticsList: Diagnostic[] = [];
    validateScalarTagValues(defDoc(RICH_DEF), diagnosticsList, { diagnosticsCheckUnknownFlags: true, diagnosticsCheckUnknownDetailLevels: true } as never, null);
    expect(diagnosticsList).toEqual([]);
  });

  it('validateDefStructure:root 空早退;非合法段跳过', () => {
    const diagnosticsList: Diagnostic[] = [];
    validateDefStructure(defDoc(RICH_DEF), diagnosticsList, { diagnosticsCheckDuplicateDefinitions: true, diagnosticsCheckMissingPropertyFields: true } as never, null);
    expect(diagnosticsList).toEqual([]);
    // 只含非符号段(如 <Volatile>,非 ALLOWED_TOP_LEVEL_SECTIONS 面)→ 无诊断
    const volatileDoc = defDoc('<root>\n  <Volatile>\n    <position>1</position>\n  </Volatile>\n</root>');
    const volatileAst = parseDefAst(volatileDoc)!;
    validateDefStructure(volatileDoc, diagnosticsList, { diagnosticsCheckDuplicateDefinitions: true, diagnosticsCheckMissingPropertyFields: true } as never, volatileAst);
    expect(diagnosticsList).toEqual([]);
    // 非合法顶层段(如 <NotASection>,toSectionName → null)→ continue 跳过
    const unknownDoc = defDoc('<root>\n  <NotASection>\n    <x>1</x>\n  </NotASection>\n</root>');
    validateDefStructure(unknownDoc, diagnosticsList, { diagnosticsCheckDuplicateDefinitions: true, diagnosticsCheckMissingPropertyFields: true } as never, parseDefAst(unknownDoc)!);
    expect(diagnosticsList).toEqual([]);
  });

  it('validateTypeNode:value 空/有子元素/关闭未知类型校验 → 早退', () => {
    const diagnosticsList: Diagnostic[] = [];
    const config = { diagnosticsCheckUnknownTypes: false };
    // value 为空
    validateTypeNode(defDoc(RICH_DEF), diagnosticsList, { name: 'Type', children: [] } as never, { builtins: new Set(), customTypes: new Set(), entityTypes: new Set() }, config as never);
    // 有子元素(Type 节点内嵌 <of>)
    validateTypeNode(defDoc(RICH_DEF), diagnosticsList, { name: 'Type', children: [{ kind: 'element', name: 'of' }] } as never, { builtins: new Set(), customTypes: new Set(), entityTypes: new Set() }, { diagnosticsCheckUnknownTypes: true } as never);
    // 校验关闭
    validateTypeNode(defDoc(RICH_DEF), diagnosticsList, { name: 'Type', children: [{ kind: 'text', text: 'VEC3' }] } as never, { builtins: new Set(), customTypes: new Set(), entityTypes: new Set() }, config as never);
    expect(diagnosticsList).toEqual([]);
  });

  it('validateTypeNode:内建命中跳过;resolveCustomTypeReference 状态分支', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-val-ct-'));
    try {
      const defsDir = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(
        path.join(defsDir, 'types.xml'),
        '<root>\n  <CustomT><Properties><x><Type>UINT32</Type></x></Properties></CustomT>\n</root>\n',
        'utf8'
      );
      stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'root', index: 0 } as never];
      const doc = defDoc(RICH_DEF, path.join(defsDir, 'Avatar.def'));
      const diagnosticsList: Diagnostic[] = [];
      // 内建 UINT32 → 命中跳过(不产诊断)
      validateTypeNode(doc, diagnosticsList, { name: 'Type', children: [{ kind: 'text', text: 'UINT32' }] } as never, { builtins: new Set(['UINT32']), customTypes: new Set(['CustomT']), entityTypes: new Set() }, { diagnosticsCheckUnknownTypes: true } as never);
      // 已注册 CustomT(有类型声明)→ resolved 跳过
      validateTypeNode(doc, diagnosticsList, { name: 'Type', children: [{ kind: 'text', text: 'CustomT' }] } as never, { builtins: new Set(), customTypes: new Set(['CustomT']), entityTypes: new Set() }, { diagnosticsCheckUnknownTypes: true } as never);
      expect(diagnosticsList).toEqual([]);
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validateSectionStructure / validatePropertyStructure / 纯函数(覆盖率)', () => {
  it('属性作用域:同名不同作用域不报重复;空作用域不记账', () => {
    const diagnosticsList: Diagnostic[] = [];
    const section = defDoc(
      '<root>\n  <Properties>\n    <p>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </p>\n    <p>\n      <Type>UINT32</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </p>\n    <q>\n      <Type>UINT32</Type>\n      <Flags>NO_SCOPE_FLAG</Flags>\n    </q>\n  </Properties>\n</root>'
    );
    validateSectionStructure(section, diagnosticsList, { children: [] } as never, 'Properties', { diagnosticsCheckDuplicateDefinitions: true, diagnosticsCheckMissingPropertyFields: true } as never);
    expect(diagnosticsList).toEqual([]);
  });

  it('validatePropertyStructure:缺 Type 与缺 Flags 各报一条', () => {
    const diagnosticsList: Diagnostic[] = [];
    const doc = defDoc('<root>\n  <Properties>\n    <x>\n      <Type>UINT32</Type>\n    </x>\n    <y>\n      <Flags>BASE</Flags>\n    </y>\n  </Properties>\n</root>');
    const ast = parseDefAst(doc)!;
    const props = ast.root.children.filter(
      (child): child is import('../src/defParser').DefElementNode =>
        child.kind === 'element' && child.name === 'Properties'
    )[0];
    const propChildren = props.children.filter(
      (child): child is import('../src/defParser').DefElementNode => child.kind === 'element'
    );
    const x = propChildren.find(node => node.name === 'x')!;
    const y = propChildren.find(node => node.name === 'y')!;
    validatePropertyStructure(doc, diagnosticsList, x);
    validatePropertyStructure(doc, diagnosticsList, y);
    expect(diagnosticsList.map(item => item.message)).toEqual([
      '属性 x 缺少 <Flags> 定义',
      '属性 y 缺少 <Type> 定义'
    ]);
  });

  it('getPropertyFlagScopes:空 flags → [];base/cell/client 三作用域', () => {
    expect(getPropertyFlagScopes({ name: 'p', children: [] } as never)).toEqual([]);
    const scopes = getPropertyFlagScopes({
      name: 'p',
      children: [{ kind: 'element', name: 'Flags', children: [{ kind: 'text', text: 'BASE_AND_CLIENT' }] }]
    } as never);
    expect(scopes).toEqual(['base', 'client']);
    // cell-only(CELL_PUBLIC 不在 base/client 集)→ 单 cell 作用域
    const cellOnly = getPropertyFlagScopes({
      name: 'p',
      children: [{ kind: 'element', name: 'Flags', children: [{ kind: 'text', text: 'CELL_PUBLIC' }] }]
    } as never);
    expect(cellOnly).toEqual(['cell']);
  });

  it('normalizePropertyFlag:空/各映射/原样回落', () => {
    expect(normalizePropertyFlag(undefined)).toBeUndefined();
    expect(normalizePropertyFlag('  ')).toBeUndefined();
    expect(normalizePropertyFlag('CELL_AND_CLIENT')).toBe('CELL_PUBLIC_AND_OWN');
    expect(normalizePropertyFlag('CELL_AND_CLIENTS')).toBe('ALL_CLIENTS');
    expect(normalizePropertyFlag('CELL_AND_OTHER_CLIENTS')).toBe('OTHER_CLIENTS');
    expect(normalizePropertyFlag('BASE')).toBe('BASE');
  });

  it('describePropertyScope:标签查表', () => {
    expect(describePropertyScope('base')).toBe('Base');
    expect(describePropertyScope('cell')).toBe('Cell');
    expect(describePropertyScope('client')).toBe('Client');
  });
});

describe('validateEntitiesXmlDocument(覆盖率)', () => {
  it('enableDiagnostics=false:delete 诊断', () => {
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    const collection = new DiagnosticCollection();
    const doc = defDoc('<root><Avatar/></root>', '/tmp/ws/scripts/entities.xml');
    collection.set(doc.uri, [new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 'x', 1)]);
    try {
      validateEntitiesXmlDocument(doc, collection);
      expect(collection.get(doc.uri)).toEqual([]);
    } finally {
      configurationOverrides.clear();
    }
  });

  it('重复登记实体:warning 诊断', () => {
    const collection = new DiagnosticCollection();
    const doc = defDoc(
      '<root>\n  <Avatar/>\n  <Avatar/>\n  <Monster/>\n</root>',
      '/tmp/ws/scripts/entities.xml'
    );
    validateEntitiesXmlDocument(doc, collection);
    const messages = collection.get(doc.uri).map(item => item.message);
    expect(messages.some(m => m.includes('entities.xml 中实体 <Avatar> 重复登记'))).toBe(true);
    expect(messages.length).toBe(1);
  });
});
