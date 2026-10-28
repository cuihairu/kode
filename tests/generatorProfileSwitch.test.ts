import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import { runGeneratorFormWizard } from '../src/generatorForms';
import { setActiveProfile } from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';
import type * as vscode from 'vscode';
import { Uri, workspace as stubWorkspace, window as stubWindow } from './helpers/vscodeStub';

// IDE-PRJ-013 生成向导响应 profile 切换:实体向导(模板入口)与表单向导的
// 预览与写入路径都按活动 profile 的资产根解析;预览打开期间切换即作废,
// 重算路径要求重新确认,绝不沿旧预览的路径落盘。真实临时目录真实文件,
// 窗口交互经可脚本化 stub 按队列回放。

interface UiScript {
  inputs: string[];
  picks: Array<(items: unknown[]) => unknown>;
  info: string[];
}

const ui: UiScript = { inputs: [], picks: [], info: [] };

const pickLabel = (label: string) => (items: unknown[]): unknown =>
  (items as Array<{ label: string }>).find(item => item.label === label);

const pickConfirm = (items: unknown[]): unknown => pickLabel('确认生成')(items);

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

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

let root = '';
let wsRoot = '';
let profileARoot = '';
let profileBRoot = '';
const generators: KBEngineCodeGenerator[] = [];

const makeAssetsRoot = (target: string): void => {
  fs.mkdirSync(path.join(target, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'scripts', 'entities.xml'),
    ['<root>', '</root>', ''].join('\n'),
    'utf8'
  );
};

const makeProfile = async (
  memento: vscode.Memento,
  displayName: string,
  assetsRoot: string
): Promise<string> => {
  const created = await new ProjectProfileStore(memento).create({
    displayName,
    assetsRoot,
    engineRoot: path.join(root, `eng-${displayName}`)
  });
  return created.id;
};

beforeAll(() => {
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.showInputBox = async (): Promise<string | undefined> => ui.inputs.shift();
  windowish.showQuickPick = async (
    items: unknown[] | Promise<unknown[]>
  ): Promise<unknown> => {
    const resolved = await items;
    const script = ui.picks.shift();
    return script ? script(resolved) : undefined;
  };
  windowish.showInformationMessage = async (...args: unknown[]): Promise<unknown> => {
    const message = String(args[0]);
    ui.info.push(message);
    return undefined;
  };
  windowish.showWarningMessage = async (): Promise<unknown> => undefined;
  windowish.showErrorMessage = async (...args: unknown[]): Promise<unknown> => {
    ui.info.push(`ERROR:${String(args[0])}`);
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
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-gps-'));
  wsRoot = path.join(root, 'ws');
  profileARoot = path.join(root, 'profileA');
  profileBRoot = path.join(root, 'profileB');
  makeAssetsRoot(wsRoot);
  makeAssetsRoot(profileARoot);
  makeAssetsRoot(profileBRoot);

  ui.inputs = [];
  ui.picks = [];
  ui.info = [];

  stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
  stubWorkspace.findFiles = async () => [];
});

afterEach(() => {
  for (const generator of generators) {
    generator.dispose();
  }
  generators.length = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('entity wizard follows the active profile', () => {
  it('previews and writes def, python and entities.xml registration under the profile assets root', async () => {
    const memento = new MemoryMemento();
    const profileAId = await makeProfile(memento, 'A', profileARoot);
    await setActiveProfile(memento, profileAId);
    const generator = new KBEngineCodeGenerator({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    generators.push(generator);

    let previewItems: Array<{ label: string; description?: string }> = [];
    ui.picks = [
      pickLabel('空实体'),
      (items: unknown[]) => {
        previewItems = items as Array<{ label: string; description?: string }>;
        return pickConfirm(items);
      }
    ];
    ui.inputs = ['Hero'];

    await generator.showTemplates();

    // 写入路径全部落在 profile 资产根,工作区同名落点零写入
    expect(fs.existsSync(path.join(profileARoot, 'scripts', 'entity_defs', 'Hero.def'))).toBe(true);
    expect(fs.existsSync(path.join(profileARoot, 'scripts', 'Hero.py'))).toBe(true);
    expect(fs.readFileSync(path.join(profileARoot, 'scripts', 'entities.xml'), 'utf8')).toContain('<Hero ');
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'Hero.py'))).toBe(false);

    // 预览路径=写入路径,都来自所选 profile
    expect(previewItems.find(item => item.label === '新增 .def')?.description)
      .toBe(path.join(profileARoot, 'scripts', 'entity_defs', 'Hero.def'));
    expect(previewItems.find(item => item.label === '新增 Python')?.description)
      .toBe(path.join(profileARoot, 'scripts', 'Hero.py'));
    expect(previewItems.find(item => item.label === '注册 entities.xml')?.description)
      .toContain(path.join(profileARoot, 'scripts', 'entities.xml'));
  }, 15000);

  it('invalidates the open preview when the profile switches and writes along the recomputed paths', async () => {
    const memento = new MemoryMemento();
    const profileAId = await makeProfile(memento, 'A', profileARoot);
    const profileBId = await makeProfile(memento, 'B', profileBRoot);
    await setActiveProfile(memento, profileAId);
    const generator = new KBEngineCodeGenerator({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    generators.push(generator);

    // 第二步确认时模拟预览打开期间切换到 profile B
    ui.picks = [
      pickLabel('空实体'),
      async (items: unknown[]) => {
        await setActiveProfile(memento, profileBId);
        return pickConfirm(items);
      },
      pickConfirm
    ];
    ui.inputs = ['Hero'];

    await generator.showTemplates();

    expect(ui.info).toContain('活动 profile 已切换，生成路径已按新 profile 重算，请重新确认');
    // 旧预览的 profile A 落点零写入,重算后按 profile B 落盘
    expect(fs.existsSync(path.join(profileARoot, 'scripts', 'entity_defs', 'Hero.def'))).toBe(false);
    expect(fs.existsSync(path.join(profileBRoot, 'scripts', 'entity_defs', 'Hero.def'))).toBe(true);
    expect(fs.existsSync(path.join(profileBRoot, 'scripts', 'Hero.py'))).toBe(true);
    expect(fs.readFileSync(path.join(profileBRoot, 'scripts', 'entities.xml'), 'utf8')).toContain('<Hero ');
  }, 15000);

  it('keeps the workspace chain with no profile and with a stale selection', async () => {
    // 无 memento(极简装配):工作区链
    const bare = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    generators.push(bare);
    ui.picks = [pickLabel('空实体'), pickConfirm];
    ui.inputs = ['Hero'];
    await bare.showTemplates();
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Hero.def'))).toBe(true);

    // 陈旧选择(记录已删):如实回落工作区链
    const memento = new MemoryMemento();
    const doomedId = await makeProfile(memento, 'doomed', path.join(root, 'gone'));
    await setActiveProfile(memento, doomedId);
    await new ProjectProfileStore(memento).remove(doomedId);
    const stale = new KBEngineCodeGenerator({ workspaceState: memento } as unknown as vscode.ExtensionContext);
    generators.push(stale);
    ui.picks = [pickLabel('空实体'), pickConfirm];
    ui.inputs = ['Warden'];
    await stale.showTemplates();
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Warden.def'))).toBe(true);
  }, 15000);
});

describe('form wizard follows the active profile', () => {
  it('writes the space form and its entities.xml registration under the profile assets root', async () => {
    const memento = new MemoryMemento();
    const profileAId = await makeProfile(memento, 'A', profileARoot);
    await setActiveProfile(memento, profileAId);

    ui.picks = [pickLabel('空间实体 (space)'), pickConfirm];
    ui.inputs = ['Lobby'];

    await runGeneratorFormWizard({ workspaceState: memento });

    expect(fs.readFileSync(path.join(profileARoot, 'scripts', 'entity_defs', 'Lobby.def'), 'utf8')).toContain('<Space/>');
    expect(fs.readFileSync(path.join(profileARoot, 'scripts', 'entities.xml'), 'utf8')).toContain(
      '<Lobby hasBase="true" hasCell="true" />'
    );
    expect(fs.existsSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Lobby.def'))).toBe(false);
  }, 15000);

  it('invalidates the open preview when the profile switches and writes along the recomputed paths', async () => {
    const memento = new MemoryMemento();
    const profileAId = await makeProfile(memento, 'A', profileARoot);
    const profileBId = await makeProfile(memento, 'B', profileBRoot);
    await setActiveProfile(memento, profileAId);

    ui.picks = [
      pickLabel('空间实体 (space)'),
      async (items: unknown[]) => {
        await setActiveProfile(memento, profileBId);
        return pickConfirm(items);
      },
      pickConfirm
    ];
    ui.inputs = ['Lobby'];

    await runGeneratorFormWizard({ workspaceState: memento });

    expect(ui.info).toContain('活动 profile 已切换，生成路径已按新 profile 重算，请重新确认');
    expect(fs.existsSync(path.join(profileARoot, 'scripts', 'entity_defs', 'Lobby.def'))).toBe(false);
    expect(fs.readFileSync(path.join(profileBRoot, 'scripts', 'entity_defs', 'Lobby.def'), 'utf8')).toContain('<Space/>');
    expect(fs.readFileSync(path.join(profileBRoot, 'scripts', 'entities.xml'), 'utf8')).toContain(
      '<Lobby hasBase="true" hasCell="true" />'
    );
  }, 15000);

  it('keeps the workspace chain when called without a workspaceState', async () => {
    ui.picks = [pickLabel('空间实体 (space)'), pickConfirm];
    ui.inputs = ['Village'];

    await runGeneratorFormWizard();

    expect(fs.readFileSync(path.join(wsRoot, 'scripts', 'entity_defs', 'Village.def'), 'utf8')).toContain('<Space/>');
  }, 15000);
});
