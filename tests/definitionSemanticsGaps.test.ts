import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinitionSemanticsLoader,
  parseLocalDefinition
} from '../src/backend/definitionSemantics';

// definitionSemantics 的解析与继承合并缺口:Interfaces 三种引用形态
// (自闭合无名/子元素名/引用名)、parseOptionalBoolean 的未知值、
// ARRAY of 的 <Type> 内嵌 <Properties> 递归、坏 XML 的 negative 缓存、
// 接口与父链的组件槽去重、纯继承链上方法来源链回溯。

const write = (root: string, relative: string, content: string): void => {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
};

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semantics-gap-'));

  // 纯继承链:BaseE 只有方法,MidE/TopE 只声明 Parent
  write(root, 'scripts/entity_defs/BaseE.def', [
    '<root>',
    '  <BaseMethods>',
    '    <yell/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/MidE.def', '<root>\n  <Parent>BaseE</Parent>\n</root>');
  write(root, 'scripts/entity_defs/TopE.def', '<root>\n  <Parent>MidE</Parent>\n</root>');

  // 接口组件槽重复:IA 与 IB 都声明 slot "pack"
  const ifaceWithPack = [
    '<root>',
    '  <Components>',
    '    <pack>',
    '      <Type>HealthComp</Type>',
    '    </pack>',
    '  </Components>',
    '</root>'
  ].join('\n');
  write(root, 'scripts/entity_defs/interfaces/IA.def', ifaceWithPack);
  write(root, 'scripts/entity_defs/interfaces/IB.def', ifaceWithPack);
  write(root, 'scripts/entity_defs/components/HealthComp.def', '<root>\n</root>');
  write(root, 'scripts/entity_defs/DupSlot.def', [
    '<root>',
    '  <Interfaces>',
    '    <interface>IA</interface>',
    '    <interface>IB</interface>',
    '  </Interfaces>',
    '</root>'
  ].join('\n'));

  // 父链组件槽重复:P1 有 pack,P2 继承 P1 且自己也声明 pack,P3 只继承
  const entityWithPack = (parent?: string): string => [
    '<root>',
    ...(parent ? [`  <Parent>${parent}</Parent>`] : []),
    '  <Components>',
    '    <pack>',
    '      <Type>HealthComp</Type>',
    '    </pack>',
    '  </Components>',
    '</root>'
  ].join('\n');
  write(root, 'scripts/entity_defs/SlotP1.def', entityWithPack());
  write(root, 'scripts/entity_defs/SlotP2.def', entityWithPack('SlotP1'));
  write(root, 'scripts/entity_defs/SlotP3.def', '<root>\n  <Parent>SlotP2</Parent>\n</root>');

  // 坏 XML:negative 结果缓存
  write(root, 'scripts/entity_defs/BadEntity.def', '<root><Hero>');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseLocalDefinition parsing gaps', () => {
  const semantics = parseLocalDefinition([
    '<root>',
    '  <Interfaces>',
    '    <Interface/>',
    '    <Interface><Monster/></Interface>',
    '    <interface>MoveIface</interface>',
    '  </Interfaces>',
    '  <Properties>',
    '    <mood>',
    '      <Type>UINT8</Type>',
    '      <Persistent>maybe</Persistent>',
    '    </mood>',
    '    <bag>',
    '      <Type>',
    '        ARRAY',
    '        <of>ITEM_POS</of>',
    '        <Properties>',
    '          <x>',
    '            <Type>UINT8</Type>',
    '          </x>',
    '        </Properties>',
    '      </Type>',
    '    </bag>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'entity', 'IfaceForms', '/tmp/IfaceForms.def');

  it('skips nameless interface refs and derives names from child elements', () => {
    // <Interface/> 无名跳过;<Interface><Monster/></Interface> 取首子元素名;
    // 直取形态引擎静默跳过(entitydef.cpp L559-561),故只认四拼写 wrapper
    expect(semantics.interfaces.map(ref => ref.name)).toEqual(['Monster', 'MoveIface']);
  });

  it('drops direct-name interface children the engine skips, exact wrapper spelling', () => {
    // 引擎 loadInterfaces(entitydef.cpp L559-561)只认 interface/Interface/
    // type/Type 四拼写 wrapper(大小写敏感精确比对),其余子元素 continue:
    // 直取形态 <X/> 与非四拼写的 <INTERFACE/> 引擎静默跳过,不产生混入
    const direct = parseLocalDefinition(
      [
        '<root>',
        '  <Interfaces>',
        '    <MoveIface/>',
        '    <INTERFACE>Mixed</INTERFACE>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      'entity',
      'DirectForms',
      '/tmp/DirectForms.def'
    );
    expect(direct.interfaces).toEqual([]);

    const wrapped = parseLocalDefinition(
      [
        '<root>',
        '  <Interfaces>',
        '    <interface>MoveIface</interface>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      'entity',
      'WrappedForm',
      '/tmp/WrappedForm.def'
    );
    expect(wrapped.interfaces).toEqual([{ name: 'MoveIface', line: 3 }]);
  });

  it('drops component slots with no Type tag and with an empty Type element', () => {
    // <slot/> 无 Type 节点、<typed><Type/> 空 Type 元素:本地解析阶段即丢弃,
    // 引擎 loadComponents 亦取不到类型,不产生槽位
    const noType = parseLocalDefinition(
      [
        '<root>',
        '  <Components>',
        '    <slot/>',
        '    <typed>',
        '      <Type/>',
        '    </typed>',
        '  </Components>',
        '</root>'
      ].join('\n'),
      'entity',
      'NoTypeSlots',
      '/tmp/NoTypeSlots.def'
    );
    expect(noType.components).toEqual([]);

    // 嵌套元素写法 <Type><GunComp/></Type> 无直接文本,回落取首子元素标签名
    // (容忍超集:与 <Parent><Hero/></Parent> 取名口径一致)
    const nested = parseLocalDefinition(
      [
        '<root>',
        '  <Components>',
        '    <gun>',
        '      <Type>',
        '        <GunComp/>',
        '      </Type>',
        '    </gun>',
        '  </Components>',
        '</root>'
      ].join('\n'),
      'entity',
      'NestedTypeSlots',
      '/tmp/NestedTypeSlots.def'
    );
    expect(nested.components.map(slot => slot.typeName)).toEqual(['GunComp']);
  });

  it('returns undefined persistent for unknown boolean spellings', () => {
    expect(semantics.properties[0].persistent).toBeUndefined();
    expect(semantics.properties[0].name).toBe('mood');
  });

  it('recurses into Properties nested inside an ARRAY Type element', () => {
    const bag = semantics.properties[1];
    expect(bag.arrayElement).toBeDefined();
    expect(bag.arrayElement?.typeName).toBe('ITEM_POS');
    expect(bag.arrayElement?.children).toHaveLength(1);
    expect(bag.arrayElement?.children[0].name).toBe('x');
    // 元素子属性 fullPath 以数组元素路径为前缀
    expect(bag.arrayElement?.children[0].fullPath).toBe('bag[].x');
  });
});

describe('loader cache and inheritance merge gaps', () => {
  it('caches the negative result of a definition that fails to parse', () => {
    const loader = createDefinitionSemanticsLoader(root)!;

    expect(loader.loadLocal('BadEntity', 'entity')).toBeNull();
    // 第二次直接命中缓存,仍为 null
    expect(loader.loadLocal('BadEntity', 'entity')).toBeNull();
  });

  it('deduplicates component slots coming from repeated interfaces', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const resolved = loader.loadResolved('DupSlot', 'entity')!;

    expect(resolved.components.map(slot => slot.slotName)).toEqual(['pack']);
  });

  it('deduplicates component slots accumulated along the parent chain', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const resolved = loader.loadResolved('SlotP3', 'entity')!;

    // SlotP2 解析时:自身 pack 与继承自 SlotP1 的 pack 同槽,第二个跳过
    expect(resolved.components.map(slot => slot.slotName)).toEqual(['pack']);
  });

  it('recovers the source chain from inherited methods on a pure-inheritance chain', () => {
    const loader = createDefinitionSemanticsLoader(root)!;
    const resolved = loader.loadResolved('TopE', 'entity')!;

    // TopE→MidE→BaseE:BaseE 组零属性,方法段 yell 提供来源链;
    // MidE 直推组为空组也入列
    const labels = resolved!.inheritanceGroups.map(group => group.label);
    expect(labels).toContain('Parent · MidE / BaseE');
    expect(resolved!.effectiveMethodsBySection.BaseMethods.map(method => method.name))
      .toEqual(['yell']);
  });
});

describe('parseMethods 空参数剔除', () => {
  it('drops empty Arg elements so args and argTypes stay 1:1', () => {
    const local = parseLocalDefinition([
      '<root>',
      '  <BaseMethods>',
      '    <hit><Arg></Arg><Arg>UINT32</Arg></hit>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'), 'entity', 'ArgE', '/tmp/ArgE.def');

    expect(local.methods).toHaveLength(1);
    expect(local.methods[0].args).toEqual(['UINT32']);
    expect(local.methods[0].argTypes).toHaveLength(1);
    expect(local.methods[0].argTypes[0]).toMatchObject({ name: 'UINT32' });
  });
});

describe('loadLocalRaw 原文直传面的两个空臂', () => {
  let rawRoot = '';

  beforeAll(() => {
    rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-rawgap-'));
    fs.mkdirSync(path.join(rawRoot, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(rawRoot, 'scripts/entity_defs/Real.def'),
      '<root><Properties><hp><Type>UINT32</Type></hp></Properties></root>',
      'utf8'
    );
    // 同名目录:定位面 existsSync 命中,快照读取 EISDIR 失败 → 内容 null
    fs.mkdirSync(path.join(rawRoot, 'scripts/entity_defs/NoRead.def'));
  });

  afterAll(() => {
    fs.rmSync(rawRoot, { recursive: true, force: true });
  });

  it('解析不到定义文件返回 null(路径解析失败,不虚建原文)', () => {
    const loader = createDefinitionSemanticsLoader(rawRoot)!;
    expect(loader.loadLocalRaw('NoSuchEntity', 'entity')).toBeNull();
  });

  it('定位到路径但读不到内容(同名目录 EISDIR)返回 null', () => {
    const loader = createDefinitionSemanticsLoader(rawRoot)!;
    expect(loader.loadLocalRaw('NoRead', 'entity')).toBeNull();
    // 对照:正常文件原文直传,不解析
    const raw = loader.loadLocalRaw('Real', 'entity')!;
    expect(raw.filePath).toBe(path.join(rawRoot, 'scripts/entity_defs/Real.def'));
    expect(raw.content).toContain('<Type>UINT32</Type>');
  });
});

describe('缓存身份探不到(文件被删)即重解析,不吐陈旧缓存', () => {
  let goneRoot = '';
  let heroPath = '';

  beforeAll(() => {
    goneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-gone-'));
    fs.mkdirSync(path.join(goneRoot, 'scripts/entity_defs'), { recursive: true });
    heroPath = path.join(goneRoot, 'scripts/entity_defs/Hero.def');
    fs.writeFileSync(
      heroPath,
      '<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>',
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(goneRoot, { recursive: true, force: true });
  });

  it('入口文件被删后同 loader 再查询:身份令牌探不到,当轮现解析回 null', () => {
    const loader = createDefinitionSemanticsLoader(goneRoot)!;
    expect(loader.loadResolved('Hero', 'entity')?.effectiveProperties.map(property => property.name))
      .toEqual(['hp']);

    fs.rmSync(heroPath);

    // 同一 loader 实例:resolvedCache 里留着上一轮的身份集合,重探入口文件
    // 身份时 stat 失败 → 身份令牌 null → 不等值判过期 → 重新解析(文件已
    // 不在,如实 null),绝不把旧语义当新鲜值吐出
    expect(loader.loadResolved('Hero', 'entity')).toBeNull();
  });
});

describe('接口的接口混入嵌套链:实体把二级接口的混入组带上来源链', () => {
  let chainRoot = '';

  beforeAll(() => {
    chainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-ifacechain-'));
    fs.mkdirSync(path.join(chainRoot, 'scripts/entity_defs/interfaces'), { recursive: true });
    fs.writeFileSync(
      path.join(chainRoot, 'scripts/entity_defs/interfaces/LeafIface.def'),
      '<root><Properties><leaf><Type>UINT8</Type></leaf></Properties></root>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(chainRoot, 'scripts/entity_defs/interfaces/MidIface.def'),
      [
        '<root>',
        '  <Interfaces>',
        '    <interface>LeafIface</interface>',
        '  </Interfaces>',
        '  <Properties>',
        '    <mid><Type>UINT8</Type></mid>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(chainRoot, 'scripts/entity_defs/NestedIfaceEntity.def'),
      [
        '<root>',
        '  <Interfaces>',
        '    <Interface>',
        '      <MidIface/>',
        '    </Interface>',
        '  </Interfaces>',
        '  <Properties>',
        '    <hp><Type>UINT32</Type></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(chainRoot, { recursive: true, force: true });
  });

  it('实体→Mid→Leaf 的混入组逐级入列,叶子属性来源链带两级接口名', () => {
    const loader = createDefinitionSemanticsLoader(chainRoot)!;
    const resolved = loader.loadResolved('NestedIfaceEntity', 'entity')!;

    // 一组来自直连 MidIface,一组来自 Mid 自身混入的 LeafIface(嵌套组)
    const labels = resolved.inheritanceGroups.map(group => group.label);
    expect(labels).toContain('Mixin · MidIface');
    expect(labels).toContain('Mixin · MidIface / LeafIface');

    const nested = resolved.inheritanceGroups.find(
      group => group.label === 'Mixin · MidIface / LeafIface'
    )!;
    expect(nested.owner.name).toBe('LeafIface');
    expect(nested.properties.map(property => property.name)).toEqual(['leaf']);
    expect(nested.properties[0].source.chain).toEqual(['MidIface', 'LeafIface']);
  });
});

describe('身份键词法折叠与符号链接实解析分叉:consumed 路径探不到身份不落缓存', () => {
  let aliasRoot = '';
  let realRoot = '';
  let rawDefPath = '';

  beforeAll(() => {
    // 分叉构造:身份键是词法折叠(.. 弹出,不懂符号链接),内核实解析却
    // 穿链接走另一棵树——aliasRoot/alias → realRoot/mid,raw 路径里的 ..
    // 弹掉 alias 后指向 aliasRoot/scripts(不存在),而内核沿链接落到
    // realRoot/scripts(存在)。读取走实路径成功,收尾身份重探走折叠键失败。
    aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-symdiv-'));
    realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-symdiv-real-'));
    fs.mkdirSync(path.join(realRoot, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(realRoot, 'scripts/entity_defs/Hero.def'),
      '<root><Properties><hp><Type>UINT32</Type><Flags>BASE</Flags></hp></Properties></root>',
      'utf8'
    );
    fs.mkdirSync(path.join(realRoot, 'mid'));
    fs.symlinkSync(path.join(realRoot, 'mid'), path.join(aliasRoot, 'alias'));
    rawDefPath = `${aliasRoot}/alias/../scripts/entity_defs/Hero.def`;
  });

  afterAll(() => {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  });

  it('读取成功但身份探不到 → 语义照常返回,但不落身份缓存(无身份不记忆)', () => {
    const loader = createDefinitionSemanticsLoader(aliasRoot)!;
    // 前提自证:折叠键目标在本根下不存在,读取成功全靠内核穿符号链接
    expect(fs.existsSync(path.join(aliasRoot, 'scripts'))).toBe(false);

    const resolved = loader.loadResolvedAt(rawDefPath, 'Hero', 'entity')!;
    expect(resolved.effectiveProperties.map(property => property.name)).toEqual(['hp']);

    // 收尾身份重探(消费键=词法折叠)stat 失败 → 身份集合 null → 本轮结果
    // 不落缓存。证据:删掉实树文件后再查,同键重解析如实回 null——若曾被
    // 缓存,这里会吐出陈旧语义
    fs.rmSync(path.join(realRoot, 'scripts/entity_defs/Hero.def'));
    expect(loader.loadResolvedAt(rawDefPath, 'Hero', 'entity')).toBeNull();
  });
});

// 逐行不可达论证(诚实边界,不写凑数测试):
// - 类内私有 effectivePropertyKey 方法体(与模块级同名函数相邻排版):类方法
//   体内的裸标识符调用走模块级 effectivePropertyKey 函数(class 成员必须经
//   this. 限定才进入作用域),私有方法本体无任何调用点,是死代码;其逻辑由
//   模块级同名函数承载并被上游测试覆盖。产品代码不得动,故按不可达记账。
