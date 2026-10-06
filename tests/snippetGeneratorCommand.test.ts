import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { workspace, workspaceState } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// 批94「代码片段生成器(自定义代码片段)」命令装配层:选区 → 三步输入 →
// 合并写入 .vscode/kbengine-custom.code-snippets。覆盖合并保留、同名覆盖
// 警告、取消/无选区/无工作区/坏 JSON 各分支;纯转义/合并逻辑由
// tests/snippetGenerator.test.ts 覆盖。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const windowish = stubWindow as unknown as Record<string, unknown>;

let root = '';

interface InputBoxOptions {
  validateInput?: (value: string) => string | null;
}

const scriptInputBox = (answers: Array<string | undefined>): Array<InputBoxOptions | undefined> => {
  const recorded: Array<InputBoxOptions | undefined> = [];
  windowish.showInputBox = async (options?: InputBoxOptions) => {
    recorded.push(options);
    return answers.shift();
  };
  return recorded;
};

const makeEditor = (
  docText: string,
  start: { line: number; character: number },
  end: { line: number; character: number }
): unknown => ({
  document: makeTextDocument(docText, { fileName: path.join(root, 'Avatar.def') }),
  selection: { isEmpty: false, start, end }
});

const activateAndWait = async (): Promise<ExtensionContext> => {
  const context = makeContext();
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 300));
  return context;
};

const snippetsFilePath = (): string => path.join(root, '.vscode', 'kbengine-custom.code-snippets');

const HP_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

describe('kbengine.snippets.generateFromSelection 命令', () => {
  let originalInputBox: unknown;
  let originalInformationMessage: unknown;

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snippet-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalInputBox = windowish.showInputBox;
    originalInformationMessage = windowish.showInformationMessage;
  });

  afterEach(() => {
    windowish.showInputBox = originalInputBox;
    windowish.showInformationMessage = originalInformationMessage;
    delete windowish.activeTextEditor;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('选区经转义/去缩进后合并写入片段文件,信息含名称/前缀/路径', async () => {
    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    const inputOptions = scriptInputBox(['HpBlock', 'kbe-hp', '血量块']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    // 名称/前缀两步的必填校验回调:空串与纯空白拒绝,合法值放行
    expect(inputOptions[0]?.validateInput?.('')).toBe('片段名称不能为空');
    expect(inputOptions[0]?.validateInput?.('   ')).toBe('片段名称不能为空');
    expect(inputOptions[0]?.validateInput?.('HpBlock')).toBeNull();
    expect(inputOptions[1]?.validateInput?.('')).toBe('触发前缀不能为空');
    expect(inputOptions[1]?.validateInput?.('kbe-hp')).toBeNull();

    const parsed = JSON.parse(fs.readFileSync(snippetsFilePath(), 'utf8')) as {
      HpBlock: { scope: string; prefix: string; body: string[]; description: string };
    };
    expect(parsed.HpBlock).toEqual({
      scope: 'kbengine-def',
      prefix: 'kbe-hp',
      body: ['<hp>', '  <Type>UINT32</Type>', '  <Flags>BASE</Flags>', '</hp>'],
      description: '血量块'
    });
    expect(messages.info.at(-1)).toContain('HpBlock');
    expect(messages.info.at(-1)).toContain('kbe-hp');
    expect(messages.info.at(-1)).toContain(snippetsFilePath());
    expect(messages.warning).toEqual([]);
    expect(messages.error).toEqual([]);

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('片段体对 $ 与 \\ 逐行转义', async () => {
    windowish.activeTextEditor = makeEditor('$root = 1\n\\slash', { line: 0, character: 0 }, { line: 1, character: 6 });
    scriptInputBox(['Esc', 'kbe-esc', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    const parsed = JSON.parse(fs.readFileSync(snippetsFilePath(), 'utf8')) as {
      Esc: { body: string[] };
    };
    expect(parsed.Esc.body).toEqual(['\\$root = 1', '\\\\slash']);

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('再次生成合并保留旧条目,同名条目覆盖并警告', async () => {
    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    scriptInputBox(['HpBlock', 'kbe-hp', '血量块']);
    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    windowish.activeTextEditor = makeEditor('OtherEntity', { line: 0, character: 0 }, { line: 0, character: 11 });
    scriptInputBox(['Other', 'kbe-other', '另一条']);
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    let parsed = JSON.parse(fs.readFileSync(snippetsFilePath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['HpBlock', 'Other']);
    expect(messages.warning).toEqual([]);

    scriptInputBox(['Other', 'kbe-other2', '覆盖版']);
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    parsed = JSON.parse(fs.readFileSync(snippetsFilePath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['HpBlock', 'Other']);
    expect((parsed.Other as { prefix: string }).prefix).toBe('kbe-other2');
    expect(messages.warning.at(-1)).toContain('已覆盖同名自定义片段 Other');

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('描述提示取消时按空描述继续(不写 description 字段)', async () => {
    windowish.activeTextEditor = makeEditor('Plain', { line: 0, character: 0 }, { line: 0, character: 5 });
    scriptInputBox(['NoDesc', 'kbe-nodesc', undefined]);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    const parsed = JSON.parse(fs.readFileSync(snippetsFilePath(), 'utf8')) as {
      NoDesc: Record<string, unknown>;
    };
    expect(parsed.NoDesc).toEqual({ scope: 'kbengine-def', prefix: 'kbe-nodesc', body: ['Plain'] });
    expect(messages.info.at(-1)).toContain('NoDesc');

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('无活动编辑器或空选区给出提示且不落盘', async () => {
    const context = await activateAndWait();

    await commands.executeCommand('kbengine.snippets.generateFromSelection');
    expect(messages.info.at(-1)).toBe('请先在编辑器中选中要生成片段的文本');

    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 0, character: 0 }, { line: 0, character: 0 });
    await commands.executeCommand('kbengine.snippets.generateFromSelection');
    expect(messages.info.at(-1)).toBe('请先在编辑器中选中要生成片段的文本');
    expect(windowish.showInputBox).toBe(originalInputBox);

    expect(fs.existsSync(snippetsFilePath())).toBe(false);
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('纯空白选区提示不含有效文本且不落盘', async () => {
    windowish.activeTextEditor = makeEditor('a\n   \n  \nb', { line: 1, character: 0 }, { line: 2, character: 2 });
    scriptInputBox(['Blank', 'kbe-blank', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    expect(messages.info.at(-1)).toBe('选区不含有效文本,未生成片段');
    expect(fs.existsSync(snippetsFilePath())).toBe(false);
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('名称或前缀取消则中止且不落盘', async () => {
    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    const context = await activateAndWait();

    scriptInputBox([undefined]);
    await commands.executeCommand('kbengine.snippets.generateFromSelection');
    expect(fs.existsSync(snippetsFilePath())).toBe(false);

    scriptInputBox(['OnlyName', undefined]);
    await commands.executeCommand('kbengine.snippets.generateFromSelection');
    expect(fs.existsSync(snippetsFilePath())).toBe(false);
    expect(messages.info).toEqual([]);

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('无工作区时报错不落盘', async () => {
    workspace.workspaceFolders = [];
    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    scriptInputBox(['Ws', 'kbe-ws', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    expect(messages.error.at(-1)).toBe('没有打开的工作区,无法保存自定义片段');
    expect(fs.existsSync(snippetsFilePath())).toBe(false);
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('既有片段文件为坏 JSON(手改注释)时报错且不改写', async () => {
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    const handEdited = '{ // 用户手改注释\n  "Kept": { "prefix": "kept", "body": ["x"] }\n}';
    fs.writeFileSync(snippetsFilePath(), handEdited, 'utf8');

    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    scriptInputBox(['Fresh', 'kbe-fresh', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    expect(messages.error.at(-1)).toContain('不是合法的对象 JSON');
    expect(messages.error.at(-1)).toContain(snippetsFilePath());
    expect(fs.readFileSync(snippetsFilePath(), 'utf8')).toBe(handEdited);
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('片段文件读取失败(路径被目录占位)时报错且不改写', async () => {
    // 路径存在但不是普通文件:readFileSync 抛 EISDIR,IO 失败必须落到
    // 错误通道并带片段文件路径,不能裸抛给宿主
    fs.mkdirSync(snippetsFilePath(), { recursive: true });

    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    scriptInputBox(['Fresh', 'kbe-fresh', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    expect(messages.error.at(-1)).toContain('无法读取自定义片段文件');
    expect(messages.error.at(-1)).toContain(snippetsFilePath());
    expect(messages.info).toEqual([]);
    expect(fs.statSync(snippetsFilePath()).isDirectory()).toBe(true);
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('片段目录创建失败(.vscode 被文件占位)时报错', async () => {
    // .vscode 是普通文件时 mkdirSync 必抛(ENOTDIR/EEXIST 一类),写入段
    // 的 IO 失败同样要带路径落到错误通道
    fs.writeFileSync(path.join(root, '.vscode'), '不是目录', 'utf8');

    windowish.activeTextEditor = makeEditor(HP_DEF, { line: 2, character: 0 }, { line: 5, character: 9 });
    scriptInputBox(['Fresh', 'kbe-fresh', '']);

    const context = await activateAndWait();
    await commands.executeCommand('kbengine.snippets.generateFromSelection');

    expect(messages.error.at(-1)).toContain('无法写入自定义片段文件');
    expect(messages.error.at(-1)).toContain(snippetsFilePath());
    expect(messages.info).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.vscode'), 'utf8')).toBe('不是目录');
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });
});
