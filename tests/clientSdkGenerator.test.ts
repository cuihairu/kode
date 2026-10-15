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
      expect(generateClientSdkEntities({ languages: ['typescript'], outputDir: outDir, overwrite: true })).toEqual({
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
});

function requireResolve(typeMap: ClientSdkTypeMap, type: string, elementType: string | null): string {
  return resolveClientSdkTypeName(typeMap, type, elementType);
}
