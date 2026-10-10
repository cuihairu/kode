import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import {
  findEntityDefsDirForDefFile,
  findEntityScriptFile,
  findInterfaceScriptFile
} from '../src/definitionWorkspace';
import { messages } from './fake-vscode/windowState';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 根修令①⑤布局矩阵(用户令 2026-10-10):脚本目录解析以 def 文件相对
// 反推为第一优先(向上找最近 entity_defs 目录——名字匹配,或同级含
// entities.xml/types.xml),找不到才回落工作区候选链。本文件把真实世界
// 会出现的布局各摆一个,逐个断言 F12「有落点」而非「有提示」(提示仅作
// 辅助,命中实现时不弹)。结果同步 TESTING.md 批115 节。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

let root = '';

const write = (relative: string, content: string) => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-layout-matrix-'));

  // L1 标准:scripts/entity_defs
  write('standard/scripts/entities.xml', '<root>\n  <Boxe hasBase="true"/>\n</root>\n');
  write('standard/scripts/entity_defs/Boxe.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('standard/scripts/base/Boxe.py', 'class Boxe:\n    def __init__(self):\n        pass\n');

  // L2 非标准:server/scripts/entity_defs(工程在打开根的子目录)
  write('nested/server/scripts/entity_defs/Ship.def', [
    '<root>',
    '  <Properties>',
    '    <crew>',
    '      <Type>UINT16</Type>',
    '    </crew>',
    '  </Properties>',
    '  <CellMethods>',
    '    <onSail>',
    '      <Arg>UINT8</Arg>',
    '    </onSail>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));
  write('nested/server/scripts/base/Ship.py', 'class Ship:\n    pass\n');
  write('nested/server/scripts/cell/Ship.py', 'class Ship:\n\n    def onSail(self, level):\n        pass\n');

  // L3 仅 entity_defs 在根(角色目录与 defs 同层)
  write('flatroot/entity_defs/Drone.def', [
    '<root>',
    '  <Properties>',
    '    <power>',
    '      <Type>UINT32</Type>',
    '    </power>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('flatroot/base/Drone.py', 'class Drone:\n    pass\n');

  // L4 改名 defs 目录(不叫 entity_defs,靠 types.xml 识别)
  write('renamed/assets/scripts/defs/types.xml', '<root>\n</root>\n');
  write('renamed/assets/scripts/defs/Flyer.def', [
    '<root>',
    '  <Properties>',
    '    <altitude>',
    '      <Type>UINT32</Type>',
    '    </altitude>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('renamed/assets/scripts/base/Flyer.py', 'class Flyer:\n    pass\n');

  // L5 组件 def + L6 接口 def,均在非标准布局下
  write('nested/server/scripts/entity_defs/components/Gun.def', [
    '<root>',
    '  <CellMethods>',
    '    <onFire>',
    '      <Arg>UINT8</Arg>',
    '    </onFire>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));
  write('nested/server/scripts/cell/Gun.py', 'class Gun:\n\n    def onFire(self, level):\n        pass\n');
  write('nested/server/scripts/entity_defs/interfaces/WingsIface.def', [
    '<root>',
    '  <ClientMethods>',
    '    <onFlap>',
    '    </onFlap>',
    '  </ClientMethods>',
    '</root>'
  ].join('\n'));
  write('nested/server/scripts/interfaces/WingsIface.py', 'class WingsIface:\n\n    def onFlap(self):\n        pass\n');

  // 降级矩阵 M1-M5 的注册表/期望位置夹具
  write('nested/server/scripts/entities.xml', '<root>\n  <Boat hasBase="true"/>\n</root>\n');
  write('nows/entity_defs/No.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write('scripts/entities.xml', '<root>\n  <Loose hasBase="true"/>\n</root>\n');
  write('scripts/interfaces/Wings.py', 'class Wings:\n    pass\n');
  write('weird/entities.xml', '<root>\n</root>\n');
  write('weird/entity_defs/My-Entity.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
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

const defAt = (
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

const provider = new KBEngineDefinitionProvider();

describe('根修令布局矩阵:def 相对解析优先,各布局必有落点', () => {
  it('L1 标准 scripts/entity_defs:属性 → base 脚本 class 行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|hp>',
        '      <Type>UINT32</Type>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'standard/scripts/entity_defs/Boxe.def'
    );
    messages.info.length = 0;
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'standard', 'scripts', 'base', 'Boxe.py'));
    expect(location!.range.start.line).toBe(0);
    expect(messages.info, '命中实现不弹提示').toEqual([]);
  });

  it('L2 非标准 server/scripts/entity_defs:属性/CellMethods 各有落点', async () => {
    const prop = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|crew>',
        '      <Type>UINT16</Type>',
        '    </crew>',
        '  </Properties>',
        '  <CellMethods>',
        '    <onSail>',
        '      <Arg>UINT8</Arg>',
        '    </onSail>',
        '  </CellMethods>',
        '</root>'
      ].join('\n'),
      'nested/server/scripts/entity_defs/Ship.def'
    );
    messages.info.length = 0;
    const propLocation = provider.provideDefinition(
      prop.document,
      prop.position
    ) as unknown as LocationLike;
    expect(propLocation?.uri.fsPath).toBe(p(root, 'nested', 'server', 'scripts', 'base', 'Ship.py'));
    expect(propLocation!.range.start.line).toBe(0);

    const method = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <crew>',
        '      <Type>UINT16</Type>',
        '    </crew>',
        '  </Properties>',
        '  <CellMethods>',
        '    <|onSail>',
        '      <Arg>UINT8</Arg>',
        '    </onSail>',
        '  </CellMethods>',
        '</root>'
      ].join('\n'),
      'nested/server/scripts/entity_defs/Ship.def'
    );
    const methodLocation = await provider.provideDefinition(
      method.document,
      method.position
    ) as unknown as LocationLike;
    expect(methodLocation?.uri.fsPath).toBe(
      p(root, 'nested', 'server', 'scripts', 'cell', 'Ship.py')
    );
    expect(methodLocation!.range.start.line).toBe(2);
    expect(messages.info, '命中实现不弹提示').toEqual([]);
  });

  it('L3 仅 entity_defs 在根:属性 → base 脚本 class 行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|power>',
        '      <Type>UINT32</Type>',
        '    </power>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'flatroot/entity_defs/Drone.def'
    );
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'flatroot', 'base', 'Drone.py'));
    expect(location!.range.start.line).toBe(0);
  });

  it('L4 改名 defs 目录(靠 types.xml 识别):属性 → base 脚本 class 行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|altitude>',
        '      <Type>UINT32</Type>',
        '    </altitude>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'renamed/assets/scripts/defs/Flyer.def'
    );
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'renamed', 'assets', 'scripts', 'base', 'Flyer.py'));
    expect(location!.range.start.line).toBe(0);
  });

  it('L5 组件 def(非标准布局):CellMethods → cell 脚本 def 行', async () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <CellMethods>',
        '    <|onFire>',
        '      <Arg>UINT8</Arg>',
        '    </onFire>',
        '  </CellMethods>',
        '</root>'
      ].join('\n'),
      'nested/server/scripts/entity_defs/components/Gun.def'
    );
    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'nested', 'server', 'scripts', 'cell', 'Gun.py'));
    expect(location!.range.start.line).toBe(2);
  });

  it('L6 接口 def(非标准布局):ClientMethods → interfaces 脚本 def 行', async () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <ClientMethods>',
        '    <|onFlap>',
        '    </onFlap>',
        '  </ClientMethods>',
        '</root>'
      ].join('\n'),
      'nested/server/scripts/entity_defs/interfaces/WingsIface.def'
    );
    const location = await provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(
      p(root, 'nested', 'server', 'scripts', 'interfaces', 'WingsIface.py')
    );
    expect(location!.range.start.line).toBe(2);
  });
});

describe('根修令落点降级矩阵:实现缺失仍有落点,提示给真实路径', () => {
  it('M1 嵌套布局脚本缺失:提示列双根真实路径,落 entities.xml 声明行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|draft>',
        '      <Type>UINT32</Type>',
        '    </draft>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'nested/server/scripts/entity_defs/Boat.def'
    );
    messages.info.length = 0;
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(
      p(root, 'nested', 'server', 'scripts', 'entities.xml')
    );
    expect(location!.range.start.line).toBe(1);
    // 双根:def 反推根(工作区相对) + 布局根(工作区相对),全是真实路径
    // (反推根列首无前置分隔,布局根条目用分隔边界断言防子串误判)
    const hint = messages.info.join('\n');
    expect(hint).toContain('期望位置:nested/server/scripts/base/Boat.py、');
    expect(hint).toContain('、scripts/base/Boat.py、');
    expect(hint, '禁止花括号模板').not.toContain('{base}');
  });

  it('M2 无 workspace 脚本缺失:提示列绝对路径,落 def 首行', () => {
    const saved = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    try {
      const { document, position } = defAt(
        [
          '<root>',
          '  <Properties>',
          '    <|hp>',
          '      <Type>UINT32</Type>',
          '    </hp>',
          '  </Properties>',
          '</root>'
        ].join('\n'),
        'nows/entity_defs/No.def'
      );
      messages.info.length = 0;
      const location = provider.provideDefinition(document, position) as unknown as LocationLike;
      expect(location?.uri.fsPath).toBe(p(root, 'nows', 'entity_defs', 'No.def'));
      expect(location!.range.start.line).toBe(0);
      expect(messages.info.join('\n')).toContain(p(root, 'nows', 'base', 'No.py'));
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('M3 散落 def(反推不出 defs 目录):走布局注册表,落 entities.xml 声明行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|hp>',
        '      <Type>UINT32</Type>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'loose/Loose.def'
    );
    messages.info.length = 0;
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'scripts', 'entities.xml'));
    expect(location!.range.start.line).toBe(1);
    // 反推失败时提示退到布局根,仍给真实路径
    expect(messages.info.join('\n')).toContain('scripts/base/Loose.py');
  });

  it('M4 悬停段标签且无脚本:附注列期望位置(真实路径)', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Proper|ties>',
        '    <hp>',
        '      <Type>UINT32</Type>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'nows/entity_defs/No.def'
    );
    const hoverProvider = new KBEngineHoverProvider();
    const result = hoverProvider.provideHover(document, position) as unknown as {
      contents: unknown;
    } | null;
    const rawContents = result?.contents ?? [];
    const contents = Array.isArray(rawContents) ? rawContents : [rawContents];
    const text = contents.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
    expect(text).toContain('未找到实体脚本,期望位置:');
    // 悬停时 workspace 在位,路径按工作区相对展示(M2 已验绝对路径形态)
    expect(text).toContain('nows/base/No.py');
    expect(text, '禁止花括号模板').not.toContain('{base}');
  });

  it('M5 实体名含连字符:注册表匹配守卫拒绝,落 def 首行', () => {
    const { document, position } = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|hp>',
        '      <Type>UINT32</Type>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'weird/entity_defs/My-Entity.def'
    );
    const location = provider.provideDefinition(document, position) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'weird', 'entity_defs', 'My-Entity.def'));
    expect(location!.range.start.line).toBe(0);
  });
});

describe('根修令管理器回落:索引未收录非标准布局,仍走 def 相对候选链', () => {
  const nonStandardDef = 'nested/server/scripts/entity_defs/Ship.def';
  const methodTemplate = [
    '<root>',
    '  <Properties>',
    '    <crew>',
    '      <Type>UINT16</Type>',
    '    </crew>',
    '  </Properties>',
    '  <CellMethods>',
    '    <|onSail>',
    '      <Arg>UINT8</Arg>',
    '    </onSail>',
    '  </CellMethods>',
    '</root>'
  ].join('\n');

  it('N1 索引收录符号但脚本未索引 → 落 cell 脚本 def 行', async () => {
    const manager = {
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ ownerName: 'Ship', symbolName: 'onSail' }),
      resolveMethodImplementationByIdentity: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const managedProvider = new KBEngineDefinitionProvider(manager);

    const { document, position } = defAt(methodTemplate, nonStandardDef);
    const location = await managedProvider.provideDefinition(
      document,
      position
    ) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'nested', 'server', 'scripts', 'cell', 'Ship.py'));
    expect(location!.range.start.line).toBe(2);
  });

  it('N2 索引未收录符号 → 同样落 cell 脚本 def 行', async () => {
    const manager = {
      resolveDefinitionSymbolAtPosition: () => Promise.resolve(null),
      resolveMethodImplementationByIdentity: () => Promise.resolve(null)
    } as unknown as EntityMappingManager;
    const managedProvider = new KBEngineDefinitionProvider(manager);

    const { document, position } = defAt(methodTemplate, nonStandardDef);
    const location = await managedProvider.provideDefinition(
      document,
      position
    ) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(root, 'nested', 'server', 'scripts', 'cell', 'Ship.py'));
    expect(location!.range.start.line).toBe(2);
  });
});

describe('根修令导出助手单元:反推边界', () => {
  it('U1 反推 6 层未命中 defs 目录 → null(防跨出工程)', () => {
    const deepDef = p(root, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'X.def');
    fs.mkdirSync(path.dirname(deepDef), { recursive: true });
    fs.writeFileSync(deepDef, '<root></root>', 'utf8');
    expect(findEntityDefsDirForDefFile(deepDef)).toBeNull();
  });

  it('U2 反推未命中且无 workspace → findEntityScriptFile null', () => {
    const saved = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    try {
      const doc = makeTextDocument('<root></root>', {
        fileName: p(root, 'deep2', 'X.def'),
        languageId: 'kbengine-def'
      });
      expect(findEntityScriptFile('X', 'base', doc)).toBeNull();
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('U3 反推未命中 → 接口脚本退工作区布局链命中', () => {
    const doc = makeTextDocument('<root></root>', {
      fileName: p(root, 'loose2', 'Wings.def'),
      languageId: 'kbengine-def'
    });
    expect(findInterfaceScriptFile('Wings', doc)).toBe(
      p(root, 'scripts', 'interfaces', 'Wings.py')
    );
  });
});
