import { describe, expect, it } from 'vitest';
import {
  LocalDefinitionSemantics,
  parseLocalDefinition
} from '../src/definitionSemantics';
import {
  buildMessageTable,
  DefTreeSource,
  MessageMethodEntry,
  MessageTable,
  MessageTableIssueKind,
  renderMessageTableJson,
  renderMessageTableMarkdown
} from '../src/messageTable';

/** 内存 def 树:键 "entity:名"/"interface:名" → def 全文 */
function createSource(files: Record<string, string>): DefTreeSource {
  return {
    loadDef(name, kind) {
      const content = files[`${kind}:${name}`];
      if (content === undefined) {
        return null;
      }
      return parseLocalDefinition(content, kind, name, `/defs/${kind}s/${name}.def`);
    }
  };
}

/** 控制文件路径形态(反斜杠归一化用例) */
function createSourceWithPaths(
  files: Record<string, { content: string; path: string }>
): DefTreeSource {
  return {
    loadDef(name, kind) {
      const file = files[`${kind}:${name}`];
      if (!file) {
        return null;
      }
      return parseLocalDefinition(file.content, kind, name, file.path);
    }
  };
}

function methodOf(table: MessageTable, name: string): MessageMethodEntry {
  const method = table.methods.find(entry => entry.name === name);
  if (!method) {
    throw new Error(`method ${name} not found`);
  }
  return method;
}

function issuesOfKind(table: MessageTable, kind: MessageTableIssueKind) {
  return table.issues.filter(issue => issue.kind === kind);
}

describe('messageTable 基础装配', () => {
  it('实体 def 不存在返回 null', () => {
    expect(buildMessageTable('Ghost', createSource({}))).toBeNull();
  });

  it('非法 XML def:文档根缺失按空 def 装载,rootName 兜底空串', () => {
    const table = buildMessageTable('Broken', createSource({ 'entity:Broken': 'not xml' }))!;
    expect(table.module).toBe('Broken');
    expect(table.properties).toHaveLength(0);
    expect(table.methods).toHaveLength(0);
    expect(table.issues).toHaveLength(0);
    expect(table.loadFailed).toBe(false);
    expect(table.sources).toEqual([{ name: 'Broken', kind: 'own', filePath: '/defs/entitys/Broken.def' }]);
  });

  it('空 def:21 基元占 1-21,无方法无问题,装载通过', () => {
    const table = buildMessageTable('Empty', createSource({ 'entity:Empty': '<root></root>' }))!;
    expect(table.module).toBe('Empty');
    expect(table.methods).toHaveLength(0);
    expect(table.clientMethods).toHaveLength(0);
    expect(table.clientProperties).toHaveLength(0);
    expect(table.issues).toHaveLength(0);
    expect(table.loadFailed).toBe(false);
    expect(table.fatalCount).toBe(0);
    expect(typeof table.generatedAt).toBe('string');
    expect(table.aliasIdEnabled).toBe(false);

    expect(table.types).toHaveLength(21);
    expect(table.types[0]).toMatchObject({ name: 'UINT8', utype: 1, kind: 'primitive' });
    expect(table.types[2]).toMatchObject({ name: 'UINT64', utype: 3 });
    expect(table.types[9]).toMatchObject({ name: 'UNICODE', utype: 10 });
    expect(table.types[16]).toMatchObject({ name: 'ENTITYCALL', utype: 17 });
    expect(table.types[20]).toMatchObject({ name: 'VECTOR4', utype: 21, aliasedTo: null });

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('# 消息编号表 — Empty');
    expect(markdown).toContain('通过(无致命问题)');
    expect(markdown).toContain('(无客户端可见方法)');
    expect(markdown).toContain('aliasID 关闭:引擎 entitydefAliasID 默认关');
    expect(markdown).toContain('基元');
    expect(markdown).not.toContain('装配序');
  });
});

describe('utype 分配与客户端可见性', () => {
  const files = {
    'entity:E': [
      '<root>',
      '  <CellMethods>',
      '    <onTick></onTick>',
      '    <onMove><Exposed/></onMove>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <reqQuest><Exposed/></reqQuest>',
      '    <save></save>',
      '  </BaseMethods>',
      '  <ClientMethods>',
      '    <onUpdate></onUpdate>',
      '  </ClientMethods>',
      '</root>'
    ].join('\n')
  };

  it('自动分配按 Cell→Base→Client 顺序连续编号', () => {
    const table = buildMessageTable('E', createSource(files))!;
    expect(methodOf(table, 'onTick').utype).toBe(1);
    expect(methodOf(table, 'onMove').utype).toBe(2);
    expect(methodOf(table, 'reqQuest').utype).toBe(3);
    expect(methodOf(table, 'save').utype).toBe(4);
    expect(methodOf(table, 'onUpdate').utype).toBe(5);
  });

  it('客户端可见子集与方向标记', () => {
    const table = buildMessageTable('E', createSource(files))!;
    expect(table.clientMethods.map(method => method.name).sort())
      .toEqual(['onMove', 'onUpdate', 'reqQuest']);

    const onTick = methodOf(table, 'onTick');
    expect(onTick.direction).toBe('server-internal');
    expect(onTick.visibleToClient).toBe(false);
    expect(methodOf(table, 'onMove').direction).toBe('client-to-server');
    expect(methodOf(table, 'onUpdate').direction).toBe('server-to-client');
    expect(methodOf(table, 'onMove').visibleToClient).toBe(true);

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('服务器内部方法');
    expect(markdown).toContain('| onTick |');
    expect(markdown).toContain('| save |');
  });

  it('显式 Utype 占号,后续自动分配跳过已占用;0 与非数字视同未设置', () => {
    const source = createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <one><Utype>1</Utype></one>',
        '    <a><Utype>10</Utype></a>',
        '    <b><Utype>abc</Utype></b>',
        '  </CellMethods>',
        '  <BaseMethods>',
        '    <c><Utype>0</Utype></c>',
        '    <d></d>',
        '  </BaseMethods>',
        '</root>'
      ].join('\n')
    });
    const table = buildMessageTable('E', source)!;
    const one = methodOf(table, 'one');
    expect(one.utype).toBe(1);
    expect(one.declaredUtype).toBe(1);
    const a = methodOf(table, 'a');
    expect(a.utype).toBe(10);
    expect(a.declaredUtype).toBe(10);
    // 自动分配:计数器 1 被显式占用,跳到 2
    expect(methodOf(table, 'b').utype).toBe(2);
    const c = methodOf(table, 'c');
    expect(c.declaredUtype).toBeNull();
    expect(c.utype).toBe(3);
    expect(methodOf(table, 'd').utype).toBe(4);
  });

  it('显式 Utype 重复:引擎 Conflict 报错,第二个方法不添加', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <m1><Utype>5</Utype></m1>',
        '    <m2><Utype>5</Utype></m2>',
        '    <m3></m3>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const conflicts = issuesOfKind(table, 'utype-conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].message)
      .toBe("EntityDef::loadDefCellMethods: E.m2, 'Utype' 5 Conflict(E.m1 'Utype' 5)!");
    expect(conflicts[0].fatal).toBe(true);
    const m2 = methodOf(table, 'm2');
    expect(m2.status).toBe('utype-conflict');
    expect(m2.utype).toBeNull();
    expect(table.loadFailed).toBe(true);
    expect(table.fatalCount).toBe(1);
    // 冲突方法不占新号,后续自动分配从最小未占用继续
    expect(methodOf(table, 'm3').utype).toBe(1);
  });

  it('显式 Utype 溢出(>65535)报溢出', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Utype>65536</Utype></m></CellMethods></root>'
    }))!;
    const overflows = issuesOfKind(table, 'utype-overflow');
    expect(overflows[0].message)
      .toBe("EntityDef::loadDefCellMethods: 'Utype' has overflowed(65536 > 65535), is E.m!");
    expect(methodOf(table, 'm').status).toBe('utype-overflow');
    expect(methodOf(table, 'm').utype).toBeNull();
  });
});

describe('参数序列', () => {
  it('未知参数类型:dataType[X] not found,方法不添加且名字可复用', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <foo><Arg>FOO</Arg></foo>',
        '    <foo2></foo2>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'unknown-arg-type');
    expect(issues[0].message)
      .toBe('EntityDef::loadDefCellMethods: dataType[FOO] not found, in foo!');
    const foo = methodOf(table, 'foo');
    expect(foo.status).toBe('arg-load-failed');
    expect(foo.args[0]).toMatchObject({ name: 'FOO', utype: null, ofType: null });
    expect(foo.utype).toBeNull();
    // 失败方法不占号:foo2 自动拿 1
    expect(methodOf(table, 'foo2').utype).toBe(1);
  });

  it('ARRAY of 链:内联类型逐参占 DataType utype,嵌套注册 _X_ArrayType', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <m1>',
        '      <Arg>ARRAY<of>UINT8</of></Arg>',
        '    </m1>',
        '    <m2>',
        '      <Arg>ARRAY<of>ARRAY<of>INT32</of></of></Arg>',
        '    </m2>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues).toHaveLength(0);

    const m1 = methodOf(table, 'm1');
    expect(m1.args[0]).toMatchObject({
      name: 'ARRAY',
      utype: 22,
      ofType: { name: 'UINT8', utype: 1, ofType: null }
    });
    const m2 = methodOf(table, 'm2');
    expect(m2.args[0]).toMatchObject({
      name: 'ARRAY',
      utype: 23,
      ofType: { name: 'ARRAY', utype: 24, ofType: { name: 'INT32', utype: 7, ofType: null } }
    });

    const userTypes = table.types.filter(type => type.utype >= 22);
    expect(userTypes).toEqual([
      { name: 'E_m1', utype: 22, kind: 'inline-array', aliasedTo: null, line: userTypes[0].line, origin: 'E' },
      { name: 'E_m2', utype: 23, kind: 'inline-array', aliasedTo: null, line: userTypes[1].line, origin: 'E' },
      { name: '_E_m2_ArrayType', utype: 24, kind: 'inline-array', aliasedTo: null, line: userTypes[2].line, origin: 'E' }
    ]);

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('(ARRAY of UINT8#1#22)');
    expect(markdown).toContain('(ARRAY of ARRAY of INT32#7#24#23)');
  });

  it('ARRAY 缺 of:两条引擎报错,内联类型仍占号', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Arg>ARRAY</Arg></m></CellMethods></root>'
    }))!;
    expect(table.issues.map(issue => issue.kind))
      .toEqual(['array-of-missing', 'unknown-arg-type']);
    expect(table.issues[0].message).toBe('FixedArrayType::initialize: not found "of".');
    expect(table.issues[1].message)
      .toBe('EntityDef::loadDefCellMethods: dataType[ARRAY] not found, in m!');
    const m = methodOf(table, 'm');
    expect(m.args[0].utype).toBeNull();
    expect(m.status).toBe('arg-load-failed');
    expect(table.types.some(type => type.name === 'E_m' && type.utype === 22)).toBe(true);
    expect(renderMessageTableMarkdown(table)).toContain('ARRAY?');
  });

  it('ARRAY 空 of:key[ARRAY] did not find type[]!', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Arg>ARRAY<of></of></Arg></m></CellMethods></root>'
    }))!;
    expect(table.issues.map(issue => issue.kind))
      .toEqual(['array-of-unknown-type', 'unknown-arg-type']);
    expect(table.issues[0].message)
      .toBe('FixedArrayType::initialize: key[ARRAY] did not find type[]!');
  });

  it('ARRAY of 未知类型:initialize 报错 + 共享 dataType[ARRAY] 报错', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Arg>ARRAY<of>UFO</of></Arg></m></CellMethods></root>'
    }))!;
    expect(table.issues.map(issue => issue.kind))
      .toEqual(['array-of-unknown-type', 'unknown-arg-type']);
    expect(table.issues[0].message)
      .toBe('FixedArrayType::initialize: key[ARRAY] did not find type[UFO]!');
  });

  it('嵌套缺内层 of:子先报 not found "of".、父补 Array is wrong.、顶层补 dataType[ARRAY]', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Arg>ARRAY<of>ARRAY</of></Arg></m></CellMethods></root>'
    }))!;
    expect(table.issues.map(issue => issue.kind))
      .toEqual(['array-of-missing', 'array-init-failed', 'unknown-arg-type']);
    expect(table.issues[1].message).toBe('FixedArrayType::initialize: Array is wrong.');
    // 外层与嵌套级各占一个内联 utype
    expect(table.types.map(type => type.name).filter(name => name.includes('_m_')))
      .toEqual(['_E_m_ArrayType']);
    expect(table.types.filter(type => type.utype >= 22)).toHaveLength(2);
  });

  it('嵌套叶子未知:叶子报 key 错、逐层补 Array is wrong.、顶层补 dataType[ARRAY]', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <m><Arg>ARRAY<of>ARRAY<of>UFO</of></of></Arg></m>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues.map(issue => issue.kind))
      .toEqual(['array-of-unknown-type', 'array-init-failed', 'unknown-arg-type']);
    expect(table.issues[0].message)
      .toBe('FixedArrayType::initialize: key[ARRAY] did not find type[UFO]!');
  });
});

describe('名字冲突', () => {
  it('同段同名:[X] is exist!,第二个方法不添加', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <m></m>',
        '    <m></m>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'method-name-conflict');
    expect(issues[0].message).toBe('ScriptDefModule::addCellMethodDescription: [m] is exist!');
    expect(methodOf(table, 'm').utype).toBe(1);
    // 第二个同名的 entry utype 未分配(载入失败)
    const entries = table.methods.filter(entry => entry.name === 'm');
    expect(entries[1].status).toBe('name-conflict');
    expect(entries[1].utype).toBeNull();
  });

  it('跨段同名合法:各自占号、无问题', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods><m></m></CellMethods>',
        '  <BaseMethods><m></m></BaseMethods>',
        '  <ClientMethods><m></m></ClientMethods>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues).toHaveLength(0);
    expect(methodOf(table, 'm').utype).toBe(1);
    const entries = table.methods.filter(entry => entry.name === 'm');
    expect(entries.map(entry => entry.utype)).toEqual([1, 2, 3]);
  });

  it('父类方法撞本实体组件槽名:component name conflict(槽属性装载失败但组件名已登记)', () => {
    const table = buildMessageTable('Child', createSource({
      'entity:Child': [
        '<root>',
        '  <CellMethods><go></go></CellMethods>',
        '  <Components><go><Type>PackComp</Type></go></Components>',
        '  <Parent>P</Parent>',
        '</root>'
      ].join('\n'),
      'entity:P': '<root><BaseMethods><go><Exposed/></go></BaseMethods></root>'
    }))!;
    // 槽 go 撞本实体方法名 → property 冲突,但引擎仍无条件 addComponentDescription
    expect(issuesOfKind(table, 'property-method-name-conflict')).toHaveLength(1);
    // 父链 go:属性表未登记,组件表已登记 → component 冲突
    const issues = issuesOfKind(table, 'method-component-name-conflict');
    expect(issues).toHaveLength(1);
    expect(issues[0].message)
      .toBe('ScriptDefModule::addBaseMethodDescription: There is a component[go] name conflict!');
    expect(issues[0].fatal).toBe(true);
    const parentGo = table.methods.filter(entry => entry.name === 'go');
    expect(parentGo[0].status).toBe('ok');
    expect(parentGo[1].status).toBe('name-conflict');
    expect(parentGo[1].utype).toBeNull();
    expect(table.loadFailed).toBe(true);
  });

  it('方法撞属性名:property name conflict', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
        '  </Properties>',
        '  <BaseMethods><hp></hp></BaseMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'method-property-name-conflict');
    expect(issues[0].message)
      .toBe('ScriptDefModule::addBaseMethodDescription: There is a property[hp] name conflict!');
    const hp = methodOf(table, 'hp');
    expect(hp.status).toBe('name-conflict');
    expect(hp.utype).toBeNull();
  });
});

describe('继承与接口装配', () => {
  const files = {
    'entity:Hero': [
      '<root>',
      '  <Interfaces>',
      '    <interface>ICombat</interface>',
      '  </Interfaces>',
      '  <Parent>MyBase</Parent>',
      '  <Properties>',
      '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
      '  </Properties>',
      '  <CellMethods><h1></h1></CellMethods>',
      '</root>'
    ].join('\n'),
    'interface:ICombat': [
      '<root>',
      '  <CellMethods><i1><Exposed/></i1></CellMethods>',
      '</root>'
    ].join('\n'),
    'entity:MyBase': [
      '<root>',
      '  <Parent>Grand</Parent>',
      '  <Properties>',
      '    <mp><Type>UINT32</Type><Flags>BASE</Flags></mp>',
      '  </Properties>',
      '  <BaseMethods><b1></b1></BaseMethods>',
      '</root>'
    ].join('\n'),
    'entity:Grand': '<root><CellMethods><g1></g1></CellMethods></root>'
  };

  it('装配序:own → 接口声明序 → 父链递归,同一 utype 序列连续', () => {
    const table = buildMessageTable('Hero', createSource(files))!;
    expect(methodOf(table, 'h1').utype).toBe(1);
    expect(methodOf(table, 'i1').utype).toBe(2);
    expect(methodOf(table, 'b1').utype).toBe(3);
    expect(methodOf(table, 'g1').utype).toBe(4);

    expect(table.sources).toEqual([
      { name: 'Hero', kind: 'own', filePath: '/defs/entitys/Hero.def' },
      { name: 'ICombat', kind: 'interface', filePath: '/defs/interfaces/ICombat.def' },
      { name: 'MyBase', kind: 'parent', filePath: '/defs/entitys/MyBase.def' },
      { name: 'Grand', kind: 'parent', filePath: '/defs/entitys/Grand.def' }
    ]);

    const i1 = methodOf(table, 'i1');
    expect(i1.origin).toBe('ICombat(接口)');
    expect(i1.originKind).toBe('interface');
    expect(methodOf(table, 'b1').origin).toBe('MyBase(父类)');
    expect(methodOf(table, 'g1').originKind).toBe('parent');

    // hasClient:hp(BASE_AND_CLIENT)在,mp(BASE)不在
    expect(table.clientProperties.map(property => property.name)).toEqual(['hp']);

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('Hero(own) → ICombat(interface) → MyBase(parent) → Grand(parent)');
    expect(markdown).toContain('ICombat(接口)');
  });

  it('接口 def 只并入属性与方法(接口内 Parent/Interfaces 不再递归)', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Interfaces><interface>Iface</interface></Interfaces>',
        '  <CellMethods><own></own></CellMethods>',
        '</root>'
      ].join('\n'),
      'interface:Iface': [
        '<root>',
        '  <Parent>ShouldNotLoad</Parent>',
        '  <CellMethods><im></im></CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues.some(issue => issue.kind === 'parent-file-missing')).toBe(false);
    expect(table.methods.map(method => method.name).sort()).toEqual(['im', 'own']);
  });

  it('接口文件缺失:engine 文案 fatal,分支终止', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': '<root><Interfaces><interface>Nope</interface></Interfaces></root>'
    }))!;
    const issues = issuesOfKind(table, 'interface-file-missing');
    expect(issues[0].message)
      .toBe('EntityDef::loadDefInfo: failed to load entity:Nope interface.');
    expect(issues[0].fatal).toBe(true);
    expect(table.loadFailed).toBe(true);
  });

  it('父类文件缺失:engine 文案 fatal', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': '<root><Parent>Ghost</Parent><CellMethods><m></m></CellMethods></root>'
    }))!;
    const issues = issuesOfKind(table, 'parent-file-missing');
    expect(issues[0].message)
      .toBe('EntityDef::loadDefInfo: failed to load entity:Ghost parentClass.');
  });

  it('接口重复声明:引擎 loadInterfaces 无去重,第二次完整装载撞名字', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Interfaces>',
        '    <interface>ICombat</interface>',
        '    <interface>ICombat</interface>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      'interface:ICombat': [
        '<root>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
        '  </Properties>',
        '  <ClientMethods><onHit></onHit></ClientMethods>',
        '</root>'
      ].join('\n')
    }))!;
    // 接口不是父链重入,不得误报成环
    expect(issuesOfKind(table, 'parent-cycle')).toHaveLength(0);
    expect(table.sources.filter(source => source.name === 'ICombat')).toHaveLength(2);

    const methodIssues = issuesOfKind(table, 'method-name-conflict');
    expect(methodIssues.map(issue => issue.message)).toEqual([
      'ScriptDefModule::addClientMethodDescription: [onHit] is exist!'
    ]);
    // 第二次装载 hp 撞已装的两域:按域各报一条,外层再补一条汇总
    const propertyIssues = issuesOfKind(table, 'property-name-conflict');
    expect(propertyIssues.map(issue => issue.message)).toEqual([
      'ScriptDefModule::addPropertyDescription: [hp] is exist! componentType=6.',
      'ScriptDefModule::addPropertyDescription: [hp] is exist! componentType=7.',
      'EntityDef::addPropertyDescription(Hero): root.'
    ]);
  });

  it('父链成环:kode 截断并报 parent-cycle', () => {
    const table = buildMessageTable('A', createSource({
      'entity:A': '<root><Parent>B</Parent><CellMethods><a1></a1></CellMethods></root>',
      'entity:B': '<root><Parent>A</Parent><CellMethods><b1></b1></CellMethods></root>'
    }))!;
    const issues = issuesOfKind(table, 'parent-cycle');
    expect(issues).toHaveLength(1);
    expect(issues[0].fatal).toBe(true);
    expect(issues[0].message).toContain('父类链成环');
    expect(table.sources.map(source => source.name)).toEqual(['A', 'B']);
    expect(methodOf(table, 'a1').utype).toBe(1);
    expect(methodOf(table, 'b1').utype).toBe(2);
  });

  it('子方法撞父属性名:属性侧补外层汇总报错(root 为所在 def 根元素名)', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Parent>MyBase</Parent>',
        '  <CellMethods><attack></attack></CellMethods>',
        '</root>'
      ].join('\n'),
      'entity:MyBase': [
        '<root>',
        '  <Properties>',
        '    <attack><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></attack>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'property-method-name-conflict');
    expect(issues[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: There is a method[attack] name conflict! componentType=6.');
    expect(issues[1].message).toBe('EntityDef::addPropertyDescription(Hero): root.');
    expect(table.loadFailed).toBe(true);
  });

  it('父属性撞子组件槽名:component name conflict', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Parent>MyBase</Parent>',
        '  <Components><bag><Type>BagComp</Type></bag></Components>',
        '</root>'
      ].join('\n'),
      'entity:MyBase': [
        '<root>',
        '  <Properties>',
        '    <bag><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></bag>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'property-component-name-conflict');
    expect(issues[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: There is a component[bag] name conflict!');
  });

  it('父属性撞子同名属性(同域):[X] is exist! + 外层汇总', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Parent>MyBase</Parent>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'entity:MyBase': [
        '<root>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const dups = issuesOfKind(table, 'property-name-conflict');
    expect(dups[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: [hp] is exist! componentType=6.');
    expect(dups[1].message).toBe('EntityDef::addPropertyDescription(Hero): root.');
  });

  it('双域属性撞双域同名:每域一条 + 外层汇总一条', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Parent>MyBase</Parent>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'entity:MyBase': [
        '<root>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const dups = issuesOfKind(table, 'property-name-conflict');
    expect(dups).toHaveLength(3);
    expect(dups[0].message).toContain('componentType=6.');
    expect(dups[1].message).toContain('componentType=7.');
    expect(dups[2].message).toBe('EntityDef::addPropertyDescription(Hero): root.');
  });

  it('同文件反斜杠路径:visited 键归一化后可判重', () => {
    const table = buildMessageTable('Hero', createSourceWithPaths({
      'entity:Hero': {
        content: '<root><Parent>MyBase</Parent></root>',
        path: 'C:\\defs\\Hero.def'
      },
      'entity:MyBase': {
        content: '<root><CellMethods><m></m></CellMethods></root>',
        path: 'C:\\DEFS\\mybase.def'
      }
    }))!;
    expect(table.issues).toHaveLength(0);
    expect(table.sources.map(source => source.filePath)).toEqual([
      'C:\\defs\\Hero.def',
      'C:\\DEFS\\mybase.def'
    ]);
  });
});

describe('属性装载', () => {
  it('保留属性名:limited 报错(含引擎缺逗号拼接名)', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <id><Type>UINT32</Type><Flags>BASE</Flags></id>',
        '    <interface><Type>UINT32</Type><Flags>BASE</Flags></interface>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const limited = issuesOfKind(table, 'property-name-limited');
    expect(limited.map(issue => issue.message)).toEqual([
      "EntityDef::loadDefPropertys: 'id' is limited, in module(E)!",
      "EntityDef::loadDefPropertys: 'interface' is limited, in module(E)!"
    ]);
    expect(table.clientProperties).toHaveLength(0);
  });

  it('Flags 缺失/未知:引擎文案逐一对齐;OWN_CLIENT 归 cell+client 域合法', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <p1><Type>UINT32</Type></p1>',
        '    <p2><Type>UINT32</Type><Flags>nope</Flags></p2>',
        '    <p3><Type>UINT32</Type><Flags>OWN_CLIENT</Flags></p3>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    expect(issuesOfKind(table, 'property-flags-missing')[0].message)
      .toBe('EntityDef::loadDefPropertys: not fount flagsNode, is E.p1!');
    expect(issuesOfKind(table, 'property-flags-unknown')[0].message)
      .toBe('EntityDef::loadDefPropertys: not fount flags[NOPE], is E.p2!');
    // OWN_CLIENT(0x10)落在 ENTITY_CELL_DATA_FLAGS 与 CLIENT 位集内:合法装载
    expect(table.clientProperties.map(property => property.name)).toEqual(['p3']);
    expect(table.properties[2].flags).toBe('OWN_CLIENT');
    // 缺 Flags 节点的 p1:flags 列为空,markdown 全量属性表显示 —;
    // 未知值 p2 原样保留(NOPE),utype 同样不分配
    expect(renderMessageTableMarkdown(table)).toContain('| p1 | UINT32 | — | — | 否 | — | E | 3 |');
    expect(renderMessageTableMarkdown(table)).toContain('| p2 | UINT32 | NOPE | — | 否 | — | E | 4 |');
  });

  it('hasClient 按位集判定;Type 缺失仍保留在客户端属性表(typeName null)', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <p1><Flags>BASE_AND_CLIENT</Flags></p1>',
        '    <p2><Type>UINT32</Type><Flags>BASE</Flags></p2>',
        '    <p3><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></p3>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const missing = issuesOfKind(table, 'property-type-missing');
    expect(missing[0].message)
      .toBe('EntityDef::loadDefPropertys: not fount TypeNode, is E.p1!');
    expect(table.clientProperties.map(property => property.name)).toEqual(['p1']);
    expect(table.clientProperties[0].typeName).toBeNull();
    expect(table.clientProperties[0].flags).toBe('BASE_AND_CLIENT');

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('| p1 | — | BASE_AND_CLIENT |');
  });

  it('类型未注册:kode 组合文案(引擎静默失败)', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <p><Type>UFO</Type><Flags>BASE</Flags></p>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'property-type-unknown');
    expect(issues[0].fatal).toBe(true);
    expect(issues[0].message).toContain('类型 UFO 未注册');
    expect(issues[0].message).toContain('引擎静默 return false');
  });

  it('ARRAY 属性:内联类型占 DataType utype,属性 utype 独立从 1 起', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <bag>',
        '      <Type>',
        '        ARRAY',
        '        <of>UINT32</of>',
        '      </Type>',
        '      <Flags>CELL_PUBLIC</Flags>',
        '    </bag>',
        '  </Properties>',
        '  <CellMethods><m></m></CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues).toHaveLength(0);
    expect(table.types.find(type => type.name === 'E_bag'))
      .toMatchObject({ utype: 22, kind: 'inline-array' });
    const bag = table.properties[0];
    expect(bag.utype).toBe(1);
    expect(bag.declaredUtype).toBeNull();
    // 方法 utype 与属性 utype 是两套空间,同从 1 起
    expect(methodOf(table, 'm').utype).toBe(1);
  });
});

describe('属性 utype(calcDefPropertyUType)', () => {
  it('显式占号 + 自动跳过(显式 1 挡住计数器起点)', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <a><Type>UINT32</Type><Flags>BASE</Flags><Utype>1</Utype></a>',
        '    <b><Type>UINT32</Type><Flags>BASE</Flags></b>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const a = table.properties[0];
    const b = table.properties[1];
    expect(a.utype).toBe(1);
    expect(a.declaredUtype).toBe(1);
    expect(b.utype).toBe(2);
    expect(b.declaredUtype).toBeNull();
  });

  it('显式冲突:按持有者注册域逐条报(BASE_AND_CLIENT 持有者对双域冲突报两条)', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <a><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags><Utype>3</Utype></a>',
        '    <b><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags><Utype>3</Utype></b>',
        '    <c><Type>UINT32</Type><Flags>BASE</Flags></c>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    const conflicts = issuesOfKind(table, 'utype-conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].message)
      .toBe("EntityDef::calcDefPropertyUType: E.b, 'Utype' 3 Conflict(E.a 'Utype' 3)!");
    expect(table.properties[1].utype).toBeNull();
    expect(table.loadFailed).toBe(true);
    // 冲突属性不入已用表,后续自动分配从 2 起(a 占 3,1 空闲)
    expect(table.properties[2].utype).toBe(1);
  });

  it('显式溢出:calcDefPropertyUType 文案', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <a><Type>UINT32</Type><Flags>BASE</Flags><Utype>65536</Utype></a>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    }))!;
    expect(issuesOfKind(table, 'utype-overflow')[0].message)
      .toBe("EntityDef::calcDefPropertyUType: 'Utype' has overflowed(65536 > 65535), is E.a!");
    expect(table.properties[0].utype).toBeNull();
  });
});

describe('组件槽', () => {
  const files = {
    'entity:Hero': [
      '<root>',
      '  <Components>',
      '    <pack><Type>PackComp</Type><Utype>9</Utype></pack>',
      '  </Components>',
      '  <CellMethods><go></go></CellMethods>',
      '</root>'
    ].join('\n')
  };

  it('槽 = 三域属性,占属性 utype,EntityComponentType 占 DataType utype,hasClient 计入', () => {
    const table = buildMessageTable('Hero', createSource(files))!;
    expect(table.issues).toHaveLength(0);
    const pack = table.properties.find(property => property.name === 'pack')!;
    expect(pack).toMatchObject({
      typeName: 'PackComp',
      flags: 'BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS',
      hasClient: true,
      utype: 9,
      declaredUtype: 9
    });
    expect(table.types.find(type => type.name === 'PackComp'))
      .toMatchObject({ utype: 22, kind: 'entity-component' });
    expect(table.clientProperties.map(property => property.name)).toEqual(['pack']);
    // 方法 utype(1)与槽属性 utype(9,显式)互不干扰
    expect(methodOf(table, 'go').utype).toBe(1);
  });

  it('同名组件类型只构造一次 EntityComponentType(模块缓存)', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Components>',
        '    <s1><Type>PackComp</Type></s1>',
        '    <s2><Type>PackComp</Type></s2>',
        '  </Components>',
        '</root>'
      ].join('\n')
    }))!;
    expect(table.issues).toHaveLength(0);
    expect(table.types.filter(type => type.name === 'PackComp')).toHaveLength(1);
    const slots = table.properties.filter(property => property.typeName === 'PackComp');
    expect(slots.map(property => property.utype)).toEqual([1, 2]);
  });

  it('槽撞已装方法名:property 方法名冲突(componentType=5,cell 先查)', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Components><go><Type>PackComp</Type></go></Components>',
        '  <CellMethods><go></go></CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'property-method-name-conflict');
    expect(issues[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: There is a method[go] name conflict! componentType=5.');
    // 槽仍占属性 utype(引擎 calcDefPropertyUType 先于名字三查)
    expect(table.properties[0].utype).toBe(1);
  });

  it('重名槽:component 冲突', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Components>',
        '    <pack><Type>PackComp</Type></pack>',
        '    <pack><Type>PackComp</Type></pack>',
        '  </Components>',
        '</root>'
      ].join('\n')
    }))!;
    const issues = issuesOfKind(table, 'property-component-name-conflict');
    expect(issues[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: There is a component[pack] name conflict!');
  });

  it('槽显式 utype 撞已有属性:槽装载失败,组件名不登记', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Properties>',
        '    <a><Type>UINT32</Type><Flags>BASE</Flags><Utype>5</Utype></a>',
        '  </Properties>',
        '  <Components>',
        '    <pack><Type>PackComp</Type><Utype>5</Utype></pack>',
        '  </Components>',
        '</root>'
      ].join('\n')
    }))!;
    const conflicts = issuesOfKind(table, 'utype-conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].message)
      .toBe("EntityDef::calcDefPropertyUType: Hero.pack, 'Utype' 5 Conflict(Hero.a 'Utype' 5)!");
    // 早退:entry 存在但 utype 未分配,后续同名组件走不到 component 冲突臂
    const pack = table.properties.find(property => property.name === 'pack')!;
    expect(pack.utype).toBeNull();
  });

  it('槽撞已有属性(同域):[X] is exist!', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Properties>',
        '    <pack><Type>UINT32</Type><Flags>BASE</Flags></pack>',
        '  </Properties>',
        '  <Components>',
        '    <pack><Type>PackComp</Type></pack>',
        '  </Components>',
        '</root>'
      ].join('\n')
    }))!;
    const dups = issuesOfKind(table, 'property-name-conflict');
    expect(dups[0].message)
      .toBe('ScriptDefModule::addPropertyDescription: [pack] is exist! componentType=6.');
  });

  it('槽撞三域同名(两属性分域注册):三域各报一条,属性名表不重复登记', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Properties>',
        '    <pack><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></pack>',
        '    <pack><Type>UINT32</Type><Flags>BASE</Flags></pack>',
        '  </Properties>',
        '  <Components><pack><Type>PackComp</Type></pack></Components>',
        '</root>'
      ].join('\n')
    }))!;
    const conflicts = issuesOfKind(table, 'property-name-conflict');
    expect(conflicts.map(issue => issue.message)).toEqual([
      'ScriptDefModule::addPropertyDescription: [pack] is exist! componentType=5.',
      'ScriptDefModule::addPropertyDescription: [pack] is exist! componentType=6.',
      'ScriptDefModule::addPropertyDescription: [pack] is exist! componentType=7.'
    ]);
  });

  it('保留槽名:loadComponents 文案', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': [
        '<root>',
        '  <Components>',
        '    <position><Type>PackComp</Type></position>',
        '  </Components>',
        '</root>'
      ].join('\n')
    }))!;
    expect(issuesOfKind(table, 'property-name-limited')[0].message)
      .toBe("EntityDef::loadComponents: 'position' is limited, in module(Hero)!");
  });
});

describe('aliasID', () => {
  const files = {
    'entity:E': [
      '<root>',
      '  <Properties>',
      '    <zeta><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></zeta>',
      '    <alpha><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></alpha>',
      '    <gamma><Type>UINT32</Type><Flags>BASE</Flags></gamma>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <fire><Exposed/></fire>',
      '  </BaseMethods>',
      '  <ClientMethods>',
      '    <zebra></zebra>',
      '    <apple></apple>',
      '  </ClientMethods>',
      '</root>'
    ].join('\n')
  };

  it('默认关闭:aliasID 全 null,markdown 标注关闭', () => {
    const table = buildMessageTable('E', createSource(files))!;
    expect(table.aliasIdEnabled).toBe(false);
    expect(table.properties.every(property => property.aliasID === null)).toBe(true);
    expect(table.methods.every(method => method.aliasID === null)).toBe(true);
    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('关闭(引擎默认)');
    expect(markdown).toContain('aliasID 关闭:引擎 entitydefAliasID 默认关');
    expect(markdown).toContain('| fire |');
  });

  it('开启:hasClient 属性按名升序从 4 起,ClientMethods 从 1 起,Exposed 不参与', () => {
    const table = buildMessageTable('E', createSource(files), { aliasIdEnabled: true })!;
    expect(table.aliasIdEnabled).toBe(true);
    const alpha = table.properties.find(property => property.name === 'alpha')!;
    const zeta = table.properties.find(property => property.name === 'zeta')!;
    expect(alpha.aliasID).toBe(4);
    expect(zeta.aliasID).toBe(5);
    expect(table.properties.find(property => property.name === 'gamma')!.aliasID).toBeNull();

    expect(methodOf(table, 'apple').aliasID).toBe(1);
    expect(methodOf(table, 'zebra').aliasID).toBe(2);
    expect(methodOf(table, 'fire').aliasID).toBeNull();

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('开启(entitydefAliasID)');
    expect(markdown).toContain('| apple | ClientMethods |');
    expect(markdown).toContain('| alpha | UINT32 | BASE_AND_CLIENT | 2 | 4 |');
  });

  it('重复 ClientMethod 名:排序撞同名,冲突条目 utype 列显示 —', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><ClientMethods><m></m><m></m></ClientMethods></root>'
    }), { aliasIdEnabled: true })!;
    const entries = table.methods.filter(entry => entry.name === 'm');
    expect(entries).toHaveLength(2);
    expect(entries[0].utype).toBe(1);
    expect(entries[1].utype).toBeNull();
    // 同名条目也进 aliasID 升序编号(assignAliasIds 按方法段全取)
    expect(entries[0].aliasID).toBe(1);
    expect(entries[1].aliasID).toBe(2);

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('| 1 | m | ClientMethods | server-to-client | () | 1 | 1 |');
    expect(markdown).toContain('| 2 | m | ClientMethods | server-to-client | () | — | 2 |');
  });

  it('属性超限(末号 >255):全部回退 -1,markdown 出回退注记', () => {
    const names: string[] = [];
    for (let i = 0; i < 253; i += 1) {
      names.push(`p${String(i).padStart(3, '0')}`);
    }
    const propertyXml = names.map(name =>
      `    <${name}><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></${name}>`
    ).join('\n');
    const table = buildMessageTable('E', createSource({
      'entity:E': `<root>\n  <Properties>\n${propertyXml}\n  </Properties>\n</root>`
    }), { aliasIdEnabled: true })!;
    expect(table.clientProperties.every(property => property.aliasID === -1)).toBe(true);
    expect(renderMessageTableMarkdown(table)).toContain('计数超 255');
  });

  it('方法恰 255 个:1..255 有效不回退(边界)', () => {
    const names: string[] = [];
    for (let i = 0; i < 255; i += 1) {
      names.push(`m${String(i).padStart(3, '0')}`);
    }
    const methodXml = names.map(name => `    <${name}></${name}>`).join('\n');
    const table = buildMessageTable('E', createSource({
      'entity:E': `<root>\n  <ClientMethods>\n${methodXml}\n  </ClientMethods>\n</root>`
    }), { aliasIdEnabled: true })!;
    const ids = table.methods.map(method => method.aliasID).sort((a, b) => a! - b!);
    expect(ids[0]).toBe(1);
    expect(ids[254]).toBe(255);
    expect(table.methods.every(method => method.aliasID !== -1)).toBe(true);
  });

  it('方法超限(>255 个):全部回退 -1', () => {
    const names: string[] = [];
    for (let i = 0; i < 256; i += 1) {
      names.push(`m${String(i).padStart(3, '0')}`);
    }
    const methodXml = names.map(name => `    <${name}></${name}>`).join('\n');
    const table = buildMessageTable('E', createSource({
      'entity:E': `<root>\n  <ClientMethods>\n${methodXml}\n  </ClientMethods>\n</root>`
    }), { aliasIdEnabled: true })!;
    expect(table.methods.every(method => method.aliasID === -1)).toBe(true);
  });

  it('开启但无客户端属性:markdown 走空表臂', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><Properties><p><Type>UINT32</Type><Flags>BASE</Flags></p></Properties></root>'
    }), { aliasIdEnabled: true })!;
    expect(renderMessageTableMarkdown(table)).toContain('(无 hasClient 属性)');
  });
});

describe('types.xml', () => {
  const TYPES = [
    '<types>',
    '  <HP>UINT8</HP>',
    '  <GOLD>',
    '    <FIXED_DICT>',
    '      <Properties>',
    '        <amount>',
    '          <Type>UINT32</Type>',
    '        </amount>',
    '      </Properties>',
    '    </FIXED_DICT>',
    '  </GOLD>',
    '  <LIST><ARRAY><of>UINT8</of></ARRAY></LIST>',
    '  <GOLD_ALIAS>GOLD</GOLD_ALIAS>',
    '</types>'
  ].join('\n');

  it('别名共享 utype,用户类型从 22 起按文档序', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root><CellMethods><m><Arg>HP</Arg><Arg>GOLD</Arg><Arg>LIST</Arg><Arg>GOLD_ALIAS</Arg></m></CellMethods></root>'
    }), { typesXml: TYPES })!;
    expect(table.issues).toHaveLength(0);

    const byName = Object.fromEntries(table.types.map(type => [type.name, type]));
    expect(byName.HP).toMatchObject({ utype: 1, kind: 'alias', aliasedTo: 'UINT8' });
    expect(byName.GOLD).toMatchObject({ utype: 22, kind: 'fixed-dict', aliasedTo: null });
    expect(byName.LIST).toMatchObject({ utype: 23, kind: 'array', aliasedTo: null });
    expect(byName.GOLD_ALIAS).toMatchObject({ utype: 22, kind: 'alias', aliasedTo: 'GOLD' });

    const m = methodOf(table, 'm');
    expect(m.args.map(arg => arg.utype)).toEqual([1, 22, 23, 22]);

    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('| HP | 1 | alias | UINT8 |');
    expect(markdown).toContain('| LIST | 23 | array | — |');
  });

  it('重名别名(大小写不敏感):报错但装载继续,用户类型仍占号', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), {
      typesXml: [
        '<types>',
        '  <HP>UINT8</HP>',
        '  <hp>INT8</hp>',
        '  <GOLD><FIXED_DICT><Properties><a><Type>UINT32</Type></a></Properties></FIXED_DICT></GOLD>',
        '  <GOLD><FIXED_DICT><Properties><b><Type>UINT32</Type></b></Properties></FIXED_DICT></GOLD>',
        '  <LIST><ARRAY><of>UINT8</of></ARRAY></LIST>',
        '  <LIST><ARRAY><of>UINT16</of></ARRAY></LIST>',
        '</types>'
      ].join('\n')
    })!;
    const dups = issuesOfKind(table, 'duplicate-type-alias');
    expect(dups.map(issue => issue.message)).toEqual([
      'DataTypes::addDataType(name): name hp exist.',
      'DataTypes::addDataType(name): name GOLD exist.',
      'DataTypes::addDataType(name): name LIST exist.'
    ]);
    expect(dups.every(issue => issue.fatal === false)).toBe(true);
    // 非致命问题在 markdown 问题清单标 [warn]
    expect(renderMessageTableMarkdown(table))
      .toContain('- [warn] DataTypes::addDataType(name): name hp exist. (行 3)');
    expect(table.loadFailed).toBe(false);
    // 重名的 FIXED_DICT/ARRAY 仍占 utype(名字不覆盖)
    expect(table.types.filter(type => type.name === 'GOLD')).toHaveLength(2);
    expect(table.types.filter(type => type.name === 'GOLD').map(type => type.utype))
      .toEqual([22, 23]);
    expect(table.types.filter(type => type.name === 'LIST')).toHaveLength(2);
    expect(table.types.filter(type => type.name === 'LIST').map(type => type.utype))
      .toEqual([24, 25]);
  });

  it('下划线前缀别名名 / 别名指向未注册类型', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), {
      typesXml: [
        '<types>',
        '  <_BAD>UINT8</_BAD>',
        '  <MY>UFO</MY>',
        '</types>'
      ].join('\n')
    })!;
    expect(issuesOfKind(table, 'invalid-type-alias-name')[0].message)
      .toBe('DataTypes::loadTypes: Not allowed to use the prefix "_"! aliasName=_BAD');
    expect(issuesOfKind(table, 'unknown-aliased-type')[0].message)
      .toBe("DataTypes::loadTypes: can't fount type UFO by alias[MY].");
    expect(table.loadFailed).toBe(true);
  });

  it('FIXED_DICT 缺 Properties:两条报错', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), {
      typesXml: '<types><GOLD><FIXED_DICT><Other>1</Other></FIXED_DICT></GOLD></types>'
    })!;
    expect(table.issues.map(issue => issue.message)).toEqual([
      'FixedDictType::initialize: not found "Properties".',
      'DataTypes::loadTypes: parse FIXED_DICT [GOLD] error!'
    ]);
  });

  it('ARRAY 缺 of / of 未知:parse ARRAY 报错,未知 of 仍占号', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), {
      typesXml: [
        '<types>',
        '  <LIST1><ARRAY></ARRAY></LIST1>',
        '  <LIST2><ARRAY><of>UFO</of></ARRAY></LIST2>',
        '</types>'
      ].join('\n')
    })!;
    expect(table.issues.map(issue => issue.message)).toEqual([
      'FixedArrayType::initialize: not found "of".',
      'DataTypes::loadTypes: parse ARRAY [LIST1] error!',
      'FixedArrayType::initialize: key[ARRAY] did not find type[UFO]!',
      'DataTypes::loadTypes: parse ARRAY [LIST2] error!'
    ]);
    // 两个 ARRAY 都已构造占号(LIST1 缺 of 的构造同样占 22),别名均不注册
    const consumed = table.types.find(type => type.name === 'LIST2');
    expect(consumed).toMatchObject({ utype: 23, kind: 'array', aliasedTo: null });
    expect(table.types.find(type => type.name === 'LIST1'))
      .toMatchObject({ utype: 22, kind: 'array', aliasedTo: null });
  });

  it('非法 XML:kode 组合文案;纯注释:静默无用户类型', () => {
    const bad = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), { typesXml: '<types><HP' })!;
    expect(issuesOfKind(bad, 'types-parse-error')[0].message)
      .toBe('DataTypes::loadTypes: types.xml 解析失败(非法 XML)');

    const silent = buildMessageTable('E', createSource({
      'entity:E': '<root></root>'
    }), { typesXml: '<!-- only comment -->' })!;
    expect(silent.issues).toHaveLength(0);
    expect(silent.types).toHaveLength(21);
  });
});

describe('渲染与行号', () => {
  it('失败态 markdown:标出 fatal 数与推演口径,问题列表带 [fatal] 与行号', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <CellMethods>',
        '    <m1><Utype>5</Utype></m1>',
        '    <m2><Utype>5</Utype></m2>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const markdown = renderMessageTableMarkdown(table);
    expect(markdown).toContain('装载状态: 失败(1 个致命问题');
    expect(markdown).toContain('引擎遇首个 fatal 即终止装载');
    expect(markdown).toContain('编号口径');
    expect(markdown).toContain("[fatal] EntityDef::loadDefCellMethods: E.m2, 'Utype' 5 Conflict");
    expect(markdown).toContain('(行 4)');
    expect(markdown).toContain('| — |');
  });

  it('JSON 与 MessageTable 同形可回读,嵌套 ofType 序列化', () => {
    const table = buildMessageTable('E', createSource({
      'entity:E': [
        '<root>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>',
        '    <mp><Type>UINT32</Type><Flags>BASE</Flags><Utype>9</Utype></mp>',
        '  </Properties>',
        '  <CellMethods>',
        '    <m><Arg>ARRAY<of>ARRAY<of>INT32</of></of></Arg><Exposed/></m>',
        '    <bad><Arg>UFO</Arg></bad>',
        '  </CellMethods>',
        '</root>'
      ].join('\n')
    }))!;
    const parsed = JSON.parse(renderMessageTableJson(table)) as MessageTable;
    expect(parsed.module).toBe('E');
    expect(parsed.loadFailed).toBe(true);
    expect(parsed.clientMethods).toHaveLength(1);
    expect(parsed.methods[0].args[0]).toMatchObject({
      name: 'ARRAY',
      utype: 22,
      ofType: { name: 'ARRAY', utype: 23, ofType: { name: 'INT32', utype: 7, ofType: null } }
    });
    // 全量属性与客户端子集同形序列化
    expect(parsed.properties.map(property => property.name)).toEqual(['hp', 'mp']);
    expect(parsed.properties[0]).toMatchObject({
      name: 'hp',
      typeName: 'UINT32',
      flags: 'BASE_AND_CLIENT',
      hasClient: true,
      utype: 1,
      declaredUtype: null,
      aliasID: null,
      origin: 'E',
      originKind: 'own',
      line: 3
    });
    expect(parsed.properties[1]).toMatchObject({ utype: 9, declaredUtype: 9 });
    expect(parsed.clientProperties.map(property => property.name)).toEqual(['hp']);
    expect(parsed.clientProperties[0]).toMatchObject({ flags: 'BASE_AND_CLIENT', utype: 1 });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      kind: 'unknown-arg-type',
      fatal: true,
      line: 8
    });
    expect(parsed.sources).toEqual([{ name: 'E', kind: 'own', filePath: '/defs/entitys/E.def' }]);
  });

  it('缺 Type 节点:typeName/utype 列两臂均显示 —', () => {
    const source = createSource({
      'entity:E': '<root><Properties><hp><Flags>BASE_AND_CLIENT</Flags></hp></Properties></root>'
    });
    const off = buildMessageTable('E', source)!;
    expect(off.properties[0].typeName).toBeNull();
    expect(off.properties[0].utype).toBeNull();
    expect(off.properties[0].hasClient).toBe(true);
    expect(issuesOfKind(off, 'property-type-missing')[0].message)
      .toBe('EntityDef::loadDefPropertys: not fount TypeNode, is E.hp!');
    expect(renderMessageTableMarkdown(off)).toContain('| hp | — | BASE_AND_CLIENT | — | 是 | — | E | 1 |');

    const on = renderMessageTableMarkdown(buildMessageTable('E', source, { aliasIdEnabled: true }))!;
    expect(on).toContain('| hp | — | BASE_AND_CLIENT | — | 4 |');
  });

  it('文件缺失类问题无行号:问题列表不附 (行 N)', () => {
    const table = buildMessageTable('Hero', createSource({
      'entity:Hero': '<root><Interfaces><interface>Ghost</interface></Interfaces></root>'
    }))!;
    const markdown = renderMessageTableMarkdown(table);
    const line = markdown.split('\n').find(entry => entry.includes('failed to load entity:Ghost interface.'))!;
    expect(line).toContain('[fatal]');
    expect(line).not.toMatch(/\(行/);
  });

  it('行号对齐 def 声明行', () => {
    const def = [
      '<root>',                                  // 1
      '  <Properties>',                          // 2
      '    <hp><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></hp>', // 3
      '  </Properties>',                         // 4
      '  <CellMethods>',                         // 5
      '    <m><Arg>UFO</Arg></m>',               // 6
      '  </CellMethods>',                        // 7
      '</root>'                                  // 8
    ].join('\n');
    const table = buildMessageTable('E', createSource({ 'entity:E': def }))!;
    expect(table.properties[0].line).toBe(3);
    expect(methodOf(table, 'm').line).toBe(6);
    expect(table.issues[0].line).toBe(6);
  });

  it('loadLocal 装载入口:entity/interface 两类取源共用一个 DefTreeSource', () => {
    // 覆盖 DefTreeSource 两个 kind 参数的实际取用路径
    const seen: Array<string> = [];
    const table = buildMessageTable('A', {
      loadDef(name, kind) {
        seen.push(`${kind}:${name}`);
        const files: Record<string, string> = {
          'entity:A': '<root><Interfaces><interface>I</interface></Interfaces><CellMethods><a1></a1></CellMethods></root>',
          'interface:I': '<root><ClientMethods><i1></i1></ClientMethods></root>'
        };
        const content = files[`${kind}:${name}`];
        if (content === undefined) {
          return null as unknown as LocalDefinitionSemantics;
        }
        return parseLocalDefinition(content, kind, name, `/defs/${kind}s/${name}.def`);
      }
    })!;
    expect(seen).toEqual(['entity:A', 'interface:I']);
    expect(table.methods.map(method => method.name).sort()).toEqual(['a1', 'i1']);
  });
});
