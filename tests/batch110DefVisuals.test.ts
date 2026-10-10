import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider, KBEngineHoverProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { findEntityScriptFile, readWorkspaceTextFile } from '../src/definitionWorkspace';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批110 验收走查:真实临时工作区 + 真实 provider,逐步走通 def 语义导航
// 与悬停(用户令)——Properties 字段跳实体脚本 class 实现(base→cell→client
// 回落)、BaseMethods/CellMethods/ClientMethods 方法跳脚本 def 实现(无
// 工程索引时按文件约定回落)、映射管理器在位时仍走管理器、未实现方法与
// 无脚本工作区如实返回 null、段标签悬停按用户口径出文案。每步断言跳转
// 目标在磁盘上真实存在;本文件即操作记录,结果同步 TESTING.md 批110 节。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

interface LocationLike {
  uri: { fsPath: string; scheme: string };
  range: { start: { line: number; character: number } };
}

let wsRoot = '';
let bareRoot = '';

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE_AND_CLIENT</Flags>',
  '      <Persistent>true</Persistent>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <onKill>',
  '      <Arg>ENTITY_ID</Arg>',
  '      <Exposed>true</Exposed>',
  '    </onKill>',
  '    <onMissing>',
  '    </onMissing>',
  '  </BaseMethods>',
  '  <CellMethods>',
  '    <onScan>',
  '      <Exposed>true</Exposed>',
  '    </onScan>',
  '  </CellMethods>',
  '  <ClientMethods>',
  '    <onDamage>',
  '      <Arg>UINT8</Arg>',
  '    </onDamage>',
  '  </ClientMethods>',
  '</root>'
].join('\n');

const HERO_BASE_PY = [
  '',
  '',
  'class Hero(KBEntity):',
  '',
  '    def onKill(self, entityId):',
  '        pass',
  '',
  '    def onMissing(self):',
  '        pass',
  ''
].join('\n');

const HERO_CELL_PY = [
  '',
  '',
  'class Hero:',
  '',
  '    def onScan(self, entityId):',
  '        pass',
  ''
].join('\n');

const HERO_CLIENT_PY = [
  '',
  '',
  'class Hero:',
  '',
  '    def onDamage(self, level):',
  '        pass',
  ''
].join('\n');

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-batch110-'));
  bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-batch110-bare-'));
  const write = (root: string, relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write(wsRoot, 'scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true" hasClient="true"/>',
    '</root>'
  ].join('\n'));
  write(wsRoot, 'scripts/entity_defs/Hero.def', HERO_DEF);
  write(wsRoot, 'scripts/base/Hero.py', HERO_BASE_PY);
  write(wsRoot, 'scripts/cell/Hero.py', HERO_CELL_PY);
  write(wsRoot, 'scripts/client/Hero.py', HERO_CLIENT_PY);
  // bareRoot:只有孤立 def,无 entities.xml、无任何脚本(降级面)
  write(bareRoot, 'entity_defs/Lone.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(wsRoot), name: 'ws', index: 0 },
    { uri: Uri.file(bareRoot), name: 'bare', index: 1 }
  ];
});

afterAll(() => {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(bareRoot, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

// `|` 标记光标位置。
const defAt = (
  template: string,
  fileName: string
): { document: MinimalTextDocument; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return {
    document: makeTextDocument(text, { fileName, languageId: 'kbengine-def' }),
    position: new Position(line, character)
  };
};

describe('批110 验收走查:def 语义导航与悬停', () => {
  const defProvider = new KBEngineDefinitionProvider();
  const hoverProvider = new KBEngineHoverProvider();
  const heroDefPath = () => p(wsRoot, 'scripts', 'entity_defs', 'Hero.def');

  it('① Properties 字段 → scripts/base/<实体>.py 的 class 声明行', () => {
    const { document, position } = defAt(
      HERO_DEF.replace('    <hp>', '    <|hp>'),
      heroDefPath()
    );

    const location = defProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'base', 'Hero.py');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    const classLine = HERO_BASE_PY.split('\n').findIndex(l => l.startsWith('class Hero'));
    expect(location!.range.start.line).toBe(classLine);
  });

  it('② Properties 字段:无 base 脚本时按 cell→client 回落', () => {
    // 备走 base 脚本,cell 侧仍在
    const basePy = p(wsRoot, 'scripts', 'base', 'Hero.py');
    const stash = fs.readFileSync(basePy, 'utf8');
    fs.unlinkSync(basePy);
    try {
      const { document, position } = defAt(
        HERO_DEF.replace('    <hp>', '    <|hp>'),
        heroDefPath()
      );
      const location = defProvider.provideDefinition(
        document,
        position
      ) as unknown as LocationLike;
      const expected = p(wsRoot, 'scripts', 'cell', 'Hero.py');
      expect(location?.uri.fsPath).toBe(expected);
      expect(fs.existsSync(expected)).toBe(true);
    } finally {
      fs.writeFileSync(basePy, stash, 'utf8');
    }
  });

  it('③ BaseMethods 方法(无工程索引)→ scripts/base/<实体>.py 的 def 行', async () => {
    const { document, position } = defAt(
      HERO_DEF.replace('    <onKill>', '    <|onKill>'),
      heroDefPath()
    );

    const location = await defProvider.provideDefinition(
      document,
      position
    ) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'base', 'Hero.py');
    expect(location?.uri.fsPath).toBe(expected);
    const defLine = HERO_BASE_PY.split('\n').findIndex(l => l.includes('def onKill'));
    expect(location!.range.start.line).toBe(defLine);
  });

  it('④ CellMethods/ClientMethods 方法 → 对应角色脚本的 def 行', async () => {
    const scan = defAt(HERO_DEF.replace('    <onScan>', '    <|onScan>'), heroDefPath());
    const scanLocation = await defProvider.provideDefinition(
      scan.document,
      scan.position
    ) as unknown as LocationLike;
    expect(scanLocation?.uri.fsPath).toBe(p(wsRoot, 'scripts', 'cell', 'Hero.py'));
    const scanLine = HERO_CELL_PY.split('\n').findIndex(l => l.includes('def onScan'));
    expect(scanLocation!.range.start.line).toBe(scanLine);

    const damage = defAt(HERO_DEF.replace('    <onDamage>', '    <|onDamage>'), heroDefPath());
    const damageLocation = await defProvider.provideDefinition(
      damage.document,
      damage.position
    ) as unknown as LocationLike;
    expect(damageLocation?.uri.fsPath).toBe(p(wsRoot, 'scripts', 'client', 'Hero.py'));
    const damageLine = HERO_CLIENT_PY.split('\n').findIndex(l => l.includes('def onDamage'));
    expect(damageLocation!.range.start.line).toBe(damageLine);
  });

  it('⑤ 映射管理器在位时优先走管理器(不回落文件约定)', async () => {
    const manager = {
      resolveDefinitionSymbolAtPosition: () =>
        Promise.resolve({ ownerName: 'Hero', symbolName: 'onKill' }),
      resolveMethodImplementationByIdentity: () =>
        Promise.resolve({ filePath: p(wsRoot, 'manager', 'Impl.py'), line: 7, character: 4 })
    } as unknown as EntityMappingManager;
    const managedProvider = new KBEngineDefinitionProvider(manager);

    const { document, position } = defAt(
      HERO_DEF.replace('    <onKill>', '    <|onKill>'),
      heroDefPath()
    );
    const location = await managedProvider.provideDefinition(
      document,
      position
    ) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(wsRoot, 'manager', 'Impl.py'));
    expect(location!.range.start.line).toBe(6);
  });

  it('⑥ 方法未实现(脚本在、def 缺)→ 回落 entities.xml 声明行,不虚跳', async () => {
    // 闭合标签同步替换,保持 def XML 结构完整
    const missing = defAt(
      HERO_DEF
        .replace('    <onMissing>', '    <|onNothing>')
        .replace('    </onMissing>', '    </onNothing>'),
      heroDefPath()
    );
    const location = await defProvider.provideDefinition(
      missing.document,
      missing.position
    ) as unknown as LocationLike;
    expect(location?.uri.fsPath).toBe(p(wsRoot, 'scripts', 'entities.xml'));
    expect(location!.range.start.line).toBe(1);
  });

  it('⑩ 脚本异常面:读取失败按零行兜底、无 class 行落脚本首行', () => {
    expect(readWorkspaceTextFile(p(wsRoot, 'scripts', 'base', 'Nope.py'))).toBe('');
    // 字符串 target 口径(非 document)同样可探
    expect(findEntityScriptFile('Hero', 'base', wsRoot)).toBe(
      p(wsRoot, 'scripts', 'base', 'Hero.py')
    );

    const basePy = p(wsRoot, 'scripts', 'base', 'Hero.py');
    const stash = fs.readFileSync(basePy, 'utf8');
    fs.writeFileSync(basePy, 'from kbe import KBEntity\n', 'utf8');
    try {
      const { document, position } = defAt(
        HERO_DEF.replace('    <hp>', '    <|hp>'),
        heroDefPath()
      );
      const location = defProvider.provideDefinition(
        document,
        position
      ) as unknown as LocationLike;
      expect(location?.uri.fsPath).toBe(basePy);
      expect(location!.range.start.line).toBe(0);
    } finally {
      fs.writeFileSync(basePy, stash, 'utf8');
    }
  });

  it('⑦ 无脚本孤立 def 工作区:落 def 首行,不再无声 null', async () => {
    const lonePath = p(bareRoot, 'entity_defs', 'Lone.def');
    const prop = defAt(
      [
        '<root>',
        '  <Properties>',
        '    <|hp>',
        '    </hp>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      lonePath
    );
    const propLocation = defProvider.provideDefinition(
      prop.document,
      prop.position
    ) as unknown as LocationLike;
    expect(propLocation?.uri.fsPath).toBe(lonePath);
    expect(propLocation!.range.start.line).toBe(0);

    const method = defAt(
      [
        '<root>',
        '  <BaseMethods>',
        '    <|onHit>',
        '    </onHit>',
        '  </BaseMethods>',
        '</root>'
      ].join('\n'),
      lonePath
    );
    const methodLocation = await defProvider.provideDefinition(
      method.document,
      method.position
    ) as unknown as LocationLike;
    expect(methodLocation?.uri.fsPath).toBe(lonePath);
    expect(methodLocation!.range.start.line).toBe(0);
  });

  it('⑧ 无 workspace:def 相对解析仍落点(根修令①:文件相对优先)', async () => {
    const saved = stubWorkspace.workspaceFolders;
    stubWorkspace.workspaceFolders = [];
    try {
      const prop = defAt(
        HERO_DEF.replace('    <hp>', '    <|hp>'),
        p(wsRoot, 'scripts', 'entity_defs', 'Hero.def')
      );
      const propLocation = defProvider.provideDefinition(
        prop.document,
        prop.position
      ) as unknown as LocationLike;
      expect(propLocation?.uri.fsPath).toBe(p(wsRoot, 'scripts', 'base', 'Hero.py'));
      expect(propLocation!.range.start.line).toBe(2);

      const method = defAt(
        HERO_DEF.replace('    <onKill>', '    <|onKill>'),
        p(wsRoot, 'scripts', 'entity_defs', 'Hero.def')
      );
      const methodLocation = await defProvider.provideDefinition(
        method.document,
        method.position
      ) as unknown as LocationLike;
      expect(methodLocation?.uri.fsPath).toBe(p(wsRoot, 'scripts', 'base', 'Hero.py'));
      expect(methodLocation!.range.start.line).toBe(4);
    } finally {
      stubWorkspace.workspaceFolders = saved;
    }
  });

  it('⑨ 段标签悬停按用户口径:玩家属性/BaseApp 远程可调用/客户端回调', () => {
    const hoverText = (template: string): string => {
      const { document, position } = defAt(template, heroDefPath());
      const hover = hoverProvider.provideHover(document, position) as {
        contents: Array<{ value: string }> | { value: string };
      } | null;
      if (!hover) {
        return '';
      }
      const contents = hover.contents;
      return Array.isArray(contents)
        ? contents.map(item => item.value).join('')
        : contents.value;
    };

    const propertiesDoc = hoverText(
      HERO_DEF.replace('  <Properties>', '  <|Properties>').replace('  </Properties>', '  </Prop|erties>')
    );
    expect(propertiesDoc).toContain('**Properties**');
    expect(propertiesDoc).toContain('玩家属性');
    expect(propertiesDoc).toContain('Persistent');

    const baseDoc = hoverText(
      HERO_DEF.replace('  <BaseMethods>', '  <|BaseMethods>')
    );
    expect(baseDoc).toContain('**BaseMethods**');
    expect(baseDoc).toContain('可远程调用');
    expect(baseDoc).toContain('Exposed');

    const clientDoc = hoverText(
      HERO_DEF.replace('  <ClientMethods>', '  <|ClientMethods>')
    );
    expect(clientDoc).toContain('**ClientMethods**');
    expect(clientDoc).toContain('回调客户端');
  });
});
