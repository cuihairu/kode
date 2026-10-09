import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批111 验收走查:引用型字段全量接通后的清单式实跳记录。每类字段点跳一次,
// 断言落点(文件 + 行)正确;负例断言不虚跳(null)。走查清单:
//
// 方法段 → 脚本 def 行(候选闭包:自有角色脚本 → 本 def 接口脚本 → 父 def 角色
// 脚本 → 父 def 接口脚本 → 逐级上溯;接口 def 不跟随 Parent;<Interfaces> 混入
// 只认引擎装载拼写——wrapper 四拼写 interface/Interface/type/Type,接口名取
// wrapper 首子节点(entitydef.cpp loadInterfaces:551-639,直取形态引擎不装载)):
//   ① 自有角色脚本优先(Hero.onKill → base/Hero.py)
//   ② 接口混入脚本(Hero.onScan → interfaces/MoveIface.py)
//   ③ 父 def 角色脚本(Hero.onRoam → base/Mob.py)
//   ④ 祖父 def 传递(NPC.onHeir → base/Grandparent.py)
//   ⑤ CellMethods 自有脚本(Hero.onUpdate → cell/Hero.py)
//   ⑥ ClientMethods 自有脚本(Hero.onSpawn → client/Hero.py)
//   ⑦ 组件 def 经 components/ 父链(MoveComponent.onTick → cell/BaseComponent.py)
//   ⑧ 组件 def 自身无脚本落父脚本(ChildComponent.onTick → cell/BaseComponent.py)
//   ⑨ 接口 def 自身脚本(MoveIface.onScan → interfaces/MoveIface.py)
//   ⑩ 负例:悬空 Parent(Target.onMiss → null)
//   ⑪ 负例:空父 def(EmptyParentCase.onEdge → null)
//   ⑫ 负例:Parent 环(CycleA.onLoop → null)
//   ⑬ 负例:闭包可解析但方法无实现(Orphan.onGhost → null)
// def → def 引用段:
//   ⑭ Parent 子标签 → 兄弟 def(Hero 的 Mob)
//   ⑮ Interfaces 子标签 → 接口 def(Hero 的 MoveIface)
//   ⑯ Type 值(实体)→ 实体 def(Mob 的 Hero)
//   ⑰ Type 值(组件,Properties 内)→ 组件 def(Hero 的 MoveComponent)
//   ⑱ Type 值(组件,Components 槽位)→ 组件 def(Mob 的 MoveComponent)
//   ⑲ Type 值(自定义别名)→ types.xml 声明行(Hero 的 GIFT)
//   ⑳ Arg 值 → 实体 def(Mob.onRoam 的 Hero)
//   ㉑ 负例:Type 值自引用(Hero 的 Hero → null)
// 同文件引用段:
//   ㉒ DetailLevel 值 → <DetailLevels> 档位行(Hero 的 NEAR)
//   ㉓ DetailLevel 值 → 另一档位行(Hero 的 MEDIUM)
//   ㉔ 负例:无 DetailLevels 段(Lone 的 NEAR → null)
//   ㉕ 负例:有 DetailLevels 段但档位未声明(Hero 的 FAR 值点在 sight 上 → null)
// 补例(方法闭包边界):
//   ㉖ 负例:父 def 坏 XML(UnderBroken.onEdge → null,语义面为空即止)
//   ㉗ 负例:组件父 def 不存在(OrphanComponent.onTick → null)

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

let root = '';

const ENTITIES_XML = [
  '<root>',
  '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
  '  <Mob hasBase="true" hasCell="false" hasClient="true"/>',
  '  <NPC hasBase="true" hasCell="true" hasClient="false"/>',
  '  <Target hasBase="true" hasCell="false" hasClient="false"/>',
  '  <EmptyParentCase hasBase="true" hasCell="false" hasClient="false"/>',
  '</root>'
].join('\n');

const TYPES_XML = [
  '<root>',
  '  <DOLL>',
  '    <Type>FIXED_DICT</Type>',
  '    <Properties>',
  '      <name><Type>UNICODE</Type></name>',
  '      <dbid/>',
  '    </Properties>',
  '    <implementedBy>item.doll</implementedBy>',
  '  </DOLL>',
  '  <GIFT>',
  '    <Type>DOLL</Type>',
  '  </GIFT>',
  '  <BROKEN>',
  '    <Type>UINT8</Type>',
  '    <implementedBy>nosuch.mod</implementedBy>',
  '  </BROKEN>',
  '</root>'
].join('\n');

const HERO_DEF = [
  '<root>',
  '  <Parent>Mob</Parent>',
  '  <Interfaces>',
  '    <Interface>',
  '      <MoveIface/>',
  '    </Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>CELL_AND_CLIENTS</Flags>',
  '      <DetailLevel>NEAR</DetailLevel>',
  '      <Persistent>true</Persistent>',
  '      <DatabaseLength>128</DatabaseLength>',
  '      <Identifier>true</Identifier>',
  '    </hp>',
  '    <sight>',
  '      <Type>UINT16</Type>',
  '      <DetailLevel>MEDIUM</DetailLevel>',
  '    </sight>',
  '    <ref>',
  '      <Type>Hero</Type>',
  '    </ref>',
  '    <bag>',
  '      <Type>GIFT</Type>',
  '    </bag>',
  '    <comp>',
  '      <Type>MoveComponent</Type>',
  '    </comp>',
  '  </Properties>',
  '  <DetailLevels>',
  '    <NEAR>',
  '      <radius>10</radius>',
  '      <hyst>1</hyst>',
  '    </NEAR>',
  '    <MEDIUM>',
  '      <radius>20</radius>',
  '      <hyst>2</hyst>',
  '    </MEDIUM>',
  '    <FAR>',
  '      <radius>30</radius>',
  '      <hyst>3</hyst>',
  '    </FAR>',
  '  </DetailLevels>',
  '  <BaseMethods>',
  '    <onKill>',
  '      <Arg>ENTITY_ID</Arg>',
  '      <Exposed>true</Exposed>',
  '    </onKill>',
  '    <onScan>',
  '      <Arg>Hero</Arg>',
  '    </onScan>',
  '    <onRoam>',
  '      <Arg>UINT8</Arg>',
  '    </onRoam>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onUpdate>',
  '      <Arg>UINT32</Arg>',
  '    </onUpdate>',
  '  </CellMethods>',
  '  <ClientMethods>',
  '    <onSpawn>',
  '      <Arg>UINT8</Arg>',
  '    </onSpawn>',
  '  </ClientMethods>',
  '</root>'
].join('\n');

const MOB_DEF = [
  '<root>',
  '  <Parent>Grandparent</Parent>',
  '  <Interfaces>',
  '    <Interface>',
  '      <ScanIface/>',
  '    </Interface>',
  '  </Interfaces>',
  '  <Properties>',
  '    <master>',
  '      <Type>Hero</Type>',
  '    </master>',
  '  </Properties>',
  '  <Components>',
  '    <mover>',
  '      <Type>MoveComponent</Type>',
  '    </mover>',
  '  </Components>',
  '  <BaseMethods>',
  '    <onRoam>',
  '      <Arg>Hero</Arg>',
  '    </onRoam>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const NPC_DEF = [
  '<root>',
  '  <Parent>Mob</Parent>',
  '  <BaseMethods>',
  '    <onHeir/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const GRANDPARENT_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <onHeir/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const TARGET_DEF = [
  '<root>',
  '  <Parent>Ghostless</Parent>',
  '  <BaseMethods>',
  '    <onMiss/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const EMPTY_PARENT_CASE_DEF = [
  '<root>',
  '  <Parent>EmptyParent</Parent>',
  '  <BaseMethods>',
  '    <onEdge/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const LONE_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <DetailLevel>NEAR</DetailLevel>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const CYCLE_A_DEF = [
  '<root>',
  '  <Parent>CycleB</Parent>',
  '  <BaseMethods>',
  '    <onLoop/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const CYCLE_B_DEF = [
  '<root>',
  '  <Parent>CycleA</Parent>',
  '  <BaseMethods>',
  '    <onLoop/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const ORPHAN_DEF = [
  '<root>',
  '  <Parent>Mob</Parent>',
  '  <BaseMethods>',
  '    <onGhost/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

// 父 def 坏 XML:语义面为空(getReferenceTargetName 所在的 parseDefText 失败),
// 闭包在父级即止,不产生候选
const UNDER_BROKEN_DEF = [
  '<root>',
  '  <Parent>BrokenParent</Parent>',
  '  <BaseMethods>',
  '    <onEdge/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const BROKEN_PARENT_DEF = '<root><BaseMethods><onEdge/></BaseMethods>';

// 组件父 def 在 components/ 内不存在:悬空引用不产生候选
const ORPHAN_COMPONENT_DEF = [
  '<root>',
  '  <Parent>GhostComp</Parent>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const MOVE_IFACE_DEF = [
  '<root>',
  '  <BaseMethods>',
  '    <onScan/>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const MOVE_COMPONENT_DEF = [
  '<root>',
  '  <Parent>BaseComponent</Parent>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const BASE_COMPONENT_DEF = [
  '<root>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const CHILD_COMPONENT_DEF = [
  '<root>',
  '  <Parent>BaseComponent</Parent>',
  '  <CellMethods>',
  '    <onTick/>',
  '  </CellMethods>',
  '</root>'
].join('\n');

const HERO_BASE_PY = [
  'class Hero(object):',
  '    def onKill(self):',
  '        pass'
].join('\n');

const MOB_BASE_PY = [
  'class Mob(object):',
  '    def onRoam(self):',
  '        pass'
].join('\n');

const GRANDPARENT_BASE_PY = [
  'class Grandparent(object):',
  '    def onHeir(self):',
  '        pass'
].join('\n');

const HERO_CELL_PY = [
  'class Hero(object):',
  '    def onUpdate(self):',
  '        pass'
].join('\n');

const HERO_CLIENT_PY = [
  'class Hero(object):',
  '    def onSpawn(self):',
  '        pass'
].join('\n');

const MOVE_IFACE_PY = [
  'class MoveIface(object):',
  '    def onScan(self):',
  '        pass'
].join('\n');

const BASE_COMPONENT_CELL_PY = [
  'class BaseComponent(object):',
  '    def onTick(self):',
  '        pass'
].join('\n');

const defFixtures: Array<[string, string]> = [
  ['scripts/entities.xml', ENTITIES_XML],
  ['scripts/entity_defs/types.xml', TYPES_XML],
  ['scripts/entity_defs/Hero.def', HERO_DEF],
  ['scripts/entity_defs/Mob.def', MOB_DEF],
  ['scripts/entity_defs/NPC.def', NPC_DEF],
  ['scripts/entity_defs/Grandparent.def', GRANDPARENT_DEF],
  ['scripts/entity_defs/Target.def', TARGET_DEF],
  ['scripts/entity_defs/EmptyParentCase.def', EMPTY_PARENT_CASE_DEF],
  ['scripts/entity_defs/EmptyParent.def', '<root></root>'],
  ['scripts/entity_defs/Lone.def', LONE_DEF],
  ['scripts/entity_defs/CycleA.def', CYCLE_A_DEF],
  ['scripts/entity_defs/CycleB.def', CYCLE_B_DEF],
  ['scripts/entity_defs/Orphan.def', ORPHAN_DEF],
  ['scripts/entity_defs/UnderBroken.def', UNDER_BROKEN_DEF],
  ['scripts/entity_defs/BrokenParent.def', BROKEN_PARENT_DEF],
  ['scripts/entity_defs/components/OrphanComponent.def', ORPHAN_COMPONENT_DEF],
  ['scripts/entity_defs/interfaces/MoveIface.def', MOVE_IFACE_DEF],
  ['scripts/entity_defs/interfaces/ScanIface.def', '<root></root>'],
  ['scripts/entity_defs/components/MoveComponent.def', MOVE_COMPONENT_DEF],
  ['scripts/entity_defs/components/BaseComponent.def', BASE_COMPONENT_DEF],
  ['scripts/entity_defs/components/ChildComponent.def', CHILD_COMPONENT_DEF],
  ['scripts/base/Hero.py', HERO_BASE_PY],
  ['scripts/base/Mob.py', MOB_BASE_PY],
  ['scripts/base/Grandparent.py', GRANDPARENT_BASE_PY],
  ['scripts/cell/Hero.py', HERO_CELL_PY],
  ['scripts/client/Hero.py', HERO_CLIENT_PY],
  ['scripts/interfaces/MoveIface.py', MOVE_IFACE_PY],
  ['scripts/cell/BaseComponent.py', BASE_COMPONENT_CELL_PY]
];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-batch111-walk-'));
  for (const [relative, content] of defFixtures) {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

// `|` 标记光标位置。
const cursorOf = (template: string): { text: string; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return { text, position: new Position(line, character) };
};

const docAt = (
  template: string,
  fileName: string
): { document: MinimalTextDocument; position: Position } => {
  const { text, position } = cursorOf(template);
  return {
    document: makeTextDocument(text, {
      fileName: p(root, ...fileName.split('/')),
      languageId: 'kbengine-def'
    }),
    position
  };
};

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number; character: number } };
}

const lineOf = (content: string, predicate: (line: string) => boolean): number =>
  content.split('\n').findIndex(predicate);

describe('批111 走查 A:方法段 → 脚本 def 行', () => {
  const provider = new KBEngineDefinitionProvider();

  it('① 自有角色脚本优先:BaseMethods.onKill → base/Hero.py 的 def 行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('    <onKill>', '    <|onKill>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/base/Hero.py'));
    expect(location?.range.start.line).toBe(lineOf(HERO_BASE_PY, line => line.includes('def onKill')));
  });

  it('② 接口混入脚本:BaseMethods.onScan → interfaces/MoveIface.py 的 def 行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('    <onScan>', '    <|onScan>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/interfaces/MoveIface.py'));
    expect(location?.range.start.line).toBe(lineOf(MOVE_IFACE_PY, line => line.includes('def onScan')));
  });

  it('③ 父 def 角色脚本:BaseMethods.onRoam → base/Mob.py 的 def 行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('    <onRoam>', '    <|onRoam>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/base/Mob.py'));
    expect(location?.range.start.line).toBe(lineOf(MOB_BASE_PY, line => line.includes('def onRoam')));
  });

  it('④ 祖父 def 传递:NPC.onHeir → base/Grandparent.py 的 def 行', async () => {
    const { document, position } = docAt(
      NPC_DEF.replace('    <onHeir/>', '    <|onHeir/>'),
      'scripts/entity_defs/NPC.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/base/Grandparent.py'));
    expect(location?.range.start.line).toBe(
      lineOf(GRANDPARENT_BASE_PY, line => line.includes('def onHeir'))
    );
  });

  it('⑤ CellMethods 自有脚本:onUpdate → cell/Hero.py 的 def 行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('    <onUpdate>', '    <|onUpdate>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/cell/Hero.py'));
    expect(location?.range.start.line).toBe(lineOf(HERO_CELL_PY, line => line.includes('def onUpdate')));
  });

  it('⑥ ClientMethods 自有脚本:onSpawn → client/Hero.py 的 def 行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('    <onSpawn>', '    <|onSpawn>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/client/Hero.py'));
    expect(location?.range.start.line).toBe(lineOf(HERO_CLIENT_PY, line => line.includes('def onSpawn')));
  });

  it('⑦ 组件 def 经 components/ 父链:MoveComponent.onTick → cell/BaseComponent.py', async () => {
    const { document, position } = docAt(
      MOVE_COMPONENT_DEF.replace('    <onTick/>', '    <|onTick/>'),
      'scripts/entity_defs/components/MoveComponent.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/cell/BaseComponent.py'));
    expect(location?.range.start.line).toBe(
      lineOf(BASE_COMPONENT_CELL_PY, line => line.includes('def onTick'))
    );
  });

  it('⑧ 组件 def 自身无脚本落父脚本:ChildComponent.onTick → cell/BaseComponent.py', async () => {
    const { document, position } = docAt(
      CHILD_COMPONENT_DEF.replace('    <onTick/>', '    <|onTick/>'),
      'scripts/entity_defs/components/ChildComponent.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/cell/BaseComponent.py'));
    expect(location?.range.start.line).toBe(
      lineOf(BASE_COMPONENT_CELL_PY, line => line.includes('def onTick'))
    );
  });

  it('⑨ 接口 def 自身脚本:MoveIface.onScan → interfaces/MoveIface.py 的 def 行', async () => {
    const { document, position } = docAt(
      MOVE_IFACE_DEF.replace('    <onScan/>', '    <|onScan/>'),
      'scripts/entity_defs/interfaces/MoveIface.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/interfaces/MoveIface.py'));
    expect(location?.range.start.line).toBe(lineOf(MOVE_IFACE_PY, line => line.includes('def onScan')));
  });

  it('⑩ 负例:悬空 Parent(Target.onMiss)→ null', async () => {
    const { document, position } = docAt(
      TARGET_DEF.replace('    <onMiss/>', '    <|onMiss/>'),
      'scripts/entity_defs/Target.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('⑪ 负例:空父 def(EmptyParentCase.onEdge)→ null', async () => {
    const { document, position } = docAt(
      EMPTY_PARENT_CASE_DEF.replace('    <onEdge/>', '    <|onEdge/>'),
      'scripts/entity_defs/EmptyParentCase.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('⑫ 负例:Parent 环(CycleA.onLoop)→ null', async () => {
    const { document, position } = docAt(
      CYCLE_A_DEF.replace('    <onLoop/>', '    <|onLoop/>'),
      'scripts/entity_defs/CycleA.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('⑬ 负例:闭包可解析但方法无实现(Orphan.onGhost)→ null', async () => {
    const { document, position } = docAt(
      ORPHAN_DEF.replace('    <onGhost/>', '    <|onGhost/>'),
      'scripts/entity_defs/Orphan.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('㉖ 负例:父 def 坏 XML(UnderBroken.onEdge)→ null', async () => {
    const { document, position } = docAt(
      UNDER_BROKEN_DEF.replace('    <onEdge/>', '    <|onEdge/>'),
      'scripts/entity_defs/UnderBroken.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('㉗ 负例:组件父 def 不存在(OrphanComponent.onTick)→ null', async () => {
    const { document, position } = docAt(
      ORPHAN_COMPONENT_DEF.replace('    <onTick/>', '    <|onTick/>'),
      'scripts/entity_defs/components/OrphanComponent.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});

describe('批111 走查 B:def → def 引用段', () => {
  const provider = new KBEngineDefinitionProvider();

  it('⑭ Parent 子标签 → 兄弟 def(Hero 的 Mob)', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('<Parent>Mob</Parent>', '<Parent>Mo|b</Parent>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/Mob.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('⑮ Interfaces 混入名 → 接口 def(Hero 的 MoveIface)', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('      <MoveIface/>', '      <Mo|veIface/>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/interfaces/MoveIface.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('⑯ Type 值(实体)→ 实体 def(Mob 的 Hero)', async () => {
    const { document, position } = docAt(
      MOB_DEF.replace('      <Type>Hero</Type>', '      <Type>He|ro</Type>'),
      'scripts/entity_defs/Mob.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/Hero.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('⑰ Type 值(组件,Properties 内)→ 组件 def(Hero 的 MoveComponent)', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('      <Type>MoveComponent</Type>', '      <Type>MoveCompo|nent</Type>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/components/MoveComponent.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('⑱ Type 值(组件,Components 槽位)→ 组件 def(Mob 的 MoveComponent)', async () => {
    const { document, position } = docAt(
      MOB_DEF.replace('      <Type>MoveComponent</Type>', '      <Type>MoveCompo|nent</Type>'),
      'scripts/entity_defs/Mob.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/components/MoveComponent.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('⑲ Type 值(自定义别名)→ types.xml 声明行(Hero 的 GIFT)', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('      <Type>GIFT</Type>', '      <Type>GI|FT</Type>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/types.xml'));
    expect(location?.range.start.line).toBe(lineOf(TYPES_XML, line => line.includes('<GIFT>')));
  });

  it('⑳ Arg 值 → 实体 def(Mob.onRoam 的 Hero)', async () => {
    const { document, position } = docAt(
      MOB_DEF.replace('      <Arg>Hero</Arg>', '      <Arg>He|ro</Arg>'),
      'scripts/entity_defs/Mob.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/Hero.def'));
    expect(location?.range.start.line).toBe(0);
  });

  it('㉑ 负例:Type 值自引用(Hero 的 Hero)→ null', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('      <Type>Hero</Type>', '      <Type>He|ro</Type>'),
      'scripts/entity_defs/Hero.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});

describe('批111 走查 C:同文件引用段(DetailLevel → 档位声明)', () => {
  const provider = new KBEngineDefinitionProvider();

  it('㉒ DetailLevel 值 → <DetailLevels> 的 NEAR 档位行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('<DetailLevel>NEAR</DetailLevel>', '<DetailLevel>NEA|R</DetailLevel>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/Hero.def'));
    expect(location?.range.start.line).toBe(lineOf(HERO_DEF, line => line.includes('<NEAR>')));
  });

  it('㉓ DetailLevel 值 → <DetailLevels> 的 MEDIUM 档位行', async () => {
    const { document, position } = docAt(
      HERO_DEF.replace('<DetailLevel>MEDIUM</DetailLevel>', '<DetailLevel>MEDI|UM</DetailLevel>'),
      'scripts/entity_defs/Hero.def'
    );

    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts/entity_defs/Hero.def'));
    expect(location?.range.start.line).toBe(lineOf(HERO_DEF, line => line.includes('<MEDIUM>')));
  });

  it('㉔ 负例:无 DetailLevels 段(Lone 的 NEAR)→ null', async () => {
    const { document, position } = docAt(
      LONE_DEF.replace('<DetailLevel>NEAR</DetailLevel>', '<DetailLevel>NEA|R</DetailLevel>'),
      'scripts/entity_defs/Lone.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });

  it('㉕ 负例:有 DetailLevels 段但档位未声明(Hero 的 ULTRA)→ null', async () => {
    // sight 声明 DetailLevel ULTRA,而 <DetailLevels> 只声明了 NEAR/MEDIUM/FAR:
    // 档位名在声明列表里找不到 → null,不虚跳
    const { document, position } = docAt(
      HERO_DEF.replace('<DetailLevel>MEDIUM</DetailLevel>', '<DetailLevel>ULT|RA</DetailLevel>'),
      'scripts/entity_defs/Hero.def'
    );

    expect(await provider.provideDefinition(document, position)).toBeNull();
  });
});
