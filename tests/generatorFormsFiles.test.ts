import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateGeneratorForm,
  runGeneratorFormWizard,
  type GeneratorFormInput
} from '../src/generatorForms';
import type { DefinitionWorkspaceLayout } from '../src/definitionWorkspace';
import type * as vscode from 'vscode';
import { messages, Uri, window as stubWindow, workspace as stubWorkspace, workspaceState } from './helpers/vscodeStub';

// 批139(盘点 G7)落盘与命令编排层:四形态在真实临时工作区树上写真实文件,
// 并按引擎装载口径改写 entities.xml / types.xml / 实体 def。纯内容层见
// tests/generatorForms.test.ts。

interface InputBoxOptions {
  prompt?: string;
  placeHolder?: string;
  validateInput?: (value: string) => string | null;
}

type PickScript = (items: unknown[]) => unknown;

interface UiScript {
  inputs: Array<string | undefined>;
  inputOptions: InputBoxOptions[];
  picks: PickScript[];
  infos: string[];
}

const ui: UiScript = { inputs: [], inputOptions: [], picks: [], infos: [] };

const pickLabel = (label: string): PickScript => (items: unknown[]) =>
  items.find(item => (item as { label: string }).label === label);

const pickIndex = (index: number): PickScript => (items: unknown[]) => items[index];

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showQuickPick',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

let root: string;

beforeEach(() => {
  for (const key of patchedKeys) {
    if (originalWindow[key] === undefined && windowish[key] !== undefined) {
      originalWindow[key] = windowish[key];
    }
  }

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-forms-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    ['<root>', '  <Avatar hasBase="true" hasCell="true" hasClient="true" />', '</root>', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entity_defs', 'Avatar.def'),
    ['<root>', '  <Properties>', '    <hp>', '      <Type>UINT32</Type>', '    </hp>', '  </Properties>', '</root>', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entity_defs', 'types.xml'),
    ['<root>', '  <ITEM_ID>UINT16</ITEM_ID>', '</root>', ''].join('\n'),
    'utf8'
  );

  ui.inputs = [];
  ui.inputOptions = [];
  ui.picks = [];
  ui.infos = [];

  windowish.showInputBox = async (options?: InputBoxOptions): Promise<string | undefined> => {
    if (options) {
      ui.inputOptions.push(options);
    }
    return ui.inputs.shift();
  };
  windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
    const resolved = await items;
    const script = ui.picks.shift();
    return script ? script(resolved) : undefined;
  };
  windowish.showInformationMessage = async (...args: unknown[]): Promise<unknown> => {
    const message = String(args[0]);
    // 真实 vscode 的 items 形态(是否打开生成的文件)按队列回放:取出该步的
    // 选择脚本并执行,测试未排脚本时按未选择处理
    const script = message === '是否打开生成的文件?' ? ui.picks.shift() : undefined;
    const reply = script ? script([]) : undefined;
    ui.infos.push(message);
    return typeof reply === 'string' ? reply : undefined;
  };
  windowish.showWarningMessage = async (message: string): Promise<undefined> => {
    messages.warning.push(message);
    return undefined;
  };
  windowish.showErrorMessage = async (message: string): Promise<undefined> => {
    messages.error.push(message);
    return undefined;
  };

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
});

afterAll(() => {
  for (const key of patchedKeys) {
    if (originalWindow[key] === undefined) {
      delete windowish[key];
    } else {
      windowish[key] = originalWindow[key];
    }
  }
});

const layout = (overrides: Partial<DefinitionWorkspaceLayout> = {}): DefinitionWorkspaceLayout => {
  const base: DefinitionWorkspaceLayout = {
    workspaceRoot: root,
    entityDefsRoot: path.join(root, 'scripts', 'entity_defs'),
    entityScriptsRoot: path.join(root, 'scripts'),
    interfacesRoot: path.join(root, 'scripts', 'entity_defs', 'interfaces'),
    componentsRoot: path.join(root, 'scripts', 'entity_defs', 'components'),
    entitiesXmlPath: path.join(root, 'scripts', 'entities.xml'),
    typesXmlPath: path.join(root, 'scripts', 'entity_defs', 'types.xml'),
    userTypeRoots: [path.join(root, 'scripts', 'user_type')]
  };
  return { ...base, ...overrides };
};

const proxyInput: GeneratorFormInput = {
  kind: 'proxy',
  value: { entityName: 'Avatar', methodSection: 'BaseMethods', methodNames: ['onTargetChanged'] }
};
const spaceInput: GeneratorFormInput = { kind: 'space', value: { name: 'MySpace' } };
const componentInput: GeneratorFormInput = {
  kind: 'component',
  value: { name: 'Inventory', properties: [{ name: 'value', type: 'UINT32', flags: 'CELL_PUBLIC' }] }
};
const fixedDictInput: GeneratorFormInput = {
  kind: 'fixedDict',
  value: { name: 'MY_DATA', properties: [{ name: 'value', type: 'UINT32' }], implementedBy: 'MY_DATA_DATA.inst' }
};

describe('generateGeneratorForm 落盘', () => {
  it('代理落 scripts/proxy_defs/<实体名>Proxy.def', () => {
    const outcome = generateGeneratorForm(proxyInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.filePath).toBe(path.join(root, 'scripts', 'proxy_defs', 'AvatarProxy.def'));
    expect(outcome.written).toBe(true);
    expect(outcome.notes).toEqual([]);
    expect(outcome.touchedFiles).toEqual([]);
    const content = fs.readFileSync(outcome.filePath as string, 'utf8');
    expect(content).toContain('<AvatarProxy/>');
    expect(content).toContain('<onTargetChanged>');
  });

  it('空间落 def 并在 entities.xml 登记 hasBase + hasCell', () => {
    const outcome = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.written).toBe(true);
    expect(outcome.touchedFiles).toEqual([path.join(root, 'scripts', 'entities.xml')]);
    expect(fs.readFileSync(outcome.filePath as string, 'utf8')).toContain('<Space/>');
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')).toBe(
      [
        '<root>',
        '  <Avatar hasBase="true" hasCell="true" hasClient="true" />',
        '  <MySpace hasBase="true" hasCell="true" />',
        '</root>',
        ''
      ].join('\n')
    );
  });

  it('组件落 entity_defs/components/<名>.def', () => {
    const outcome = generateGeneratorForm(componentInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.filePath).toBe(path.join(root, 'scripts', 'entity_defs', 'components', 'Inventory.def'));
    expect(fs.existsSync(outcome.filePath as string)).toBe(true);
    expect(outcome.touchedFiles).toEqual([]);
  });

  it('固定字典写入已有 types.xml 的 </root> 前', () => {
    const outcome = generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.filePath).toBe(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
    expect(outcome.touchedFiles).toEqual([path.join(root, 'scripts', 'entity_defs', 'types.xml')]);
    expect(fs.readFileSync(outcome.filePath as string, 'utf8')).toBe(
      [
        '<root>',
        '  <ITEM_ID>UINT16</ITEM_ID>',
        '  <MY_DATA>',
        '    FIXED_DICT',
        '    <Properties>',
        '      <value>',
        '        <Type>UINT32</Type>',
        '      </value>',
        '    </Properties>',
        '    <implementedBy>MY_DATA_DATA.inst</implementedBy>',
        '  </MY_DATA>',
        '',
        '</root>',
        ''
      ].join('\n')
    );
  });

  it('types.xml 不存在时新建最小根', () => {
    fs.rmSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
    const outcome = generateGeneratorForm(fixedDictInput, root, { generatedAt: '2026-10-16T00:00:00.000Z', layout: layout() });
    const content = fs.readFileSync(outcome.filePath as string, 'utf8');

    expect(content.startsWith('<root>')).toBe(true);
    expect(content).toContain('<!-- 生成时间: 2026-10-16T00:00:00.000Z -->');
    expect(content).toContain('<MY_DATA>');
    expect(content.trimEnd().endsWith('</root>')).toBe(true);
  });

  it('已存在且未覆盖时只记说明不改文件;overwrite=true 覆盖', () => {
    const target = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
    fs.writeFileSync(target, '<root/>', 'utf8');

    const skipped = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });
    expect(skipped.written).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('<root/>');
    expect(skipped.notes.some(note => note.includes('已存在,未覆盖'))).toBe(true);

    const overwritten = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', overwrite: true, layout: layout() });
    expect(overwritten.written).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('<Space/>');
  });

  it('目录定位不到时如实说明,不写盘', () => {
    const outcome = generateGeneratorForm(componentInput, root, {
      layout: layout({ componentsRoot: null })
    });

    expect(outcome.filePath).toBeNull();
    expect(outcome.written).toBe(false);
    expect(outcome.notes).toEqual(['未能定位组件的落盘目录,未生成']);
  });

  it('主产物冲突时整体不写:空间 def 已存在则不做 entities.xml 登记', () => {
    const target = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
    fs.writeFileSync(target, '<root/>', 'utf8');
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const entitiesBefore = fs.readFileSync(entitiesXml, 'utf8');

    const outcome = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });

    expect(outcome.written).toBe(false);
    expect(outcome.conflict).toBe(true);
    expect(outcome.touchedFiles).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('<root/>');
    // 不写半套:entities.xml 不因主产物冲突而顺带登记
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(entitiesBefore);
  });
});

describe('generateGeneratorForm 附带改写', () => {
  it('空间已登记时不重复写入', () => {
    const outcome = generateGeneratorForm(
      { kind: 'space', value: { name: 'Avatar' } },
      root,
      { generatedAt: 'TS', overwrite: true, layout: layout() }
    );

    expect(outcome.notes).toEqual(['Avatar 已在 entities.xml 中注册,未重复写入']);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8').match(/<Avatar /g)).toHaveLength(1);
  });

  it('entities.xml 缺失或结构异常时如实说明', () => {
    fs.rmSync(path.join(root, 'scripts', 'entities.xml'));
    const missing = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', layout: layout() });
    expect(missing.notes).toContain('未找到 entities.xml,空间 MySpace 未登记(引擎按登记装载,请手动补一行)');

    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root>\n', 'utf8');
    const malformed = generateGeneratorForm(spaceInput, root, { generatedAt: 'TS', overwrite: true, layout: layout() });
    expect(malformed.notes).toContain('entities.xml 找不到 </root> 标签,空间 MySpace 未登记');
  });

  it('entitiesXmlPath 为 null 时同样如实说明', () => {
    const outcome = generateGeneratorForm(spaceInput, root, {
      generatedAt: 'TS',
      layout: layout({ entitiesXmlPath: null })
    });

    expect(outcome.notes).toContain('未找到 entities.xml,空间 MySpace 未登记(引擎按登记装载,请手动补一行)');
  });

  it('types.xml 类型重名不写入,缺 </root> 亦不写入', () => {
    generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });
    const duplicated = generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });
    expect(duplicated.notes).toEqual(['types.xml 中已有同名类型 MY_DATA,未写入']);
    expect(duplicated.written).toBe(false);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8').match(/<MY_DATA>/g)).toHaveLength(1);

    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), '<root>\n', 'utf8');
    const malformed = generateGeneratorForm(fixedDictInput, root, { generatedAt: 'TS', layout: layout() });
    expect(malformed.notes).toEqual(['types.xml 找不到 </root> 标签,类型 MY_DATA 未写入']);
    expect(malformed.written).toBe(false);
  });

  it('实体 def 只有注释(无根元素)时挂载如实说明', () => {
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Comment.def'), '<!-- 只有注释 -->\n', 'utf8');
    const outcome = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: 'Comment'
    });

    expect(outcome.notes).toContain('Comment.def 里没有 <Properties> 段,组件未挂载(请手写 COMPONENT 属性)');
  });

  it('组件挂载:在实体 Properties 段末插 COMPONENT 属性', () => {
    const outcome = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: 'Avatar'
    });

    expect(outcome.touchedFiles).toEqual([path.join(root, 'scripts', 'entity_defs', 'Avatar.def')]);
    const content = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8');
    expect(content).toContain('    <Inventory>\n      <Type>COMPONENT</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </Inventory>');
    expect(content.indexOf('<Inventory>')).toBeGreaterThan(content.indexOf('<hp>'));
  });

  it('组件挂载不指定实体时不动任何已有文件', () => {
    const before = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8');
    const outcome = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: null
    });

    expect(outcome.touchedFiles).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8')).toBe(before);
  });

  it('组件挂载三类未做面各记一条说明', () => {
    const noDefsRoot = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout({ entityDefsRoot: null, componentsRoot: path.join(root, 'scripts', 'entity_defs', 'components') }),
      attachTo: 'Avatar'
    });
    expect(noDefsRoot.notes).toEqual(['未能定位实体定义目录,组件未挂载']);

    const missingEntity = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      overwrite: true,
      layout: layout(),
      attachTo: 'Ghost'
    });
    expect(missingEntity.notes).toContain('未找到实体 Ghost 的 .def,组件未挂载');

    fs.writeFileSync(
      path.join(root, 'scripts', 'entity_defs', 'Bare.def'),
      '<root><BaseMethods><roar/></BaseMethods></root>',
      'utf8'
    );
    const noProperties = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      overwrite: true,
      layout: layout(),
      attachTo: 'Bare'
    });
    expect(noProperties.notes).toContain('Bare.def 里没有 <Properties> 段,组件未挂载(请手写 COMPONENT 属性)');

    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Broken.def'), '<root><Properties></root>', 'utf8');
    const malformed = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      overwrite: true,
      layout: layout(),
      attachTo: 'Broken'
    });
    expect(malformed.notes).toContain('Broken.def 里没有 <Properties> 段,组件未挂载(请手写 COMPONENT 属性)');
  });

  it('组件属性同名时(大小写不敏感)不重复挂载', () => {
    const outcome = generateGeneratorForm(componentInput, root, {
      generatedAt: 'TS',
      layout: layout(),
      attachTo: 'Avatar'
    });
    expect(outcome.notes).toEqual([]);

    const second = generateGeneratorForm(
      { kind: 'component', value: { name: 'INVENTORY', properties: [] } },
      root,
      { generatedAt: 'TS', layout: layout(), attachTo: 'Avatar' }
    );
    expect(second.notes).toEqual(['Avatar.def 已有同名属性 INVENTORY,组件未挂载']);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8').match(/<Inventory>/g)).toHaveLength(1);
  });
});

describe('runGeneratorFormWizard', () => {
  it('代理流程:形态 → 实体名 → 方法名 → 方法段 → 落盘 → 播报', async () => {
    ui.picks = [pickLabel('代理实体 (proxy)'), pickLabel('BaseMethods'), pickLabel('确认生成')];
    ui.inputs = ['Avatar', 'onTargetChanged, syncState'];

    await runGeneratorFormWizard();

    expect(fs.existsSync(path.join(root, 'scripts', 'proxy_defs', 'AvatarProxy.def'))).toBe(true);
    const content = fs.readFileSync(path.join(root, 'scripts', 'proxy_defs', 'AvatarProxy.def'), 'utf8');
    expect(content).toContain('<onTargetChanged>');
    expect(content).toContain('<syncState>');
    expect(ui.infos.some(info => info.includes('已生成代理实体'))).toBe(true);
    expect(messages.warning).toEqual([]);
  });

  it('代理无方法名时不问方法段;取消方法段选择则中止', async () => {
    ui.picks = [pickLabel('代理实体 (proxy)'), pickLabel('确认生成')];
    ui.inputs = ['Avatar', ''];
    await runGeneratorFormWizard();
    expect(fs.readFileSync(path.join(root, 'scripts', 'proxy_defs', 'AvatarProxy.def'), 'utf8')).not.toContain('Methods>');

    ui.picks = [pickLabel('代理实体 (proxy)')];
    ui.inputs = ['Avatar', 'roar'];
    await runGeneratorFormWizard();
    expect(fs.readFileSync(path.join(root, 'scripts', 'proxy_defs', 'AvatarProxy.def'), 'utf8')).not.toContain('<roar>');
  });

  it('空间流程:名称 → 落盘 + 登记', async () => {
    ui.picks = [pickLabel('空间实体 (space)'), pickLabel('确认生成')];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'), 'utf8')).toContain('<Space/>');
    expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')).toContain(
      '<MySpace hasBase="true" hasCell="true" />'
    );
  });

  it('组件流程:名称 → 示例属性 → 挂载目标(实体列表来自 entities.xml)', async () => {
    ui.picks = [pickLabel('组件 (component)'), pickLabel('是'), pickLabel('Avatar'), pickLabel('确认生成')];
    ui.inputs = ['Inventory'];

    await runGeneratorFormWizard();

    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'components', 'Inventory.def'), 'utf8')).toContain(
      '<Flags>CELL_PUBLIC</Flags>'
    );
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8')).toContain('<Type>COMPONENT</Type>');
  });

  it('组件选「否」出空属性段,选「不挂载」不动实体', async () => {
    ui.picks = [pickLabel('组件 (component)'), pickLabel('否'), pickLabel('不挂载'), pickLabel('确认生成')];
    ui.inputs = ['Bare'];

    await runGeneratorFormWizard();

    const content = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'components', 'Bare.def'), 'utf8');
    expect(content).toContain('  <Properties>\n  </Properties>');
    expect(content).not.toContain('<onChanged>');
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8')).not.toContain('COMPONENT');
  });

  it('固定字典流程:名称 → 实现符号 → 示例字段', async () => {
    ui.picks = [pickLabel('固定字典类型 (fixedDict)'), pickLabel('是'), pickLabel('确认生成')];
    ui.inputs = ['MY_DATA', 'MY_DATA_DATA.my_data_inst'];

    await runGeneratorFormWizard();

    const content = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8');
    expect(content).toContain('<implementedBy>MY_DATA_DATA.my_data_inst</implementedBy>');
    expect(content).toContain('<MY_DATA>');
  });

  it('实现符号留空时不写 implementedBy;选「否」不出示例字段', async () => {
    ui.picks = [pickLabel('固定字典类型 (fixedDict)'), pickLabel('否'), pickLabel('确认生成')];
    ui.inputs = ['MY_DATA', '   '];

    await runGeneratorFormWizard();

    const content = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8');
    expect(content).not.toContain('implementedBy');
    expect(content).not.toContain('<value>');
  });

  it('输入校验:名称不合规与实现符号不合规各给一条提示', async () => {
    ui.picks = [pickLabel('代理实体 (proxy)'), pickLabel('CellMethods'), pickLabel('确认生成')];
    ui.inputs = ['Avatar', 'roar'];
    await runGeneratorFormWizard();

    const nameValidator = ui.inputOptions.find(options => options.prompt === '输入代理对应的实体名称');
    expect(nameValidator?.validateInput?.('1bad')).toContain('必须以大写字母开头');
    expect(nameValidator?.validateInput?.('Good')).toBeNull();

    ui.inputOptions = [];
    ui.picks = [pickLabel('固定字典类型 (fixedDict)'), pickLabel('否'), pickLabel('确认生成')];
    ui.inputs = ['MY_DATA', 'not-a-symbol'];
    await runGeneratorFormWizard();

    const symbolValidator = ui.inputOptions.find(options => options.prompt?.startsWith('实现符号'));
    expect(symbolValidator?.validateInput?.('MODULE.symbol')).toBeNull();
    expect(symbolValidator?.validateInput?.('MODULESYMBOL')).toContain('MODULE.symbol');
  });

  it('取消形态选择 / 取消名称 / 取消实现符号输入都直接中止', async () => {
    ui.picks = [() => undefined];
    await runGeneratorFormWizard();
    expect(fs.readdirSync(path.join(root, 'scripts'))).not.toContain('proxy_defs');

    ui.picks = [pickLabel('空间实体 (space)')];
    ui.inputs = [];
    await runGeneratorFormWizard();
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'))).toBe(false);

    ui.picks = [pickLabel('固定字典类型 (fixedDict)')];
    ui.inputs = ['MY_DATA'];
    await runGeneratorFormWizard();
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).not.toContain('MY_DATA');
  });

  it('代理/组件/固定字典三形态在名称输入处取消都中止', async () => {
    ui.picks = [pickLabel('代理实体 (proxy)')];
    ui.inputs = [];
    await runGeneratorFormWizard();
    expect(fs.existsSync(path.join(root, 'scripts', 'proxy_defs'))).toBe(false);

    ui.picks = [pickLabel('组件 (component)')];
    ui.inputs = [];
    await runGeneratorFormWizard();
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'components'))).toBe(false);

    ui.picks = [pickLabel('固定字典类型 (fixedDict)')];
    ui.inputs = [];
    await runGeneratorFormWizard();
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).not.toContain('MY_DATA');
  });

  it('组件在挂载目标处取消则中止(名称已问完)', async () => {
    ui.picks = [pickLabel('组件 (component)'), pickLabel('是')];
    ui.inputs = ['Inventory'];

    await runGeneratorFormWizard();

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'components', 'Inventory.def'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'), 'utf8')).not.toContain('COMPONENT');
  });

  it('打开生成的文件:应答「是」时开文档', async () => {
    workspaceState.openTextDocumentCalls.length = 0;
    ui.picks = [pickLabel('空间实体 (space)'), pickLabel('确认生成'), () => '是'];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(ui.infos).toContain('是否打开生成的文件?');
    expect(workspaceState.openTextDocumentCalls).toHaveLength(1);
  });

  it('未覆盖时只播报说明不询问打开', async () => {
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'), '<root/>', 'utf8');
    ui.picks = [pickLabel('空间实体 (space)')];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(messages.warning.some(warning => warning.includes('已存在,未覆盖'))).toBe(true);
    expect(ui.infos).not.toContain('是否打开生成的文件?');
  });

  it('无工作区时报错并返回', async () => {
    stubWorkspace.workspaceFolders = [];
    ui.picks = [pickLabel('空间实体 (space)')];

    await runGeneratorFormWizard();

    expect(messages.error).toEqual(['没有打开的工作区']);
    expect(ui.picks).toHaveLength(1);
  });

  it('落盘抛错时走错误通道', async () => {
    // 目标目录被同名文件占住 → 建目录/写文件抛错,命令应如实报错不静默
    fs.writeFileSync(path.join(root, 'scripts', 'proxy_defs'), 'occupied', 'utf8');
    ui.picks = [pickLabel('代理实体 (proxy)'), pickLabel('确认生成')];
    ui.inputs = ['Avatar', ''];

    await runGeneratorFormWizard();

    expect(messages.error.some(error => error.startsWith('生成失败:'))).toBe(true);
  });
});

describe('runGeneratorFormWizard 统一预览与冲突 (IDE-GEN-008)', () => {
  it('确认前列出计划项与准确路径(与实体向导同款确认面)', async () => {
    let previewItems: Array<{ label: string; description?: string }> = [];
    ui.picks = [
      pickLabel('空间实体 (space)'),
      items => {
        previewItems = items as Array<{ label: string; description?: string }>;
        return previewItems[0];
      }
    ];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(previewItems.map(item => item.label)).toEqual(['确认生成', '新增 .def', '注册 entities.xml']);
    expect(previewItems[1].description).toBe(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'));
    expect(previewItems[2].description).toContain(path.join(root, 'scripts', 'entities.xml'));
    expect(previewItems[2].description).toContain('<MySpace hasBase="true" hasCell="true" />');
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'))).toBe(true);
  });

  it('预览取消时不写任何文件', async () => {
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const entitiesBefore = fs.readFileSync(entitiesXml, 'utf8');
    ui.picks = [pickLabel('空间实体 (space)'), () => undefined];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'))).toBe(false);
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(entitiesBefore);
    expect(messages.error).toEqual([]);
    expect(ui.infos).not.toContain('是否打开生成的文件?');
  });

  it('主产物冲突时不进预览,直接播报冲突说明', async () => {
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'), '<root/>', 'utf8');
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const entitiesBefore = fs.readFileSync(entitiesXml, 'utf8');
    ui.picks = [pickLabel('空间实体 (space)')];
    ui.inputs = ['MySpace'];

    await runGeneratorFormWizard();

    expect(messages.warning.some(warning => warning.includes('已存在,未覆盖'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'MySpace.def'), 'utf8')).toBe('<root/>');
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(entitiesBefore);
  });

  it('固定字典冲突(同名类型)同样整体不写', async () => {
    fs.writeFileSync(
      path.join(root, 'scripts', 'entity_defs', 'types.xml'),
      ['<root>', '  <MY_DATA>UINT16</MY_DATA>', '</root>', ''].join('\n'),
      'utf8'
    );
    const typesBefore = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8');
    ui.picks = [pickLabel('固定字典类型 (fixedDict)')];
    ui.inputs = ['MY_DATA', ''];

    await runGeneratorFormWizard();

    expect(messages.warning).toContain('types.xml 中已有同名类型 MY_DATA,未写入');
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).toBe(typesBefore);
  });
});
