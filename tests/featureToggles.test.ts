import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';

import { EntityMappingManager } from '../src/entityMapping';
import {
  KBEngineCompletionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider
} from '../src/languageProviders';
import {
  buildKbeStubExportContent,
  buildKbeStubExportContentForWorkspace
} from '../src/pythonStubExport';
import { buildEntityTypeStubPlan } from '../src/entityTypeStubs';
import { getCustomTypeInfos } from '../src/definitionWorkspace';
import { configurationOverrides, Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 新功能配置开关(用户令 2026-10-21:新功能都要配置开关,默认开启):
// 五枚独立布尔键逐项正反各至少 1 例(默认值断言 + false 不接管/接管)。
// 读取处统一走 vscode.workspace.getConfiguration 单点读取,测试经
// configurationOverrides 覆写。

const pyDoc = (text: string, fileName: string): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const hoverText = (hover: unknown): string => {
  const { contents } = (hover ?? { contents: [] }) as { contents: unknown };
  const raw = Array.isArray(contents) ? contents : [contents];
  return raw.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

describe('package.json 开关注册(默认值断言)', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  ) as { contributes: { configuration: { properties: Record<string, { type: string; default: boolean; description: string }> } } };
  const properties = pkg.contributes.configuration.properties;

  const expectedKeys = [
    'kbengine.entity.builtinProperties',
    'kbengine.entity.receiverSections',
    'kbengine.python.stubEngineTypings',
    'kbengine.python.entityStubMethods',
    'kbengine.types.aliasDiscovery'
  ];

  it('五枚键逐项注册:boolean、default true、description 标明默认开', () => {
    for (const key of expectedKeys) {
      const entry = properties[key];
      expect(entry, key).toBeDefined();
      expect(entry.type).toBe('boolean');
      expect(entry.default, `${key} 默认开`).toBe(true);
      expect(entry.description.toLowerCase()).toContain('default: enabled');
    }
  });
});

describe('kbengine.entity.builtinProperties(内建属性 hover+self. 补全)', () => {
  const managers: EntityMappingManager[] = [];
  const providers = () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    return {
      hover: new KBEngineHoverProvider(manager),
      completion: new KBEngineCompletionProvider(manager)
    };
  };

  afterEach(() => {
    configurationOverrides.delete('kbengine');
    managers.splice(0).forEach(manager => manager.dispose());
  });

  it('默认开:cell 脚本 self. 补全给内建属性、hover 出内建属性标注', async () => {
    const { hover, completion } = providers();
    const completionDoc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const items = completion.provideCompletionItems(
      completionDoc,
      new Position(2, '        self.'.length)
    ) as Array<{ label: string }>;
    expect(items.map(item => item.label)).toContain('position');

    const hoverDoc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.position = (1, 2, 3)\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(hover.provideHover(hoverDoc, new Position(2, '        self.'.length)))
    );
    expect(text).toContain('内建属性');
  });

  it('false:补全空表不接管、hover 落回普通链(无内建属性标注)', async () => {
    configurationOverrides.set('kbengine', { 'entity.builtinProperties': false });
    const { hover, completion } = providers();
    const completionDoc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.\n',
      '/proj/scripts/cell/Avatar.py'
    );
    expect(
      completion.provideCompletionItems(completionDoc, new Position(2, '        self.'.length))
    ).toEqual([]);

    const hoverDoc = pyDoc(
      'class Avatar:\n    def tick(self):\n        self.position = (1, 2, 3)\n',
      '/proj/scripts/cell/Avatar.py'
    );
    const text = hoverText(
      await Promise.resolve(hover.provideHover(hoverDoc, new Position(2, '        self.'.length)))
    );
    expect(text).not.toContain('内建属性');
  });
});

describe('kbengine.entity.receiverSections(接收者段过滤)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  // reborn 只在 CellMethods 段(带 <Arg>UINT8</Arg>);heal 只在 BaseMethods 段
  const setupWorkspace = (): { root: string; defFile: string; cellPy: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-toggle-receiver-'));
    roots.push(root);
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const defFile = put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <CellMethods>',
      '    <reborn>',
      '      <Arg>UINT8</Arg>',
      '    </reborn>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <heal/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    const cellPy = put('scripts/cell/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'receiver', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' ? [Uri.file(defFile)] : []);
    return { root, defFile, cellPy };
  };

  const makeManager = (): EntityMappingManager => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    managers.push(manager);
    return manager;
  };

  afterEach(() => {
    configurationOverrides.delete('kbengine');
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  it('默认开:self.cell.reborn 按段闸跳 CellMethods 声明', async () => {
    const { defFile, cellPy } = setupWorkspace();
    const provider = new PythonDefinitionProvider(makeManager());
    const doc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.reborn(1)\n',
      cellPy
    );
    const jump = await provider.provideDefinition(doc, new Position(2, '        self.cell.'.length));
    expect(jump).toMatchObject({ uri: { fsPath: defFile }, range: { start: { line: 2 } } });
  });

  it('false:回归不感知段的旧解析(多段访问无接收者类型证据不跳;无前缀照常按名命中)', async () => {
    const { defFile, cellPy } = setupWorkspace();
    configurationOverrides.set('kbengine', { 'entity.receiverSections': false });
    const provider = new PythonDefinitionProvider(makeManager());
    // 旧口径:多段 self.base.reborn 没有 receiver 段证据 → 不跳(nested receiver
    // type unknown),不因开关关闭而误用段过滤
    const multiDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.base.reborn(1)\n',
      cellPy
    );
    expect(
      await provider.provideDefinition(multiDoc, new Position(2, '        self.base.'.length))
    ).toBeNull();

    // 旧解析本身健在:无前缀 self.reborn 按名命中(reborn 在 CellMethods 声明)
    const plainDoc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.reborn(1)\n',
      cellPy
    );
    const jump = await provider.provideDefinition(plainDoc, new Position(2, '        self.'.length));
    expect(jump).toMatchObject({ uri: { fsPath: defFile } });
  });

  it('false:形参/类型闸门不随之关闭(签名不符的 def 声明 hover 仍不标注)', async () => {
    const { cellPy } = setupWorkspace();
    configurationOverrides.set('kbengine', { 'entity.receiverSections': false });
    const hover = new KBEngineHoverProvider(makeManager());
    // reborn 声明 <Arg>UINT8</Arg>(1 个形参);python def reborn(self) 个数不符
    // → 形参闸拒绝标注。该闸是纠错不是增强,不受段过滤开关影响。
    const doc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def reborn(self):\n        pass\n',
      cellPy
    );
    const text = hoverText(
      await Promise.resolve(hover.provideHover(doc, new Position(1, '    def '.length)))
    );
    expect(text).not.toContain('def 声明');
  });

  it('默认开:def 声明 hover 出签名文本,arg1: int 为内建映射口径', async () => {
    const { cellPy } = setupWorkspace();
    const hover = new KBEngineHoverProvider(makeManager());
    // 签名对上(1 个形参,注解 int=UINT8 映射)→ 标注 + 带类型签名
    const doc = pyDoc(
      'class Avatar(kbe.KBEntity):\n    def reborn(self, arg1: int):\n        pass\n',
      cellPy
    );
    const text = hoverText(
      await Promise.resolve(hover.provideHover(doc, new Position(1, '    def '.length)))
    );
    expect(text).toContain('def 声明');
    expect(text).toContain('def reborn(self, arg1: int)');
  });
});

describe('kbengine.python.stubEngineTypings(KBEngine.pyi 引擎全量导出)', () => {
  const makeEngineRoot = (): string => {
    const engineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-toggle-engine-'));
    fs.mkdirSync(path.join(engineRoot, 'typings'), { recursive: true });
    fs.writeFileSync(
      path.join(engineRoot, 'typings', '_KBEngine_common.pyi'),
      'class Entity:\n    id: int\n',
      'utf8'
    );
    for (const moduleName of [
      '_KBEngine_baseapp', '_KBEngine_bots', '_KBEngine_cellapp', '_KBEngine_dbmgr',
      '_KBEngine_hooks', '_KBEngine_interfaces', '_KBEngine_logger', '_KBEngine_loginapp',
      '_KBEngine_pythonapp', '_KBEngine_server_errors'
    ]) {
      fs.writeFileSync(path.join(engineRoot, 'typings', `${moduleName}.pyi`), '# fixture\n', 'utf8');
    }
    return engineRoot;
  };

  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('默认开:显式引擎 checkout 拼全量 API', () => {
    const engineRoot = makeEngineRoot();
    try {
      const content = buildKbeStubExportContentForWorkspace('/ws', {
        engineRoot,
        engineRootEnv: {}
      });
      expect(content).toContain('generated from the local KBEngine typings checkout');
      expect(content).toContain('class Entity:');
    } finally {
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
  });

  it('false:回落精选目录(不读引擎 checkout)', () => {
    const engineRoot = makeEngineRoot();
    try {
      configurationOverrides.set('kbengine', { 'python.stubEngineTypings': false });
      expect(buildKbeStubExportContentForWorkspace('/ws', { engineRoot, engineRootEnv: {} }))
        .toBe(buildKbeStubExportContent());
    } finally {
      fs.rmSync(engineRoot, { recursive: true, force: true });
    }
  });
});

describe('kbengine.python.entityStubMethods(entity_types.pyi 方法面)', () => {
  const baseMapping = {
    name: 'Avatar',
    properties: { hp: { defFile: '/p/Avatar.def', line: 3 } },
    methods: {
      cellTick: [
        { section: 'CellMethods', exposed: false, declaredArgs: ['UINT8'], line: 5 }
      ]
    }
  } as never;

  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('默认开(缺省参):plan 含方法面', () => {
    const plan = buildEntityTypeStubPlan([baseMapping], []);
    expect(plan.entries[0]?.methods.map(method => method.name)).toEqual(['cellTick']);
    expect(plan.content).toContain('def cellTick(arg1: int) -> None: ...');
  });

  it('includeMethods=false:方法面让位,只有方法的实体落出存根', () => {
    const plan = buildEntityTypeStubPlan([baseMapping], [], { includeMethods: false });
    expect(plan.entries[0]?.methods).toEqual([]);
    expect(plan.content).not.toContain('def cellTick');
  });

  it('false(配置读取处):exportEntityTypeStubs 落盘属性面存根', async () => {
    const originalFolders = workspace.workspaceFolders;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-toggle-estub-'));
    const written = new Map<string, string>();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'estub', index: 0 }];
      configurationOverrides.set('kbengine', { 'python.entityStubMethods': false });
      const { exportEntityTypeStubs } = await import('../src/entityTypeStubs');
      const memoryDeps = {
        exists: (candidate: string): boolean => written.has(candidate),
        readFile: (candidate: string): string => written.get(candidate) ?? '',
        writeFile: (candidate: string, content: string): void => {
          written.set(candidate, content);
        },
        mkdir: (): void => undefined
      };
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      await exportEntityTypeStubs(manager, memoryDeps, {
        silent: true,
        listMappings: () => [baseMapping],
        listCustomTypes: () => []
      });
      const stub = [...written.entries()].find(([file]) => file.endsWith('entity_types.pyi'));
      expect(stub).toBeDefined();
      expect(stub?.[1]).toContain('hp: ');
      expect(stub?.[1]).not.toContain('def cellTick');
      manager.dispose();
    } finally {
      configurationOverrides.delete('kbengine');
      workspace.workspaceFolders = originalFolders;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('kbengine.types.aliasDiscovery(alias.xml 类型发现)', () => {
  const makeAliasRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-toggle-alias-'));
    const put = (relative: string, content: string): void => {
      const target = path.join(root, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    };
    put('scripts/entity_defs/alias.xml', [
      '<root>',
      '  <DIRECT>UINT8</DIRECT>',
      '</root>'
    ].join('\n'));
    return root;
  };

  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  it('默认开:alias.xml 类型并入自定义类型表', () => {
    const root = makeAliasRoot();
    try {
      expect(getCustomTypeInfos(root).map(info => info.name)).toContain('DIRECT');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('false:回落只认 types.xml 的旧口径(alias 类型让位)', () => {
    const root = makeAliasRoot();
    try {
      configurationOverrides.set('kbengine', { 'types.aliasDiscovery': false });
      expect(getCustomTypeInfos(root).map(info => info.name)).not.toContain('DIRECT');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('def 方法签名文本(审计遗留承诺:声明 <Arg><Type> 必须带类型注解)', () => {
  it('签名助手口径与存根同表:UINT8→int、未知回落 Any、无 <Arg> 不硬造', async () => {
    // 经补全面验证:PythonCompletionProvider 的实体方法 documentation 首行
    // 出签名;这里用 hover 面已在 receiverSections describe 覆盖 int 口径,
    // 此处补"无 <Arg> 只出 self"与"未知类型不硬造"两臂。
    const originalFolders = workspace.workspaceFolders;
    const originalFindFiles = workspace.findFiles;
    const managers: EntityMappingManager[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-toggle-sig-'));
    try {
      const put = (relative: string, content: string): string => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        return file;
      };
      // heal 无 <Arg>;custom 只在 BaseMethods 带未知类型 FOO
      const defFile = put('scripts/entity_defs/Avatar.def', [
        '<root>',
        '  <BaseMethods>',
        '    <heal/>',
        '    <custom>',
        '      <Arg>FOO</Arg>',
        '    </custom>',
        '  </BaseMethods>',
        '</root>'
      ].join('\n'));
      const basePy = put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'sig', index: 0 }];
      workspace.findFiles = async (glob?: string) => (glob === '**/*.def' ? [Uri.file(defFile)] : []);

      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      managers.push(manager);
      await manager.waitForInitialScan();
      const completion = new PythonCompletionProvider(manager);
      const doc = pyDoc('class Avatar:\n    def tick(self):\n        self.\n', basePy);
      const items = completion.provideCompletionItems(
        doc,
        new Position(2, '        self.'.length)
      ) as Array<{ label: string; documentation?: { value: string } }>;
      const heal = items.find(item => item.label === 'heal');
      const custom = items.find(item => item.label === 'custom');
      expect(heal?.documentation?.value).toContain('def heal(self)');
      expect(heal?.documentation?.value).not.toContain('arg1');
      expect(custom?.documentation?.value).toContain('def custom(self, arg1: Any)');
    } finally {
      managers.splice(0).forEach(manager => manager.dispose());
      fs.rmSync(root, { recursive: true, force: true });
      workspace.workspaceFolders = originalFolders;
      workspace.findFiles = originalFindFiles;
    }
  });
});
