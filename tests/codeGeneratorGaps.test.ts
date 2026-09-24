import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type { EntityDefinition } from '../src/codeGenerator';
import type * as vscode from 'vscode';
import { Uri, workspace as stubWorkspace, window as stubWindow } from './helpers/vscodeStub';

// codeGenerator 的剩余缺口:generateDefContent 的 CellMethods/ClientMethods
// 段渲染(exposed 只在 cell/base 侧)、generatePythonFile 的无工作区 throw
// 与深目录递归创建、showWizard 的 Cell/Client-only 示例属性分支、生成后
// 询问打开文件、generateFromTemplate 的生成失败 catch。

interface InputBoxOptions {
  validateInput?: (value: string) => string | null;
  value?: string;
}

interface UiScript {
  inputs: Array<string | undefined>;
  picks: Array<(items: unknown[]) => unknown>;
  info: string[];
  error: string[];
}

const ui: UiScript = { inputs: [], picks: [], info: [], error: [] };

const pickIndex = (index: number) => (items: unknown[]): unknown => items[index];
const pickNone = (): undefined => undefined;

let root: string;

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = ['showInputBox', 'showQuickPick', 'showInformationMessage', 'showErrorMessage'];

const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalShowTextDocument = stubWindow.showTextDocument;

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
    void options;
    return ui.inputs.shift();
  };
  windowish.showQuickPick = async (
    items: unknown[] | Promise<unknown[]>,
    _options?: unknown
  ): Promise<unknown> => {
    const resolved = await items;
    const select = ui.picks.shift();
    return select ? select(resolved) : undefined;
  };
  windowish.showInformationMessage = async (message: string): Promise<unknown> => {
    ui.info.push(message);
    return undefined;
  };
  windowish.showErrorMessage = async (message: string): Promise<unknown> => {
    ui.error.push(message);
    return undefined;
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    if (originalWindow[key] === undefined) {
      delete windowish[key];
    } else {
      windowish[key] = originalWindow[key];
    }
  }
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  stubWindow.showTextDocument = originalShowTextDocument;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-gap-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <BaseThing hasBase="true" />\n</root>\n',
    'utf8'
  );

  ui.inputs = [];
  ui.picks = [];
  ui.info = [];
  ui.error = [];

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
});

const makeGenerator = (): KBEngineCodeGenerator =>
  new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);

const internals = (generator: KBEngineCodeGenerator): {
  config: { defOutputPath: string; pythonOutputPath: string; generatePython: boolean; registerInEntitiesXml: boolean };
  generateDefContent: (entity: EntityDefinition) => string;
  generateFromTemplate: (entity: EntityDefinition) => Promise<void>;
} => generator as unknown as never;

describe('generateDefContent method sections', () => {
  it('renders CellMethods with Exposed and ClientMethods without it', () => {
    const generator = makeGenerator();
    const content = internals(generator).generateDefContent({
      config: { name: 'Fighter', hasBase: false, hasCell: true, hasClient: true },
      cellMethods: [
        { name: 'dash', exposed: true, args: [{ name: 'steps', type: 'UINT8' }] }
      ],
      clientMethods: [
        { name: 'playAnim', exposed: false, returnType: 'STRING' }
      ]
    });

    expect(content).toContain('  <CellMethods>');
    expect(content).toContain('    <dash>');
    expect(content).toContain('      <Exposed/>');
    expect(content).toContain('      <Arg>UINT8</Arg>');
    expect(content).toContain('    </dash>');
    expect(content).toContain('  </CellMethods>');

    expect(content).toContain('  <ClientMethods>');
    expect(content).toContain('    <playAnim>');
    expect(content).toContain('    </playAnim>');
    expect(content).not.toContain('    <playAnim>\n      <Exposed/>');
    expect(content).toContain('  </ClientMethods>');
  });
});

describe('generatePythonFile guards', () => {
  it('throws when no workspace folder is open', async () => {
    const generator = makeGenerator();
    stubWorkspace.workspaceFolders = [];

    await expect(
      generator.generatePythonFile({
        config: { name: 'Hero', hasBase: true, hasCell: false, hasClient: false }
      })
    ).rejects.toThrow('没有打开的工作区');
  });

  it('creates missing output directories recursively', async () => {
    const generator = makeGenerator();
    internals(generator).config.pythonOutputPath = 'gen/out/deep';

    const written = await generator.generatePythonFile({
      config: { name: 'Hero', hasBase: true, hasCell: false, hasClient: false }
    });

    expect(written).toBe(path.join(root, 'gen', 'out', 'deep', 'Hero.py'));
    const content = fs.readFileSync(written, 'utf8');
    expect(content).toContain('class Hero');
    // 内嵌生成时间戳,只断言存在性字段
    expect(content).toContain('生成时间');
  });
});

describe('showWizard sample property branches', () => {
  it('assigns cell properties and methods for a Cell-only entity', async () => {
    ui.inputs.push('CellEntity');
    ui.picks.push(pickIndex(1), pickNone, pickIndex(0));

    const generator = makeGenerator();
    await generator.showWizard();

    expect(ui.info[0]).toContain('已生成 .def 文件');
    const defFile = path.join(root, 'scripts', 'entity_defs', 'CellEntity.def');
    const content = fs.readFileSync(defFile, 'utf8');
    expect(content).toContain('CELL_PRIVATE');
    expect(content).toContain('  <CellMethods>');
    expect(content).toContain('    <getName>');
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')).toContain('<CellEntity');
  }, 8000);

  it('assigns client properties for a Client-only entity', async () => {
    ui.inputs.push('ClientEntity');
    ui.picks.push(pickIndex(2), pickNone, pickIndex(0));

    const generator = makeGenerator();
    await generator.showWizard();

    const content = fs.readFileSync(
      path.join(root, 'scripts', 'entity_defs', 'ClientEntity.def'),
      'utf8'
    );
    expect(content).toContain('OTHER_CLIENTS');
    // 实现现状:Client-only 分支只赋 clientProperties,不赋 clientMethods,
    // 故整个 ClientMethods 段缺席
    expect(content).not.toContain('ClientMethods');
  }, 8000);
});

describe('post-generation open prompt', () => {
  it('opens the generated def file when the user accepts', async () => {
    ui.inputs.push('OpenEntity');
    ui.picks.push(pickIndex(0), pickNone, pickIndex(0));

    const originalInfo = windowish.showInformationMessage;
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      ui.info.push(message);
      return message.includes('是否打开') ? '是' : undefined;
    };

    const opened: string[] = [];
    const shown: unknown[] = [];
    stubWorkspace.openTextDocument = (async (uri: Uri) => {
      opened.push(uri.fsPath);
      return { uri };
    }) as unknown as typeof stubWorkspace.openTextDocument;
    stubWindow.showTextDocument = (async (document: unknown) => {
      shown.push(document);
      return {};
    }) as unknown as typeof stubWindow.showTextDocument;

    try {
      const generator = makeGenerator();
      await generator.showWizard();
    } finally {
      windowish.showInformationMessage = originalInfo;
      stubWorkspace.openTextDocument = originalOpenTextDocument;
      stubWindow.showTextDocument = originalShowTextDocument;
    }

    expect(ui.info).toContain('是否打开生成的文件？');
    expect(opened).toHaveLength(1);
    expect(path.basename(opened[0])).toBe('OpenEntity.def');
    expect(shown).toHaveLength(1);
  }, 8000);
});

describe('generateFromTemplate failure path', () => {
  it('reports 生成失败 when the workspace is gone', async () => {
    const generator = makeGenerator();
    stubWorkspace.workspaceFolders = [];
    ui.inputs.push('TplEntity');

    await internals(generator).generateFromTemplate({
      config: { name: 'TplEntity', hasBase: true, hasCell: false, hasClient: false }
    });

    expect(ui.error).toHaveLength(1);
    expect(ui.error[0]).toContain('生成失败');
    expect(ui.error[0]).toContain('没有打开的工作区');
  });
});
