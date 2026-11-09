import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPropertyInitOrderLensSpecs,
  describePropertyInitOrderTitle
} from '../src/backend/propertyInitOrderLens';
import { PropertyCodeLensProvider, resolvePropertyLandingLine } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { configurationOverrides, makeTextDocument, Uri } from './helpers/vscodeStub';
import * as vscode from './helpers/vscodeStub';

// IDE-PROP-001:属性先于 __init__ 装载的可见化。纯逻辑层(build*)按注入的
// 实体名→def 解析器出镜;provider 层(PropertyCodeLensProvider)装配 + 独立
// 开关(codeLens.propertyInitOrder 与 codeLens.property 互不影响);另锁
// 属性落点四档(resolvePropertyLandingLine)不回归——装载语义镜只加可见性,
// 不许动 F12 落点。

interface CodeLensLike {
  range: { start: { line: number; character: number } };
  command: { title: string; command: string; arguments: Array<unknown> };
}

const resolverOf = (entities: Record<string, string>) => (name: string): string | null => entities[name] ?? null;

describe('buildPropertyInitOrderLensSpecs(纯扫描层)', () => {
  const script = [
    'import KBEngine',
    '',
    'class Avatar(kbe.KBEntity):',
    '    def __init__(self):',
    '        self.hp = 100',
    '',
    '    def tick(self):',
    '        pass',
    ''
  ].join('\n');

  it('实体类 __init__ 声明行出一枚镜:锚在 def __init__ 行,标题点名实体 def', () => {
    const specs = buildPropertyInitOrderLensSpecs(script, resolverOf({ Avatar: '/ws/entity_defs/Avatar.def' }));
    expect(specs).toEqual([
      {
        line: 3,
        character: 4,
        entityName: 'Avatar',
        defPath: '/ws/entity_defs/Avatar.def',
        title: '属性先于 __init__ 装载 · 来自 Avatar.def'
      }
    ]);
  });

  it('类名解析不到 def(非实体类)如实不出镜', () => {
    expect(buildPropertyInitOrderLensSpecs(script, resolverOf({}))).toEqual([]);
    expect(buildPropertyInitOrderLensSpecs(script, () => null)).toEqual([]);
  });

  it('没有 __init__ 的类不出镜;模块级 def __init__(无类上下文)不出镜', () => {
    const noInit = 'class Avatar(kbe.KBEntity):\n    def tick(self):\n        pass\n';
    expect(buildPropertyInitOrderLensSpecs(noInit, resolverOf({ Avatar: '/x/Avatar.def' }))).toEqual([]);

    const topLevelInit = 'def __init__(self):\n    pass\n';
    expect(buildPropertyInitOrderLensSpecs(topLevelInit, resolverOf({ __init__: '/x/__init__.def' }))).toEqual([]);
  });

  it('多个实体类各出一枚(按出现序);同名类重复定义只出第一枚', () => {
    const two = [
      'class Avatar(kbe.KBEntity):',
      '    def __init__(self):',
      '        pass',
      '',
      'class Monster(kbe.KBEntity):',
      '    def __init__(self):',
      '        pass',
      ''
    ].join('\n');
    const resolver = resolverOf({ Avatar: '/x/Avatar.def', Monster: '/x/Monster.def' });
    expect(buildPropertyInitOrderLensSpecs(two, resolver).map(spec => spec.entityName)).toEqual(['Avatar', 'Monster']);

    const dup = 'class Avatar:\n    def __init__(self):\n        pass\n\nclass Avatar:\n    def __init__(self):\n        pass\n';
    expect(buildPropertyInitOrderLensSpecs(dup, resolver)).toHaveLength(1);
  });

  it('嵌套类:__init__ 归最近一层类;同缩进的顶层 def __init__ 不归上一个类', () => {
    const nested = [
      'class Avatar:',                       // 0 缩进
      '    class Helper:',                   // 4 缩进(最近一层)
      '        def __init__(self):',         // 8 缩进 → Helper
      '            pass',
      '    def __init__(self):',             // 4 缩进 → Avatar
      '        pass',
      ''
    ].join('\n');
    const specs = buildPropertyInitOrderLensSpecs(nested, resolverOf({ Helper: '/x/Helper.def', Avatar: '/x/Avatar.def' }));
    expect(specs.map(spec => [spec.entityName, spec.line])).toEqual([['Helper', 2], ['Avatar', 4]]);

    const dedented = 'class Avatar:\n    def tick(self):\n        pass\ndef __init__(self):\n    pass\n';
    expect(buildPropertyInitOrderLensSpecs(dedented, resolverOf({ Avatar: '/x/Avatar.def' }))).toEqual([]);
  });

  it('CRLF 行尾同口径', () => {
    const crlf = 'class Avatar:\r\n    def __init__(self):\r\n        pass\r\n';
    const specs = buildPropertyInitOrderLensSpecs(crlf, resolverOf({ Avatar: '/x/Avatar.def' }));
    expect(specs.map(spec => spec.line)).toEqual([1]);
  });
});

describe('describePropertyInitOrderTitle(标题)', () => {
  it('标题点名实体 def 文件', () => {
    expect(describePropertyInitOrderTitle('Avatar')).toBe('属性先于 __init__ 装载 · 来自 Avatar.def');
  });
});

describe('PropertyCodeLensProvider 装载镜装配与独立开关(真实 fixture 工作区)', () => {
  let root: string;
  let foldersBackup: typeof vscode.workspace.workspaceFolders;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kode-prop-init-'));
    mkdirSync(join(root, 'entity_defs'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'base'), { recursive: true });
    writeFileSync(join(root, 'entity_defs', 'Avatar.def'), '<Root>\n  <Properties>\n    <hp>\n      <Type>UINT32</Type>\n    </hp>\n  </Properties>\n</Root>\n');
    writeFileSync(join(root, 'scripts', 'base', 'Avatar.py'), [
      'class Avatar(kbe.KBEntity):',
      '    def __init__(self):',
      '        self.hp = 100',
      ''
    ].join('\n'));
    foldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'fixture', index: 0 }];
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders = foldersBackup;
    rmSync(root, { recursive: true, force: true });
  });

  const scriptDoc = () =>
    makeTextDocument(
      [
        'class Avatar(kbe.KBEntity):',
        '    def __init__(self):',
        '        self.hp = 100',
        ''
      ].join('\n'),
      { fileName: join(root, 'scripts', 'base', 'Avatar.py'), languageId: 'python' }
    );

  const providerWithHit = () => new PropertyCodeLensProvider({
    resolvePropertyDefinitionInfo: () =>
      Promise.resolve({
        defFile: join(root, 'entity_defs', 'Avatar.def'),
        line: 3,
        identity: { symbolName: 'hp', propertyPath: 'hp' },
        typeName: 'UINT32',
        domains: ['base'],
        persistent: false
      })
  } as unknown as EntityMappingManager);

  it('装载镜与访问镜同 provider 共存:各一枚,装载镜锚在 __init__ 行回 def', async () => {
    const lenses = (await providerWithHit().provideCodeLenses(scriptDoc())) as unknown as CodeLensLike[];
    expect(lenses).toHaveLength(2);
    const initLens = lenses.find(lens => lens.command.title.includes('先于 __init__'));
    expect(initLens).toBeDefined();
    expect(initLens!.range.start).toEqual({ line: 1, character: 4 });
    expect(initLens!.command.command).toBe('kbengine.source.reveal');
    expect((initLens!.command.arguments[0] as { fsPath: string }).fsPath).toBe(join(root, 'entity_defs', 'Avatar.def'));
    expect(lenses.some(lens => lens.command.title.startsWith('属性 ·'))).toBe(true);
  });

  it('独立开关:关访问镜不影响装载镜;关装载镜不影响访问镜;全关即空', async () => {
    const document = scriptDoc();

    configurationOverrides.set('kbengine', { 'codeLens.property': false });
    let lenses: CodeLensLike[];
    try {
      lenses = (await providerWithHit().provideCodeLenses(document)) as unknown as CodeLensLike[];
    } finally {
      configurationOverrides.delete('kbengine');
    }
    expect(lenses.map(lens => lens.command.title)).toEqual(['属性先于 __init__ 装载 · 来自 Avatar.def']);

    configurationOverrides.set('kbengine', { 'codeLens.propertyInitOrder': false });
    try {
      lenses = (await providerWithHit().provideCodeLenses(document)) as unknown as CodeLensLike[];
    } finally {
      configurationOverrides.delete('kbengine');
    }
    expect(lenses.map(lens => lens.command.title)).toEqual(['属性 · hp · UINT32 · base']);

    configurationOverrides.set('kbengine', { 'codeLens.property': false, 'codeLens.propertyInitOrder': false });
    try {
      expect(await providerWithHit().provideCodeLenses(document)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });

  it('工作区没有该实体 def 时装载镜如实不出(访问镜不受影响)', async () => {
    rmSync(join(root, 'entity_defs', 'Avatar.def'), { force: true });
    const lenses = (await providerWithHit().provideCodeLenses(scriptDoc())) as unknown as CodeLensLike[];
    expect(lenses.map(lens => lens.command.title)).toEqual(['属性 · hp · UINT32 · base']);
  });
});

describe('resolvePropertyLandingLine(属性落点四档,回归锁)', () => {
  it('一档:与 def 同名的类定义行', () => {
    expect(resolvePropertyLandingLine(['class Avatar:', '    pass'], 'Avatar')).toBe(0);
  });

  it('二档:无同名类时 __init__ 行', () => {
    expect(resolvePropertyLandingLine(['class Helper:', '    def __init__(self):', '        pass'], 'Avatar')).toBe(1);
  });

  it('三档:无 __init__ 时首个类行;四档:无类时脚本首行', () => {
    expect(resolvePropertyLandingLine(['class Helper:', '    pass'], 'Avatar')).toBe(0);
    expect(resolvePropertyLandingLine(['import KBEngine', ''], 'Avatar')).toBe(0);
  });
});
