import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import type { EntityDefinition } from '../src/codeGenerator';
import type * as vscode from 'vscode';
import { Uri, workspace as stubWorkspace, window as stubWindow } from './helpers/vscodeStub';

// KBEngineCodeGenerator 的文件落盘与命令编排层:generateDefFile/
// generatePythonFile/registerInEntitiesXml 在真实临时工作区树上写真实
// 文件;showWizard/showTemplates 经可脚本化的窗口 stub(记录调用、按队列
// 回放选择)走完整生成流程。纯生成函数已由 codeGenerator.test.ts 覆盖。

interface InputBoxOptions {
  validateInput?: (value: string) => string | null;
  value?: string;
}

interface UiScript {
  inputs: Array<string | undefined>;
  inputOptions: InputBoxOptions[];
  picks: Array<(items: unknown[]) => unknown>;
  info: string[];
  warning: string[];
  error: string[];
}

const ui: UiScript = { inputs: [], inputOptions: [], picks: [], info: [], warning: [], error: [] };

const pickIndex = (index: number) => (items: unknown[]): unknown => items[index];
const pickNone = (): undefined => undefined;

let root: string;
let bareRoot: string;

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showQuickPick',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

const originalFindFiles = stubWorkspace.findFiles;

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
    if (options) {
      ui.inputOptions.push(options);
    }
    return ui.inputs.shift();
  };
  windowish.showQuickPick = async (
    items: unknown[] | Promise<unknown[]>,
    _options?: unknown
  ): Promise<unknown> => {
    // 真实 vscode 接受数组或 Promise(向导第 3 步传入异步实体列表)
    const resolved = await items;
    const select = ui.picks.shift();
    return select ? select(resolved) : undefined;
  };
  windowish.showInformationMessage = async (message: string): Promise<unknown> => {
    ui.info.push(message);
    return undefined;
  };
  windowish.showWarningMessage = async (message: string): Promise<unknown> => {
    ui.warning.push(message);
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
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bareRoot, { recursive: true, force: true });
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-'));
  bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-bare-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    ['<root>', '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />', '</root>', ''].join('\n'),
    'utf8'
  );
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entity_defs', 'Monster.def'),
    '<root><BaseMethods><roar/></BaseMethods></root>',
    'utf8'
  );

  ui.inputs = [];
  ui.inputOptions = [];
  ui.picks = [];
  ui.info = [];
  ui.warning = [];
  ui.error = [];

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => [
    Uri.file(path.join(root, 'scripts', 'entity_defs', 'Hero.def')),
    Uri.file(path.join(root, 'scripts', 'entity_defs', 'Monster.def'))
  ];
});

const makeGenerator = (): KBEngineCodeGenerator =>
  new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);

const internals = (generator: KBEngineCodeGenerator): {
  config: { defOutputPath: string; pythonOutputPath: string; generatePython: boolean; registerInEntitiesXml: boolean };
  generateDefContent: (entity: EntityDefinition) => string;
  generatePythonContent: (entity: EntityDefinition) => string;
  getExistingEntities: () => Promise<Array<{ label: string; description: string }>>;
} => generator as unknown as never;

const sampleEntity = (): EntityDefinition => ({
  config: {
    name: 'Hero',
    hasBase: true,
    hasCell: true,
    hasClient: false,
    description: '测试实体'
  },
  baseProperties: [
    { name: 'level', type: 'UINT32', flags: 'BASE', default: '1', persistent: true }
  ],
  baseMethods: [{ name: 'onKilled', exposed: false }]
});

describe('KBEngineCodeGenerator file outputs', () => {
  it('rejects def generation without a workspace', async () => {
    stubWorkspace.workspaceFolders = [];
    await expect(makeGenerator().generateDefFile(sampleEntity())).rejects.toThrow('没有打开的工作区');
  });

  it('writes the def file into the resolved definitions root', async () => {
    const generator = makeGenerator();
    const defPath = await generator.generateDefFile(sampleEntity());

    expect(defPath).toBe(path.join(root, 'scripts', 'entity_defs', 'Hero.def'));
    // 内容内嵌生成时间戳,归一化后做全量比对
    const normalize = (content: string): string => content.replace(/生成时间: .*/, '生成时间: <ts>');
    expect(normalize(fs.readFileSync(defPath, 'utf8'))).toBe(
      normalize(internals(generator).generateDefContent(sampleEntity()))
    );
  });

  it('writes the python file under the configured scripts root', async () => {
    const generator = makeGenerator();
    const pyPath = await generator.generatePythonFile(sampleEntity());

    expect(pyPath).toBe(path.join(root, 'scripts', 'Hero.py'));
    const normalize = (content: string): string => content.replace(/生成时间: .*/, '生成时间: <ts>');
    expect(normalize(fs.readFileSync(pyPath, 'utf8'))).toBe(
      normalize(internals(generator).generatePythonContent(sampleEntity()))
    );
  });

  it('inserts the registration line before </root>', async () => {
    const generator = makeGenerator();
    await generator.registerInEntitiesXml({
      name: 'Monster',
      hasBase: true,
      hasCell: false,
      hasClient: false
    });

    const content = fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8');
    expect(content).toBe(
      [
        '<root>',
        '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />',
        '  <Monster hasCell="false" hasBase="true" hasClient="false" />',
        '</root>',
        ''
      ].join('\n')
    );
    expect(ui.warning).toEqual([]);
  });

  it('warns and keeps the file unchanged on duplicate registration', async () => {
    const generator = makeGenerator();
    await generator.registerInEntitiesXml({
      name: 'BaseThing',
      hasBase: true,
      hasCell: false,
      hasClient: false
    });

    expect(ui.warning).toEqual(['实体 BaseThing 已经在 entities.xml 中注册']);
    expect(
      fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')
    ).not.toContain('BaseThing hasCell="false"');
  });

  it('rejects a malformed xml without a closing root tag', async () => {
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root>\n', 'utf8');
    await expect(
      makeGenerator().registerInEntitiesXml({ name: 'Ghost', hasBase: true, hasCell: false, hasClient: false })
    ).rejects.toThrow('entities.xml 格式错误：找不到 </root> 标签');
  });

  it('rejects when entities.xml is missing and reports the path', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file(bareRoot), name: 'bare', index: 0 }
    ];
    await expect(
      makeGenerator().registerInEntitiesXml({ name: 'Ghost', hasBase: true, hasCell: false, hasClient: false })
    ).rejects.toThrow(
      `entities.xml 不存在: ${path.join(bareRoot, 'scripts', 'entities.xml')}`
    );
  });

  it('rejects registration without a workspace', async () => {
    stubWorkspace.workspaceFolders = [];
    await expect(
      makeGenerator().registerInEntitiesXml({ name: 'Ghost', hasBase: true, hasCell: false, hasClient: false })
    ).rejects.toThrow('没有打开的工作区');
  });
});

describe('KBEngineCodeGenerator wizard', () => {
  it('aborts before creating anything when the name is cancelled', async () => {
    ui.inputs.push(undefined);

    await makeGenerator().showWizard();

    expect(ui.info).toEqual([]);
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'scripts', 'entity_defs'))).toEqual(['Monster.def']);
  });

  it('aborts when the entity type pick is cancelled', async () => {
    ui.inputs.push('Hero');
    ui.picks.push(pickNone);

    await makeGenerator().showWizard();

    expect(ui.info).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'scripts', 'entity_defs'))).toEqual(['Monster.def']);
  });

  it('validates the entity name pattern', async () => {
    ui.inputs.push('Hero', undefined);
    ui.picks.push(pickNone);

    await makeGenerator().showWizard();

    const validate = ui.inputOptions[0].validateInput;
    expect(validate?.('hero')).toContain('大写字母开头');
    expect(validate?.('1Hero')).toContain('大写字母开头');
    expect(validate?.('Hero')).toBeNull();
    expect(validate?.('')).toContain('大写字母开头');
  });

  it('runs the full base+cell flow and registers the entity', async () => {
    ui.inputs.push('Hero');
    ui.picks.push(pickIndex(3), pickIndex(1), pickIndex(0));

    await makeGenerator().showWizard();

    // 类型列表第 4 项 Base+Cell;父实体列表第 2 项 Monster;属性询问选“是”
    const defPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    const defContent = fs.readFileSync(defPath, 'utf8');
    expect(defContent).toContain('<Parent>');
    expect(defContent).toContain('<Monster/>');
    expect(defContent).toContain('<Properties>');
    expect(defContent).toContain('<id>');
    expect(defContent).toContain('<Type>UINT64</Type>');
    expect(defContent).toContain('<Flags>BASE</Flags>');
    expect(defContent).toContain('<name>');
    expect(defContent).toContain('<DatabaseLength>50</DatabaseLength>');
    expect(defContent).toContain('<BaseMethods>');
    expect(defContent).toContain('<getName>');
    expect(defContent).not.toContain('<Exposed/>');

    const pyContent = fs.readFileSync(path.join(root, 'scripts', 'Hero.py'), 'utf8');
    expect(pyContent).toContain('class HeroCell():');
    expect(pyContent).toContain('def onEnterWorld(self):');
    expect(pyContent).toContain('def getName(self):');

    const xmlContent = fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8');
    expect(xmlContent).toContain('  <Hero hasCell="true" hasBase="true" hasClient="false" />');

    expect(ui.info[0]).toContain('Hero.def');
    expect(ui.info[1]).toContain('Hero.py');
    expect(ui.info[2]).toContain('entities.xml 中注册 Hero');
    expect(ui.info[3]).toBe('是否打开生成的文件？');
    expect(ui.error).toEqual([]);
  });

  it('surfaces generation failures through the error channel', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file(bareRoot), name: 'bare', index: 0 }
    ];
    ui.inputs.push('Hero');
    ui.picks.push(pickIndex(0), pickNone, pickIndex(1));

    await makeGenerator().showWizard();

    expect(ui.error).toHaveLength(1);
    expect(ui.error[0]).toContain('生成失败');
    expect(ui.error[0]).toContain('entities.xml 不存在');
    // def 与 python 已生成并在 register 前各推一条成功消息
    expect(ui.info).toHaveLength(2);
    expect(ui.info[0]).toContain('Hero.def');
    expect(ui.info[1]).toContain('Hero.py');
  });
});

describe('KBEngineCodeGenerator templates', () => {
  it('aborts when the template pick is cancelled', async () => {
    ui.picks.push(pickNone);

    await makeGenerator().showTemplates();

    expect(ui.inputs).toEqual([]);
    expect(ui.info).toEqual([]);
  });

  it('aborts generateFromTemplate when the name is cancelled', async () => {
    ui.picks.push(pickIndex(4));
    ui.inputs.push(undefined);

    await makeGenerator().showTemplates();

    expect(ui.info).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'scripts', 'entity_defs'))).toEqual(['Monster.def']);
  });

  it('generates the account template under a new name', async () => {
    ui.picks.push(pickIndex(0));
    ui.inputs.push('MyAccount');

    await makeGenerator().showTemplates();

    const defContent = fs.readFileSync(
      path.join(root, 'scripts', 'entity_defs', 'MyAccount.def'),
      'utf8'
    );
    expect(defContent).toContain('<accountName>');
    expect(defContent).toContain('<DatabaseLength>64</DatabaseLength>');
    expect(defContent).toContain('<login>');
    expect(defContent).toContain('<Exposed/>');
    expect(defContent).toContain('<Arg>STRING</Arg>');

    const pyContent = fs.readFileSync(
      path.join(root, 'scripts', 'MyAccount.py'),
      'utf8'
    );
    expect(pyContent).toContain('class MyAccountBase():');
    expect(pyContent).not.toContain('onEnterWorld');

    expect(
      fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')
    ).toContain('  <MyAccount hasCell="false" hasBase="true" hasClient="true" />');
    expect(ui.info[2]).toContain('entities.xml 中注册 MyAccount');
    expect(ui.error).toEqual([]);
  });
});

describe('KBEngineCodeGenerator config and lookups', () => {
  it('falls back to defaults without a workspace folder', () => {
    stubWorkspace.workspaceFolders = [];
    const config = internals(makeGenerator()).config;
    expect(config).toEqual({
      defOutputPath: 'scripts/entity_defs',
      pythonOutputPath: 'scripts',
      generatePython: true,
      registerInEntitiesXml: true
    });
  });

  it('resolves the definitions root against the workspace on load', () => {
    const config = internals(makeGenerator()).config;
    expect(config.defOutputPath).toBe(path.join(root, 'scripts', 'entity_defs'));
    expect(config.pythonOutputPath).toBe('scripts');
  });

  it('lists existing entities from the def file set', async () => {
    const entities = await internals(makeGenerator()).getExistingEntities();
    expect(entities).toEqual([
      { label: 'Hero', description: path.join(root, 'scripts', 'entity_defs', 'Hero.def') },
      { label: 'Monster', description: path.join(root, 'scripts', 'entity_defs', 'Monster.def') }
    ]);
  });

  it('returns no entities without a workspace', async () => {
    stubWorkspace.workspaceFolders = [];
    expect(await internals(makeGenerator()).getExistingEntities()).toEqual([]);
  });

  it('disposes without side effects', () => {
    expect(() => makeGenerator().dispose()).not.toThrow();
  });
});
