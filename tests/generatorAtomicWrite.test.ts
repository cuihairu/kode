import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KBEngineCodeGenerator, createGenerationRollbackLedger } from '../src/codeGenerator';
import { generateGeneratorForm } from '../src/generatorForms';
import { writeFileAtomic } from '../src/atomicFileWrite';
import type * as vscode from 'vscode';
import { Uri, window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-GEN-005:生成器写盘走原子替换(同目录临时文件+rename 落位)。
// 中断模拟:vi.mock 包一层 fs.writeFileSync,对目标文件与临时文件先写
// 半截再抛错——直写实现会把旧文件截断成半截文本(红),原子实现只在
// 临时文件上留下残迹并清理,旧文件字节原封(绿)。vitest 的 fs 命名空间
// 冻结不可直改,故走 vi.mock(对 src 模块同图生效)。

const interruptState = vi.hoisted(() => ({
  targets: [] as string[]
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWriteFileSync = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: ((target: unknown, data: unknown, options: unknown) => {
      const targetPath = typeof target === 'string' ? target : '';
      // 目标或其原子临时文件(目标路径.kode-tmp-*)都拦:直写实现拦目标,
      // 原子实现拦它的临时文件
      const interrupted = interruptState.targets.some(
        item => targetPath === item || targetPath.startsWith(`${item}.kode-tmp`)
      );
      if (interrupted) {
        realWriteFileSync(targetPath, String(data).slice(0, 20), 'utf8');
        throw new Error('simulated interruption');
      }
      return realWriteFileSync(target as never, data as never, options as never);
    }) as typeof realWriteFileSync
  };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-atomic-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
});

afterEach(() => {
  interruptState.targets = [];
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generator atomic writes (IDE-GEN-005)', () => {
  it('keeps entities.xml intact when the registration write is interrupted', async () => {
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const original = [
      '<root>',
      '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />',
      '  <OtherThing hasBase="true" hasCell="true" hasClient="false" />',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(entitiesXml, original, 'utf8');

    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    interruptState.targets = [entitiesXml];

    await expect(
      generator.registerInEntitiesXml({ name: 'Monster', hasBase: true, hasCell: false, hasClient: false }, createGenerationRollbackLedger())
    ).rejects.toThrow('simulated interruption');

    // 旧文件保持完整,没有半截文本,也没有临时文件残留
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(root, 'scripts')).sort()).toEqual(['entities.xml', 'entity_defs']);
  });

  it('keeps types.xml intact when the fixed dict write is interrupted', async () => {
    const typesXml = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    const original = [
      '<root>',
      '  <ITEM_ID>',
      '    <Type>UINT32</Type>',
      '  </ITEM_ID>',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(typesXml, original, 'utf8');
    interruptState.targets = [typesXml];

    await expect(
      generateGeneratorForm(
        { kind: 'fixedDict', value: { name: 'AVATAR_DATA', properties: [{ name: 'value', type: 'UINT32' }] } },
        root
      )
    ).rejects.toThrow('simulated interruption');

    expect(fs.readFileSync(typesXml, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(root, 'scripts', 'entity_defs')).sort()).toEqual(['types.xml']);
  });

  it('writeFileAtomic creates a new file and fully replaces an existing one', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'fresh.txt');
    writeFileAtomic(target, 'first');
    expect(fs.readFileSync(target, 'utf8')).toBe('first');

    writeFileAtomic(target, 'second-complete-content');
    expect(fs.readFileSync(target, 'utf8')).toBe('second-complete-content');
    // 落位后目录里只有目标文件,无临时残留
    expect(fs.readdirSync(dir)).toEqual(['fresh.txt']);
  });

  it('writeFileAtomic leaves the target untouched and cleans the temp file when interrupted', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'kept.txt');
    fs.writeFileSync(target, 'original-full-content', 'utf8');
    interruptState.targets = [target];

    expect(() => writeFileAtomic(target, 'new-content-that-never-lands')).toThrow('simulated interruption');

    expect(fs.readFileSync(target, 'utf8')).toBe('original-full-content');
    expect(fs.readdirSync(dir)).toEqual(['kept.txt']);
  });

  it('writeFileAtomic noClobber refuses to overwrite a concurrently-created file', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'guarded.txt');
    fs.writeFileSync(target, '并发先到的内容', 'utf8');

    expect(() => writeFileAtomic(target, '本次要写的内容', { noClobber: true })).toThrow();

    // 并发先到的文件字节原样,无临时残留
    expect(fs.readFileSync(target, 'utf8')).toBe('并发先到的内容');
    expect(fs.readdirSync(dir)).toEqual(['guarded.txt']);
  });

  it('writeFileAtomic noClobber lands when the target is absent', () => {
    const dir = path.join(root, 'unit');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'fresh-guarded.txt');

    writeFileAtomic(target, 'fresh-content', { noClobber: true });

    expect(fs.readFileSync(target, 'utf8')).toBe('fresh-content');
    expect(fs.readdirSync(dir)).toEqual(['fresh-guarded.txt']);
  });
});

describe('form generation rollback (IDE-GEN-008)', () => {
  it('rolls back the space def when the entities.xml write fails', async () => {
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const original = [
      '<root>',
      '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />',
      '</root>',
      ''
    ].join('\n');
    fs.writeFileSync(entitiesXml, original, 'utf8');
    const defPath = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
    interruptState.targets = [entitiesXml];

    await expect(
      generateGeneratorForm({ kind: 'space', value: { name: 'MySpace' } }, root)
    ).rejects.toThrow('simulated interruption');

    // def 已写出但 entities.xml 写入失败:本次新增文件回收,旧注册原样
    expect(fs.existsSync(defPath)).toBe(false);
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(original);
  });
});

describe('multi-file rollback (IDE-GEN-006)', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const originalWindow: Record<string, unknown> = {};
  const windowKeys = ['showInputBox', 'showQuickPick', 'showInformationMessage', 'showErrorMessage'];
  const originalFindFiles = stubWorkspace.findFiles;
  const originalOpenTextDocument = stubWorkspace.openTextDocument;
  const info: string[] = [];
  const error: string[] = [];

  beforeAll(() => {
    for (const key of windowKeys) {
      originalWindow[key] = windowish[key];
    }
    windowish.showInputBox = async (): Promise<string | undefined> => 'Rollback';
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = await items;
      return resolved[0];
    };
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      info.push(message);
      return message.includes('是否打开') ? '是' : undefined;
    };
    windowish.showErrorMessage = async (message: string): Promise<unknown> => {
      error.push(message);
      return undefined;
    };
  });

  afterAll(() => {
    for (const key of windowKeys) {
      if (originalWindow[key] === undefined) {
        delete windowish[key];
      } else {
        windowish[key] = originalWindow[key];
      }
    }
    stubWorkspace.findFiles = originalFindFiles;
    stubWorkspace.openTextDocument = originalOpenTextDocument;
    stubWorkspace.workspaceFolders = [];
  });

  beforeEach(() => {
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      ['<root>', '  <BaseThing hasBase="true" hasCell="false" hasClient="false" />', '</root>', ''].join('\n'),
      'utf8'
    );
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = async () => [];
    info.length = 0;
    error.length = 0;
  });

  it('rolls back the def file when the python write fails', async () => {
    const defPath = path.join(root, 'scripts', 'entity_defs', 'Rollback.def');
    const pyPath = path.join(root, 'scripts', 'base', 'Rollback.py');
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const entitiesBefore = fs.readFileSync(entitiesXml, 'utf8');
    // 只拦 python 面的写(直写或其临时文件):def 落盘成功后 python 中断
    interruptState.targets = [pyPath];

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.showWizard();

    expect(error).toHaveLength(1);
    expect(error[0]).toContain('生成失败');
    // 第一份新增文件被回收,python 没有半截,entities.xml 无本次注册项
    expect(fs.existsSync(defPath)).toBe(false);
    expect(fs.existsSync(pyPath)).toBe(false);
    expect(fs.readFileSync(entitiesXml, 'utf8')).toBe(entitiesBefore);
  });

  it('keeps files and registration when the post-commit open step fails (AUD-064)', async () => {
    const defPath = path.join(root, 'scripts', 'entity_defs', 'Rollback.def');
    const pyPath = path.join(root, 'scripts', 'base', 'Rollback.py');
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');
    const entitiesBefore = fs.readFileSync(entitiesXml, 'utf8');
    // 提交边界后,打开生成的文件一步失败:已提交事务绝不被回滚
    stubWorkspace.openTextDocument = (async (): Promise<never> => {
      throw new Error('open failed');
    }) as unknown as typeof stubWorkspace.openTextDocument;

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.showWizard();

    expect(error).toHaveLength(1);
    expect(error[0]).toContain('打开生成文件失败');
    // 本次产物与注册项全部保留(事务已提交)
    expect(fs.existsSync(defPath)).toBe(true);
    expect(fs.existsSync(pyPath)).toBe(true);
    expect(fs.readFileSync(entitiesXml, 'utf8')).not.toBe(entitiesBefore);
    expect(fs.readFileSync(entitiesXml, 'utf8')).toContain('<Rollback ');
  });

  it('two overlapping wizards on one instance keep each other files (AUD-064)', async () => {
    const firstDef = path.join(root, 'scripts', 'entity_defs', 'FirstA.def');
    const secondDef = path.join(root, 'scripts', 'entity_defs', 'SecondB.def');
    const entitiesXml = path.join(root, 'scripts', 'entities.xml');

    // 实体名按调用次序分配,避免 Second 与 First 撞名
    const nameQueue = ['FirstA', 'SecondB'];
    const savedInputBox = windowish.showInputBox;
    windowish.showInputBox = async (): Promise<string | undefined> => nameQueue.shift() ?? 'Rollback';

    // First 停在"是否打开"提示(手动闸门),Second 在同一实例上跑完
    let openPromptCount = 0;
    let releaseFirstOpen: (() => void) | undefined;
    const firstOpenGate = new Promise<unknown>(resolve => {
      releaseFirstOpen = () => resolve('是');
    });
    const savedInfoMessage = windowish.showInformationMessage;
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      if (message.includes('是否打开')) {
        openPromptCount++;
        if (openPromptCount === 1) {
          return firstOpenGate;
        }
        return '否';
      }
      return undefined;
    };
    // 打开文件一步抛错:旧共享账本会把 Second 的成功产物一并回滚
    stubWorkspace.openTextDocument = (async (): Promise<never> => {
      throw new Error('open failed');
    }) as unknown as typeof stubWorkspace.openTextDocument;

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    const first = generator.showWizard(); // 停在打开提示,产物已落盘
    const second = generator.showWizard(); // 同实例第二次,完整跑完并选"否"
    await second;
    releaseFirstOpen?.();
    await first;

    expect(error).toHaveLength(1);
    expect(error[0]).toContain('打开生成文件失败');
    // 两调用的产物都在:Second 不被 First 的回滚误删,First 自身也未回滚
    expect(fs.existsSync(firstDef)).toBe(true);
    expect(fs.existsSync(secondDef)).toBe(true);
    const xml = fs.readFileSync(entitiesXml, 'utf8');
    expect(xml).toContain('<FirstA ');
    expect(xml).toContain('<SecondB ');

    windowish.showInputBox = savedInputBox;
    windowish.showInformationMessage = savedInfoMessage;
  });

  it('template flow rolls back the same way', async () => {
    const defPath = path.join(root, 'scripts', 'entity_defs', 'Rollback.def');
    const pyPath = path.join(root, 'scripts', 'base', 'Rollback.py');
    interruptState.targets = [pyPath];
    windowish.showInputBox = async (): Promise<string | undefined> => 'Rollback';

    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    await generator.showTemplates();

    expect(error).toHaveLength(1);
    expect(error[0]).toContain('生成失败');
    expect(fs.existsSync(defPath)).toBe(false);
    expect(fs.existsSync(pyPath)).toBe(false);
  });
});
