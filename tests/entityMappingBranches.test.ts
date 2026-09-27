import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager, type EntityMapping, type DefinitionSymbolIdentity } from '../src/entityMapping';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// 批60 分支覆盖专项(entityMapping.ts):逐分支补齐——
// - 无工作区根的一串回落(getWorkspaceRoot 双 || 分支、collectPythonOwnerFiles
//   的空根布局、toLegacyMapping 的回落脚本路径);
// - 私有工具的直接驱动(buildIndex 空路径、collectPythonMethods 的存在性守卫、
//   bindPythonMethods 的三种 owner 类型推断兜底、rebasePropertyPath 的
//   点开头路径与 arrayElement 递归、scoreMethodDefinition 的全缺席打分);
// - 真实索引上的解析未命中(resolveDefinitionSymbolAtPosition 属性/方法两路
//   null、resolveMethodImplementation 的无定义 null);
// - 身份缺 propertyPath 的索引条目(类型上 propertyPath 可选)在属性解析与
//   按位置解析中的归一化比较。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

interface PropertyDefinitionEntry {
  defFile: string;
  line: number;
  identity: DefinitionSymbolIdentity;
}

interface ManagerInternals {
  mappingIndexes: Map<string, unknown>;
  storeIndex(index: unknown): void;
  getWorkspaceRoot(filePath: string): string | null;
  collectPythonOwnerFiles(semantics: unknown): unknown[];
  collectPythonMethods(ownerFiles: Array<{ filePath: string }>): unknown[];
  bindPythonMethods(definitions: unknown[], methods: Array<{ filePath: string }>): void;
  rebasePropertyPath(property: unknown, prefix: string): {
    fullPath: string;
    children: Array<{ fullPath: string }>;
    arrayElement?: { fullPath: string };
  };
  scoreMethodDefinition(
    definition: unknown,
    options: {
      ownerKind?: 'entity' | 'interface' | 'component';
      ownerName?: string;
      section?: 'BaseMethods' | 'CellMethods' | 'ClientMethods';
      componentSlotName?: string;
    }
  ): number;
  buildIndex(entityName: string, defPath: string): Promise<unknown | null>;
  toLegacyMapping(index: unknown): EntityMapping;
}

const internals = (manager: EntityMappingManager): ManagerInternals =>
  manager as unknown as ManagerInternals;

const withWorkspaceFolders = (folders: Array<{ uri: Uri; name: string; index: number }>): void => {
  stubWorkspace.workspaceFolders = folders;
};

const originalFindFiles = stubWorkspace.findFiles;
let root = '';
let manager: EntityMappingManager | undefined;
let heroDefFile = '';

const craftedIdentity = (overrides: Partial<DefinitionSymbolIdentity> = {}): DefinitionSymbolIdentity => ({
  ownerKind: 'entity',
  ownerName: 'Crafted',
  sourceKind: 'local',
  sourceChain: [],
  symbolName: 'hp',
  ...overrides
});

// 一个不经扫描、直接入表的索引:身份不带 propertyPath(类型上可选),
// 用来驱动解析层的 propertyPath 归一化比较与空 owner 文件回落
const craftedIndex = (ownerFile: string | null) => ({
  rootName: 'Crafted',
  rootCategory: 'entity' as const,
  rootDefFile: p(root, 'scripts', 'entity_defs', 'Crafted.def'),
  semantics: {},
  propertyDefinitions: [{
    defFile: p(root, 'scripts', 'entity_defs', 'Crafted.def'),
    line: 5,
    identity: craftedIdentity()
  }] as PropertyDefinitionEntry[],
  methodDefinitions: [],
  pythonOwnerFiles: ownerFile ? [{ ownerKind: 'entity' as const, ownerName: 'Crafted', filePath: ownerFile }] : [],
  pythonMethods: []
});

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mapping-branch-'));

  fs.mkdirSync(p(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    p(root, 'scripts', 'entities.xml'),
    '<root>\n  <Hero hasBase="true" hasCell="false" hasClient="false"/>\n</root>\n',
    'utf8'
  );
  heroDefFile = p(root, 'scripts', 'entity_defs', 'Hero.def');
  fs.writeFileSync(heroDefFile, [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </hp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <move/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'), 'utf8');

  stubWorkspace.findFiles = async () => [Uri.file(heroDefFile)];
  withWorkspaceFolders([{ uri: Uri.file(root), name: 'ws', index: 0 }]);

  manager = new EntityMappingManager({ subscriptions: [] } as never);
  for (let i = 0; i < 500 && !manager.getMapping('Hero'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(manager.getMapping('Hero'), 'Hero index built').toBeTruthy();
});

afterAll(() => {
  manager?.dispose();
  stubWorkspace.findFiles = originalFindFiles;
  withWorkspaceFolders([]);
  fs.rmSync(root, { recursive: true, force: true });
});

const heroIdentity = (name: string): DefinitionSymbolIdentity => {
  const mapping = (manager as EntityMappingManager).getMapping('Hero')!;
  const methods = mapping.methods[name];
  expect(methods, `Hero method ${name} indexed`).toBeTruthy();
  return methods[0].identity;
};

describe('EntityMappingManager 无工作区根的回落', () => {
  it('getWorkspaceRoot 在工作区外与无工作区两级回落', () => {
    const target = internals(manager as EntityMappingManager);

    // 命中工作区前缀
    expect(target.getWorkspaceRoot(p(root, 'scripts', 'base', 'Hero.py'))).toBe(root);
    // 工作区外的文件:find 谓词两分支都不命中,回落到首个文件夹
    // (第二个 startsWith 因此被求值)
    expect(target.getWorkspaceRoot(p(root, '..', 'elsewhere', 'Other.py'))).toBe(root);

    withWorkspaceFolders([]);
    try {
      // 无工作区:两级回落全落空
      expect(target.getWorkspaceRoot(p(root, 'scripts', 'base', 'Hero.py'))).toBeNull();
    } finally {
      withWorkspaceFolders([{ uri: Uri.file(root), name: 'ws', index: 0 }]);
    }
  });

  it('collectPythonOwnerFiles 在空根下不产出 owner 文件', () => {
    const semantics = {
      owner: { kind: 'entity', name: 'Ghost', filePath: p(root, 'scripts', 'entity_defs', 'Ghost.def') },
      effectiveProperties: [],
      effectiveMethodsBySection: { BaseMethods: [], CellMethods: [], ClientMethods: [] },
      components: []
    };

    withWorkspaceFolders([]);
    try {
      // 无工作区根 → getWorkspaceRoot null → 布局按空根构造,候选相对路径
      // 全不存在,收集结果为空
      expect(internals(manager as EntityMappingManager).collectPythonOwnerFiles(semantics)).toEqual([]);
    } finally {
      withWorkspaceFolders([{ uri: Uri.file(root), name: 'ws', index: 0 }]);
    }
  });

  it('toLegacyMapping 无 owner 文件且无工作区时回落相对脚本路径', () => {
    const target = internals(manager as EntityMappingManager);
    const index = craftedIndex(null);

    withWorkspaceFolders([]);
    try {
      const mapping = target.toLegacyMapping(index);
      expect(mapping.name).toBe('Crafted');
      // 回落路径是相对约定位置(scripts/base/<实体名>.py),不是绝对路径
      expect(path.isAbsolute(mapping.pythonFile)).toBe(false);
      expect(mapping.pythonFile).toContain('Crafted.py');
      expect(mapping.pythonFiles).toHaveLength(1);
      expect(mapping.pythonFiles[0]).toBe(mapping.pythonFile);
    } finally {
      withWorkspaceFolders([{ uri: Uri.file(root), name: 'ws', index: 0 }]);
    }
  });
});

describe('EntityMappingManager 私有工具的直接驱动', () => {
  it('buildIndex 空 def 路径返回 null', async () => {
    expect(await internals(manager as EntityMappingManager).buildIndex('Hero', '')).toBeNull();
  });

  it('collectPythonMethods 跳过不存在的 owner 文件', () => {
    const missing = [{ filePath: p(root, 'scripts', 'base', 'Nowhere.py') }];
    expect(internals(manager as EntityMappingManager).collectPythonMethods(missing)).toEqual([]);
  });

  it('bindPythonMethods 对无法推断归属的文件用三种兜底键且不绑定', () => {
    const method: {
      filePath: string;
      methodName: string;
      line: number;
      character: number;
      endLine: number;
      calls: never[];
      binding?: unknown;
    } = {
      filePath: p(root, 'notes', 'readme.txt'),
      methodName: 'move',
      line: 1,
      character: 4,
      endLine: 2,
      calls: []
    };

    // 非 .py 且不含 components/interfaces 段:三种归属推断全落空,
    // 依次按 entity/interface/component 兜底构键,无定义可绑
    internals(manager as EntityMappingManager).bindPythonMethods([], [method]);
    expect(method.binding).toBeUndefined();
  });

  it('rebasePropertyPath 处理点开头路径并递归 arrayElement', () => {
    const rebased = internals(manager as EntityMappingManager).rebasePropertyPath({
      name: 'weird',
      fullPath: '.weird',
      children: [{ name: 'k', fullPath: '.weird.k', children: [] }],
      arrayElement: { name: 'e', fullPath: '.weird.x', children: [] }
    }, 'slot');

    // split('.')[0] 为空串时回退整条路径,整节点前缀替换为槽名
    expect(rebased.fullPath).toBe('slot');
    expect(rebased.children[0].fullPath).toBe('slot');
    expect(rebased.arrayElement?.fullPath).toBe('slot');
  });

  it('scoreMethodDefinition 选项全缺席时得 0 分,匹配时按分值累加', () => {
    const target = internals(manager as EntityMappingManager);
    const inheritedDefinition = {
      defFile: p(root, 'scripts', 'entity_defs', 'Hero.def'),
      line: 8,
      section: 'BaseMethods' as const,
      exposed: false,
      identity: {
        ownerKind: 'interface' as const,
        ownerName: 'Iface',
        sourceKind: 'inherited' as const,
        sourceChain: ['Iface'],
        section: 'BaseMethods' as const,
        symbolName: 'move'
      }
    };

    // 四个 options 条件全短路、sourceKind 非 local:打分全走 else
    expect(target.scoreMethodDefinition(inheritedDefinition, {})).toBe(0);

    const localDefinition = {
      ...inheritedDefinition,
      identity: { ...inheritedDefinition.identity, ownerKind: 'entity' as const, ownerName: 'Hero', sourceKind: 'local' as const }
    };
    expect(target.scoreMethodDefinition(localDefinition, {
      ownerKind: 'entity',
      ownerName: 'Hero',
      section: 'BaseMethods'
    })).toBe(110);
  });

  // 批62 行覆盖:四个打分条件里只剩 componentSlotName 一项无生产调用面传值
  // (批33 已登记该选项在解析链上未被使用),这里按打分函数的契约直接驱动它,
  // 锁定"槽名命中 +30 / 不命中不加"的分值规则,不代表候选收集会用该选项。
  it('componentSlotName 选项按槽名是否相同加减分', () => {
    const target = internals(manager as EntityMappingManager);
    const slotDefinition = {
      defFile: p(root, 'scripts', 'entity_defs', 'Hero.def'),
      line: 8,
      section: 'BaseMethods' as const,
      exposed: false,
      identity: {
        ownerKind: 'component' as const,
        ownerName: 'Bag',
        sourceKind: 'local' as const,
        sourceChain: [],
        section: 'BaseMethods' as const,
        symbolName: 'add',
        componentSlotName: 'bag'
      }
    };
    const options = {
      ownerKind: 'component' as const,
      ownerName: 'Bag',
      section: 'BaseMethods' as const,
      componentSlotName: 'bag'
    };

    // 四项全中(40+40+20+30)再加 local 的 10 分
    expect(target.scoreMethodDefinition(slotDefinition, options)).toBe(140);
    // 对照:槽名不同即少 30 分,其余打分不变
    expect(target.scoreMethodDefinition(slotDefinition, { ...options, componentSlotName: 'wallet' })).toBe(110);
    // 对照:定义自身无槽名时,传了选项也不加分
    const { componentSlotName, ...identityWithoutSlot } = slotDefinition.identity;
    expect(componentSlotName).toBe('bag');
    expect(target.scoreMethodDefinition(
      { ...slotDefinition, identity: identityWithoutSlot },
      options
    )).toBe(110);
  });
});

describe('EntityMappingManager 真实索引上的解析未命中', () => {
  it('按位置解析属性时路径不匹配返回 null', async () => {
    const mapping = (manager as EntityMappingManager).getMapping('Hero')!;
    const property = mapping.properties['hp'];
    expect(property).toBeDefined();

    // 命中侧(正向对照)
    const hit = await (manager as EntityMappingManager).resolveDefinitionSymbolAtPosition(
      heroDefFile, property.line, 'hp', undefined, 'hp'
    );
    expect(hit?.propertyPath).toBe('hp');

    // 同 defFile 同行,propertyPath 不同 → 未命中
    expect(await (manager as EntityMappingManager).resolveDefinitionSymbolAtPosition(
      heroDefFile, property.line, 'hp', undefined, 'other.path'
    )).toBeNull();

    // 方法侧:同 defFile 同行但段内无该名 → 未命中
    expect(await (manager as EntityMappingManager).resolveDefinitionSymbolAtPosition(
      heroDefFile, property.line, 'nowhere', 'BaseMethods', undefined
    )).toBeNull();
  });

  it('resolveMethodImplementation 对已索引实体的无定义方法返回 null', async () => {
    expect(heroIdentity('move').symbolName).toBe('move');
    expect(await (manager as EntityMappingManager).resolveMethodImplementation(
      'Hero', 'nosuchmethod', 'BaseMethods'
    )).toBeNull();
  });
});

describe('EntityMappingManager 身份缺 propertyPath 的索引条目', () => {
  const ownerFile = () => p(root, 'scripts', 'base', 'Crafted.py');

  beforeAll(() => {
    internals(manager as EntityMappingManager).storeIndex(craftedIndex(ownerFile()));
  });

  it('属性解析按归一空路径比较,不匹配即 null', async () => {
    const found = (manager as EntityMappingManager).getMapping('Crafted');
    expect(found, 'crafted index visible through the public query').toBeTruthy();

    // 条目 identity 无 propertyPath:归一为 '' 与 'hp' 不等,主查询与
    // rootSymbol 兜底查询均落空
    expect(await (manager as EntityMappingManager).resolvePropertyDefinition(
      ownerFile(), 'hp', 'hp'
    )).toBeNull();
    expect(await (manager as EntityMappingManager).resolvePropertyDefinition(
      ownerFile(), 'hp'
    )).toBeNull();
  });

  it('按位置解析属性时同样按归一空路径比较', async () => {
    expect(await (manager as EntityMappingManager).resolveDefinitionSymbolAtPosition(
      p(root, 'scripts', 'entity_defs', 'Crafted.def'), 5, 'hp', undefined, 'hp'
    )).toBeNull();
  });
});
