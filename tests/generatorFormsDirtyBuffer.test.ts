import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateGeneratorForm, type GeneratorFormInput } from '../src/generatorForms';
import type { DefinitionWorkspaceLayout } from '../src/definitionWorkspace';
import { makeTextDocument, Uri, workspace as stubWorkspace, workspaceState } from './helpers/vscodeStub';

// IDE-AUD-030(R2-F07):entities.xml 登记直接原子写盘,打开中的脏缓冲不跟随
// ——登记进了盘,用户随后保存旧缓冲,盘上登记被旧内容覆盖丢失。本测试锁定:
// 打开文档(含脏)走 WorkspaceEdit 缓冲写入(插入点按缓冲区当前文本定位,
// 用户未保存改动原样保留),未打开才原子写盘。

const DISK_XML = [
  '<root>',
  '  <Avatar hasBase="true" hasCell="true" hasClient="true" />',
  '</root>',
  ''
].join('\n');

// 用户脏缓冲:盘上没有的未保存行,结构仍完整
const DIRTY_XML = [
  '<root>',
  '  <Avatar hasBase="true" hasCell="true" hasClient="true" />',
  '  <!-- 未保存:手工加的 Boss 实体 -->',
  '</root>',
  ''
].join('\n');

let root: string;
let entitiesXmlPath: string;

const layout = (): DefinitionWorkspaceLayout => ({
  workspaceRoot: root,
  entityDefsRoot: path.join(root, 'scripts', 'entity_defs'),
  entityScriptsRoot: path.join(root, 'scripts'),
  interfacesRoot: path.join(root, 'scripts', 'entity_defs', 'interfaces'),
  componentsRoot: path.join(root, 'scripts', 'entity_defs', 'components'),
  entitiesXmlPath,
  typesXmlPath: path.join(root, 'scripts', 'entity_defs', 'types.xml'),
  userTypeRoots: [path.join(root, 'scripts', 'user_type')]
});

const spaceInput: GeneratorFormInput = { kind: 'space', value: { name: 'MySpace' } };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud030-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  entitiesXmlPath = path.join(root, 'scripts', 'entities.xml');
  fs.writeFileSync(entitiesXmlPath, DISK_XML, 'utf8');
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.textDocuments = [];
  workspaceState.applyEditCalls.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
});

describe('entities.xml 登记进打开缓冲区(AUD-030)', () => {
  it('R2-F07 复现:打开脏文档时登记进缓冲区,盘不动,用户未保存行保留', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];

    const outcome = await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.touchedFiles).toEqual([entitiesXmlPath]);
    // 缓冲区=旧脏内容 + 新登记(用户未保存行原样保留)
    const bufferText = dirtyDoc.getText();
    expect(bufferText).toContain('<!-- 未保存:手工加的 Boss 实体 -->');
    expect(bufferText).toContain('<MySpace hasBase="true" hasCell="true" />');
    // 盘未动:登记只在缓冲区,等用户保存才落盘
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
    // 版本守卫可见:缓冲写入使文档版本前进
    expect(dirtyDoc.version).toBe(8);
  });

  it('未打开才原子写盘(applyEdit 零调用)', async () => {
    const outcome = await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.touchedFiles).toEqual([entitiesXmlPath]);
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toContain('<MySpace hasBase="true" hasCell="true" />');
    expect(workspaceState.applyEditCalls).toHaveLength(0);
  });

  it('缓冲区结构异常(无 </root>)时如实说明,缓冲盘都不动', async () => {
    const broken = makeTextDocument('<root>\n', { uri: Uri.file(entitiesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [broken];

    const outcome = await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.notes).toContain('entities.xml 缓冲区找不到 </root> 标签,空间 MySpace 未登记');
    expect(outcome.touchedFiles).toEqual([]);
    expect(broken.getText()).toBe('<root>\n');
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });

  it('缓冲区已有同名登记(用户手敲)时不重复写入', async () => {
    const withEntity = DIRTY_XML.replace('  <!--', '  <MySpace hasBase="true" hasCell="true" />\n  <!--');
    const doc = makeTextDocument(withEntity, { uri: Uri.file(entitiesXmlPath), version: 9 });
    stubWorkspace.textDocuments = [doc];

    const outcome = await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.notes).toContain('MySpace 已在 entities.xml 中注册,未重复写入');
    expect(outcome.touchedFiles).toEqual([]);
    expect(doc.getText().match(/<MySpace /g)).toHaveLength(1);
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });

  it('模拟保存:保存脏缓冲后盘上同时有新登记与旧脏内容', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];

    await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    // 模拟用户 Ctrl+S:缓冲区全文落盘
    fs.writeFileSync(entitiesXmlPath, dirtyDoc.getText(), 'utf8');
    const saved = fs.readFileSync(entitiesXmlPath, 'utf8');
    expect(saved).toContain('<!-- 未保存:手工加的 Boss 实体 -->');
    expect(saved).toContain('<MySpace hasBase="true" hasCell="true" />');
  });
});

// AUD-031:表单附带改写(固定字典 types.xml、组件挂载 def)同 R2-F07 闭环——
// 打开文档(含脏)走 WorkspaceEdit 缓冲写入(插入点按缓冲区当前文本定位,
// 用户未保存改动原样保留),未打开才原子写盘。

const DISK_TYPES = [
  '<root>',
  '  <ITEM_ID>',
  '    <Type>UINT32</Type>',
  '  </ITEM_ID>',
  '</root>',
  ''
].join('\n');

const DIRTY_TYPES = [
  '<root>',
  '  <ITEM_ID>',
  '    <Type>UINT32</Type>',
  '  </ITEM_ID>',
  '  <!-- 未保存:手工加的 BOSS_FLAGS -->',
  '</root>',
  ''
].join('\n');

const DISK_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const DIRTY_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '    </hp>',
  '    <!-- 未保存:手工加的 mana 属性占位 -->',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const fixedDictInput: GeneratorFormInput = {
  kind: 'fixedDict',
  value: { name: 'AVATAR_DATA', properties: [{ name: 'value', type: 'UINT32' }] }
};
const componentInput: GeneratorFormInput = { kind: 'component', value: { name: 'Inventory', properties: [] } };

describe('types.xml 固定字典登记进打开缓冲区(AUD-031)', () => {
  it('R2-F07 复现:打开脏 types.xml 时登记进缓冲区,盘不动,未保存行保留', async () => {
    const typesPath = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesPath, DISK_TYPES, 'utf8');
    const dirtyDoc = makeTextDocument(DIRTY_TYPES, { uri: Uri.file(typesPath), version: 5 });
    stubWorkspace.textDocuments = [dirtyDoc];

    const outcome = await generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.written).toBe(true);
    expect(outcome.touchedFiles).toEqual([typesPath]);
    const bufferText = dirtyDoc.getText();
    expect(bufferText).toContain('<!-- 未保存:手工加的 BOSS_FLAGS -->');
    expect(bufferText).toContain('<AVATAR_DATA>');
    expect(fs.readFileSync(typesPath, 'utf8')).toBe(DISK_TYPES);
    expect(dirtyDoc.version).toBe(6);
  });

  it('未打开才原子写盘(applyEdit 零调用)', async () => {
    const typesPath = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesPath, DISK_TYPES, 'utf8');
    stubWorkspace.textDocuments = [];
    workspaceState.applyEditCalls.length = 0;

    const outcome = await generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.written).toBe(true);
    expect(fs.readFileSync(typesPath, 'utf8')).toContain('<AVATAR_DATA>');
    expect(workspaceState.applyEditCalls).toHaveLength(0);
  });
});

describe('组件挂载 def 进打开缓冲区(AUD-031)', () => {
  it('R2-F07 复现:打开脏目标 def 时挂载进缓冲区,盘不动,未保存行保留', async () => {
    const entityDefPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
    fs.writeFileSync(entityDefPath, DISK_DEF, 'utf8');
    const dirtyDoc = makeTextDocument(DIRTY_DEF, { uri: Uri.file(entityDefPath), version: 4 });
    stubWorkspace.textDocuments = [dirtyDoc];

    const outcome = await generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: 'Avatar'
    });

    expect(outcome.touchedFiles).toContain(entityDefPath);
    const bufferText = dirtyDoc.getText();
    expect(bufferText).toContain('<!-- 未保存:手工加的 mana 属性占位 -->');
    expect(bufferText).toContain('    <Inventory>\n      <Type>COMPONENT</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </Inventory>');
    expect(fs.readFileSync(entityDefPath, 'utf8')).toBe(DISK_DEF);
  });

  it('未打开才原子写盘(applyEdit 零调用)', async () => {
    const entityDefPath = path.join(root, 'scripts', 'entity_defs', 'Avatar.def');
    fs.writeFileSync(entityDefPath, DISK_DEF, 'utf8');
    stubWorkspace.textDocuments = [];
    workspaceState.applyEditCalls.length = 0;

    const outcome = await generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: 'Avatar'
    });

    const content = fs.readFileSync(entityDefPath, 'utf8');
    expect(content).toContain('    <Inventory>\n      <Type>COMPONENT</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </Inventory>');
    expect(workspaceState.applyEditCalls).toHaveLength(0);
  });
});

describe('缓冲写入异常语义(AUD-031)', () => {
  const realApplyEdit = stubWorkspace.applyEdit;

  afterEach(() => {
    stubWorkspace.applyEdit = realApplyEdit;
  });

  it('applyEdit 抛错且文本未落缓冲:上抛交回滚,主产物回收,缓冲不动', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];
    const defPath = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
    stubWorkspace.applyEdit = (async (): Promise<boolean> => {
      throw new Error('simulated interruption');
    }) as unknown as typeof stubWorkspace.applyEdit;

    await expect(
      generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() })
    ).rejects.toThrow('simulated interruption');

    // 主产物(先落盘的 def)被回收,缓冲区原样未动
    expect(fs.existsSync(defPath)).toBe(false);
    expect(dirtyDoc.getText()).toBe(DIRTY_XML);
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });

  it('applyEdit 抛错但文本已进缓冲:按实文判落地,登记保留不误报失败', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];
    const real = stubWorkspace.applyEdit;
    stubWorkspace.applyEdit = (async (edit: never): Promise<boolean> => {
      await real(edit);
      throw new Error('boom after land');
    }) as unknown as typeof stubWorkspace.applyEdit;

    const outcome = await generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.touchedFiles).toEqual([entitiesXmlPath]);
    expect(dirtyDoc.getText()).toContain('<MySpace hasBase="true" hasCell="true" />');
    expect(dirtyDoc.getText()).toContain('<!-- 未保存:手工加的 Boss 实体 -->');
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });
});
