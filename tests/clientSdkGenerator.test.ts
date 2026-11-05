// 客户端实体 SDK 生成器(盘点 G4,已代决:首批 TS + C# 两种目标语言)。
// 纯解析/映射/发射函数走纯函数用例;collectClientSdkEntities 与
// generateClientSdkEntities 在真实临时工作区树上写真实文件(同
// codeGeneratorFiles.test.ts 既有约定);命令编排走可脚本化的 fake vscode
// 窗口。源定义口径复用 defParser/defAnalyzer 既有模块,不重写解析。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClientSdkTypeMap,
  collectClientSdkEntities,
  findClientSdkMemberConflicts,
  formatClientSdkMemberConflictMessage,
  generateClientSdkComponentsFile,
  generateClientSdkEntities,
  generateClientSdkEntityFile,
  generateClientSdkFixedDictsFile,
  isClientVisibleProperty,
  parseClientSdkEntity,
  resolveClientSdkTypeName,
  runClientSdkGenerateCommand
} from '../src/clientSdkGenerator';
import type {
  ClientSdkLanguage,
  ClientSdkTypeMap
} from '../src/clientSdkGenerator';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { Uri, messages } from './helpers/vscodeStub';
import { window as windowish, workspace as workspaceish } from './helpers/vscodeStub';

const GENERATED_AT = '2026-10-16T08:00:00.000Z';

const FULL_DEF = `<!DOCTYPE entity>
<!-- Avatar 实体定义 -->
<root>
  <Parent>
    <Entity/>
  </Parent>
  <Properties>
    <name>
      <Type>STRING</Type>
      <Flags>BASE</Flags>
    </name>
    <hp>
      <Type>UINT32</Type>
      <Flags>CELL_PUBLIC_AND_OWN</Flags>
      <Default>100</Default>
    </hp>
    <homePosition>
      <Type>VECTOR3</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </homePosition>
    <loot>
      <Type>ARRAY<of>UINT8</of></Type>
      <Flags>OWN_CLIENT</Flags>
    </loot>
    <bag>
      <Type>AvatarProps</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </bag>
    <skills>
      <Type>ARRAY<of>STRING</of></Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </skills>
  </Properties>
  <BaseMethods>
    <createAvatar>
      <Exposed/>
      <Arg>UINT8</Arg>
    </createAvatar>
    <internalPurge>
      <Arg>UINT32</Arg>
    </internalPurge>
  </BaseMethods>
  <CellMethods>
    <moveTo>
      <Exposed>true</Exposed>
      <Arg>VECTOR3</Arg>
    </moveTo>
  </CellMethods>
  <ClientMethods>
    <onHPChanged>
      <Arg>UINT32</Arg>
      <Arg>UINT32</Arg>
    </onHPChanged>
  </ClientMethods>
</root>
`;

const MINIMAL_DEF = `<root>
  <Properties>
    <level>
      <Type>UINT8</Type>
      <Flags>BASE</Flags>
    </level>
  </Properties>
</root>
`;

// IDE-AUD-062:业务属性占用辅助成员名(TS entityId / C# EntityId)。
const ENTITY_ID_COLLISION_DEF = `<root>
  <Properties>
    <entityId>
      <Type>UINT32</Type>
      <Flags>OWN_CLIENT</Flags>
    </entityId>
  </Properties>
  <ClientMethods>
    <onBaseOutgoing>
      <Arg>UINT32</Arg>
    </onBaseOutgoing>
  </ClientMethods>
</root>
`;

// IDE-AUD-063:TS SDK 64 位整数表示——UINT64/INT64 与 ARRAY 元素。
const INT64_DEF = `<root>
  <Properties>
    <coins>
      <Type>UINT64</Type>
      <Flags>OWN_CLIENT</Flags>
    </coins>
    <balance>
      <Type>INT64</Type>
      <Flags>BASE_AND_CLIENT</Flags>
    </balance>
    <tags>
      <Type>ARRAY<of>UINT64</of></Type>
      <Flags>OWN_CLIENT</Flags>
    </tags>
  </Properties>
</root>
`;

function makeCustomTypeInfo(
  name: string,
  aliasType: string,
  properties: Array<[string, string | undefined]> = []
): CustomTypeInfo {
  return {
    name,
    filePath: 'scripts/entity_defs/types.xml',
    line: 1,
    implementedByLine: 1,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: aliasType,
    structure: { name: aliasType, rawValue: aliasType, children: [] },
    properties: properties.map(([propertyName, typeName]) => ({ name: propertyName, typeName }))
  };
}

function makeFixedDictTypeMap(language: ClientSdkLanguage): ClientSdkTypeMap {
  return buildClientSdkTypeMap(
    [
      makeCustomTypeInfo('AvatarProps', 'FIXED_DICT', [['hp', 'UINT32'], ['name', 'STRING']]),
      makeCustomTypeInfo('Money', 'UINT32')
    ],
    language
  );
}

describe('parseClientSdkEntity', () => {
  it('解析完整定义:Parent、属性旗标域、三类方法面', () => {
    const entity = parseClientSdkEntity(FULL_DEF, 'Avatar');

    expect(entity).not.toBeNull();
    expect(entity?.name).toBe('Avatar');
    expect(entity?.parent).toBe('Entity');

    const byName = new Map((entity?.properties ?? []).map(property => [property.name, property]));
    expect(byName.get('name')).toMatchObject({
      type: 'STRING',
      flags: 'BASE',
      domains: ['base']
    });
    expect(byName.get('hp')).toMatchObject({
      type: 'UINT32',
      flags: 'CELL_PUBLIC_AND_OWN',
      domains: ['cell', 'client']
    });
    expect(byName.get('homePosition')).toMatchObject({
      type: 'VECTOR3',
      flags: 'BASE_AND_CLIENT',
      domains: ['base', 'client']
    });
    expect(byName.get('loot')).toMatchObject({
      type: 'ARRAY',
      elementType: 'UINT8',
      domains: ['client']
    });
    expect(byName.get('bag')).toMatchObject({
      type: 'AvatarProps',
      elementType: null,
      domains: ['base', 'client']
    });
    expect(byName.get('skills')).toMatchObject({
      type: 'ARRAY',
      elementType: 'STRING',
      domains: ['base', 'client']
    });
  });

  it('只收 Exposed 的 Base/Cell 方法,ClientMethods 全收(不要求 Exposed)', () => {
    const entity = parseClientSdkEntity(FULL_DEF, 'Avatar');

    expect(entity?.exposedBaseMethods).toEqual([
      { name: 'createAvatar', argTypes: ['UINT8'] }
    ]);
    expect(entity?.exposedCellMethods).toEqual([
      { name: 'moveTo', argTypes: ['VECTOR3'] }
    ]);
    expect(entity?.clientMethods).toEqual([
      { name: 'onHPChanged', argTypes: ['UINT32', 'UINT32'] }
    ]);
  });

  it('最小定义:无 Parent、无方法面时为空数组', () => {
    const entity = parseClientSdkEntity(MINIMAL_DEF, 'Ghost');

    expect(entity).not.toBeNull();
    expect(entity?.name).toBe('Ghost');
    expect(entity?.parent).toBeNull();
    expect(entity?.properties).toHaveLength(1);
    expect(entity?.clientMethods).toEqual([]);
    expect(entity?.exposedBaseMethods).toEqual([]);
    expect(entity?.exposedCellMethods).toEqual([]);
  });

  it('非法内容为 null', () => {
    expect(parseClientSdkEntity('', 'Empty')).toBeNull();
    expect(parseClientSdkEntity('not xml at all', 'Empty')).toBeNull();
    // 解析器抛错(闭合标签不匹配)也照实收 null,不让单份坏 def 打断整批生成
    expect(parseClientSdkEntity('<root><Properties></root>', 'Broken')).toBeNull();
  });

  it('畸形属性:缺 <Type>、空 <of>、缺 <Flags> 均照实收不抛错', () => {
    const entity = parseClientSdkEntity(
      '<root><Properties>' +
        '<noType><Flags>BASE</Flags></noType>' +
        '<emptyOf><Type>ARRAY<of></of></Type><Flags>OWN_CLIENT</Flags></emptyOf>' +
        '<noFlags><Type>UINT8</Type></noFlags>' +
      '</Properties></root>',
      'Malformed'
    );

    expect(entity).not.toBeNull();
    expect(entity?.properties).toEqual([
      { name: 'noType', type: '', elementType: null, flags: 'BASE', domains: ['base'] },
      { name: 'emptyOf', type: 'ARRAY', elementType: null, flags: 'OWN_CLIENT', domains: ['client'] },
      { name: 'noFlags', type: 'UINT8', elementType: null, flags: '', domains: [] }
    ]);
  });
});

// ---------------------------------------------------------------------------
// IDE-RUST-006 组件槽解析:slot 成员 + 组件类型类(仅客户端可见属性)。
// 与 crates/kode-server/tests/client_sdk_dispatch.rs 同 fixture 同断言
// (TS↔Rust 对拍契约)。
// ---------------------------------------------------------------------------

const COMPONENT_DEF =
  '<root><Properties>' +
  '<hp><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></hp>' +
  '<name><Type>STRING</Type><Flags>BASE</Flags></name>' +
  '</Properties></root>';
const COMPONENT_ENTITY_DEF =
  '<root><Properties>' +
  '<level><Type>UINT8</Type><Flags>BASE</Flags></level>' +
  '</Properties><Components>' +
  '<healthPack><Type>HealthComp</Type></healthPack>' +
  '</Components></root>';

describe('组件槽解析(IDE-RUST-006)', () => {
  it('组件槽客户端可见属性入模型:slot + typeName + 可见属性', () => {
    const entity = parseClientSdkEntity(COMPONENT_ENTITY_DEF, 'Avatar', { HealthComp: COMPONENT_DEF });
    expect(entity).not.toBeNull();
    expect(entity?.components).toHaveLength(1);
    const component = entity!.components[0];
    expect(component.slot).toBe('healthPack');
    expect(component.typeName).toBe('HealthComp');
    expect(component.properties.map(property => property.name)).toEqual(['hp']);
    expect(component.properties[0]).toMatchObject({ flags: 'CELL_PUBLIC_AND_OWN', domains: ['cell', 'client'] });
    // 纯服务端属性(name BASE)不进组件模型
    expect(component.properties.some(property => property.name === 'name')).toBe(false);
  });

  it('缺失组件 def:跳过该槽', () => {
    const entity = parseClientSdkEntity(COMPONENT_ENTITY_DEF, 'Avatar', {});
    expect(entity?.components).toEqual([]);
  });

  it('组件 def 接口/父类递归:客户端可见属性按名去重(自身优先)', () => {
    const ifaceDef =
      '<root><Properties><shield><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></shield></Properties></root>';
    const parentDef =
      '<root><Properties><weight><Type>FLOAT</Type><Flags>BASE</Flags></weight></Properties></root>';
    const compositeDef =
      '<root><Interfaces><interface>IDef</interface></Interfaces><Parent><BaseComp/></Parent>' +
      '<Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></hp></Properties></root>';
    const entity = parseClientSdkEntity(COMPONENT_ENTITY_DEF, 'Avatar', {
      HealthComp: compositeDef,
      IDef: ifaceDef,
      BaseComp: parentDef
    });
    // 自身 hp + 接口 shield(客户端可见);父类 weight 是 BASE 域不进
    expect(entity!.components[0].properties.map(property => property.name)).toEqual(['hp', 'shield']);
  });

  it('槽缺 <Type> 或无目标:不产组件条目', () => {
    const entity = parseClientSdkEntity(
      '<root><Components><broken/></Components></root>', 'Avatar', { HealthComp: COMPONENT_DEF }
    );
    expect(entity?.components).toEqual([]);
  });
});

describe('组件 SDK 发射(IDE-RUST-006,与 Rust client_sdk_dispatch 对拍)', () => {
  it('TS:实体 slot 成员 + 组件类(仅客户端可见属性)', () => {
    const entity = parseClientSdkEntity(COMPONENT_ENTITY_DEF, 'Avatar', { HealthComp: COMPONENT_DEF })!;
    const ts = generateClientSdkEntityFile(entity, 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT);
    expect(ts).toContain('public healthPack: HealthComp;');
    expect(ts).toContain("import { HealthComp } from './ClientSdkComponents';");

    const comps = generateClientSdkComponentsFile(
      [entity], 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT
    );
    expect(comps).not.toBeNull();
    expect(comps ?? '').toContain('export class HealthComp');
    expect(comps ?? '').toContain('public hp: number');
    expect(comps ?? '').not.toContain('public name:');
  });

  it('C#:实体 slot 成员 + 组件类(仅客户端可见属性)', () => {
    const entity = parseClientSdkEntity(COMPONENT_ENTITY_DEF, 'Avatar', { HealthComp: COMPONENT_DEF })!;
    const cs = generateClientSdkEntityFile(entity, 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT);
    expect(cs).toContain('public HealthComp HealthPack { get; set; }');

    const comps = generateClientSdkComponentsFile(
      [entity], 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT
    );
    expect(comps).not.toBeNull();
    expect(comps ?? '').toContain('public class HealthComp');
    expect(comps ?? '').toContain('public uint Hp { get; set; }');
    expect(comps ?? '').not.toContain('public string Name');
  });

  it('无组件槽:不产组件伴随文件', () => {
    const entity = parseClientSdkEntity(FULL_DEF, 'Avatar')!;
    expect(generateClientSdkComponentsFile([entity], 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT)).toBeNull();
  });
});

describe('isClientVisibleProperty', () => {
  const entity = parseClientSdkEntity(FULL_DEF, 'Avatar');

  it('按旗标域判定客户端可见性', () => {
    const byName = new Map((entity?.properties ?? []).map(property => [property.name, property]));

    expect(isClientVisibleProperty(byName.get('hp')!)).toBe(true);
    expect(isClientVisibleProperty(byName.get('homePosition')!)).toBe(true);
    expect(isClientVisibleProperty(byName.get('loot')!)).toBe(true);
    expect(isClientVisibleProperty(byName.get('name')!)).toBe(false);
    expect(isClientVisibleProperty(byName.get('bag')!)).toBe(true);
  });
});

describe('buildClientSdkTypeMap / 类型解析', () => {
  it('别名进表、FIXED_DICT 带字段进表', () => {
    const typeMap = makeFixedDictTypeMap('typescript');

    expect(typeMap.aliases.get('Money')).toBe('UINT32');
    expect(typeMap.fixedDicts.get('AvatarProps')?.properties).toEqual([
      { name: 'hp', typeName: 'UINT32' },
      { name: 'name', typeName: 'STRING' }
    ]);
  });

  it('内置类型映射:TS 与 C# 各自表', () => {
    const tsMap = makeFixedDictTypeMap('typescript');
    const csMap = makeFixedDictTypeMap('csharp');

    expect(tsMap.builtin['UINT32']).toBe('number');
    expect(tsMap.builtin['VECTOR3']).toBe('[number, number, number]');
    expect(tsMap.builtin['STRING']).toBe('string');
    expect(csMap.builtin['UINT32']).toBe('uint');
    expect(csMap.builtin['VECTOR3']).toBe('Vector3');
    expect(csMap.builtin['STRING']).toBe('string');
    expect(csMap.builtin['INT64']).toBe('long');
  });

  it('resolveClientSdkTypeName:内置 / 别名递归 / FIXED_DICT / ARRAY / 兜底', () => {
    const typeMap = makeFixedDictTypeMap('typescript');

    expect(requireResolve(typeMap, 'UINT32', null)).toBe('number');
    expect(requireResolve(typeMap, 'Money', null)).toBe('number');
    expect(requireResolve(typeMap, 'AvatarProps', null)).toBe('AvatarProps');
    expect(requireResolve(typeMap, 'ARRAY', 'UINT8')).toBe('number[]');
    expect(requireResolve(typeMap, 'ARRAY', 'AvatarProps')).toBe('AvatarProps[]');
    expect(requireResolve(typeMap, 'NOPE', null)).toBe('unknown');
  });

  it('C# 未知类型兜底 object', () => {
    const typeMap = makeFixedDictTypeMap('csharp');

    expect(requireResolve(typeMap, 'NOPE', null)).toBe('object');
    expect(requireResolve(typeMap, 'ARRAY', 'UINT8')).toBe('byte[]');
  });

  it('自引用别名回落兜底值(不无限递归)', () => {
    const typeMap = buildClientSdkTypeMap([makeCustomTypeInfo('SelfRef', 'SelfRef')], 'typescript');

    expect(requireResolve(typeMap, 'SelfRef', null)).toBe('unknown');
  });

  it('FIXED_DICT 字段缺 <Type> 时 typeName 收 null', () => {
    const typeMap = buildClientSdkTypeMap(
      [
        makeCustomTypeInfo('LooseProps', 'FIXED_DICT', [
          ['weight', 'UINT32'],
          ['loose', undefined]
        ])
      ],
      'typescript'
    );

    expect(typeMap.fixedDicts.get('LooseProps')?.properties).toEqual([
      { name: 'weight', typeName: 'UINT32' },
      { name: 'loose', typeName: null }
    ]);
  });
});

describe('generateClientSdkEntityFile', () => {
  const entity = parseClientSdkEntity(FULL_DEF, 'Avatar')!;

  it('TypeScript:仅客户端可见属性成字段,Exposed 方法成包装,回调成虚位', () => {
    const content = generateClientSdkEntityFile(entity, 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT);

    expect(content).toContain('export class Avatar');
    expect(content).toContain('public readonly entityId: number');
    expect(content).toContain('public hp: number');
    expect(content).toContain('public homePosition: [number, number, number]');
    expect(content).toContain('public loot: number[]');
    expect(content).toContain('public skills: string[]');
    expect(content).toContain('public onHPChanged(_arg0: number, _arg1: number): void');
    expect(content).toContain("this.onBaseOutgoing('createAvatar', [_arg0])");
    expect(content).toContain("this.onCellOutgoing('moveTo', [_arg0])");
    expect(content).toContain('protected onBaseOutgoing(_method: string, _args: unknown[]): void');
    expect(content).toContain('protected onCellOutgoing(_method: string, _args: unknown[]): void');
    expect(content).toContain(GENERATED_AT);

    // 纯服务端属性与未 Exposed 方法不进客户端面
    expect(content).not.toContain('public name:');
    expect(content).toContain('public bag: AvatarProps');
    expect(content).toContain("import { AvatarProps } from './ClientSdkFixedDicts';");
    expect(content).not.toContain('internalPurge');
  });

  it('C#:PascalCase 命名、get/set 属性、Vector3、object 参数数组', () => {
    const content = generateClientSdkEntityFile(entity, 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT);

    expect(content).toContain('namespace KbEngineClient');
    expect(content).toContain('public class Avatar');
    expect(content).toContain('public long EntityId { get; }');
    expect(content).toContain('public uint Hp { get; set; }');
    expect(content).toContain('public Vector3 HomePosition { get; set; }');
    expect(content).toContain('public byte[] Loot { get; set; }');
    expect(content).toContain('public virtual void OnHPChanged(uint arg0, uint arg1)');
    expect(content).toContain('public AvatarProps Bag { get; set; }');
    expect(content).toContain('BaseCallCreateAvatar(byte arg0)');
    expect(content).toContain('new object[] { arg0 }');
    expect(content).toContain('CellCallMoveTo(Vector3 arg0)');
    expect(content).toContain('protected virtual void OnBaseOutgoing(string method, object[] args)');
    expect(content).toContain('protected virtual void OnCellOutgoing(string method, object[] args)');

    expect(content).not.toContain('public string Name');
    expect(content).not.toContain('internalPurge');
  });

  it('C# 无父类无固定字典时摘要行两段都省略', () => {
    const tinyDef = '<root><Properties><hp><Type>UINT32</Type><Flags>OWN_CLIENT</Flags></hp></Properties></root>';
    const content = generateClientSdkEntityFile(parseClientSdkEntity(tinyDef, 'Tiny')!, 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT);

    expect(content).toContain('public class Tiny');
    expect(content).toContain('public uint Hp { get; set; }');
    expect(content).toContain('/// <summary>Tiny 客户端实体 SDK 骨架</summary>');
    expect(content).not.toContain('父类');
    expect(content).not.toContain('固定字典');
    expect(content).not.toContain('OnBaseOutgoing("');
    expect(content).toContain('OnBaseOutgoing(string method, object[] args)');
  });

  it('客户端方法缺省时仍发射类与接缝', () => {
    const content = generateClientSdkEntityFile(parseClientSdkEntity(MINIMAL_DEF, 'Ghost')!, 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT);

    expect(content).toContain('export class Ghost');
    expect(content).toContain('protected onBaseOutgoing');
    expect(content).toContain('protected onCellOutgoing');
    expect(content).not.toContain('public baseCall');
    expect(content).not.toContain('public cellCall');
  });
});

describe('generateClientSdkFixedDictsFile', () => {
  const entities = [parseClientSdkEntity(FULL_DEF, 'Avatar')!];

  it('只收被生成实体引用到的 FIXED_DICT 类型', () => {
    const content = generateClientSdkFixedDictsFile(entities, 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT);

    expect(content).not.toBeNull();
    expect(content).toContain('export interface AvatarProps');
    expect(content).toContain('hp: number');
    expect(content).toContain('name: string');
    expect(content).not.toContain('Money');
  });

  it('无 FIXED_DICT 引用时为 null', () => {
    const content = generateClientSdkFixedDictsFile(
      [parseClientSdkEntity(MINIMAL_DEF, 'Ghost')!],
      'typescript',
      makeFixedDictTypeMap('typescript'),
      GENERATED_AT
    );

    expect(content).toBeNull();
  });

  it('字段缺 <Type> 时 TS 兜底 unknown、C# 兜底 object', () => {
    const loose = buildClientSdkTypeMap(
      [makeCustomTypeInfo('LooseProps', 'FIXED_DICT', [['weight', '']])],
      'typescript'
    );
    const looseCs = buildClientSdkTypeMap(
      [makeCustomTypeInfo('LooseProps', 'FIXED_DICT', [['weight', '']])],
      'csharp'
    );
    const entity = parseClientSdkEntity(
      '<root><Properties><loose><Type>LooseProps</Type><Flags>OWN_CLIENT</Flags></loose></Properties></root>',
      'Loose'
    )!;

    expect(generateClientSdkFixedDictsFile([entity], 'typescript', loose, GENERATED_AT)).toContain('weight: unknown;');
    expect(generateClientSdkFixedDictsFile([entity], 'csharp', looseCs, GENERATED_AT)).toContain('public object Weight { get; set; }');
  });

  it('C# 发射 class 形态', () => {
    const content = generateClientSdkFixedDictsFile(entities, 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT);

    expect(content).toContain('public class AvatarProps');
    expect(content).toContain('public uint Hp { get; set; }');
    expect(content).toContain('public string Name { get; set; }');
  });

  it('仅组件属性引用的 FIXED_DICT:伴随文件仍生成,与组件 import 同源不断裂', () => {
    // 实体属性不引用 FIXED_DICT,仅组件槽属性引用 AvatarProps(COMPONENT_DEF 的 hp 是
    // CELL_PUBLIC_AND_OWN 客户端可见,但其 Type 是 UINT32;这里换用引用 FIXED_DICT 的组件)。
    const dictCompDef =
      '<root><Properties><bag><Type>AvatarProps</Type><Flags>CELL_PUBLIC_AND_OWN</Flags></bag></Properties></root>';
    const entity = parseClientSdkEntity(
      '<root><Properties><level><Type>UINT8</Type><Flags>BASE</Flags></level></Properties>' +
        '<Components><inventory><Type>DictComp</Type></inventory></Components></root>',
      'Avatar',
      { DictComp: dictCompDef }
    )!;

    const fixed = generateClientSdkFixedDictsFile(
      [entity], 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT
    );
    // 修复前:只收集实体属性引用 → 返回 null,组件文件的 import 断裂。
    expect(fixed).not.toBeNull();
    expect(fixed ?? '').toContain('export interface AvatarProps');

    const comps = generateClientSdkComponentsFile(
      [entity], 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT
    );
    expect(comps ?? '').toContain("import { AvatarProps } from './ClientSdkFixedDicts';");
  });
});

describe('collectClientSdkEntities', () => {
  let workspaceRoot: string;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-workspace-'));
    const defsDir = path.join(workspaceRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'scripts', 'entities.xml'),
      '<root>\n  <Avatar hasBase="true"/>\n  <Ghost hasBase="true"/>\n  <Orphan hasBase="true"/>\n</root>\n',
      'utf8'
    );
    fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');
    fs.writeFileSync(path.join(defsDir, 'Ghost.def'), MINIMAL_DEF, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('按 entities.xml 登记序收集,缺 def 的实体跳过', () => {
    const entities = collectClientSdkEntities(workspaceRoot);

    expect(entities.map(entity => entity.name)).toEqual(['Avatar', 'Ghost']);
    expect(entities[0]?.parent).toBe('Entity');
  });

  it('已登记但 def 内容非 XML 的实体跳过', () => {
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-broken-'));
    const defsDir = path.join(brokenRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, 'scripts', 'entities.xml'), '<root><Broken hasBase="true"/></root>', 'utf8');
    fs.writeFileSync(path.join(defsDir, 'Broken.def'), 'not xml at all', 'utf8');

    expect(collectClientSdkEntities(brokenRoot)).toEqual([]);
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  });

  it('def XML 未闭合标签解析抛错时实体跳过', () => {
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-throw-'));
    const defsDir = path.join(brokenRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, 'scripts', 'entities.xml'), '<root><Broken hasBase="true"/></root>', 'utf8');
    fs.writeFileSync(path.join(defsDir, 'Broken.def'), '<root>', 'utf8');

    expect(parseClientSdkEntity('<root>', 'Broken')).toBeNull();
    expect(collectClientSdkEntities(brokenRoot)).toEqual([]);
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  });

  it('无 entities.xml 时为空表', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-empty-'));
    try {
      expect(collectClientSdkEntities(emptyRoot)).toEqual([]);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('generateClientSdkEntities', () => {
  let workspaceRoot: string;
  let outDir: string;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gen-src-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gen-out-'));
    const defsDir = path.join(workspaceRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');
    fs.writeFileSync(
      path.join(defsDir, 'types.xml'),
      '<root>\n' +
        '  <AvatarProps>\n' +
        '    <Type>FIXED_DICT</Type>\n' +
        '    <Properties>\n' +
        '      <hp><Type>UINT32</Type></hp>\n' +
        '      <name><Type>STRING</Type></name>\n' +
        '    </Properties>\n' +
        '  </AvatarProps>\n' +
        '  <Money>\n' +
        '    <Type>UINT32</Type>\n' +
        '  </Money>\n' +
        '</root>\n',
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('落盘实体文件与 FIXED_DICT 伴随文件,写满两种语言', async () => {
    const result = await generateClientSdkEntities(
      { languages: ['typescript', 'csharp'], outputDir: outDir, overwrite: false },
      workspaceRoot
    );

    const avatarTs = path.join(outDir, 'Avatar.ts');
    const avatarCs = path.join(outDir, 'Avatar.cs');
    expect(fs.existsSync(avatarTs)).toBe(true);
    expect(fs.existsSync(avatarCs)).toBe(true);
    expect(fs.readFileSync(avatarTs, 'utf8')).toContain('export class Avatar');
    expect(fs.readFileSync(avatarCs, 'utf8')).toContain('public class Avatar');

    const writtenKinds = result.files.filter(file => file.written).map(file => `${file.kind}:${file.language}`);
    expect(writtenKinds).toContain('entity:typescript');
    expect(writtenKinds).toContain('entity:csharp');
    expect(writtenKinds).toContain('fixedDicts:typescript');
    expect(writtenKinds).toContain('fixedDicts:csharp');
    expect(result.skipped).toBe(0);
    expect(result.entities.map(entity => entity.name)).toEqual(['Avatar']);
  });

  it('已存在且 overwrite=false 时跳过写盘并计数', async () => {
    const result = await generateClientSdkEntities(
      { languages: ['typescript'], outputDir: outDir, overwrite: false },
      workspaceRoot
    );

    expect(result.files.filter(file => file.written)).toHaveLength(0);
    expect(result.skipped).toBe(2);
  });

  it('overwrite=true 覆盖既有文件', async () => {
    const result = await generateClientSdkEntities(
      { languages: ['typescript'], outputDir: outDir, overwrite: true },
      workspaceRoot
    );

    expect(result.files.filter(file => file.written)).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it('工作区根回落 workspaceFolders', async () => {
    workspaceish.workspaceFolders = [{ uri: Uri.file(workspaceRoot), name: 'ws', index: 0 }];
    const result = await generateClientSdkEntities({ languages: ['typescript'], outputDir: outDir, overwrite: true });

    expect(result.files.filter(file => file.written)).toHaveLength(2);
    expect(result.generatedTimestamp === undefined).toBe(true);
  });

  it('无工作区根时返回空结果不抛错', async () => {
    const saved = workspaceish.workspaceFolders;
    workspaceish.workspaceFolders = [];
    try {
      await expect(generateClientSdkEntities({ languages: ['typescript'], outputDir: outDir, overwrite: true })).resolves.toEqual({
        files: [],
        entities: [],
        skipped: 0
      });
    } finally {
      workspaceish.workspaceFolders = saved;
    }
  });

  it('输出目录为相对路径时相对工作区根解析', async () => {
    const result = await generateClientSdkEntities(
      { languages: ['typescript'], outputDir: 'scripts/client_entities', overwrite: true },
      workspaceRoot
    );

    expect(result.files.filter(file => file.written)).toHaveLength(2);
    expect(fs.existsSync(path.join(workspaceRoot, 'scripts', 'client_entities', 'Avatar.ts'))).toBe(true);
  });

  it('Rust 核心在场时走 RPC 路径:契约参数与落盘内容都取自 Rust 返回', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const canned = [
      { fileName: 'Avatar.ts', content: '// rust: Avatar\n' },
      { fileName: 'ClientSdkFixedDicts.ts', content: '// rust: fixed\n' }
    ];
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: canned };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await generateClientSdkEntities(
        { languages: ['typescript'], outputDir: outDir, overwrite: true, generatedAt: GENERATED_AT },
        workspaceRoot
      );

      expect(calledMethod).toBe('$/kode/sdk/generate');
      const params = calledParams as {
        language: string;
        entities: Array<{ name: string; defText: string }>;
        typesXml: string;
        generatedAt: string;
        engineTrace?: unknown;
        namespace: string;
      };
      expect(params.language).toBe('typescript');
      expect(params.entities).toEqual([{ name: 'Avatar', defText: FULL_DEF }]);
      expect(params.typesXml).toContain('<AvatarProps>');
      expect(params.generatedAt).toBe(GENERATED_AT);
      expect(params.namespace).toBe('KbEngineClient');
      expect(params.engineTrace).toBeUndefined();

      // Rust 路径不解析实体(entities 空),文件内容按 Rust 返回原样落盘。
      expect(result.entities).toEqual([]);
      expect(result.skipped).toBe(0);
      const avatar = result.files.find(file => file.entityName === 'Avatar');
      expect(avatar?.path).toBe(path.join(outDir, 'Avatar.ts'));
      expect(fs.readFileSync(avatar!.path, 'utf8')).toBe('// rust: Avatar\n');
      expect(fs.readFileSync(path.join(outDir, 'ClientSdkFixedDicts.ts'), 'utf8')).toBe('// rust: fixed\n');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 调用失败时回落到 TS 纯实现(实体照常解析)', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await generateClientSdkEntities(
        { languages: ['typescript'], outputDir: outDir, overwrite: true, generatedAt: GENERATED_AT },
        workspaceRoot
      );

      expect(result.entities.map(entity => entity.name)).toEqual(['Avatar']);
      const avatar = result.files.find(file => file.entityName === 'Avatar');
      expect(avatar).toBeDefined();
      expect(fs.readFileSync(avatar!.path, 'utf8')).toContain('class Avatar');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust RPC 携带组件 def 闭包(defs:组件 + 其接口/父类)', async () => {
    const compRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gen-comp-'));
    try {
      const defsDir = path.join(compRoot, 'scripts', 'entity_defs');
      fs.mkdirSync(path.join(defsDir, 'components'), { recursive: true });
      fs.mkdirSync(path.join(defsDir, 'interfaces'), { recursive: true });
      fs.writeFileSync(path.join(compRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
      fs.writeFileSync(
        path.join(defsDir, 'Avatar.def'),
        '<root><Components><healthPack><Type>HealthComp</Type></healthPack></Components></root>',
        'utf8'
      );
      fs.writeFileSync(
        path.join(defsDir, 'components', 'HealthComp.def'),
        '<root><Interfaces><interface>IDamageable</interface></Interfaces>' +
        '<Properties><hp><Type>UINT32</Type><Flags>CELL_PUBLIC</Flags></hp></Properties></root>',
        'utf8'
      );
      fs.writeFileSync(
        path.join(defsDir, 'interfaces', 'IDamageable.def'),
        '<root><Properties><shield><Type>UINT32</Type><Flags>BASE_AND_CLIENT</Flags></shield></Properties></root>',
        'utf8'
      );

      let calledParams: unknown = null;
      const fakeGate = {
        runInRust: async (_method: string, params: unknown) => {
          calledParams = params;
          return { ok: true, result: [{ fileName: 'Avatar.ts', content: '// rust\n' }] };
        }
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      try {
        const result = await generateClientSdkEntities(
          { languages: ['typescript'], outputDir: outDir, overwrite: true, generatedAt: GENERATED_AT },
          compRoot
        );
        const params = calledParams as { defs: Record<string, string> };
        expect(params.defs.HealthComp).toContain('<hp>');
        expect(params.defs.IDamageable).toContain('<shield>');
        expect(result.skipped).toBe(0);
      } finally {
        setKodeCoreShadowGate(null);
      }
    } finally {
      fs.rmSync(compRoot, { recursive: true, force: true });
    }
  });

  it('Rust 核心在场但无登记实体:短路过 Rust,空结果不落盘', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gen-empty-'));
    try {
      const fakeGate = {
        runInRust: async () => {
          throw new Error('Rust 不应被调用');
        }
      } as unknown as KodeCoreGate;
      setKodeCoreShadowGate(fakeGate);
      const result = await generateClientSdkEntities(
        { languages: ['typescript'], outputDir: outDir, overwrite: true },
        emptyRoot
      );
      expect(result).toEqual({ files: [], entities: [], skipped: 0 });
    } finally {
      setKodeCoreShadowGate(null);
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('findClientSdkMemberConflicts (IDE-AUD-062)', () => {
  it('业务 entityId 属性:TS 与 C# 都报辅助字段重名', () => {
    const entity = parseClientSdkEntity(ENTITY_ID_COLLISION_DEF, 'Hero')!;
    const conflicts = findClientSdkMemberConflicts([entity], ['typescript', 'csharp']);

    const ts = conflicts.find(c => c.language === 'typescript' && c.name === 'entityId');
    expect(ts).toBeDefined();
    expect(ts!.sources).toContain('辅助字段 entityId（实体 id）');
    expect(ts!.sources).toContain('业务属性 entityId');

    const cs = conflicts.find(c => c.language === 'csharp' && c.name === 'EntityId');
    expect(cs).toBeDefined();
    expect(cs!.sources).toContain('辅助字段 EntityId（实体 id）');
    expect(cs!.sources).toContain('业务属性 entityId');
  });

  it('ClientMethods 回调占用发送接缝名:按语言报 onBaseOutgoing/OnBaseOutgoing', () => {
    const entity = parseClientSdkEntity(ENTITY_ID_COLLISION_DEF, 'Hero')!;
    const conflicts = findClientSdkMemberConflicts([entity], ['typescript', 'csharp']);

    const ts = conflicts.find(c => c.language === 'typescript' && c.name === 'onBaseOutgoing');
    expect(ts).toBeDefined();
    expect(ts!.sources).toContain('辅助方法 onBaseOutgoing（发送接缝）');
    expect(ts!.sources).toContain('ClientMethods 回调 onBaseOutgoing');

    const cs = conflicts.find(c => c.language === 'csharp' && c.name === 'OnBaseOutgoing');
    expect(cs).toBeDefined();
  });

  it('Exposed 方法包装 baseCall* 与同名业务属性重名', () => {
    const def = `<root>
      <Properties>
        <baseCallAttack>
          <Type>UINT32</Type>
          <Flags>OWN_CLIENT</Flags>
        </baseCallAttack>
      </Properties>
      <BaseMethods>
        <attack>
          <Exposed/>
          <Arg>UINT32</Arg>
        </attack>
      </BaseMethods>
    </root>`;
    const entity = parseClientSdkEntity(def, 'Hero')!;
    const conflicts = findClientSdkMemberConflicts([entity], ['typescript']);

    const ts = conflicts.find(c => c.name === 'baseCallAttack');
    expect(ts).toBeDefined();
    expect(ts!.sources).toContain('业务属性 baseCallAttack');
    expect(ts!.sources).toContain('Exposed BaseMethods 包装 attack');
  });

  it('C# PascalCase 互撞:属性 foo 与 Foo 同映射 Foo', () => {
    const def = `<root>
      <Properties>
        <foo>
          <Type>UINT32</Type>
          <Flags>OWN_CLIENT</Flags>
        </foo>
        <Foo>
          <Type>UINT32</Type>
          <Flags>OWN_CLIENT</Flags>
        </Foo>
      </Properties>
    </root>`;
    const entity = parseClientSdkEntity(def, 'Hero')!;
    const conflicts = findClientSdkMemberConflicts([entity], ['csharp']);

    const cs = conflicts.find(c => c.name === 'Foo');
    expect(cs).toBeDefined();
    expect(cs!.sources).toContain('业务属性 foo');
    expect(cs!.sources).toContain('业务属性 Foo');
  });

  it('无重名(仅客户端可见且不撞辅助)时不报冲突', () => {
    const entity = parseClientSdkEntity(FULL_DEF, 'Avatar')!;
    expect(findClientSdkMemberConflicts([entity], ['typescript', 'csharp'])).toEqual([]);
  });

  it('空实体组或空语言组:不报冲突', () => {
    expect(findClientSdkMemberConflicts([], ['typescript'])).toEqual([]);
    const entity = parseClientSdkEntity(MINIMAL_DEF, 'Ghost')!;
    expect(findClientSdkMemberConflicts([entity], [])).toEqual([]);
  });

  it('formatClientSdkMemberConflictMessage:点名实体、语言、成员与来源', () => {
    const entity = parseClientSdkEntity(ENTITY_ID_COLLISION_DEF, 'Hero')!;
    const conflicts = findClientSdkMemberConflicts([entity], ['typescript']);
    const message = formatClientSdkMemberConflictMessage(conflicts);

    expect(message).toContain('客户端实体 SDK 生成已拒绝：辅助成员与业务成员重名。');
    expect(message).toContain('实体 Hero 的 TypeScript SDK 成员 "entityId"');
    expect(message).toContain('业务属性 entityId');
  });
});

describe('IDE-AUD-063 TS SDK 64 位整数表示', () => {
  const entity = parseClientSdkEntity(INT64_DEF, 'Hero')!;

  it('TS:UINT64/INT64 映射 bigint(全域精确),ARRAY 元素随之', () => {
    const content = generateClientSdkEntityFile(entity, 'typescript', makeFixedDictTypeMap('typescript'), GENERATED_AT);

    expect(content).toContain('public coins: bigint');
    expect(content).toContain('public balance: bigint');
    expect(content).toContain('public tags: bigint[]');
    expect(content).not.toContain('public coins: number');
    expect(content).toContain('64 位整数'); // 头部边界说明
  });

  it('C#:UINT64/INT64 保持 ulong/long(全域精确)', () => {
    const content = generateClientSdkEntityFile(entity, 'csharp', makeFixedDictTypeMap('csharp'), GENERATED_AT);

    expect(content).toContain('public ulong Coins { get; set; }');
    expect(content).toContain('public long Balance { get; set; }');
  });

  it('类型表:TS UINT64/INT64 为 bigint,非 number', () => {
    const tsMap = makeFixedDictTypeMap('typescript');
    expect(tsMap.builtin['UINT64']).toBe('bigint');
    expect(tsMap.builtin['INT64']).toBe('bigint');
  });

  it('边界验证:9007199254740993(2^53+1)在 number 静默丢精度,在 bigint 精确', () => {
    // bigint 全精确:2^53+1 保留原值。
    expect(BigInt('9007199254740993')).toBe(9007199254740993n);
    expect(`${BigInt('9007199254740993')}`).toBe('9007199254740993');
    // number 为 float64,2^53+1 落到 2^53——这正是修复前 UINT64→number 的静默隐患。
    expect(`${Number('9007199254740993')}`).not.toBe('9007199254740993');
  });
});

describe('IDE-AUD-062 辅助成员与业务成员重名', () => {
  let workspaceRoot: string;
  let outDir: string;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-collision-src-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-collision-out-'));
    const defsDir = path.join(workspaceRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'scripts', 'entities.xml'),
      '<root>\n  <Hero hasBase="true"/>\n</root>\n',
      'utf8'
    );
    fs.writeFileSync(path.join(defsDir, 'Hero.def'), ENTITY_ID_COLLISION_DEF, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('业务 entityId/onBaseOutgoing 重名:提前拒绝而非静默生成重复成员', async () => {
    await expect(
      generateClientSdkEntities(
        { languages: ['typescript', 'csharp'], outputDir: outDir, overwrite: true },
        workspaceRoot
      )
    ).rejects.toThrow(/辅助成员与业务成员重名/);
    // 预检在落盘前拒绝,输出目录不残留任何生成文件。
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});

describe('runClientSdkGenerateCommand', () => {
  const originalQuickPick = windowish.showQuickPick;
  const originalInputBox = windowish.showInputBox;
  let workspaceRoot: string;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cmd-src-'));
    const defsDir = path.join(workspaceRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');
  });

  afterAll(() => {
    windowish.showQuickPick = originalQuickPick;
    windowish.showInputBox = originalInputBox;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    messages.info.length = 0;
    messages.error.length = 0;
    workspaceish.workspaceFolders = [
      { uri: Uri.file(workspaceRoot), name: 'src', index: 0 }
    ];
  });

  it('未选语言时直接取消,不落盘不通知', async () => {
    windowish.showQuickPick = async (): Promise<undefined> => undefined;

    await runClientSdkGenerateCommand();

    expect(messages.info).toHaveLength(0);
    expect(fs.readdirSync(workspaceRoot)).not.toContain('Avatar.ts');
  });

  it('取消输出目录输入时直接取消', async () => {
    let inputCalls = 0;
    windowish.showQuickPick = async (): Promise<Array<{ value: ClientSdkLanguage }>> =>
      [{ value: 'typescript' }, { value: 'csharp' }];
    windowish.showInputBox = async (): Promise<string | undefined> => {
      inputCalls += 1;
      return undefined;
    };

    await runClientSdkGenerateCommand();

    expect(inputCalls).toBe(1);
    expect(messages.info).toHaveLength(0);
  });

  it('完整路径:选语言 + 输出目录 + 覆盖确认,落盘并通知', async () => {
    const picks: Array<Promise<unknown>> = [
      Promise.resolve([{ value: 'typescript' }]),
      Promise.resolve('skip')
    ];
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      const next = picks[pickCalls];
      pickCalls += 1;
      return next;
    };
    windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';

    await runClientSdkGenerateCommand();

    expect(pickCalls).toBe(2);
    expect(fs.existsSync(path.join(workspaceRoot, 'scripts', 'client_entities', 'Avatar.ts'))).toBe(true);
    expect(messages.info.some(message => message.includes('Avatar.ts'))).toBe(true);
    expect(messages.error).toHaveLength(0);
  });

  it('取消覆盖策略选择时直接取消', async () => {
    const picks: Array<Promise<unknown>> = [
      Promise.resolve([{ value: 'typescript' }]),
      Promise.resolve(undefined)
    ];
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      const next = picks[pickCalls];
      pickCalls += 1;
      return next;
    };
    windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';

    await runClientSdkGenerateCommand();

    expect(pickCalls).toBe(2);
    expect(messages.info).toHaveLength(0);
  });

  it('全部跳过时通知不含文件路径', async () => {
    const pickQueue: Array<Array<{ value: string }>> = [
      [{ value: 'typescript' }],
      [{ value: 'skip' }]
    ];
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      const next = pickQueue[pickCalls];
      pickCalls += 1;
      return next;
    };
    windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_sdk_round2';

    await runClientSdkGenerateCommand();
    const firstMessage = messages.info[messages.info.length - 1];
    expect(firstMessage).toContain('已生成 1 个文件');

    pickCalls = 0;
    await runClientSdkGenerateCommand();

    const last = messages.info[messages.info.length - 1];
    expect(last).toContain('已生成 0 个文件');
    expect(last).toContain('跳过 1 个');
    expect(last).not.toContain('client_entities');
  });

  it('无工作区时报错并直接返回', async () => {
    workspaceish.workspaceFolders = [];
    messages.error.length = 0;

    await runClientSdkGenerateCommand();

    expect(messages.error).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
  });

  // IDE-SDK-003 SDK 生成绑定目标 profile:profileRoot=所选 profile 资产根,
  // 实体注册序与类型数据全部取自该根(工作区根不含 entities.xml 也不回落);
  // 其他根同名实体拒收不覆盖,完成通知逐个点名。
  it('profileRoot 绑定:生成输入取自所选根,不回落工作区根', async () => {
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cmd-profile-'));
    try {
      const defsDir = path.join(profileRoot, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(path.join(profileRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
      fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');

      // 工作区根指向空目录(无 entities.xml):绑定生效则生成仍来自 profileRoot
      const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cmd-empty-'));
      try {
        workspaceish.workspaceFolders = [
          { uri: Uri.file(emptyRoot), name: 'empty', index: 0 }
        ];
        windowish.showQuickPick = async (): Promise<unknown> => [{ value: 'typescript' }];
        windowish.showInputBox = async (): Promise<string | undefined> => 'client_entities';

        await runClientSdkGenerateCommand(profileRoot);

        expect(fs.existsSync(path.join(profileRoot, 'client_entities', 'Avatar.ts'))).toBe(true);
        expect(fs.existsSync(path.join(emptyRoot, 'client_entities'))).toBe(false);
      } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  it('跨根同名拒收点名:skippedSameNameFromOtherRoots 非空 → 通知点名未覆盖', async () => {
    windowish.showQuickPick = async (): Promise<unknown> => [{ value: 'typescript' }];
    windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';

    await runClientSdkGenerateCommand(workspaceRoot, ['Avatar', 'Monster']);

    const last = messages.info[messages.info.length - 1];
    expect(last).toContain('跨根同名未覆盖');
    expect(last).toContain('Avatar');
    expect(last).toContain('Monster');
  });

  // IDE-SDK-004 SDK 输出记录引擎版本与提交:生成文件头部带引擎溯源两行
  // (版本/提交);探测不到时写 unknown 字面量(未传 trace 同样写,可追溯恒在)。
  it('engineTrace 传入 → 生成文件头部记录引擎版本与提交', async () => {
    const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cmd-trace-'));
    try {
      const defsDir = path.join(traceRoot, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(path.join(traceRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
      fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');
      workspaceish.workspaceFolders = [
        { uri: Uri.file(traceRoot), name: 'trace', index: 0 }
      ];
      windowish.showQuickPick = async (): Promise<unknown> => [{ value: 'typescript' }];
      windowish.showInputBox = async (): Promise<string | undefined> => 'client_entities';

      await runClientSdkGenerateCommand(traceRoot, undefined, {
        engineVersion: '2.5.10',
        engineCommit: 'f85ad81'
      });

      const head = fs.readFileSync(path.join(traceRoot, 'client_entities', 'Avatar.ts'), 'utf8').split('\n').slice(0, 6).join('\n');
      expect(head).toContain('引擎版本: 2.5.10');
      expect(head).toContain('引擎提交: f85ad81');
    } finally {
      fs.rmSync(traceRoot, { recursive: true, force: true });
    }
  });

  it('未传 engineTrace → 头部写 unknown 字面量(可追溯恒在,不空缺)', async () => {
    const traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cmd-trace2-'));
    try {
      const defsDir = path.join(traceRoot, 'scripts', 'entity_defs');
      fs.mkdirSync(defsDir, { recursive: true });
      fs.writeFileSync(path.join(traceRoot, 'scripts', 'entities.xml'), '<root>\n  <Avatar hasBase="true"/>\n</root>\n', 'utf8');
      fs.writeFileSync(path.join(defsDir, 'Avatar.def'), FULL_DEF, 'utf8');
      workspaceish.workspaceFolders = [
        { uri: Uri.file(traceRoot), name: 'trace2', index: 0 }
      ];
      windowish.showQuickPick = async (): Promise<unknown> => [{ value: 'typescript' }];
      windowish.showInputBox = async (): Promise<string | undefined> => 'client_entities';

      await runClientSdkGenerateCommand(traceRoot);

      const head = fs.readFileSync(path.join(traceRoot, 'client_entities', 'Avatar.ts'), 'utf8').split('\n').slice(0, 6).join('\n');
      expect(head).toContain('引擎版本: unknown');
      expect(head).toContain('引擎提交: unknown');
    } finally {
      fs.rmSync(traceRoot, { recursive: true, force: true });
    }
  });
});

// KR-AUD-73:引擎对实体 def 依序装载 Interfaces 与 Parent 并把成员并入模块
// (entitydef.cpp:371-372 loadInterfaces → loadParentClass);SDK 骨架此前只发
// 自身成员、类声明无 extends。引擎口径:自身成员优先(子覆盖同名成员),
// Interfaces 先于 Parent;接口 def 不装 Parent(KR-AUD-72,entitydef.cpp:611-638)。
describe('KR-AUD-73 entity SDK merges parent/interface members', () => {
  const AVATAR_DEF = [
    '<root>',
    '  <Parent>Monster</Parent>',
    '  <Interfaces>',
    '    <interface>TankIface</interface>',
    '  </Interfaces>',
    '  <Properties>',
    '    <hp> <Type>UINT32</Type> <Flags>OWN_CLIENT</Flags> </hp>',
    '    <name> <Type>STRING</Type> <Flags>BASE</Flags> </name>',
    '  </Properties>',
    '  <ClientMethods>',
    '    <onHurt> <Arg>UINT32</Arg> </onHurt>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  const MONSTER_DEF = [
    '<root>',
    '  <Properties>',
    '    <hp> <Type>UINT16</Type> <Flags>OWN_CLIENT</Flags> </hp>',
    '    <monsterLevel> <Type>UINT8</Type> <Flags>OWN_CLIENT</Flags> </monsterLevel>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <monsterBanish> <Exposed/> </monsterBanish>',
    '  </BaseMethods>',
    '  <ClientMethods>',
    '    <onMonsterRoar/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  const TANK_IFACE_DEF = [
    '<root>',
    '  <Parent>Ghost</Parent>',
    '  <Properties>',
    '    <armor> <Type>UINT16</Type> <Flags>OWN_CLIENT</Flags> </armor>',
    '  </Properties>',
    '  <ClientMethods>',
    '    <onShieldHit/>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n');

  const GHOST_DEF = [
    '<root>',
    '  <Properties>',
    '    <haunt> <Type>UINT8</Type> <Flags>OWN_CLIENT</Flags> </haunt>',
    '  </Properties>',
    '</root>'
  ].join('\n');

  const RELATED = {
    Avatar: AVATAR_DEF,
    Monster: MONSTER_DEF,
    TankIface: TANK_IFACE_DEF,
    Ghost: GHOST_DEF
  };

  it('merges interface then parent members after own members with override', () => {
    const entity = parseClientSdkEntity(AVATAR_DEF, 'Avatar', {}, RELATED)!;

    // 自身 → 接口 → 父链(引擎装载序);同名 hp 以自身 UINT32 优先(子覆盖)
    expect(entity.properties.map(property => property.name)).toEqual([
      'hp', 'name', 'armor', 'monsterLevel'
    ]);
    expect(entity.properties.find(property => property.name === 'hp')!.type).toBe('UINT32');
    // 接口 def 的 Parent(Ghost/haunt)不得并入——引擎对接口 def 不调 loadParentClass
    expect(entity.properties.map(property => property.name)).not.toContain('haunt');
    // 来源标记:自身成员无标记,合并成员带来源 def 名
    expect(entity.properties.find(property => property.name === 'hp')!.inheritedFrom).toBeUndefined();
    expect(entity.properties.find(property => property.name === 'armor')!.inheritedFrom).toBe('TankIface');
    expect(entity.properties.find(property => property.name === 'monsterLevel')!.inheritedFrom).toBe('Monster');

    expect(entity.clientMethods.map(method => method.name)).toEqual([
      'onHurt', 'onShieldHit', 'onMonsterRoar'
    ]);
    expect(entity.exposedBaseMethods.map(method => method.name)).toEqual(['monsterBanish']);
  });

  it('emits extends + parent import and skips redeclaring inherited members', () => {
    const entity = parseClientSdkEntity(AVATAR_DEF, 'Avatar', {}, RELATED)!;
    const typeMap = makeFixedDictTypeMap('typescript');
    const file = generateClientSdkEntityFile(
      entity, 'typescript', typeMap, GENERATED_AT, undefined, new Set(['Avatar', 'Monster'])
    );

    // 父实体在同一 SDK 生成集内 → extends + import
    expect(file).toContain(`import { Monster } from './Monster';`);
    expect(file).toContain('export class Avatar extends Monster {');
    // 继承自父链的成员由基类承载,不得重复声明;接口成员仍平铺
    expect(file).not.toMatch(/public monsterLevel:/);
    expect(file).toMatch(/public armor:/);
  });

  it('flattens parent members without extends when parent is outside the SDK set', () => {
    const entity = parseClientSdkEntity(AVATAR_DEF, 'Avatar', {}, RELATED)!;
    const typeMap = makeFixedDictTypeMap('typescript');
    const file = generateClientSdkEntityFile(
      entity, 'typescript', typeMap, GENERATED_AT, undefined, new Set(['Avatar'])
    );

    expect(file).toContain('export class Avatar {');
    // 父类不在生成集 → 无 extends,父链成员平铺保证成员完整
    expect(file).toMatch(/public monsterLevel:/);
    expect(file).toMatch(/public armor:/);
  });

  it('C# emitter inherits via base list and keeps interface members', () => {
    const entity = parseClientSdkEntity(AVATAR_DEF, 'Avatar', {}, RELATED)!;
    const typeMap = makeFixedDictTypeMap('csharp');
    const file = generateClientSdkEntityFile(
      entity, 'csharp', typeMap, GENERATED_AT, undefined, new Set(['Avatar', 'Monster'])
    );

    expect(file).toContain('public class Avatar : Monster');
    expect(file).not.toContain('MonsterLevel { get; set; }');
    expect(file).toContain('Armor { get; set; }');
  });

  it('collectClientSdkEntities wires the related-def closure end to end', () => {
    const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-kr73-'));
    try {
      const defsDir = path.join(sdkRoot, 'scripts', 'entity_defs');
      fs.mkdirSync(path.join(defsDir, 'interfaces'), { recursive: true });
      fs.writeFileSync(path.join(sdkRoot, 'scripts', 'entities.xml'),
        '<root>\n  <Avatar/>\n  <Monster/>\n</root>\n', 'utf8');
      fs.writeFileSync(path.join(defsDir, 'Avatar.def'), AVATAR_DEF, 'utf8');
      fs.writeFileSync(path.join(defsDir, 'Monster.def'), MONSTER_DEF, 'utf8');
      fs.writeFileSync(path.join(defsDir, 'interfaces', 'TankIface.def'), TANK_IFACE_DEF, 'utf8');
      fs.writeFileSync(path.join(defsDir, 'interfaces', 'Ghost.def'), GHOST_DEF, 'utf8');

      const entities = collectClientSdkEntities(sdkRoot);
      const avatar = entities.find(entity => entity.name === 'Avatar')!;
      expect(avatar.properties.map(property => property.name)).toEqual([
        'hp', 'name', 'armor', 'monsterLevel'
      ]);
      expect(avatar.properties.map(property => property.name)).not.toContain('haunt');
    } finally {
      fs.rmSync(sdkRoot, { recursive: true, force: true });
    }
  });
});

function requireResolve(typeMap: ClientSdkTypeMap, type: string, elementType: string | null): string {
  return resolveClientSdkTypeName(typeMap, type, elementType);
}
