/**
 * KSEM-SER-04:createObjFromDict 输入字典绑定 FIXED_DICT schema(纯核心+三面)。
 *
 * 引擎真源(entitydef/datatype.cpp:2673 FixedDictType::createFromStreamEx):
 * hasImpl() 时先按 keyTypes_ 声明序从流建好 wire FixedDict(嵌套 FD 字段递归
 * 同建),再 impl_createObjFromDict(pydict) 交给用户实现——入参收到的正是
 * 带 types.xml 声明键位的传输字典,未声明键下标运行时 KeyError、.get 静默
 * 返默认,静态面是唯一提前可见处。夹具镜像 SER-03(getDictFromObjReturnCheck)
 * 同构;三面接线夹具镜像 STRUCT-02(real workspace + 真实 types.xml 解析)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE,
  computeCreateObjFromDictInputKeyFindings,
  createObjFromDictInputFindingToItem,
  implBindingsForDocument,
  renderFixedDictInputKeyMessage,
  resolveCreateObjFromDictInputBindings,
  resolveCreateObjFromDictInputReceiver
} from '../src/backend/createObjFromDictInput';
import {
  resolveWireDictSubscriptKeyFromContainer,
  type FixedDictChainSegment
} from '../src/backend/fixedDictSubscript';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { PythonDefinitionProvider } from '../src/languageProviders/pythonDefinition';
import { EntityMappingManager } from '../src/entityMapping';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';

const TYPES_FILE = '/entity_defs/types.xml';
const IMPL_FILE = '/serializers_impl.py';

function node(name: string, line: number, children: CustomTypeStructureChild[] = []): CustomTypeStructureNode {
  return { name, rawValue: name, children, line };
}

function scalarField(name: string, typeName: string, line: number): CustomTypePropertyInfo {
  return { name, typeName, line };
}

function customType(
  name: string,
  aliasType: string,
  properties: CustomTypePropertyInfo[],
  line: number,
  implementedBy?: string,
  pythonFilePath?: string
): CustomTypeInfo {
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
    implementedBy,
    pythonFilePath,
    properties
  };
}

const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12),
  scalarField('y', 'FLOAT', 14),
  scalarField('z', 'FLOAT', 16)
], 10, 'serializers_impl.PositionSer', IMPL_FILE);

/** 嵌套字段容器:带 implementedBy——wire 形态照收,与内存形态门互补。 */
const INNER_INFO = customType('INNER_INFO', 'FIXED_DICT', [
  scalarField('hp', 'UINT8', 32),
  scalarField('mp', 'UINT8', 34)
], 30, 'serializers_impl.InnerSer', IMPL_FILE);

const AVATAR_BAG = customType('AVATAR_BAG', 'FIXED_DICT', [
  scalarField('inner', 'INNER_INFO', 52),
  scalarField('uid', 'UINT32', 53)
], 50, 'serializers_impl.BagSer', IMPL_FILE);

/** 过滤面夹具:pythonFilePath 不同 / 无 implementedBy。 */
const REMOTE = customType('REMOTE', 'FIXED_DICT', [scalarField('k', 'STRING', 72)], 70, 'remote.RemoteSer', '/other.py');
const BARE = customType('BARE', 'FIXED_DICT', [scalarField('k', 'STRING', 82)], 80);

const REGISTRY: CustomTypeInfo[] = [POSITION, INNER_INFO, AVATAR_BAG, REMOTE, BARE];

/** 键串内容中列(引号内首字符列),跳过同行更早的同名形态。 */
const keyCol = (line: string, key: string, occurrence = 0): number => {
  let from = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    const found = line.indexOf(`"${key}"`, from);
    if (i === occurrence) {
      return found + 1;
    }
    from = found + 1;
  }
  return -1;
};

const keySeg = (key: string): FixedDictChainSegment => ({
  kind: 'key', key, keyStart: -1, keyEnd: 0, form: 'subscript'
});

// ---------------------------------------------------------------------------
// implBindingsForDocument(注册表 → 本文档绑定面)
// ---------------------------------------------------------------------------

describe('implBindingsForDocument 按文件过滤', () => {
  it('implementedBy 末段符号 + pythonFilePath 过滤', () => {
    const bindings = implBindingsForDocument(REGISTRY, IMPL_FILE);
    expect(bindings.map(b => b.symbol).sort()).toEqual(['BagSer', 'InnerSer', 'PositionSer']);
    expect(bindings.every(b => b.container.pythonFilePath === IMPL_FILE)).toBe(true);
  });

  it('异文件/无 implementedBy:滤除', () => {
    expect(implBindingsForDocument(REGISTRY, '/elsewhere.py')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveCreateObjFromDictInputBindings(绑定面 → 输入绑定)
// ---------------------------------------------------------------------------

describe('resolveCreateObjFromDictInputBindings 绑定推导', () => {
  const bindingsFor = () => implBindingsForDocument(REGISTRY, IMPL_FILE);

  it('唯一类+方法在:入参名与方法体域', () => {
    const text = [
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return wrap(dct["uid"])',
      ''
    ].join('\n');
    const inputs = resolveCreateObjFromDictInputBindings(text, bindingsFor());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].container.name).toBe('AVATAR_BAG');
    expect(inputs[0].symbol).toBe('BagSer');
    expect(inputs[0].paramName).toBe('dct');
    expect(inputs[0].bodyStartLine).toBe(2);
    expect(inputs[0].bodyEndLine).toBe(2);
  });

  it('方法体收尾:def 缩进为界,后续方法不串域', () => {
    const text = [
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return wrap(dct["uid"])',
      '',
      '    def other(self):',
      '        return 1',
      ''
    ].join('\n');
    const inputs = resolveCreateObjFromDictInputBindings(text, bindingsFor());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].bodyEndLine).toBe(2);
  });

  it('多行签名:跨行平衡收括号,入参名取自续行', () => {
    const text = [
      'class BagSer:',
      '    def createObjFromDict(self,',
      '                          dct):',
      '        return wrap(dct["uid"])',
      ''
    ].join('\n');
    const inputs = resolveCreateObjFromDictInputBindings(text, bindingsFor());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].paramName).toBe('dct');
    expect(inputs[0].bodyStartLine).toBe(3);
    expect(inputs[0].bodyEndLine).toBe(3);
  });

  it('注解/默认值形态:剥顶层 `=`/`:`,取形参名', () => {
    const text = [
      'class BagSer:',
      '    def createObjFromDict(self, dct: dict = None):',
      '        return wrap(dct["uid"])',
      ''
    ].join('\n');
    expect(resolveCreateObjFromDictInputBindings(text, bindingsFor())[0]?.paramName).toBe('dct');
  });

  it('静态方法式单参(无 self)也收', () => {
    const text = [
      'class BagSer:',
      '    @staticmethod',
      '    def createObjFromDict(dct):',
      '        return wrap(dct["uid"])',
      ''
    ].join('\n');
    expect(resolveCreateObjFromDictInputBindings(text, bindingsFor())[0]?.paramName).toBe('dct');
  });

  it('可靠上下文门:方法缺失/同名多类/只有 self/*args/收括号未闭 → 零产出', () => {
    const noMethod = [
      'class BagSer:',
      '    def other(self):',
      '        return 1',
      ''
    ].join('\n');
    const duplicated = [
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      '',
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct',
      ''
    ].join('\n');
    const selfOnly = [
      'class BagSer:',
      '    def createObjFromDict(self):',
      '        return {}',
      ''
    ].join('\n');
    const varargs = [
      'class BagSer:',
      '    def createObjFromDict(self, *args, **kwargs):',
      '        return {}',
      ''
    ].join('\n');
    const unclosed = [
      'class BagSer:',
      '    def createObjFromDict(self, dct:',
      '        return wrap(dct["uid"])',
      ''
    ].join('\n');
    expect(resolveCreateObjFromDictInputBindings(noMethod, bindingsFor())).toHaveLength(0);
    expect(resolveCreateObjFromDictInputBindings(duplicated, bindingsFor())).toHaveLength(0);
    expect(resolveCreateObjFromDictInputBindings(selfOnly, bindingsFor())).toHaveLength(0);
    expect(resolveCreateObjFromDictInputBindings(varargs, bindingsFor())).toHaveLength(0);
    expect(resolveCreateObjFromDictInputBindings(unclosed, bindingsFor())).toHaveLength(0);
    expect(resolveCreateObjFromDictInputBindings('class A:\n    pass\n', [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveCreateObjFromDictInputReceiver(三面接收者解析)
// ---------------------------------------------------------------------------

describe('resolveCreateObjFromDictInputReceiver 接收者解析', () => {
  const text = (body: string[]) => [
    'class BagSer:',
    '    def createObjFromDict(self, dct):',
    ...body,
    ''
  ].join('\n');
  const receiverAt = (lines: string[], line: number, receiver: string) => {
    const full = text(lines);
    return resolveCreateObjFromDictInputReceiver(
      full,
      resolveCreateObjFromDictInputBindings(full, implBindingsForDocument(REGISTRY, IMPL_FILE)),
      line,
      receiver
    );
  };

  it('行在方法体内 + 接收者=入参名 → wire 容器', () => {
    const lines = ['        v = dct["uid"]', '        return v'];
    expect(receiverAt(lines, 2, 'dct')?.name).toBe('AVATAR_BAG');
  });

  it('接收者名不符/方法体外/无绑定:不接管', () => {
    const lines = ['        v = dct["uid"]', '        return v'];
    expect(receiverAt(lines, 2, 'obj')).toBeNull();
    expect(receiverAt(lines, 2, 'dct2')).toBeNull();
    expect(
      resolveCreateObjFromDictInputReceiver(text(lines), [], 2, 'dct')
    ).toBeNull();
  });

  it('域外行(邻方法同名形参)不接管', () => {
    const lines = [
      '        v = dct["uid"]',
      '        return v',
      '',
      '    def other(self, dct):',
      '        return dct["uid"]'
    ];
    expect(receiverAt(lines, 5, 'dct')).toBeNull();
    expect(receiverAt(lines, 2, 'dct')?.name).toBe('AVATAR_BAG');
  });

  it('入参重绑定(=/for/with-as)后读取不接管,重绑前仍接管', () => {
    const rebound = ['        a = dct["uid"]', '        dct = self.build()', '        return dct["uid"]'];
    expect(receiverAt(rebound, 2, 'dct')?.name).toBe('AVATAR_BAG');
    expect(receiverAt(rebound, 4, 'dct')).toBeNull();

    const forRebind = ['        for dct in items:', '            pass', '        return dct["uid"]'];
    expect(receiverAt(forRebind, 4, 'dct')).toBeNull();

    const withRebind = ['        with open(p) as dct:', '            pass', '        return dct["uid"]'];
    expect(receiverAt(withRebind, 4, 'dct')).toBeNull();
  });

  it('嵌套 def 域:内层同名形参属内层作用域,不接管;块后行恢复接管', () => {
    const lines = [
      '        def helper(dct):',
      '            return dct["uid"]',
      '        return dct["uid"]'
    ];
    expect(receiverAt(lines, 2, 'dct')).toBeNull();
    expect(receiverAt(lines, 3, 'dct')).toBeNull();
    expect(receiverAt(lines, 4, 'dct')?.name).toBe('AVATAR_BAG');
  });
});

// ---------------------------------------------------------------------------
// resolveWireDictSubscriptKeyFromContainer(wire 形态链,与内存形态门互补)
// ---------------------------------------------------------------------------

describe('resolveWireDictSubscriptKeyFromContainer wire 形态', () => {
  it('implementedBy 容器照收(wire 入参不受内存形态门管辖)', () => {
    const hit = resolveWireDictSubscriptKeyFromContainer(AVATAR_BAG, [], 'uid', REGISTRY);
    expect(hit?.container.name).toBe('AVATAR_BAG');
    expect(hit?.field?.name).toBe('uid');
    expect(hit?.annotation).toBe('int');
  });

  it('嵌套 implementedBy FD 字段链照收(STRUCT-07 边界互补)', () => {
    const hit = resolveWireDictSubscriptKeyFromContainer(AVATAR_BAG, [keySeg('inner')], 'hp', REGISTRY);
    expect(hit?.container.name).toBe('INNER_INFO');
    expect(hit?.field?.name).toBe('hp');
    expect(hit?.annotation).toBe('int');
  });

  it('未知键:容器给出(补全面供全字段),字段落空', () => {
    const hit = resolveWireDictSubscriptKeyFromContainer(AVATAR_BAG, [], 'nope', REGISTRY);
    expect(hit?.container.name).toBe('AVATAR_BAG');
    expect(hit?.field).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeCreateObjFromDictInputKeyFindings(诊断面)
// ---------------------------------------------------------------------------

describe('computeCreateObjFromDictInputKeyFindings 未声明键校验', () => {
  const findingsOf = (lines: string[]) => {
    const text = lines.join('\n');
    return computeCreateObjFromDictInputKeyFindings(
      text,
      resolveCreateObjFromDictInputBindings(text, implBindingsForDocument(REGISTRY, IMPL_FILE)),
      REGISTRY
    );
  };

  it('下标形态未声明键:锚键串位,容器/来源/消息记账', () => {
    const lines = [
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return Vector(dct["x"], dct["w"])'
    ];
    const findings = findingsOf(lines);
    expect(findings).toHaveLength(1);
    const line = lines[2];
    expect(findings[0].key).toBe('w');
    expect(findings[0].container).toBe('POSITION');
    expect(findings[0].line).toBe(2);
    expect(findings[0].character).toBe(line.indexOf('"w"') + 1);
    expect(findings[0].length).toBe(1);
    expect(findings[0].source).toBe('types.xml:10');
    expect(findings[0].message).toContain('POSITION');
    expect(findings[0].message).toContain('"w"');
  });

  it('.get 形态与 .get 链同面', () => {
    const single = findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct.get("w")'
    ]);
    expect(single).toHaveLength(1);
    expect(single[0].key).toBe('w');

    const chained = findingsOf([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct.get("inner").get("w2")'
    ]);
    expect(chained).toHaveLength(1);
    expect(chained[0].key).toBe('w2');
    expect(chained[0].container).toBe('INNER_INFO');
  });

  it('声明键读取:零产出(wire 键位=types.xml 声明字段)', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return Vector(dct["x"], dct["y"], dct["z"])'
    ])).toHaveLength(0);
  });

  it('嵌套链首段未声明:即报并止链(后段基于错误前缀不猜)', () => {
    const findings = findingsOf([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["bogus"]["uid"]'
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('bogus');
    expect(findings[0].container).toBe('AVATAR_BAG');
  });

  it('嵌套链内层未声明:容器落位内层', () => {
    const findings = findingsOf([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"]["mp2"]'
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].container).toBe('INNER_INFO');
    expect(findings[0].key).toBe('mp2');
  });

  it('嵌套 implementedBy 容器照收(声明键穿内层,零产出)', () => {
    expect(findingsOf([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["inner"]["hp"] + dct["inner"]["mp"]'
    ])).toHaveLength(0);
  });

  it('赋值目标键不判(写入面外);+=/== 照判(运行时先读键)', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["w"] = 1',
      '        dct["x"] = 2'
    ])).toHaveLength(0);

    const augmented = findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        dct["w"] += 1'
    ]);
    expect(augmented).toHaveLength(1);
    expect(augmented[0].key).toBe('w');

    const compared = findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["w"] == 1'
    ]);
    expect(compared).toHaveLength(1);
    expect(compared[0].key).toBe('w');
  });

  it('表达式/数字/变量下标:键静态不可知,断链不判', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct[var]',
      '        # + dct[0] / dct[i + 1] 同面断链',
      '        x = dct[0]',
      '        y = dct[i + 1]'
    ])).toHaveLength(0);
  });

  it('注释/字符串位掩码核验:假形态不判', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        # dct["w"]',
      '        s = "dct[\\"w\\"]"',
      '        return dct["x"]'
    ])).toHaveLength(0);
  });

  it('入参重绑定后读取不判(=/for/with)', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        dct = self.build()',
      '        return dct["w"]'
    ])).toHaveLength(0);

    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        for dct in items:',
      '            pass',
      '        return dct["w"]'
    ])).toHaveLength(0);
  });

  it('嵌套 def 域与邻方法域:读取不判', () => {
    expect(findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        def helper(dct):',
      '            return dct["w"]',
      '        return dct["x"]',
      '',
      '    def other(self, dct):',
      '        return dct["w"]'
    ])).toHaveLength(0);
  });

  it('同行多接收者:各判各', () => {
    const findings = findingsOf([
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["w"] + dct["w2"] + obj["w"]'
    ]);
    expect(findings.map(f => f.key).sort()).toEqual(['w', 'w2']);
  });
});

describe('createObjFromDictInputFindingToItem 与消息模板', () => {
  it('形状与构造点同构,code=kbengine.fixedDictInputKeySchema', () => {
    const lines = [
      'class PositionSer:',
      '    def createObjFromDict(self, dct):',
      '        return dct["w"]'
    ];
    const text = lines.join('\n');
    const findings = computeCreateObjFromDictInputKeyFindings(
      text,
      resolveCreateObjFromDictInputBindings(text, implBindingsForDocument(REGISTRY, IMPL_FILE)),
      REGISTRY
    );
    expect(findings).toHaveLength(1);
    const item = createObjFromDictInputFindingToItem(findings[0]);
    expect(item.code).toBe(FIXED_DICT_INPUT_KEY_SCHEMA_DIAGNOSTIC_CODE);
    expect(item.severity).toBe('Warning');
    expect(item.source).toBe('kbengine');
    expect(item.range.start.line).toBe(2);
    expect(item.range.start.character).toBe(lines[2].indexOf('"w"') + 1);
    expect(item.range.end.character).toBe(lines[2].indexOf('"w"') + 2);
  });

  it('消息模板单一来源:容器/键/声明位置注入', () => {
    const message = renderFixedDictInputKeyMessage('POSITION', 'w', 'types.xml:10');
    expect(message).toContain('POSITION');
    expect(message).toContain('"w"');
    expect(message).toContain('types.xml:10');
  });
});

// ---------------------------------------------------------------------------
// Provider 三面接线(真实 EntityMappingManager + 真实 types.xml 解析)
// ---------------------------------------------------------------------------

describe('KSEM-SER-04 Provider 三面(补全/跳转/悬停)', () => {
  const ORIGINAL_FIND_FILES = workspace.findFiles;
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;

  let root = '';
  let typesXmlLines: string[] = [];

  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ser04-'));
    const typesXml = [
      '<root>',
      '  <POSITION>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type> FLOAT </Type>',
      '      </x>',
      '    </Properties>',
      '  </POSITION>',
      '  <INNER_INFO>',
      '    FIXED_DICT',
      '    <implementedBy>serializers_impl.InnerSer</implementedBy>',
      '    <Properties>',
      '      <hp>',
      '        <Type> UINT8 </Type>',
      '      </hp>',
      '      <mp>',
      '        <Type> UINT8 </Type>',
      '      </mp>',
      '    </Properties>',
      '  </INNER_INFO>',
      '  <AVATAR_BAG>',
      '    FIXED_DICT',
      '    <implementedBy>serializers_impl.BagSer</implementedBy>',
      '    <Properties>',
      '      <inner>',
      '        <Type> INNER_INFO </Type>',
      '      </inner>',
      '      <uid>',
      '        <Type> UINT32 </Type>',
      '      </uid>',
      '    </Properties>',
      '  </AVATAR_BAG>',
      '</root>'
    ].join('\n');
    put('scripts/entity_defs/types.xml', typesXml);
    put('scripts/entities.xml', '<root>\n  <Avatar hasBase="true" hasCell="true"/>\n</root>');
    put('scripts/cell/Avatar.py', 'class Avatar(object):\n    pass\n');
    put(
      'scripts/entity_defs/Avatar.def',
      [
        '<root>',
        '  <Properties>',
        '    <pos><Type>POSITION</Type><Flags>CELL_PUBLIC</Flags></pos>',
        '    <bag><Type>AVATAR_BAG</Type><Flags>CELL_PUBLIC</Flags></bag>',
        '    <hp><Type>UINT16</Type><Flags>CELL_PUBLIC</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    );
    // implementedBy 模块实文件落盘:pythonFilePath 绑定按磁盘存在性建立
    put(
      'scripts/user_type/serializers_impl.py',
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        return wrap(dct["uid"])',
        '',
        '    def getDictFromObj(self, obj):',
        '        return {"uid": 1, "inner": {"hp": 2, "mp": 3}}',
        '',
        '    def isSameType(self, obj):',
        '        return True',
        ''
      ].join('\n')
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ser04', index: 0 }];
    const walkDefs = (dir: string, results: Uri[]): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDefs(full, results);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    workspace.findFiles = (async () => {
      const results: Uri[] = [];
      walkDefs(root, results);
      return results;
    }) as unknown as typeof workspace.findFiles;
    typesXmlLines = typesXml.split('\n');
  });

  afterEach(() => {
    workspace.findFiles = ORIGINAL_FIND_FILES;
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  /** types.xml 里标记行(1 起)——跳转/补全 detail 的期望行号单一来源 */
  const xmlLine = (marker: string): number => typesXmlLines.findIndex(line => line.includes(marker)) + 1;

  /** 测试文档即 implementedBy 模块本身(pythonFilePath 绑定面的文件) */
  const serDoc = (text: string) =>
    makeTextDocument(`${text}\n`, {
      fileName: path.join(root, 'scripts', 'user_type', 'serializers_impl.py'),
      languageId: 'python'
    });

  const manager = () => new EntityMappingManager({ subscriptions: [] } as never);

  type CompletionLike = { label: string; detail?: string };

  const completeIn = async (docText: string, line: number, character: number) => {
    const provider = new KBEngineCompletionProvider(manager());
    const items = (await provider.provideCompletionItems(
      serDoc(docText),
      new Position(line, character)
    )) as CompletionLike[] | undefined;
    return items ?? [];
  };

  it('补全面:入参名开键串 → 声明字段(detail=值注解 · types.xml 声明行)', async () => {
    const first = await completeIn(
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        v = dct["'
      ].join('\n'),
      2,
      '        v = dct["'.length
    );
    expect(first.map(item => item.label).sort()).toEqual(['inner', 'uid']);
    const uid = first.find(item => item.label === 'uid');
    expect(uid?.detail).toBe(`int · types.xml:${xmlLine('<uid>')}`);
  });

  it('补全面:嵌套链穿透 implementedBy 容器(与内存形态门互补)', async () => {
    const nested = await completeIn(
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        v = dct["inner"]["'
      ].join('\n'),
      2,
      '        v = dct["inner"]["'.length
    );
    expect(nested.map(item => item.label).sort()).toEqual(['hp', 'mp']);
    const hp = nested.find(item => item.label === 'hp');
    expect(hp?.detail).toBe(`int · types.xml:${xmlLine('<hp>')}`);
  });

  it('补全面诚实边界:重绑后/域外/非入参接收者不接管', async () => {
    const rebound = await completeIn(
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        dct = {}',
        '        v = dct["'
      ].join('\n'),
      3,
      '        v = dct["'.length
    );
    expect(rebound.map(item => item.label)).not.toContain('uid');

    const outside = await completeIn(
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        return wrap(dct["uid"])',
        '',
        '    def other(self, dct):',
        '        return dct["'
      ].join('\n'),
      5,
      '        return dct["'.length
    );
    expect(outside.map(item => item.label)).not.toContain('uid');

    const otherReceiver = await completeIn(
      [
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        v = payload["'
      ].join('\n'),
      2,
      '        v = payload["'.length
    );
    expect(otherReceiver.map(item => item.label)).not.toContain('uid');
  });

  it('跳转面:键 → types.xml 字段声明行(逐层容器归位)', async () => {
    const line = '        v = dct["inner"]["hp"]';
    const doc = serDoc([
      'class BagSer:',
      '    def createObjFromDict(self, dct):',
      line,
      '        return v'
    ].join('\n'));
    const provider = new PythonDefinitionProvider(manager(), undefined, undefined);
    const traced = await provider.provideDefinitionTraced(doc, new Position(2, keyCol(line, 'hp')));
    expect(traced.location?.uri.fsPath).toBe(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
    expect(traced.location?.range.start.line).toBe(xmlLine('<hp>') - 1);
    expect(traced.layers[0]).toMatchObject({ layer: 'fixeddict-key', status: 'hit' });

    const outer = await provider.provideDefinitionTraced(doc, new Position(2, keyCol(line, 'inner')));
    expect(outer.location?.range.start.line).toBe(xmlLine('<inner>') - 1);

    const unknownTraced = await provider.provideDefinitionTraced(
      serDoc([
        'class BagSer:',
        '    def createObjFromDict(self, dct):',
        '        return dct["nope"]',
        ''
      ].join('\n')),
      new Position(2, keyCol('        return dct["nope"]', 'nope'))
    );
    expect(unknownTraced.layers.some(layer => layer.layer === 'fixeddict-key' && layer.status === 'hit')).toBe(false);
  });

  it('悬停面:键类型 + 声明位置(嵌套链与外层容器键同面)', async () => {
    const hoverAt = async (lines: string[], line: number, character: number) => {
      const provider = new KBEngineHoverProvider(manager());
      const hover = (await provider.provideHover(serDoc(lines.join('\n')) as never, new Position(line, character))) as
        | { contents?: unknown }
        | null;
      const contents = hover?.contents as unknown;
      const parts = Array.isArray(contents) ? contents : contents !== undefined ? [contents] : [];
      const first = parts[0] as { value?: string } | undefined;
      return first?.value ?? null;
    };

    const nestedLine = '        v = dct["inner"]["hp"]';
    const nested = await hoverAt(
      ['class BagSer:', '    def createObjFromDict(self, dct):', nestedLine, '        return v'],
      2,
      keyCol(nestedLine, 'hp')
    );
    expect(nested).toContain('**hp: int**');
    expect(nested).toContain(`types.xml:${xmlLine('<hp>')}`);

    const outerKey = await hoverAt(
      ['class BagSer:', '    def createObjFromDict(self, dct):', nestedLine, '        return v'],
      2,
      keyCol(nestedLine, 'inner')
    );
    expect(outerKey).toContain('**inner: INNER_INFO**');

    const unknown = (await hoverAt(
      ['class BagSer:', '    def createObjFromDict(self, dct):', '        return dct["nope"]'],
      2,
      keyCol('        return dct["nope"]', 'nope')
    )) ?? '';
    expect(unknown).not.toContain('**nope:');
  });
});
