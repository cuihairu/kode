import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findCustomTypeDeclarationInfo,
  findCustomTypePythonFile,
  findCustomTypePythonImplementationFile,
  findDefinitionFileByCategory,
  findDefinitionEntryByCategory,
  findEntitiesXmlFile,
  findEntityDefinitionFile,
  findEntityDefinitionsRoot,
  getCustomTypeInfos,
  getDefinitionEntries,
  getDefinitionWorkspaceLayout,
  getEntityRuntimeProfile,
  getRegisteredCustomTypes,
  getRegisteredEntities
} from '../src/definitionWorkspace';

// definitionWorkspace 的纯路径/解析逻辑:临时 workspace 真实文件树,
// 不触 vscode 运行时(vscodeStub 的 getConfiguration 回落默认配置值)。

let root = '';

const p = (...segments: string[]) => path.join(root, ...segments);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-'));
  const write = (relative: string, content: string) => {
    const target = p(...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write('scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasClient="false"/>',
    '  <Hero hasBase="true"/>',
    '  <Golem/>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/Hero.def', '<root>\n  <Properties>\n  </Properties>\n</root>\n');
  write('scripts/entity_defs/Unregistered.def', '<root>\n</root>\n');
  write('scripts/entity_defs/interfaces/MoveIface.def', '<root>\n</root>\n');
  write('scripts/entity_defs/components/HealthComp.def', '<root>\n</root>\n');
  write('scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '  <ITEM_POS>',
    '    FIXED_DICT',
    '    <Properties>',
    '      <y><Type>UINT8</Type></y>',
    '      <x><Type>UINT8</Type></x>',
    '    </Properties>',
    '    <implementedBy>item.pos</implementedBy>',
    '  </ITEM_POS>',
    '</root>'
  ].join('\n'));
  write('scripts/base/Hero.py', 'class Hero:\n    pass\n');
  write('scripts/base/Golem.py', 'class Golem:\n    pass\n');
  write('scripts/cell/Golem.py', 'class Golem:\n    pass\n');
  write('scripts/user_type/item/pos.py', '# item pos helpers\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('getDefinitionWorkspaceLayout', () => {
  it('resolves every root against the existing scripts tree', () => {
    const layout = getDefinitionWorkspaceLayout(root);

    expect(layout.workspaceRoot).toBe(root);
    expect(layout.entityDefsRoot).toBe(p('scripts', 'entity_defs'));
    // entityScriptsRoot 是 entityDefsRoot 的父目录(scripts),不是再深一层
    expect(layout.entityScriptsRoot).toBe(p('scripts'));
    expect(layout.interfacesRoot).toBe(p('scripts', 'entity_defs', 'interfaces'));
    expect(layout.componentsRoot).toBe(p('scripts', 'entity_defs', 'components'));
    expect(layout.entitiesXmlPath).toBe(p('scripts', 'entities.xml'));
    expect(layout.typesXmlPath).toBe(p('scripts', 'entity_defs', 'types.xml'));
    expect(layout.userTypeRoots).toContain(p('scripts', 'user_type'));
  });

  it('falls back to the conventional defs root when nothing exists', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-bare-'));
    try {
      const layout = getDefinitionWorkspaceLayout(bareRoot);

      // 目录不存在时回落到约定路径而非 null
      expect(layout.entityDefsRoot).toBe(path.join(bareRoot, 'scripts', 'entity_defs'));
      expect(layout.entityScriptsRoot).toBe(path.join(bareRoot, 'scripts'));
      // 存在性文件路径无回落,保持 null
      expect(layout.entitiesXmlPath).toBeNull();
      expect(layout.typesXmlPath).toBeNull();
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

describe('getRegisteredEntities', () => {
  it('parses entities.xml children in document order with dedupe', () => {
    const entities = getRegisteredEntities(root);

    // 重复的 Hero 只保留第一次;name 'root' 不算实体
    expect(entities.map(e => e.name)).toEqual(['Hero', 'Monster', 'Golem']);

    expect(entities[0]).toEqual({
      name: 'Hero',
      hasBaseDeclared: true,
      hasCellDeclared: true,
      hasClientDeclared: true,
      hasBase: true,
      hasCell: true,
      hasClient: true
    });
    // declared 用属性存在性,值用 "true" 字面量:hasClient="false" 声明了但值为假
    expect(entities[1]).toEqual({
      name: 'Monster',
      hasBaseDeclared: false,
      hasCellDeclared: false,
      hasClientDeclared: true,
      hasBase: false,
      hasCell: false,
      hasClient: false
    });
    expect(entities[2]).toEqual({
      name: 'Golem',
      hasBaseDeclared: false,
      hasCellDeclared: false,
      hasClientDeclared: false,
      hasBase: false,
      hasCell: false,
      hasClient: false
    });
  });

  it('returns an empty list without entities.xml', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-bare2-'));
    try {
      expect(getRegisteredEntities(bareRoot)).toEqual([]);
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

describe('getEntityRuntimeProfile', () => {
  it('marks declared facets as declared and keeps missing scripts unverified', () => {
    const profile = getEntityRuntimeProfile('Hero', root);

    expect(profile).not.toBeNull();
    expect(profile!.base).toEqual({
      enabled: true,
      declared: true,
      scriptExists: true,
      scriptPath: p('scripts', 'base', 'Hero.py'),
      source: 'declared'
    });
    // hasCell="true" 已声明:即使 cell 脚本不存在也 enabled(scriptPath 为 null)
    expect(profile!.cell).toEqual({
      enabled: true,
      declared: true,
      scriptExists: false,
      scriptPath: null,
      source: 'declared'
    });
    expect(profile!.client).toEqual({
      enabled: true,
      declared: true,
      scriptExists: false,
      scriptPath: null,
      source: 'declared'
    });
    expect(profile!.runtimeRoles).toEqual(['BaseApp', 'CellApp', 'Client']);
    expect(profile!.runtimeLabel).toBe('BaseApp / CellApp / Client');
    expect(profile!.visibilityLabel).toBe('Client Entity');
    expect(profile!.registrationSummary).toBe('Registered on BaseApp / CellApp / Client');
    expect(profile!.visibilitySummary).toBe('Has client entity definition');
  });

  it('marks explicit false declarations as disabled, not inferred', () => {
    const profile = getEntityRuntimeProfile('Monster', root);

    expect(profile).not.toBeNull();
    // hasClient="false":declared=true 但值为假 → disabled
    expect(profile!.client).toEqual({
      enabled: false,
      declared: true,
      scriptExists: false,
      scriptPath: null,
      source: 'disabled'
    });
    expect(profile!.base.source).toBe('disabled');
    expect(profile!.base.enabled).toBe(false);
    expect(profile!.runtimeRoles).toEqual([]);
    expect(profile!.runtimeLabel).toBe('None');
    expect(profile!.visibilityLabel).toBe('Server Only');
    expect(profile!.registrationSummary).toBe('Registered, but no runtime role enabled');
    expect(profile!.visibilitySummary).toBe('Server only (no client entity)');
  });

  it('infers enabled facets from existing scripts when nothing is declared', () => {
    const profile = getEntityRuntimeProfile('Golem', root);

    expect(profile).not.toBeNull();
    expect(profile!.base).toEqual({
      enabled: true,
      declared: false,
      scriptExists: true,
      scriptPath: p('scripts', 'base', 'Golem.py'),
      source: 'inferred'
    });
    expect(profile!.cell).toEqual({
      enabled: true,
      declared: false,
      scriptExists: true,
      scriptPath: p('scripts', 'cell', 'Golem.py'),
      source: 'inferred'
    });
    expect(profile!.client).toEqual({
      enabled: false,
      declared: false,
      scriptExists: false,
      scriptPath: null,
      source: 'disabled'
    });
    expect(profile!.runtimeRoles).toEqual(['BaseApp', 'CellApp']);
    expect(profile!.runtimeLabel).toBe('BaseApp / CellApp');
  });

  it('returns null for unregistered entities or missing workspace', () => {
    // Unregistered.def 存在但不在 entities.xml 中
    expect(getEntityRuntimeProfile('Unregistered', root)).toBeNull();
    expect(getEntityRuntimeProfile('Hero')).toBeNull();
  });
});

describe('custom type lookups', () => {
  it('lists registered type names from types.xml', () => {
    expect([...getRegisteredCustomTypes(root)].sort()).toEqual(['ITEM_ID', 'ITEM_POS']);
  });

  it('builds full type infos with alias, structure and sorted properties', () => {
    const infos = getCustomTypeInfos(root);
    const byName = new Map(infos.map(info => [info.name, info]));

    expect(infos.map(info => info.name).sort()).toEqual(['ITEM_ID', 'ITEM_POS']);

    const itemId = byName.get('ITEM_ID')!;
    expect(itemId).toMatchObject({
      filePath: p('scripts', 'entity_defs', 'types.xml'),
      line: 2,
      aliasType: 'UINT16',
      rawValue: 'UINT16',
      properties: []
    });
    expect(itemId.implementedBy).toBeUndefined();

    // FIXED_DICT:Properties 与 implementedBy 子节点不进 rawValue
    const itemPos = byName.get('ITEM_POS')!;
    expect(itemPos).toMatchObject({
      line: 3,
      aliasType: 'FIXED_DICT',
      rawValue: 'FIXED_DICT',
      implementedBy: 'item.pos',
      // 属性按 name 排序,xml 里故意 y 在前
      properties: [
        { name: 'x', typeName: 'UINT8' },
        { name: 'y', typeName: 'UINT8' }
      ],
      // implementedBy=item.pos → user_type/item/pos.py
      pythonFilePath: p('scripts', 'user_type', 'item', 'pos.py')
    });
    expect(itemPos.line).toBeGreaterThan(itemId.line);
  });

  it('locates the declaration line and implementedBy', () => {
    expect(findCustomTypeDeclarationInfo('ITEM_ID', root)).toEqual({
      name: 'ITEM_ID',
      filePath: p('scripts', 'entity_defs', 'types.xml'),
      line: 2,
      implementedBy: undefined
    });
    expect(findCustomTypeDeclarationInfo('ITEM_POS', root)).toMatchObject({
      line: 3,
      implementedBy: 'item.pos'
    });
    expect(findCustomTypeDeclarationInfo('MISSING_TYPE', root)).toBeNull();
  });

  it('finds python implementation files by implementedBy or type name', () => {
    expect(findCustomTypePythonFile(root, 'ITEM_POS')).toBe(p('scripts', 'user_type', 'item', 'pos.py'));
    expect(findCustomTypePythonFile(root, 'ITEM_ID')).toBeNull();
    expect(findCustomTypePythonImplementationFile('ITEM_POS', root, 'item.pos'))
      .toBe(p('scripts', 'user_type', 'item', 'pos.py'));
    // 无 implementedBy 时退回按类型名找文件
    expect(findCustomTypePythonImplementationFile('MISSING', root)).toBeNull();
  });
});

describe('entity definition file lookups', () => {
  it('resolves def files and the definitions root', () => {
    expect(findEntityDefinitionFile('Hero', root)).toBe(p('scripts', 'entity_defs', 'Hero.def'));
    expect(findEntityDefinitionFile('MISSING', root)).toBeNull();
    expect(findEntityDefinitionsRoot(root)).toBe(p('scripts', 'entity_defs'));
  });

  it('falls back to the conventional root in a bare workspace', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-bare3-'));
    try {
      expect(findEntityDefinitionsRoot(bareRoot)).toBe(path.join(bareRoot, 'scripts', 'entity_defs'));
      expect(findEntityDefinitionFile('Hero', bareRoot)).toBeNull();
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('returns null without a workspace root', () => {
    // 无 target 时走 getWorkspaceRootForDocument → stub 无 workspace → null
    expect(findEntityDefinitionFile('Hero')).toBeNull();
    expect(findEntitiesXmlFile()).toBeNull();
  });

  it('finds entities.xml inside the structured workspace', () => {
    expect(findEntitiesXmlFile(root)).toBe(p('scripts', 'entities.xml'));
  });
});

describe('findDefinitionFileByCategory and findDefinitionEntryByCategory', () => {
  it('resolves files for all four categories', () => {
    expect(findDefinitionFileByCategory('Hero', 'entity', root)).toBe(p('scripts', 'entity_defs', 'Hero.def'));
    expect(findDefinitionFileByCategory('MoveIface', 'interface', root)).toBe(p('scripts', 'entity_defs', 'interfaces', 'MoveIface.def'));
    expect(findDefinitionFileByCategory('HealthComp', 'component', root)).toBe(p('scripts', 'entity_defs', 'components', 'HealthComp.def'));
    expect(findDefinitionFileByCategory('ITEM_ID', 'type', root)).toBe(p('scripts', 'entity_defs', 'types.xml'));
  });

  it('returns null for missing names', () => {
    expect(findDefinitionFileByCategory('MISSING', 'entity', root)).toBeNull();
    expect(findDefinitionFileByCategory('MISSING', 'interface', root)).toBeNull();
  });

  it('builds entries with category metadata', () => {
    const typeEntry = findDefinitionEntryByCategory('ITEM_ID', 'type', root);
    expect(typeEntry).toMatchObject({
      name: 'ITEM_ID',
      category: 'type',
      exists: true,
      registered: true,
      filePath: p('scripts', 'entity_defs', 'types.xml'),
      aliasType: 'UINT16',
      line: 2
    });

    const interfaceEntry = findDefinitionEntryByCategory('MoveIface', 'interface', root);
    expect(interfaceEntry).toMatchObject({
      name: 'MoveIface',
      category: 'interface',
      exists: true,
      registered: true
    });

    expect(findDefinitionEntryByCategory('MISSING', 'entity', root)).toBeNull();
  });
});

describe('getDefinitionEntries', () => {
  it('merges registered entities with unregistered def files, registered first', () => {
    const entries = getDefinitionEntries(root, 'entity');

    expect(entries.map(e => e.name)).toEqual(['Golem', 'Hero', 'Monster', 'Unregistered']);
    expect(entries.filter(e => e.registered).map(e => e.name)).toEqual(['Golem', 'Hero', 'Monster']);

    const hero = entries.find(e => e.name === 'Hero')!;
    expect(hero).toMatchObject({
      category: 'entity',
      exists: true,
      registered: true,
      hasBaseDeclared: true,
      hasCellDeclared: true,
      hasClientDeclared: true
    });
    const unregistered = entries.find(e => e.name === 'Unregistered')!;
    expect(unregistered).toMatchObject({ category: 'entity', exists: true, registered: false });
  });

  it('lists interfaces, components and types as single-category lists', () => {
    expect(getDefinitionEntries(root, 'interface').map(e => e.name)).toEqual(['MoveIface']);
    expect(getDefinitionEntries(root, 'component').map(e => e.name)).toEqual(['HealthComp']);
    expect(getDefinitionEntries(root, 'type').map(e => e.name).sort()).toEqual(['ITEM_ID', 'ITEM_POS']);
  });

  it('returns an empty list in a bare workspace', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defws-bare4-'));
    try {
      expect(getDefinitionEntries(bareRoot, 'entity')).toEqual([]);
      expect(getDefinitionEntries(bareRoot, 'type')).toEqual([]);
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});
