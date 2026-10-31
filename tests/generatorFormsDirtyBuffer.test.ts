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
