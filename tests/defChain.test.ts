import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDefChain } from '../src/defChain';

// def 链合并呈现(source-analysis 设计 D5 剩余段):`<Parent>` 递归 +
// interfaces/ 平铺 + components/ 挂接,与引擎归并口径一致(entitydef.cpp:
// 890-924、551-639、642-771);引擎 loadParentClass 未见防环,kode 必须带
// visited 截断。纯逻辑用例;悬停装配面在 languageProviders 测试覆盖。

let root = '';

const write = (relative: string, content: string): string => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defchain-'));

  // 定义根推导靠 entities.xml 锚(findEntityDefsRootFromFile 口径)
  write('scripts/entities.xml', '<root>\n  <Avatar/>\n</root>');

  write('scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <Parent>Monster</Parent>',
    '  <Interfaces>',
    '    <Interface><ICombat/></Interface>',
    '  </Interfaces>',
    '  <Components>',
    '    <inventory>',
    '      <Type>Inventory</Type>',
    '    </inventory>',
    '  </Components>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Parent>NPC</Parent>',
    '  <Interfaces>',
    '    <Interface><ILife/></Interface>',
    '  </Interfaces>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/NPC.def', '<root>\n</root>');
  write('scripts/entity_defs/interfaces/ICombat.def', '<root>\n</root>');
  write('scripts/entity_defs/interfaces/ILife.def', '<root>\n</root>');
  write('scripts/entity_defs/components/Inventory.def', '<root>\n</root>');
  // 接口 def 带 Parent:引擎 loadInterfaces 不读 Parent,链不得穿过它
  write('scripts/entity_defs/interfaces/IHaunted.def', [
    '<root>',
    '  <Parent>Ghost</Parent>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Lonely.def', '<root>\n</root>');
  // 父名缺 def 文件(纯脚本父类形态)
  write('scripts/entity_defs/Orphan.def', '<root>\n  <Parent>Vanished</Parent>\n</root>');
  // 环:A → B → A
  write('scripts/entity_defs/CycleA.def', '<root>\n  <Parent>CycleB</Parent>\n</root>');
  write('scripts/entity_defs/CycleB.def', '<root>\n  <Parent>CycleA</Parent>\n</root>');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildDefChain', () => {
  it('递归收集 Parent 链并平铺各级 Interfaces 与 Components', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/Avatar.def'));
    expect(info.parentChain.map(item => item.name)).toEqual(['Monster', 'NPC']);
    expect(info.parentChain[0].defPath).toBe(path.join(root, 'scripts/entity_defs/Monster.def'));
    expect(info.parentChain[1].defPath).toBe(path.join(root, 'scripts/entity_defs/NPC.def'));
    // 入口与祖先两级的接口都平铺,首见保序
    expect(info.interfaces.map(item => item.name)).toEqual(['ICombat', 'ILife']);
    expect(info.interfaces[0].defPath).toBe(path.join(root, 'scripts/entity_defs/interfaces/ICombat.def'));
    expect(info.components.map(item => item.name)).toEqual(['Inventory']);
    expect(info.components[0].defPath).toBe(path.join(root, 'scripts/entity_defs/components/Inventory.def'));
    expect(info.cycleTruncated).toBe(false);
  });

  it('裸 def(无 Parent/接口/组件)三面皆空', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/Lonely.def'));
    expect(info.parentChain).toEqual([]);
    expect(info.interfaces).toEqual([]);
    expect(info.components).toEqual([]);
    expect(info.cycleTruncated).toBe(false);
  });

  it('父名缺 def 文件时链停在该名,defPath 为 null', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/Orphan.def'));
    expect(info.parentChain).toHaveLength(1);
    expect(info.parentChain[0]).toEqual({ name: 'Vanished', defPath: null });
  });

  it('环被 visited 截断并如实标记', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/CycleA.def'));
    expect(info.parentChain.map(item => item.name)).toEqual(['CycleB', 'CycleA']);
    expect(info.cycleTruncated).toBe(true);
  });

  it('接口 def 不跟随 Parent(引擎 loadInterfaces 口径)', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/interfaces/IHaunted.def'));
    expect(info.parentChain).toEqual([]);
  });

  it('组件 def 的 Parent 在 components/ 内解析', () => {
    write('scripts/entity_defs/components/Pack.def', [
      '<root>',
      '  <Parent>Inventory</Parent>',
      '</root>'
    ].join('\n'));
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/components/Pack.def'));
    expect(info.parentChain.map(item => item.name)).toEqual(['Inventory']);
    expect(info.parentChain[0].defPath).toBe(path.join(root, 'scripts/entity_defs/components/Inventory.def'));
  });

  it('祖先文件读不到时链在该层停止,不虚构', () => {
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/Nowhere.def'), () => null);
    expect(info.parentChain).toEqual([]);
    expect(info.interfaces).toEqual([]);
    expect(info.components).toEqual([]);
  });

  it('同名接口跨层级去重(首见保序)', () => {
    write('scripts/entity_defs/BothIface.def', [
      '<root>',
      '  <Parent>Monster</Parent>',
      '  <Interfaces>',
      '    <Interface><ILife/></Interface>',
      '  </Interfaces>',
      '</root>'
    ].join('\n'));
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/BothIface.def'));
    expect(info.interfaces.map(item => item.name)).toEqual(['ILife']);
  });

  it('同名组件槽跨层级去重(首见保序)', () => {
    write('scripts/entity_defs/BothCompBase.def', [
      '<root>',
      '  <Components>',
      '    <bag>',
      '      <Type>Inventory</Type>',
      '    </bag>',
      '  </Components>',
      '</root>'
    ].join('\n'));
    write('scripts/entity_defs/BothComp.def', [
      '<root>',
      '  <Parent>BothCompBase</Parent>',
      '  <Components>',
      '    <bag>',
      '      <Type>Inventory</Type>',
      '    </bag>',
      '  </Components>',
      '</root>'
    ].join('\n'));
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/BothComp.def'));
    expect(info.components.map(item => item.name)).toEqual(['Inventory']);
  });

  it('接口/组件 def 缺文件时 defPath 如实为 null', () => {
    write('scripts/entity_defs/LooseRefs.def', [
      '<root>',
      '  <Interfaces>',
      '    <Interface><IGhost/></Interface>',
      '  </Interfaces>',
      '  <Components>',
      '    <slot>',
      '      <Type>GhostComp</Type>',
      '    </slot>',
      '  </Components>',
      '</root>'
    ].join('\n'));
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/LooseRefs.def'));
    expect(info.interfaces[0]).toEqual({ name: 'IGhost', defPath: null });
    expect(info.components[0]).toEqual({ name: 'GhostComp', defPath: null });
  });

  it('祖先 def 存在但内容畸形时闭包在该层停住,不虚构声明', () => {
    write('scripts/entity_defs/BrokenBase.def', '<not-closed');
    write('scripts/entity_defs/BrokenChild.def', '<root>\n  <Parent>BrokenBase</Parent>\n</root>');
    const info = buildDefChain(path.join(root, 'scripts/entity_defs/BrokenChild.def'));
    expect(info.parentChain.map(item => item.name)).toEqual(['BrokenBase']);
    expect(info.interfaces).toEqual([]);
    expect(info.components).toEqual([]);
  });

  it('定义根推导不出(文件不在 entity_defs 树内)三面皆空', () => {
    const outside = path.join(root, 'loose/Loose.def');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '<root>\n  <Parent>Monster</Parent>\n</root>');
    const info = buildDefChain(outside);
    expect(info.parentChain).toEqual([]);
    expect(info.interfaces).toEqual([]);
    expect(info.components).toEqual([]);
  });
});
