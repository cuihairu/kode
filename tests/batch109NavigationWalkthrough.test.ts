import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider, PythonDefinitionProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { resetEntitiesXmlMissingNotices } from '../src/definitionWorkspace';
import { buildKbeStubDocument, buildKbeStubUriString } from '../src/kbeModuleIndex';
import {
  Position,
  Uri,
  makeTextDocument,
  messages as stubMessages,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// 批109 验收走查(工单硬需求):真实临时工作区 + 真实 provider,逐步走通
// entities.xml 链路导航——清单→def、def 内 <Interfaces> 引用(自闭合与
// 配对写法)→ interfaces/<名>.def、Python 类继承头基类(登记实体 def、
// 纯脚本实体 scripts/base/<名>.py、kbe 模块面与 from-import 裸名→桩文档)、
// 以及无 entities.xml 工作区的一次性降级提示。每步断言跳转目标在磁盘上
// 真实存在(不是只画 UI);本文件即操作记录,结果同步 TESTING.md 批109 节。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

interface LocationLike {
  uri: { fsPath: string; scheme: string };
  range: { start: { line: number; character: number } };
}

let wsRoot = '';
let loneRoot = '';

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-walkthrough-'));
  loneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-walkthrough-lone-'));
  const write = (root: string, relative: string, content: string) => {
    const target = p(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  write(wsRoot, 'scripts/entities.xml', [
    '<root>',
    '  <Avatar hasBase="true" hasCell="true" hasClient="true"/>',
    '  <Monster hasBase="true"/>',
    '  <Shade/>',
    '  <Wisp/>',
    '  <Faerie/>',
    '</root>'
  ].join('\n'));
  write(wsRoot, 'scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </hp>',
    '  </Properties>',
    '  <Interfaces>',
    '    <Combat>',
    '    </Combat>',
    '  </Interfaces>',
    '</root>'
  ].join('\n'));
  write(wsRoot, 'scripts/entity_defs/Monster.def', [
    '<root>',
    '  <Properties>',
    '    <ferocity>',
    '      <Type>UINT32</Type>',
    '      <Flags>BASE</Flags>',
    '    </ferocity>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  write(wsRoot, 'scripts/entity_defs/interfaces/Combat.def', [
    '<root>',
    '  <Properties>',
    '    <combo>',
    '      <Type>UINT8</Type>',
    '      <Flags>ALL_CLIENTS</Flags>',
    '    </combo>',
    '  </Properties>',
    '</root>'
  ].join('\n'));
  // Avatar.py:项目基类与 kbe 基类(模块面 + from-import 裸名)三类继承头
  write(wsRoot, 'scripts/base/Avatar.py', [
    'import kbe',
    'from kbe import KBEntity',
    '',
    '',
    'class Avatar(Monster):',
    '',
    '    def onEnter(self):',
    '        pass',
    '',
    '',
    'class GameObject(kbe.KBEntity):',
    '',
    '    def onEnter(self):',
    '        pass',
    '',
    '',
    'class FromImport(KBEntity):',
    '',
    '    def onEnter(self):',
    '        pass',
    ''
  ].join('\n'));
  // 纯脚本实体 Shade:登记在 entities.xml 但没有 def 文件,只有脚本
  write(wsRoot, 'scripts/base/Shade.py', [
    'from __future__ import annotations',
    '',
    '',
    'class Shade(Avatar):',
    '',
    '    def onEnter(self):',
    '        pass',
    ''
  ].join('\n'));
  write(wsRoot, 'scripts/base/Wraith.py', [
    'from __future__ import annotations',
    '',
    '',
    'class Wraith(Shade):',
    '',
    '    def onEnter(self):',
    '        pass',
    ''
  ].join('\n'));
  // 纯脚本实体 Wisp:只有 cell 侧脚本(无 def、无 base 脚本)——继承头
  // 基类解析的 cell 回落臂
  write(wsRoot, 'scripts/cell/Wisp.py', [
    'from __future__ import annotations',
    '',
    '',
    'class Wisp:',
    '',
    '    def onEnter(self):',
    '        pass',
    ''
  ].join('\n'));
  // 纯脚本实体 Faerie:只有 client 侧脚本——继承头基类解析的 client 回落臂
  write(wsRoot, 'scripts/client/Faerie.py', [
    'from __future__ import annotations',
    '',
    '',
    'class Faerie:',
    '',
    '    def onEnter(self):',
    '        pass',
    ''
  ].join('\n'));
  // 降级工作区:没有 entities.xml,只有孤立 def(接口引用未落盘)
  write(loneRoot, 'Lone.def', [
    '<root>',
    '  <Interfaces>',
    '    <NoSuch/>',
    '  </Interfaces>',
    '</root>'
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(wsRoot), name: 'ws', index: 0 },
    { uri: Uri.file(loneRoot), name: 'lone', index: 1 }
  ];
  resetEntitiesXmlMissingNotices();
});

afterAll(() => {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  fs.rmSync(loneRoot, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

// `|` 标记光标位置。
const cursorOf = (
  template: string,
  fileName: string,
  languageId = 'kbengine-def'
): { document: MinimalTextDocument; position: Position } => {
  const idx = template.indexOf('|');
  expect(idx).toBeGreaterThanOrEqual(0);
  const text = template.replace('|', '');
  const before = text.slice(0, idx);
  const line = before.split('\n').length - 1;
  const lastNewline = before.lastIndexOf('\n');
  const character = line === 0 ? idx : idx - (lastNewline + 1);
  return {
    document: makeTextDocument(text, { fileName, languageId }),
    position: new Position(line, character)
  };
};

describe('批109 验收走查:entities.xml 链路导航', () => {
  const defProvider = new KBEngineDefinitionProvider();
  // 走查各步都在 kbe 桩/类继承头分支返回,不会触及映射管理器
  const pyProvider = new PythonDefinitionProvider({} as unknown as EntityMappingManager);

  it('① entities.xml 清单元素名 → entity_defs/<名>.def', () => {
    const { document, position } = cursorOf(
      [
        '<root>',
        '  <Av|atar hasBase="true" hasCell="true" hasClient="true"/>',
        '</root>'
      ].join('\n'),
      p(wsRoot, 'scripts', 'entities.xml')
    );

    const location = defProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'entity_defs', 'Avatar.def');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('② def 内 <Interfaces> 配对写法起标签名 → interfaces/<名>.def', () => {
    const { document, position } = cursorOf(
      [
        '<root>',
        '  <Interfaces>',
        '    <Comb|at>',
        '    </Combat>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      p(wsRoot, 'scripts', 'entity_defs', 'Avatar.def')
    );

    const location = defProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'entity_defs', 'interfaces', 'Combat.def');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('③ 同上,闭合标签名 → interfaces/<名>.def', () => {
    const { document, position } = cursorOf(
      [
        '<root>',
        '  <Interfaces>',
        '    <Combat>',
        '    </Comb|at>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      p(wsRoot, 'scripts', 'entity_defs', 'Avatar.def')
    );

    const location = defProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'entity_defs', 'interfaces', 'Combat.def');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('④ Python 继承头项目基类 → 基类 def(Avatar.py class Avatar(Monster))', async () => {
    const { document, position } = cursorOf(
      'class Avatar(Mon|ster):',
      p(wsRoot, 'scripts', 'base', 'Avatar.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'entity_defs', 'Monster.def');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('⑤ 纯脚本基类(无 def)→ scripts/base/<名>.py(Shade 链)', async () => {
    const { document, position } = cursorOf(
      'class Wraith(Sh|ade):',
      p(wsRoot, 'scripts', 'base', 'Wraith.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'base', 'Shade.py');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('⑤b 纯脚本基类仅有 cell 侧脚本 → scripts/cell/<名>.py', async () => {
    const { document, position } = cursorOf(
      'class WispBase(Wi|sp):',
      p(wsRoot, 'scripts', 'cell', 'Wisp.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'cell', 'Wisp.py');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('⑤c 纯脚本基类仅有 client 侧脚本 → scripts/client/<名>.py', async () => {
    const { document, position } = cursorOf(
      'class FaerieBase(Fa|erie):',
      p(wsRoot, 'scripts', 'client', 'Faerie.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const expected = p(wsRoot, 'scripts', 'client', 'Faerie.py');
    expect(location?.uri.fsPath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('⑤d 未登记且无文件的基类不接管(交回 python 扩展)', async () => {
    const { document, position } = cursorOf(
      'class OddBase(UnknownTh|ing):',
      p(wsRoot, 'scripts', 'base', 'Avatar.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position);
    expect(location).toBeNull();
  });

  it('⑥ kbe 模块面基类(kbe.KBEntity)→ 内置桩文档声明行', async () => {
    const { document, position } = cursorOf(
      [
        'import kbe',
        '',
        '',
        'class GameObject(kbe.KBE|ntity):'
      ].join('\n'),
      p(wsRoot, 'scripts', 'base', 'Avatar.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const stub = buildKbeStubDocument();
    expect(location?.uri.scheme).toBe('kbe-stub');
    // fake-vscode 的 Uri.parse 会吞 scheme 后的首个 '/'(stub 伪影),
    // 路径口径由 kbeModuleIndex 的 buildKbeStubUriString 单测锁定,这里只锁 scheme+行
    expect(location?.uri.fsPath).toContain('KBEngine.pyi');
    expect(location?.range.start.line).toBe(stub.symbolLines['KBEntity']);
  });

  it('⑦ from-import 裸名基类(KBEntity)→ 内置桩文档声明行', async () => {
    const { document, position } = cursorOf(
      [
        'from kbe import KBEntity',
        '',
        '',
        'class FromImport(KBE|ntity):'
      ].join('\n'),
      p(wsRoot, 'scripts', 'base', 'Avatar.py'),
      'python'
    );

    const location = await pyProvider.provideDefinition(document, position) as unknown as LocationLike;
    const stub = buildKbeStubDocument();
    expect(location?.uri.scheme).toBe('kbe-stub');
    expect(location?.range.start.line).toBe(stub.symbolLines['KBEntity']);
  });

  it('⑧ 无 entities.xml 工作区:导航降级且仅提示一次', async () => {
    const doc = cursorOf(
      [
        '<root>',
        '  <Interfaces>',
        '    <NoS|uch/>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      p(loneRoot, 'Lone.def')
    );

    const infoCountBefore = stubMessages.info.length;
    const first = defProvider.provideDefinition(doc.document, doc.position) as unknown as LocationLike;
    expect(first).toBeNull();

    // 第二次导航(不同词同工作区)不应追加第二条提示
    const secondDoc = cursorOf(
      [
        '<root>',
        '  <Interfaces>',
        '    <NoS|uch2/>',
        '  </Interfaces>',
        '</root>'
      ].join('\n'),
      p(loneRoot, 'Lone.def')
    );
    const second = defProvider.provideDefinition(
      secondDoc.document,
      secondDoc.position
    ) as unknown as LocationLike;
    expect(second).toBeNull();

    const notices = stubMessages.info.slice(infoCountBefore);
    expect(notices).toEqual([
      '未找到 entities.xml:实体导航按逐文件解析降级(引擎允许纯脚本定义)'
    ]);
  });
});
