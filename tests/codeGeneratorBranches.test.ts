import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type { EntityDefinition } from '../src/codeGenerator';
import type * as vscode from 'vscode';
import { Uri, workspace as stubWorkspace, window as stubWindow } from './helpers/vscodeStub';

// codeGenerator 批67 分支补测:generateDefFile 的相对 defOutputPath 归并臂
// (joinWorkspacePath 对照工作区拼接)、showWizard 与 generateFromTemplate
// 的 generatePython/registerInEntitiesXml 关断臂,以及裸工作区(无
// entity_defs 目录)下 findEntityDefinitionsRoot 返回"首选候选拼接路径"
// 的行为锁定(该返回值恒非空,`|| configuredPath` 兜底臂契约性不可达,
// 已以区间 ignore 定案,理由见源码注记与 TESTING.md 批67 段)。

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

let root = '';
let bareRoot = '';

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = ['showInputBox', 'showQuickPick', 'showInformationMessage', 'showErrorMessage'];

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
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bareRoot, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-branch-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <BaseThing hasBase="true" />\n</root>\n',
    'utf8'
  );
  // 裸工作区:无 scripts 目录,用于解析器首选候选行为锁定
  bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-bare-branch-'));

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
} => generator as unknown as never;

const sampleEntity = (): EntityDefinition => ({
  config: {
    name: 'Hero',
    hasBase: true,
    hasCell: false,
    hasClient: false,
    description: '测试实体'
  },
  baseProperties: [
    { name: 'level', type: 'UINT32', flags: 'BASE', default: '1', persistent: true }
  ],
  baseMethods: [{ name: 'onKilled', exposed: false }]
});

describe('resolveDefOutputPath against a bare workspace', () => {
  it('keeps the configured candidate join even when no defs directory exists', () => {
    // 裸工作区:entityDefsRoot 恒为首选候选的拼接路径(非空字符串),
    // 不依赖目录真实存在
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(bareRoot), name: 'bare', index: 0 }];
    expect(internals(makeGenerator()).config.defOutputPath)
      .toBe(path.join(bareRoot, 'scripts', 'entity_defs'));
  });
});

describe('generateDefFile with a relative defOutputPath', () => {
  it('joins the relative output root against the workspace folder', async () => {
    const generator = makeGenerator();
    internals(generator).config.defOutputPath = 'custom/defs';

    const defPath = await generator.generateDefFile(sampleEntity());

    expect(defPath).toBe(path.join(root, 'custom', 'defs', 'Hero.def'));
    expect(fs.readFileSync(defPath, 'utf8')).toContain('<Flags>BASE</Flags>');
  });
});

describe('wizard with python and registration disabled', () => {
  it('writes only the def file and leaves entities.xml untouched', async () => {
    const generator = makeGenerator();
    internals(generator).config.generatePython = false;
    internals(generator).config.registerInEntitiesXml = false;

    ui.inputs.push('Solo');
    ui.picks.push(pickIndex(0), pickNone, pickIndex(1));

    await generator.showWizard();

    const defContent = fs.readFileSync(
      path.join(root, 'scripts', 'entity_defs', 'Solo.def'),
      'utf8'
    );
    expect(defContent).toContain('实体: Solo');

    // 两个关断臂:不生成 .py、不写 entities.xml
    expect(fs.existsSync(path.join(root, 'scripts', 'Solo.py'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8'))
      .not.toContain('<Solo');
    expect(ui.info).toHaveLength(2);
    expect(ui.info[0]).toContain('已生成 .def 文件');
    expect(ui.info[1]).toBe('是否打开生成的文件？');
    expect(ui.error).toEqual([]);
  });
});

describe('template flow with python and registration disabled', () => {
  it('writes only the def file and stops without extra prompts', async () => {
    const generator = makeGenerator();
    internals(generator).config.generatePython = false;
    internals(generator).config.registerInEntitiesXml = false;

    ui.picks.push(pickIndex(0));
    ui.inputs.push('SoloAcct');

    await generator.showTemplates();

    const defContent = fs.readFileSync(
      path.join(root, 'scripts', 'entity_defs', 'SoloAcct.def'),
      'utf8'
    );
    expect(defContent).toContain('<accountName>');

    expect(fs.existsSync(path.join(root, 'scripts', 'SoloAcct.py'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8'))
      .not.toContain('<SoloAcct');
    expect(ui.info).toEqual([expect.stringContaining('已生成 .def 文件')]);
    expect(ui.error).toEqual([]);
  });
});
