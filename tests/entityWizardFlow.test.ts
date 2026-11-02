import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import { Uri, workspace as stubWorkspace, window as stubWindow } from './helpers/vscodeStub';

// GEN-DEF-2 新建实体向导的命令编排层:runNewEntityWizard 经可脚本化窗口
// stub(记录调用、按队列回放选择)在真实临时工作区树上走完整 3 步流程。
// 纯内容构建面由 entityWizard.test.ts 覆盖;本文件锁落盘/登记/冲突/回滚。

interface UiScript {
  inputs: Array<string | undefined>;
  picks: Array<(items: unknown[]) => unknown>;
  info: string[];
  warning: string[];
  error: string[];
}

const ui: UiScript = { inputs: [], picks: [], info: [], warning: [], error: [] };

const pickIndex = (index: number) => (items: unknown[]): unknown => items[index];
const pickNone = (): undefined => undefined;

let root: string;

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'showInputBox',
  'showQuickPick',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage'
];

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (): Promise<string | undefined> => ui.inputs.shift();
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
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  stubWorkspace.workspaceFolders = [];
});

const ENTITIES_XML = ['<root>', '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />', '</root>', ''].join('\n');
const TYPES_XML = ['<root>', '\t<ITEM_ID> UINT16 </ITEM_ID>', '</root>', ''].join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-newentity-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), ENTITIES_XML, 'utf8');
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), TYPES_XML, 'utf8');

  ui.inputs = [];
  ui.picks = [];
  ui.info = [];
  ui.warning = [];
  ui.error = [];

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
});

const makeGenerator = (): KBEngineCodeGenerator =>
  new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);

/** 编排一次成功向导:名称 → 模板 → 形态 → 确认 */
const runWizard = async (
  name: string,
  templateIndex: number,
  formIndex: number,
  confirm = true
): Promise<void> => {
  ui.inputs = [name];
  ui.picks = [pickIndex(templateIndex), pickIndex(formIndex), confirm ? pickIndex(0) : pickIndex(1)];
  await makeGenerator().runNewEntityWizard();
};

// 模板选项:0=simple 1=fixedArray 2=fixedDict
// 形态选项:0=Base 1=Cell 2=Client 3=Base+Cell 4=Base+Client 5=Cell+Client 6=Base+Cell+Client

describe('GEN-DEF-2 新建实体向导:完整流程', () => {
  it('Base+Cell+Client + fixedArray:三段脚本+def+注册全落盘', async () => {
    await runWizard('Hero', 1, 6);

    const defPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
    expect(fs.existsSync(defPath)).toBe(true);
    expect(fs.readFileSync(defPath, 'utf8')).toContain('<skillIds>');
    expect(fs.readFileSync(defPath, 'utf8')).toContain('<of> UINT32 </of>');

    for (const part of ['base', 'cell', 'client']) {
      const partPath = path.join(root, 'scripts', part, 'Hero.py');
      expect(fs.existsSync(partPath), `${part} 段未落盘`).toBe(true);
      const content = fs.readFileSync(partPath, 'utf8');
      expect(content).toContain('class Hero(KBEngine.Entity):');
    }

    // 守卫只在 base 段(skillIds 为 BASE 域)
    expect(fs.readFileSync(path.join(root, 'scripts', 'base', 'Hero.py'), 'utf8')).toContain(
      'if self.skillIds is None:'
    );
    expect(fs.readFileSync(path.join(root, 'scripts', 'cell', 'Hero.py'), 'utf8')).not.toContain(
      'self.skillIds'
    );

    const entities = fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8');
    expect(entities).toContain('<Hero hasCell="true" hasBase="true" hasClient="true" />');

    // simple 模板不动 types.xml
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).toBe(TYPES_XML);
  });

  it('fixedDict:types.xml 登记 FIXED_DICT 命名类型', async () => {
    await runWizard('Hero', 2, 3);

    const types = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8');
    expect(types).toContain('<HeroState>');
    expect(types).toContain('FIXED_DICT');
    expect(types.indexOf('<HeroState>')).toBeGreaterThan(types.indexOf('<ITEM_ID>'));
    expect(types.indexOf('<HeroState>')).toBeLessThan(types.lastIndexOf('</root>'));

    const defContent = fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'), 'utf8');
    expect(defContent).toContain('<Type> HeroState </Type>');

    // fixedDict:守卫只在 cell 段(state 为 CELL_PUBLIC 域),base 段没有
    expect(fs.existsSync(path.join(root, 'scripts', 'cell', 'Hero.py'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'scripts', 'cell', 'Hero.py'), 'utf8')).toContain(
      'if self.state is None:'
    );
    expect(fs.readFileSync(path.join(root, 'scripts', 'base', 'Hero.py'), 'utf8')).not.toContain(
      'self.state'
    );
  });

  it('不含 Client 的形态不生成客户端 stub', async () => {
    await runWizard('Hero', 0, 3);

    expect(fs.existsSync(path.join(root, 'scripts', 'base', 'Hero.py'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'cell', 'Hero.py'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'client', 'Hero.py'))).toBe(false);

    const entities = fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8');
    expect(entities).toContain('<Hero hasCell="true" hasBase="true" hasClient="false" />');
  });
});

describe('GEN-DEF-2 新建实体向导:中断与冲突', () => {
  it('步骤 2 取消:零落盘', async () => {
    ui.inputs = ['Hero'];
    ui.picks = [pickNone()];
    await makeGenerator().runNewEntityWizard();

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
  });

  it('步骤 3 取消:零落盘', async () => {
    ui.inputs = ['Hero'];
    ui.picks = [pickIndex(0), pickNone()];
    await makeGenerator().runNewEntityWizard();

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
  });

  it('计划确认被否:零落盘', async () => {
    await runWizard('Hero', 0, 0, false);

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'scripts'))).not.toContain('base');
  });

  it('同名 def 已存在:预检拦截零落盘', async () => {
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'), '<root/>', 'utf8');
    await runWizard('Hero', 0, 0);

    expect(ui.error.some(msg => msg.includes('def 文件已存在'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'), 'utf8')).toBe('<root/>');
  });

  it('fixedDict 且 types.xml 缺失:预检拦截', async () => {
    fs.rmSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
    await runWizard('Hero', 2, 0);

    expect(ui.error.some(msg => msg.includes('types.xml 不存在'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
  });

  it('生成中途失败(注册面缺失):回滚已落盘文件', async () => {
    fs.rmSync(path.join(root, 'scripts', 'entities.xml'));
    await runWizard('Hero', 0, 0);

    // def 与 base 段已写又被回滚删除(IDE-GEN-006 不留半套)
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts', 'base', 'Hero.py'))).toBe(false);
    expect(ui.error.some(msg => msg.includes('生成失败'))).toBe(true);
  });

  it('fixedDict 注册面缺失:回滚含 types.xml 还原', async () => {
    fs.rmSync(path.join(root, 'scripts', 'entities.xml'));
    await runWizard('Hero', 2, 1);

    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).toBe(TYPES_XML);
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
  });
});

describe('GEN-DEF-2 新建实体向导:入口约束与模板覆盖', () => {
  it('右键非 entity_defs 目录:提示后中止零落盘', async () => {
    const elsewhere = path.join(root, 'assets');
    fs.mkdirSync(elsewhere, { recursive: true });
    ui.inputs = ['Hero'];
    ui.picks = [pickIndex(0), pickIndex(0), pickIndex(0)];
    await makeGenerator().runNewEntityWizard(elsewhere);

    expect(ui.info.some(msg => msg.includes('entity_defs'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
  });

  it('右键 entity_defs 目录:正常生成', async () => {
    ui.inputs = ['Hero'];
    ui.picks = [pickIndex(0), pickIndex(0), pickIndex(0)];
    await makeGenerator().runNewEntityWizard(path.join(root, 'scripts', 'entity_defs'));

    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'))).toBe(true);
  });

  it('项目模板(.kode/templates/)覆盖内置 def 骨架', async () => {
    const templatesDir = path.join(root, '.kode', 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, 'new-entity.def'), '{{Name}} CUSTOM DEF', 'utf8');
    fs.writeFileSync(path.join(templatesDir, 'new-entity.base.py'), 'BASE {{ClassName}}', 'utf8');

    await runWizard('Hero', 0, 0);

    expect(fs.readFileSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'), 'utf8')).toBe(
      'Hero CUSTOM DEF'
    );
    expect(fs.readFileSync(path.join(root, 'scripts', 'base', 'Hero.py'), 'utf8')).toBe('BASE Hero');
    // 未覆盖的段走内置
    expect(fs.existsSync(path.join(root, 'scripts', 'client', 'Hero.py'))).toBe(false);
  });
});
