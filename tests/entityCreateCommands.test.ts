import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { commands, commandRegistry } from './fake-vscode/commandRegistry';
import { messages, window } from './fake-vscode/windowState';
import { l10n } from './helpers/vscodeStub';
import {
  registerEntityCreateCommands,
  runAddRpcWizard,
  runNewTypeAliasWizard
} from '../src/entityCreateCommands';
import type { GenerationRollbackLedger, KBEngineCodeGenerator } from '../src/codeGenerator';

// RUST-179 命令层编排钉(fake-vscode):计划确认后才落盘(拒绝=零写入)、
// 打开缓冲外的盘上文件走原子写盘并入账、py 脚本缺失时「仅改 def」必须经
// 用户明示、四命令注册与 undo 空账本如实回话。生成器以桩替身注入,
// 持久化/回滚只记调用不断言其内部(那属于 codeGenerator 侧契约)。

interface CreationPaths {
  workspaceRoot: string;
  defRoot: string;
  pythonRoot: string;
  typesXmlPath: string;
}

const makeStubGenerator = (paths: CreationPaths) => {
  const persisted: GenerationRollbackLedger[] = [];
  const rolledBack: GenerationRollbackLedger[] = [];
  const generator = {
    resolveCreationTargetPaths: (): CreationPaths => paths,
    persistGenerationLedger: (ledger: GenerationRollbackLedger): void => {
      persisted.push(ledger);
    },
    rollbackLedger: async (ledger: GenerationRollbackLedger): Promise<void> => {
      rolledBack.push(ledger);
    },
    undoLastGeneration: async (): Promise<boolean> => false
  };
  return {
    generator: generator as unknown as KBEngineCodeGenerator,
    persisted,
    rolledBack
  };
};

const TYPES_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Type>',
  '\t<ITEM_ID> UINT16 </ITEM_ID>',
  '</Type>'
].join('\n');

const HERO_DEF = [
  '<root>',
  '\t<Properties>',
  '\t</Properties>',
  '\t<BaseMethods>',
  '\t\t<onEnterZone>',
  '\t\t\t<Exposed> true </Exposed>',
  '\t\t</onEnterZone>',
  '\t</BaseMethods>',
  '</root>'
].join('\n');

const windowish = window as unknown as Record<string, unknown>;
const originalShowInputBox = windowish.showInputBox;
const originalShowQuickPick = windowish.showQuickPick;
const originalActiveTextEditor = windowish.activeTextEditor;

let inputQueue: Array<string | undefined>;
let pickQueue: Array<unknown>;

beforeEach(() => {
  inputQueue = [];
  pickQueue = [];
  windowish.showInputBox = async () => inputQueue.shift();
  windowish.showQuickPick = async () => pickQueue.shift();
  windowish.activeTextEditor = undefined;
});

afterEach(() => {
  windowish.showInputBox = originalShowInputBox;
  windowish.showQuickPick = originalShowQuickPick;
  windowish.activeTextEditor = originalActiveTextEditor;
  messages.info.length = 0;
  messages.error.length = 0;
});

describe('runNewTypeAliasWizard', () => {
  it('confirms plan then writes alias line to types.xml on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-alias-'));
    const typesXmlPath = path.join(dir, 'types.xml');
    fs.writeFileSync(typesXmlPath, TYPES_XML);
    const { generator, persisted } = makeStubGenerator({
      workspaceRoot: dir,
      defRoot: dir,
      pythonRoot: dir,
      typesXmlPath
    });
    inputQueue = ['GOLD'];
    pickQueue = [{ label: 'UINT32' }, { label: l10n.t('Confirm generation') }];

    await runNewTypeAliasWizard(generator);

    const updated = fs.readFileSync(typesXmlPath, 'utf8');
    expect(updated).toContain('\t<GOLD> UINT32 </GOLD>\n');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].overwrittenFiles[0]?.filePath).toBe(typesXmlPath);
    expect(persisted[0].overwrittenFiles[0]?.previous).toBe(TYPES_XML);
    expect(messages.info.some(message => message.includes('GOLD'))).toBe(true);
  });

  it('declining the plan writes nothing and persists no ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-decline-'));
    const typesXmlPath = path.join(dir, 'types.xml');
    fs.writeFileSync(typesXmlPath, TYPES_XML);
    const { generator, persisted } = makeStubGenerator({
      workspaceRoot: dir,
      defRoot: dir,
      pythonRoot: dir,
      typesXmlPath
    });
    inputQueue = ['GOLD'];
    // 第二次 QuickPick(计划确认)返回计划行以外的东西 = 未确认
    pickQueue = [{ label: 'UINT32' }, { label: l10n.t('Write files per the manifest') }];

    await runNewTypeAliasWizard(generator);

    expect(fs.readFileSync(typesXmlPath, 'utf8')).toBe(TYPES_XML);
    expect(persisted).toHaveLength(0);
  });

  it('missing types.xml is an honest error, not a silent new file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-missing-'));
    const { generator, persisted } = makeStubGenerator({
      workspaceRoot: dir,
      defRoot: dir,
      pythonRoot: dir,
      typesXmlPath: path.join(dir, 'types.xml')
    });
    inputQueue = ['GOLD'];
    pickQueue = [{ label: 'UINT32' }];

    await runNewTypeAliasWizard(generator);

    expect(messages.error.some(message => message.includes('types.xml'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'types.xml'))).toBe(false);
    expect(persisted).toHaveLength(0);
  });
});

describe('runAddRpcWizard', () => {
  it('active editor def + absent py script: writes def after explicit def-only continue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-rpc-'));
    const defPath = path.join(dir, 'Hero.def');
    fs.writeFileSync(defPath, HERO_DEF);
    const pythonRoot = path.join(dir, 'scripts');
    const { generator, persisted } = makeStubGenerator({
      workspaceRoot: dir,
      defRoot: dir,
      pythonRoot,
      typesXmlPath: path.join(dir, 'types.xml')
    });
    windowish.activeTextEditor = { document: { fileName: defPath } };
    inputQueue = ['onOpenBag', ''];
    pickQueue = [
      { label: 'BaseMethods', section: 'BaseMethods' },
      { label: '否(仅引擎内部调用)', value: false },
      { label: '继续:仅改 def(py 脚本不存在,声明无实现)', value: true },
      { label: l10n.t('Confirm generation') }
    ];

    await runAddRpcWizard(generator);

    const updated = fs.readFileSync(defPath, 'utf8');
    expect(updated).toContain('\t\t<onOpenBag>');
    expect(updated).toContain('\t\t</onOpenBag>\n\t</BaseMethods>');
    expect(updated).not.toContain('<Exposed> true </Exposed>\n\t\t\t<Arg>');
    expect(persisted).toHaveLength(1);
    expect(messages.info.some(message => message.includes('onOpenBag'))).toBe(true);
    // py 脚本绝不静默新建
    expect(fs.existsSync(path.join(pythonRoot, 'base', 'Hero.py'))).toBe(false);
  });

  it('duplicate method name is rejected before any preview or write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-create-dup-'));
    const defPath = path.join(dir, 'Hero.def');
    fs.writeFileSync(defPath, HERO_DEF);
    const { generator, persisted } = makeStubGenerator({
      workspaceRoot: dir,
      defRoot: dir,
      pythonRoot: dir,
      typesXmlPath: path.join(dir, 'types.xml')
    });
    windowish.activeTextEditor = { document: { fileName: defPath } };
    inputQueue = ['onEnterZone', ''];
    pickQueue = [
      { label: 'BaseMethods', section: 'BaseMethods' },
      { label: '否(仅引擎内部调用)', value: false }
    ];

    await runAddRpcWizard(generator);

    expect(messages.error.length).toBeGreaterThan(0);
    expect(persisted).toHaveLength(0);
    expect(fs.readFileSync(defPath, 'utf8')).toBe(HERO_DEF);
  });
});

describe('registerEntityCreateCommands', () => {
  it('registers the four creation commands', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    const { generator } = makeStubGenerator({
      workspaceRoot: '/ws',
      defRoot: '/ws',
      pythonRoot: '/ws',
      typesXmlPath: '/ws/types.xml'
    });
    registerEntityCreateCommands({ subscriptions } as unknown as vscode.ExtensionContext, generator);
    const ids = commandRegistry.registeredCommandIds();
    for (const id of [
      'kbengine.entity.addRpc',
      'kbengine.component.new',
      'kbengine.types.new',
      'kbengine.generator.undoLast'
    ]) {
      expect(ids).toContain(id);
    }
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });

  it('undo command reports honestly when there is nothing to undo', async () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    const { generator } = makeStubGenerator({
      workspaceRoot: '/ws',
      defRoot: '/ws',
      pythonRoot: '/ws',
      typesXmlPath: '/ws/types.xml'
    });
    registerEntityCreateCommands({ subscriptions } as unknown as vscode.ExtensionContext, generator);
    await commands.executeCommand('kbengine.generator.undoLast');
    expect(messages.info.some(message => message.includes('没有可撤销的生成记录'))).toBe(true);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });
});
