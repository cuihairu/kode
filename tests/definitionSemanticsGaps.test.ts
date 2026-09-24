import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinitionSemanticsLoader,
  parseLocalDefinition
} from '../src/definitionSemantics';

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
    '    <IA/>',
    '    <IB/>',
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
    '    <MoveIface/>',
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
    // <MoveIface/> 直接取标签名
    expect(semantics.interfaces.map(ref => ref.name)).toEqual(['Monster', 'MoveIface']);
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
