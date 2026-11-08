// codeGenerator 依赖臂补测(覆盖率 98% 批次):无工作区/已存在冲突抛错臂、
// types.xml 直写臂(缺失/坏格式/同名幂等/profile 资产根落点)、文档源写入
// (缓冲 applyEdit + 账本 bufferEdits + 写入未生效警示)、向导校验/取消/段
// 冲突/打开文件追问臂、以及「fixedDict 缓冲写入后注册失败 → 回滚按缓冲
// 撤销插入」的 AUD-030 事务面。与 entityWizardFlow 同一窗口队列手法。

import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  KBEngineCodeGenerator,
  createGenerationRollbackLedger
} from '../src/codeGenerator';
import { setActiveProfile } from '../src/activeProfile';
import { fixedDictTypeName } from '../src/entityWizard';
import { ProjectProfileStore } from '../src/projectProfiles';
import {
  makeTextDocument,
  Uri,
  window as stubWindow,
  workspace as stubWorkspace,
  workspaceState,
  WorkspaceEdit
} from './helpers/vscodeStub';

interface UiScript {
  inputs: Array<string | undefined>;
  picks: Array<(items: unknown[]) => unknown>;
  info: Array<{ message: string; reply?: string }>;
  warning: string[];
  error: string[];
}

const ui: UiScript = { inputs: [], picks: [], info: [], warning: [], error: [] };

const pickIndex = (index: number) => (items: unknown[]): unknown => items[index];
const pickNone = (): undefined => undefined;

let root = '';

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
    items: unknown[] | Promise<unknown[]>
  ): Promise<unknown> => {
    const resolved = await items;
    const select = ui.picks.shift();
    return select ? select(resolved) : undefined;
  };
  windowish.showInformationMessage = async (...args: unknown[]): Promise<unknown> => {
    const message = String(args[0]);
    ui.info.push({ message, reply: typeof args[1] === 'string' ? args[1] : undefined });
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
});

afterEach(() => {
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
  workspaceState.applyEditCalls.length = 0;
  ui.inputs = [];
  ui.picks = [];
  ui.info = [];
  ui.warning = [];
  ui.error = [];
});

const ENTITIES_XML = '<root>\n  <BaseThing hasBase="true" hasCell="false" hasClient="false" />\n</root>\n';
const TYPES_XML = '<root>\n\t<ITEM_ID> UINT16 </ITEM_ID>\n</root>\n';

const makeRoot = (options: { entitiesXml?: string } = {}): string => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-arms-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), options.entitiesXml ?? ENTITIES_XML, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), TYPES_XML, 'utf8');
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  return root;
};

const makeGenerator = (context: unknown = {}): KBEngineCodeGenerator =>
  new KBEngineCodeGenerator(context as vscode.ExtensionContext);

const fixedDictInput = {
  name: 'Hx',
  hasBase: true,
  hasCell: false,
  hasClient: false,
  generateClientStub: true,
  propertyTemplate: 'fixedDict' as const,
  description: '测试'
};

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

describe('codeGenerator 依赖臂(覆盖补测)', () => {
  it('无工作区:向导/段文件/types.xml 三入口如实拒绝', async () => {
    stubWorkspace.workspaceFolders = [];
    await makeGenerator().runNewEntityWizard();
    expect(ui.error).toContain('没有打开的工作区');
    const generator = makeGenerator();
    await expect(generator.generateEntityPartFile('X', 'base', 'x')).rejects.toThrow('没有打开的工作区');
    await expect(
      generator.appendFixedDictTypeToTypesXml(fixedDictInput, createGenerationRollbackLedger())
    ).rejects.toThrow('没有打开的工作区');
  });

  it('generateEntityPartFile:成功落盘;同名已存在 → 抛错保留原代码', async () => {
    const wsRoot = makeRoot();
    const generator = makeGenerator();
    const written = await generator.generateEntityPartFile('Newbie', 'base', 'class Newbie:\n    pass\n');
    expect(fs.readFileSync(written, 'utf8')).toContain('class Newbie');
    expect(path.dirname(written)).toBe(path.join(wsRoot, 'scripts', 'base'));
    await expect(generator.generateEntityPartFile('Newbie', 'base', 'other')).rejects.toThrow('Python 文件已存在');
    expect(fs.readFileSync(written, 'utf8')).toContain('class Newbie');
  });

  it('appendFixedDictTypeToTypesXml:types.xml 缺失/无 </root>/同名类型幂等', async () => {
    const wsRoot = makeRoot();
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    const generator = makeGenerator();
    // 缺失
    fs.rmSync(typesXmlPath);
    await expect(
      generator.appendFixedDictTypeToTypesXml(fixedDictInput, createGenerationRollbackLedger())
    ).rejects.toThrow('types.xml 不存在');
    // 无 </root>
    fs.writeFileSync(typesXmlPath, '<root>\n', 'utf8');
    await expect(
      generator.appendFixedDictTypeToTypesXml(fixedDictInput, createGenerationRollbackLedger())
    ).rejects.toThrow('找不到 </root>');
    // 同名类型已登记:幂等零改写
    const withType = TYPES_XML.replace('</root>', `\t<${fixedDictTypeName('Hx')}>\n</root>\n`);
    fs.writeFileSync(typesXmlPath, withType, 'utf8');
    await generator.appendFixedDictTypeToTypesXml(fixedDictInput, createGenerationRollbackLedger());
    expect(fs.readFileSync(typesXmlPath, 'utf8')).toBe(withType);
    expect(ui.warning).toHaveLength(0);
  });

  it('profile 资产根:types.xml 落点跟活动 profile 资产根走', async () => {
    const wsRoot = makeRoot();
    const profileAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gen-profile-'));
    try {
      fs.mkdirSync(path.join(profileAssets, 'scripts', 'entity_defs'), { recursive: true });
      fs.writeFileSync(path.join(profileAssets, 'scripts', 'entity_defs', 'types.xml'), TYPES_XML, 'utf8');
      const memento = new Map<string, unknown>();
      const mementoShim = {
        get: <T>(key: string, fallback?: T): T | undefined =>
          memento.has(key) ? (memento.get(key) as T | undefined) : fallback,
        update: async (key: string, value: unknown): Promise<void> => {
          memento.set(key, value);
        }
      };
      const profile = await new ProjectProfileStore(mementoShim as unknown as vscode.Memento).create({
        displayName: 'p1',
        assetsRoot: profileAssets,
        engineRoot: path.join(root, 'eng')
      });
      memento.set('kbengine.activeProfileId.v1', profile.id);
      const generator = makeGenerator({ workspaceState: mementoShim });
      await generator.appendFixedDictTypeToTypesXml(fixedDictInput, createGenerationRollbackLedger());
      const profileTypes = fs.readFileSync(
        path.join(profileAssets, 'scripts', 'entity_defs', 'types.xml'),
        'utf8'
      );
      expect(profileTypes).toContain(`<${fixedDictTypeName('Hx')}>`);
      // 工作区自身的 types.xml 未被改写
      expect(fs.readFileSync(path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml'), 'utf8')).toBe(TYPES_XML);
    } finally {
      fs.rmSync(profileAssets, { recursive: true, force: true });
    }
  });

  it('文档源 types.xml:缓冲 applyEdit 插入 + 账本 bufferEdits 入账', async () => {
    const wsRoot = makeRoot();
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    const doc = makeTextDocument(TYPES_XML, { uri: Uri.file(typesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    const ledger = createGenerationRollbackLedger();
    await makeGenerator().appendFixedDictTypeToTypesXml(fixedDictInput, ledger);
    const typeName = fixedDictTypeName('Hx');
    expect(doc.getText()).toContain(`<${typeName}>`);
    expect(ledger.bufferEdits).toHaveLength(1);
    expect(ledger.bufferEdits[0].filePath).toBe(typesXmlPath);
    expect(workspaceState.applyEditCalls).toHaveLength(1);
    expect(ui.warning).toHaveLength(0);
    // 幂等回看:缓冲已含类型,再次登记零改写
    const ledger2 = createGenerationRollbackLedger();
    await makeGenerator().appendFixedDictTypeToTypesXml(fixedDictInput, ledger2);
    expect(ledger2.bufferEdits).toHaveLength(0);
  });

  it('文档源 applyEdit 未生效:如实警示且不入账', async () => {
    const wsRoot = makeRoot();
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    const doc = makeTextDocument(TYPES_XML, { uri: Uri.file(typesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    const realApplyEdit = stubWorkspace.applyEdit;
    stubWorkspace.applyEdit = (async (): Promise<boolean> => false) as typeof stubWorkspace.applyEdit;
    try {
      const ledger = createGenerationRollbackLedger();
      await makeGenerator().appendFixedDictTypeToTypesXml(fixedDictInput, ledger);
      expect(ui.warning.join('')).toContain('缓冲区写入未生效');
      expect(ledger.bufferEdits).toHaveLength(0);
    } finally {
      stubWorkspace.applyEdit = realApplyEdit;
    }
  });

  it('fixedDict 缓冲写入后注册失败:回滚按缓冲撤销插入并删除新文件', async () => {
    const wsRoot = makeRoot({ entitiesXml: '<root><BaseThing /></root' });
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    const doc = makeTextDocument(TYPES_XML, { uri: Uri.file(typesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    await runWizard('Rollback', 2, 0, true);
    expect(ui.error.join('')).toContain('生成失败');
    // 缓冲插入被撤销:types.xml 文档不再含 FIXED_DICT 块
    expect(doc.getText()).not.toContain(fixedDictTypeName('Rollback'));
    // 新增 def/py 文件被回收
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Rollback.def'))).toBe(false);
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'base', 'Rollback.py'))).toBe(false);
  });

  it('向导校验臂:非法名报文案、合法名通过;名称取消零落盘', async () => {
    makeRoot();
    let capturedValidate: ((value: string) => string | null) | undefined;
    const queueInput = windowish.showInputBox as (options?: unknown) => Promise<string | undefined>;
    windowish.showInputBox = async (options?: { validateInput?: (v: string) => string | null }) => {
      capturedValidate = options?.validateInput;
      return undefined;
    };
    try {
      await makeGenerator().runNewEntityWizard();
    } finally {
      windowish.showInputBox = queueInput;
    }
    expect(capturedValidate).toBeDefined();
    expect(capturedValidate!('lowercase')).toBe('实体名称必须以大写字母开头，只能包含字母、数字和下划线');
    expect(capturedValidate!('Good_Name1')).toBeNull();
    // 名称取消:零落盘
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Good_Name1.def'))).toBe(false);
  });

  it('向导段冲突:同名实体二次生成 → def 与段脚本逐项如实报错', async () => {
    const wsRoot = makeRoot();
    await runWizard('Dup', 0, 0, true);
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Dup.def'))).toBe(true);
    ui.error = [];
    ui.info = [];
    await runWizard('Dup', 0, 0, true);
    const joined = ui.error.join('\n');
    expect(joined).toContain('def 文件已存在');
    expect(joined).toContain('base 段脚本已存在');
    expect(ui.info.join('')).not.toContain('已生成实体');
  });

  it('打开文件追问:选「是」打开生成 def;打开失败如实报错不回滚', async () => {
    const wsRoot = makeRoot();
    // 选「是」:info 首参追问返回「是」
    windowish.showInformationMessage = async (...args: unknown[]): Promise<unknown> =>
      args.includes('是') ? '是' : undefined;
    try {
      await runWizard('Opened', 0, 0, true);
      expect(ui.error).toHaveLength(0);
      expect(workspaceState.openTextDocumentCalls.length).toBeGreaterThan(0);
      // 打开失败:报错,但已提交产物不回滚
      const realOpen = stubWorkspace.openTextDocument;
      stubWorkspace.openTextDocument = (async (): Promise<never> => {
        throw new Error('boom');
      }) as typeof stubWorkspace.openTextDocument;
      try {
        ui.error = [];
        await runWizard('Opened2', 0, 0, true);
        expect(ui.error.join('')).toContain('打开生成文件失败');
        expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Opened2.def'))).toBe(true);
      } finally {
        stubWorkspace.openTextDocument = realOpen;
      }
    } finally {
      windowish.showInformationMessage = async (...args: unknown[]): Promise<unknown> => {
        const message = String(args[0]);
        ui.info.push({ message, reply: typeof args[1] === 'string' ? args[1] : undefined });
        return undefined;
      };
    }
  });

  it('生成中途工作区关闭:计划确认抛错走回滚路径,整体失败不落盘', async () => {
    makeRoot();
    // 形态选择器回放时清空工作区:模拟长确认期间工作区被关闭
    ui.inputs = ['Teardown'];
    ui.picks = [
      pickIndex(0),
      items => {
        stubWorkspace.workspaceFolders = [];
        return items[0];
      },
      pickIndex(0)
    ];
    await makeGenerator().runNewEntityWizard();
    expect(ui.error.join('')).toContain('生成失败');
    expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'Teardown.def'))).toBe(false);
  });

  it('注册面 applyEdit 未生效:entities.xml 如实警示,实体不登记不回滚', async () => {
    makeRoot();
    const entitiesPath = path.join(root, 'scripts', 'entities.xml');
    const doc = makeTextDocument(ENTITIES_XML, { uri: Uri.file(entitiesPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    const realApplyEdit = stubWorkspace.applyEdit;
    stubWorkspace.applyEdit = (async (): Promise<boolean> => false) as typeof stubWorkspace.applyEdit;
    try {
      await runWizard('WarnReg', 0, 0, true);
      expect(ui.warning.join('')).toContain('entities.xml 缓冲区写入未生效');
      // 注册未生效但 def/py 已提交:如实完成提示,不回滚
      expect(ui.info.map(item => item.message).join('')).toContain('已生成实体');
      expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'WarnReg.def'))).toBe(true);
    } finally {
      stubWorkspace.applyEdit = realApplyEdit;
    }
  });

  it('缓冲内容与账本偏移错位:回滚按内容比对如实跳过,不误删', async () => {
    makeRoot({ entitiesXml: '<root><BaseThing /></root' });
    const typesXmlPath = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    const doc = makeTextDocument(TYPES_XML, { uri: Uri.file(typesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    const realApplyEdit = stubWorkspace.applyEdit;
    // 篡改落点:同样的文本插到文档 0 偏移(账本记录的 insertIndex 处未动)
    stubWorkspace.applyEdit = (async (edit: {
      entries(): Array<[Uri, Array<{ newText: string }>]>;
    }): Promise<boolean> => {
      const [uriArg, edits] = edit.entries()[0];
      const newText = edits.map(item => item.newText).join('');
      const forged = new WorkspaceEdit();
      forged.insert(uriArg, doc.positionAt(0), newText);
      return realApplyEdit(forged);
    }) as typeof stubWorkspace.applyEdit;
    try {
      await runWizard('Shifted', 2, 0, true);
      // 写入检查通过(文本在场)→ 账本按原 insertIndex 记账;注册失败 → 回滚:
      // 偏移处内容与账本不符 → 跳过,绝不误删用户缓冲内容
      expect(ui.error.join('')).toContain('生成失败');
      expect(doc.getText()).toContain(fixedDictTypeName('Shifted'));
    } finally {
      stubWorkspace.applyEdit = realApplyEdit;
    }
  });

  it('回滚时缓冲已关闭:账本项按「文档不在」如实跳过,文件照常回收', async () => {
    const wsRoot = makeRoot({ entitiesXml: '<root><BaseThing /></root' });
    const typesXmlPath = path.join(wsRoot, 'scripts', 'entity_defs', 'types.xml');
    const doc = makeTextDocument(TYPES_XML, { uri: Uri.file(typesXmlPath), version: 3 });
    stubWorkspace.textDocuments = [doc];
    const realApplyEdit = stubWorkspace.applyEdit;
    // 缓冲写入「生效」但文档随即关闭:直接改缓冲文本并移出 textDocuments
    // (写入检查基于闭包引用仍通过,账本照常入账)
    stubWorkspace.applyEdit = (async (edit: {
      entries(): Array<[Uri, Array<{ newText: string }>]>;
    }): Promise<boolean> => {
      const [, edits] = edit.entries()[0];
      const newText = edits.map(item => item.newText).join('');
      doc.setText(newText + doc.getText());
      stubWorkspace.textDocuments = [];
      return true;
    }) as typeof stubWorkspace.applyEdit;
    try {
      await runWizard('ClosedDoc', 2, 0, true);
      // 注册失败 → 回滚:账本找到的缓冲已不在(textDocuments 空)→ 跳过撤销;
      // 新增 def/py 文件仍按文件面回收
      expect(ui.error.join('')).toContain('生成失败');
      expect(doc.getText()).toContain(fixedDictTypeName('ClosedDoc'));
      expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'ClosedDoc.def'))).toBe(false);
    } finally {
      stubWorkspace.applyEdit = realApplyEdit;
    }
  });

  it('确认后 profile 切换:计划按新 profile 重算并重新追问;再取消零落盘', async () => {
    makeRoot();
    // 模板向导确认回放时真实切换活动 profile(epoch 变)→ 如实播报并重问;
    // 重问取消 → 整体零落盘(IDE-PRJ-013:绝不沿旧预览路径落盘)
    const memento = new Map<string, unknown>();
    const mementoShim = {
      get: <T>(key: string, fallback?: T): T | undefined =>
        memento.has(key) ? (memento.get(key) as T | undefined) : fallback,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    };
    const store = new ProjectProfileStore(mementoShim as unknown as vscode.Memento);
    const first = await store.create({ displayName: 'a', assetsRoot: root, engineRoot: path.join(root, 'eng') });
    const second = await store.create({ displayName: 'b', assetsRoot: root, engineRoot: path.join(root, 'eng2') });
    await setActiveProfile(mementoShim as unknown as vscode.Memento, first.id);
    ui.inputs = ['EpochReask'];
    ui.picks = [
      pickIndex(0),
      async items => {
        await setActiveProfile(mementoShim as unknown as vscode.Memento, second.id);
        return items[0];
      },
      pickNone
    ];
    try {
      await makeGenerator().showTemplates();
      expect(ui.info.map(item => item.message).join('')).toContain('活动 profile 已切换');
      expect(ui.error).toHaveLength(0);
      expect(fs.existsSync(path.join(root, 'scripts', 'entity_defs', 'EpochReask.def'))).toBe(false);
    } finally {
      await setActiveProfile(mementoShim as unknown as vscode.Memento, first.id);
    }
  });
});
