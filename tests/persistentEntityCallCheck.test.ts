/**
 * RUST-177/KBE-007:def 属性持久化×ENTITYCALL 静默降级检查。
 * 引擎真源:属性显式 `<Persistent>true</Persistent>`(tolower 恒等口径,
 * entitydef.cpp:1181-1187)且属性自身类型(含 types.xml 别名链末端)解析到
 * ENTITYCALL 时,PropertyDescription 构造**无日志静默 isPersistent=false**
 * (property.cpp:48-51)——用户以为字段会持久化,实际不会。
 * 边界钉:数组属性不触发引擎判定(getName() 是 ARRAY 形态)如实不报;
 * 别名链断链/环链按不可解处理不炸;`<Persistent>` 缺省/非 'true'(含
 * '1'/'yes')一律不报——引擎就是不开。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computePersistentEntityCallFindings,
  PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE
} from '../src/backend/persistentEntityCallCheck';
import { appendPersistentEntityCallDiagnostics } from '../src/languageProviders/validation';
import type {
  CustomTypeInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';
import {
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  configurationOverrides,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// ---------------------------------------------------------------------------
// 内联注册表夹具(镜像 scalarAssignCheck.test.ts 的 CustomTypeInfo 形状)
// ---------------------------------------------------------------------------

const TYPES_FILE = '/entity_defs/types.xml';

function node(name: string, line: number, children: CustomTypeStructureChild[] = []): CustomTypeStructureNode {
  return { name, rawValue: name, children, line };
}

function customType(name: string, aliasType: string, line = 0): CustomTypeInfo {
  return {
    name,
    filePath: TYPES_FILE,
    line,
    implementedByLine: line,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: '',
    structure: node(aliasType, line),
    properties: []
  };
}

const REGISTRY: CustomTypeInfo[] = [
  customType('HOME_TARGET', 'ENTITYCALL', 5),
  customType('HOME_TARGET_ALIAS', 'HOME_TARGET', 6),
  customType('HP', 'UINT32', 7),
  customType('BROKEN', 'GHOST_NAME', 8),
  customType('LOOP_A', 'LOOP_B', 9),
  customType('LOOP_B', 'LOOP_A', 10)
];

const check = (text: string) => computePersistentEntityCallFindings(text, REGISTRY);

/** 单属性 def 夹具(Persistent 段可模板替换) */
const defWith = (typeName: string, persistent: string | null): string => {
  const lines = [
    '<root>',
    '  <Properties>',
    '    <home>',
    `      <Type>${typeName}</Type>`
  ];
  if (persistent !== null) {
    lines.push(`      <Persistent>${persistent}</Persistent>`);
  }
  lines.push('    </home>', '  </Properties>', '</root>');
  return lines.join('\n');
};

describe('RUST-177 Persistent×ENTITYCALL 静默降级(纯核)', () => {
  it('直书 ENTITYCALL + Persistent true:finding,锚 <Persistent> 元素区间', () => {
    const text = defWith('ENTITYCALL', 'true');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].propertyName).toBe('home');
    expect(findings[0].declaredType).toBe('ENTITYCALL');
    expect(findings[0].message).toContain('property.cpp:48-51');
    expect(text.slice(findings[0].offset, findings[0].offset + findings[0].length)).toBe(
      '<Persistent>true</Persistent>'
    );
  });

  it('别名链末端 ENTITYCALL:finding,declaredType 保留原样文本', () => {
    const text = defWith('HOME_TARGET', 'true');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].declaredType).toBe('HOME_TARGET');
  });

  it('两级别名链末端 ENTITYCALL:同命中', () => {
    expect(check(defWith('HOME_TARGET_ALIAS', 'true'))).toHaveLength(1);
  });

  it('Persistent 缺省/false:引擎不开持久化,零发现', () => {
    expect(check(defWith('ENTITYCALL', null))).toEqual([]);
    expect(check(defWith('ENTITYCALL', 'false'))).toEqual([]);
  });

  it('Persistent TRUE/True:tolower 恒等口径(entitydef.cpp:1181-1187),照命中', () => {
    expect(check(defWith('ENTITYCALL', 'TRUE'))).toHaveLength(1);
    expect(check(defWith('ENTITYCALL', 'True'))).toHaveLength(1);
  });

  it('Persistent 1/yes:引擎不认、不开持久化,诚实不报', () => {
    expect(check(defWith('ENTITYCALL', '1'))).toEqual([]);
    expect(check(defWith('ENTITYCALL', 'yes'))).toEqual([]);
  });

  it('内联 ARRAY 属性(元素是 ENTITYCALL):引擎判定对象是属性自身 getName()(ARRAY 形态),不报', () => {
    const text = [
      '<root>',
      '  <Properties>',
      '    <homes>',
      '      <Type>',
      '        ARRAY',
      '        <of>ENTITYCALL</of>',
      '      </Type>',
      '      <Persistent>true</Persistent>',
      '    </homes>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    expect(check(text)).toEqual([]);
  });

  it('普通别名(UINT32)/内建标量:零发现', () => {
    expect(check(defWith('HP', 'true'))).toEqual([]);
    expect(check(defWith('UINT32', 'true'))).toEqual([]);
  });

  it('断链别名(目标不存在):不可解,零发现不炸', () => {
    expect(check(defWith('BROKEN', 'true'))).toEqual([]);
  });

  it('环链别名:visited 有界,零发现不炸', () => {
    expect(check(defWith('LOOP_A', 'true'))).toEqual([]);
  });

  it('属性无 <Type>:归 unknown-type 车道,不在此声称', () => {
    const text = [
      '<root>',
      '  <Properties>',
      '    <home>',
      '      <Persistent>true</Persistent>',
      '    </home>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    expect(check(text)).toEqual([]);
  });

  it('无 Properties 段 / 无 root:空数组', () => {
    expect(check(['<root>', '</root>'].join('\n'))).toEqual([]);
    expect(check('')).toEqual([]);
  });
});

describe('RUST-177 appendPersistentEntityCallDiagnostics(装配面)', () => {
  let root = '';

  const DEF_TRAP = [
    '<root>',
    '  <Properties>',
    '    <home>',
    '      <Type>HOME_TARGET</Type>',
    '      <Persistent>true</Persistent>',
    '    </home>',
    '  </Properties>',
    '</root>'
  ].join('\n');

  const DEF_FIXED = DEF_TRAP.replace('<Persistent>true</Persistent>', '<Persistent>false</Persistent>');

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rust177-persistent-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entity_defs', 'types.xml'),
      '<root>\n  <HOME_TARGET>ENTITYCALL</HOME_TARGET>\n</root>\n',
      'utf8'
    );
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    stubWorkspace.workspaceFolders = [];
  });

  const defDoc = (text: string) =>
    makeTextDocument(text, {
      fileName: path.join(root, 'scripts', 'entity_defs', 'Avatar.def'),
      languageId: 'kbengine-def'
    });

  it('注册表快照接线:别名链末端 ENTITYCALL → Warning 追加进主 collection', () => {
    const collection = new DiagnosticCollection();
    const document = defDoc(DEF_TRAP);
    appendPersistentEntityCallDiagnostics(document, collection);
    const items = collection.get(document.uri);
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe(PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE);
    expect(items[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(document.offsetAt(items[0].range.start)).toBe(DEF_TRAP.indexOf('<Persistent>'));
  });

  it('幂等重入:重复调用不翻倍', () => {
    const collection = new DiagnosticCollection();
    const document = defDoc(DEF_TRAP);
    appendPersistentEntityCallDiagnostics(document, collection);
    appendPersistentEntityCallDiagnostics(document, collection);
    expect(collection.get(document.uri)).toHaveLength(1);
  });

  it('零发现清旧项:修掉 Persistent 后同一 uri 诊断消失', () => {
    const collection = new DiagnosticCollection();
    appendPersistentEntityCallDiagnostics(defDoc(DEF_TRAP), collection);
    const document = defDoc(DEF_FIXED);
    appendPersistentEntityCallDiagnostics(document, collection);
    expect(collection.get(document.uri)).toEqual([]);
  });

  it('enableDiagnostics=false:不动 collection', () => {
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    const collection = new DiagnosticCollection();
    const document = defDoc(DEF_TRAP);
    collection.set(document.uri, [
      new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 'x', DiagnosticSeverity.Warning)
    ]);
    try {
      appendPersistentEntityCallDiagnostics(document, collection);
      expect(collection.get(document.uri)).toHaveLength(1);
    } finally {
      configurationOverrides.clear();
    }
  });

  it('types.xml 注册表空(无工作区):不造诊断,既有项原样保留', () => {
    const saved = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    const collection = new DiagnosticCollection();
    const document = defDoc(DEF_TRAP);
    collection.set(document.uri, [
      new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 'keep', DiagnosticSeverity.Warning)
    ]);
    try {
      appendPersistentEntityCallDiagnostics(document, collection);
      const items = collection.get(document.uri);
      expect(items).toHaveLength(1);
      expect(items[0].message).toBe('keep');
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });
});
