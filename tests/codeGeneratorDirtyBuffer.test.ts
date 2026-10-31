import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type * as vscode from 'vscode';
import { makeTextDocument, Uri, window as stubWindow, workspace as stubWorkspace, workspaceState } from './helpers/vscodeStub';

// IDE-AUD-030(R2-F07):codeGenerator 的 registerInEntitiesXml 仍把登记原子
// 写盘——打开中的脏缓冲不跟随,登记进了盘,用户随后保存旧缓冲,盘上登记被
// 旧内容覆盖丢失。本测试锁定实体向导的同一闭环:打开文档(含脏)走
// WorkspaceEdit 缓冲写入(插入点按缓冲区当前文本定位,用户未保存改动原样
// 保留),未打开才原子写盘;回滚撤销缓冲插入而非写盘覆盖。

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

const entity = { name: 'Monster', hasBase: true, hasCell: false, hasClient: false };
const REGISTRATION = '  <Monster hasCell="false" hasBase="true" hasClient="false" />';

let root: string;
let entitiesXmlPath: string;
const originalOpenTextDocument = stubWorkspace.openTextDocument;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cg-dirty-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  entitiesXmlPath = path.join(root, 'scripts', 'entities.xml');
  fs.writeFileSync(entitiesXmlPath, DISK_XML, 'utf8');
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.textDocuments = [];
  workspaceState.applyEditCalls.length = 0;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
  stubWorkspace.openTextDocument = originalOpenTextDocument;
});

describe('codeGenerator entities.xml 登记进打开缓冲区(AUD-030)', () => {
  it('R2-F07 复现:打开脏文档时登记进缓冲区,盘不动,用户未保存行保留', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.registerInEntitiesXml(entity);

    // 缓冲区=旧脏内容 + 新登记(用户未保存行原样保留)
    const bufferText = dirtyDoc.getText();
    expect(bufferText).toContain('<!-- 未保存:手工加的 Boss 实体 -->');
    expect(bufferText).toContain(REGISTRATION);
    // 盘未动:登记只在缓冲区,等用户保存才落盘
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
    // 版本守卫可见:缓冲写入使文档版本前进
    expect(dirtyDoc.version).toBe(8);
    expect(workspaceState.applyEditCalls).toHaveLength(1);
  });

  it('未打开才原子写盘(applyEdit 零调用)', async () => {
    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.registerInEntitiesXml(entity);

    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toContain(REGISTRATION);
    expect(workspaceState.applyEditCalls).toHaveLength(0);
  });

  it('缓冲区已有同名登记(用户手敲)时不重复写入', async () => {
    const withEntity = DIRTY_XML.replace('  <!--', `  ${REGISTRATION}\n  <!--`);
    const doc = makeTextDocument(withEntity, { uri: Uri.file(entitiesXmlPath), version: 9 });
    stubWorkspace.textDocuments = [doc];

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.registerInEntitiesXml(entity);

    expect(workspaceState.applyEditCalls).toHaveLength(0);
    expect(doc.getText().match(/<Monster /g)).toHaveLength(1);
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });

  it('showWizard 注册进缓冲区后一步失败:缓冲撤销,盘不动', async () => {
    const dirtyDoc = makeTextDocument(DIRTY_XML, { uri: Uri.file(entitiesXmlPath), version: 7 });
    stubWorkspace.textDocuments = [dirtyDoc];
    const bufferBefore = dirtyDoc.getText();

    const windowish = stubWindow as unknown as Record<string, unknown>;
    const originalWindow: Record<string, unknown> = {};
    const windowKeys = ['showInputBox', 'showQuickPick', 'showInformationMessage', 'showErrorMessage', 'showWarningMessage'];
    for (const key of windowKeys) {
      originalWindow[key] = windowish[key];
    }
    windowish.showInputBox = async (): Promise<string | undefined> => 'Monster';
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = await items;
      return resolved[0];
    };
    windowish.showInformationMessage = async (message: string): Promise<unknown> =>
      message.includes('是否打开') ? '是' : undefined;
    windowish.showErrorMessage = async (): Promise<unknown> => undefined;
    windowish.showWarningMessage = async (): Promise<unknown> => undefined;

    // 注册成功后,打开生成的文件一步失败触发回滚
    stubWorkspace.openTextDocument = (async (): Promise<never> => {
      throw new Error('open failed');
    }) as unknown as typeof stubWorkspace.openTextDocument;

    try {
      const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
      await generator.showWizard();
    } finally {
      for (const key of windowKeys) {
        if (originalWindow[key] === undefined) {
          delete windowish[key];
        } else {
          windowish[key] = originalWindow[key];
        }
      }
    }

    // 缓冲被撤销回注册前,盘未动
    expect(dirtyDoc.getText()).toBe(bufferBefore);
    expect(fs.readFileSync(entitiesXmlPath, 'utf8')).toBe(DISK_XML);
  });
});
