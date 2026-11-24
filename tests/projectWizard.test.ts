import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  AUTO_START_PRESETS,
  buildComponentPathFacts,
  buildEngineVersionItems,
  buildInterpreterItems,
  buildStartupFacts,
  runProjectWizard,
  summarizeWizard
} from '../src/projectWizard';
import { ProjectProfileStore } from '../src/projectProfiles';
import { setActiveProfile } from '../src/activeProfile';
import { ensureDefaultDeploymentProfile } from '../src/ensureDefaultProfile';
import {
  Uri,
  commands as stubCommands,
  commandRegistry,
  window as stubWindow,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// RUST-172 项目向导:五步(资源 roots→引擎版本→脚本环境→component paths→
// server startup)每步即时落盘,Esc 即停(已完成步骤保留、未到步骤零写);
// 条目构造是纯函数可钉;编排面经 fake-vscode(window 桩 + 配置记账 + 命令
// 真分发)驱动。

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

/** 资产根 + 兄弟引擎仓:kbe/src/lib/entitydef 锚(identifier 口径)+
 * kbe/src/lib/common/kbeversion.h 三宏(findEngineRoot/readEngineVersionMarker
 * 口径),两套标记族并存,探测命中 2.5.10。 */
function buildProjectTree(): { base: string; assetsRoot: string; engineRepoParent: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wizard-'));
  const assetsRoot = path.join(base, 'proj');
  fs.mkdirSync(path.join(assetsRoot, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entity_defs', 'types.xml'), '<root>\n</root>\n', 'utf8');
  // 2026-11-24 语义:安装根 = base/kbe,身份锚 + 版本宏都在安装根下
  fs.mkdirSync(path.join(base, 'kbe', 'res', 'server'), { recursive: true });
  fs.writeFileSync(path.join(base, 'kbe', 'res', 'server', 'kbengine_defaults.xml'), '<r>\n', 'utf8');
  fs.mkdirSync(path.join(base, 'kbe', 'src', 'lib', 'entitydef'), { recursive: true });
  fs.writeFileSync(path.join(base, 'kbe', 'src', 'lib', 'entitydef', 'entitydef.cpp'), '', 'utf8');
  fs.mkdirSync(path.join(base, 'kbe', 'src', 'lib', 'common'), { recursive: true });
  fs.writeFileSync(
    path.join(base, 'kbe', 'src', 'lib', 'common', 'kbeversion.h'),
    '#define KBE_VERSION_MAJOR 2\n#define KBE_VERSION_MINOR 5\n#define KBE_VERSION_PATCH 10\n',
    'utf8'
  );
  return { base, assetsRoot, engineRepoParent: base };
}

const restoreWindow = (): void => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  windowish.showOpenDialog = async (): Promise<undefined> => undefined;
  windowish.showQuickPick = async (): Promise<undefined> => undefined;
};

afterEach(() => {
  restoreWindow();
  stubWorkspace.workspaceFolders = [];
  workspaceState.reset();
  commandRegistry.reset();
});

describe('project wizard 纯构造面(RUST-172)', () => {
  it('buildEngineVersionItems:无探测 → 预设 + 保留当前(尾位 value=null)', () => {
    const items = buildEngineVersionItems('3.7.3', null);
    expect(items[items.length - 1].label).toContain('Keep current version 3.7.3');
    expect(items[items.length - 1].value).toBeNull();
    expect(items[0].label).toContain('3.7.3');
    // 预设来自 ENGINE_VERSION_PRESETS,含官方与 fork 档
    expect(items.some(item => item.value === '2.5.10')).toBe(true);
    expect(items.some(item => item.value === '3.7.3')).toBe(true);
  });

  it('buildEngineVersionItems:探测命中 → 置顶条目带版本与引擎根出处', () => {
    const items = buildEngineVersionItems('3.7.3', { version: '2.5.10', engineRoot: '/eng' });
    expect(items[0].label).toContain('2.5.10');
    expect(items[0].description).toBe('/eng');
    expect(items[0].value).toBe('2.5.10');
  });

  it('buildInterpreterItems:保留当前置顶;设置值/venv 候选随后;PATH 空串不产候选;同值去重', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wizard-interp-'));
    const venvBin = path.join(base, '.venv', 'bin');
    fs.mkdirSync(venvBin, { recursive: true });
    fs.writeFileSync(path.join(venvBin, 'python3'), '', 'utf8');
    const venvPython = path.join(venvBin, 'python3');
    try {
      const items = buildInterpreterItems({
        current: { interpreterPath: null, interpreterSource: 'missing' },
        settingValue: venvPython, // 与 venv 候选同值 → 去重只剩一条
        venvDirectories: ['.venv', 'venv'],
        workspaceRoot: base,
        pathEnv: '', // PATH 道关闭(宿主 PATH 不可钉)
        platform: 'linux'
      });
      expect(items[0].value).toBeNull();
      expect(items[0].label).toContain('missing');
      // 同值去重:设置值先入,venv 候选不再重复入列
      expect(items.slice(1).map(item => item.value)).toEqual([venvPython]);
      expect(items[1].detail).toContain('interpreterPath setting');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('buildComponentPathFacts:scripts 根数/派生环境数/组件默认表/debug.json 状态如实', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wizard-comp-'));
    fs.mkdirSync(path.join(base, 'scripts', 'base'), { recursive: true });
    fs.mkdirSync(path.join(base, 'scripts', 'cell'), { recursive: true });
    try {
      const facts = buildComponentPathFacts({
        workspaceRoot: base,
        assetsRoot: base,
        stubDir: path.join(base, '.kbengine', 'stubs'),
        debugJsonExists: false
      });
      expect(facts[0]).toContain('Scripts roots: 1');
      // base/cell 两角色目录在盘 → 恰两个派生环境
      expect(facts[1]).toContain('environments derived: 2');
      expect(facts[1]).toContain('base/cell');
      expect(facts[2]).toContain('.kbengine/stubs');
      expect(facts[3]).toContain('loginapp:31000');
      expect(facts[4]).toContain('absent');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('buildStartupFacts:bin/config 推导路径与 autoStart 现值', () => {
    const facts = buildStartupFacts({ engineRoot: '/eng', assetsRoot: '/a', autoStart: ['machine'] });
    expect(facts[0]).toContain(path.join('/eng', 'bin', 'server'));
    expect(facts[1]).toContain('/a');
    expect(facts[2]).toContain('machine');
    const empty = buildStartupFacts({ engineRoot: null, assetsRoot: null, autoStart: [] });
    expect(empty[0]).toContain('not set');
    expect(empty[2]).toContain('none');
  });

  it('AUTO_START_PRESETS.all 与 package.json 的 autoStart 枚举面完全一致', () => {
    interface PkgShape {
      contributes: {
        configuration:
          | Array<{ properties: Record<string, { items?: { enum?: string[] } }> }>
          | { properties: Record<string, { items?: { enum?: string[] } }> };
      };
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as PkgShape;
    const configuration = pkg.contributes.configuration;
    const properties = Array.isArray(configuration)
      ? Object.assign({}, ...configuration.map(section => section.properties))
      : configuration.properties;
    const enumItems = properties['kbengine.autoStart'].items?.enum ?? [];
    expect([...enumItems].sort()).toEqual([...AUTO_START_PRESETS.all].sort());
  });

  it('summarizeWizard:空/首步即停/混合三态文案', () => {
    expect(summarizeWizard([])).toContain('nothing done');
    const stopped = summarizeWizard([{ step: 'roots', applied: false, detail: 'no folder picked' }]);
    expect(stopped).toContain('stopped at Asset roots');
    expect(stopped).toContain('nothing written');
    const mixed = summarizeWizard([
      { step: 'roots', applied: true, detail: 'x' },
      { step: 'scriptEnv', applied: false, detail: 'y' }
    ]);
    expect(mixed).toContain('Asset roots: applied');
    expect(mixed).toContain('Script environment: skipped');
  });
});

describe('project wizard 编排面(RUST-172)', () => {
  const installQuickPickRouter = (
    route: (placeHolder: string, items: readonly { label: string }[]) => { label: string } | undefined
  ): void => {
    const windowish = stubWindow as unknown as Record<string, unknown>;
    windowish.showQuickPick = async (
      items: ReadonlyArray<{ label: string }>,
      options?: { placeHolder?: string }
    ): Promise<{ label: string } | undefined> => route(options?.placeHolder ?? '', items);
  };

  const pickByLabel = (fragment: string) =>
    (_placeHolder: string, items: readonly { label: string }[]) =>
      items.find(item => item.label.includes(fragment));

  it('全链五步:roots 落 profile、引擎版本按探测 2.5.10 落设置、启动组落 autoStart;跳过步零写', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const created = await store.create({
      displayName: 'pre',
      assetsRoot: '',
      engineRoot: '',
      interpreterPath: null,
      interpreterSource: 'missing'
    });
    await setActiveProfile(memento, created.id);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    try {
      const windowish = stubWindow as unknown as Record<string, unknown>;
      windowish.showOpenDialog = async (): Promise<[vscode.Uri]> =>
        [Uri.file(assetsRoot) as unknown as vscode.Uri];
      installQuickPickRouter((placeHolder, items) => {
        if (placeHolder.includes('Review the identified layout')) return pickByLabel('Apply roots')('', items);
        if (placeHolder.includes('kbengine.engineVersion')) return pickByLabel('detected version 2.5.10')('', items);
        if (placeHolder.includes('interpreter to record')) return items[0]; // 保留当前
        if (placeHolder.includes('pick an action or continue')) return pickByLabel('Continue without changes')('', items);
        if (placeHolder.includes('current autoStart')) return pickByLabel('preset: managers')('', items);
        if (placeHolder.includes('debug launch entries')) return pickByLabel('Skip launch.json')('', items);
        return undefined;
      });

      const outcomes = await runProjectWizard({ workspaceState: memento });
      expect(outcomes.map(o => o.step)).toEqual(['roots', 'engineVersion', 'scriptEnv', 'componentPaths', 'startup']);
      expect(outcomes.map(o => o.applied)).toEqual([true, true, false, false, true]);

      // roots:识别的四面落活动 profile(engineRoot=identifier 的 kbe/ 目录形态)
      const saved = store.get(created.id);
      expect(saved?.assetsRoot).toBe(assetsRoot);
      expect(saved?.engineRoot).toBe(path.join(base, 'kbe'));

      // engineVersion:探测 2.5.10 → 工作区设置;autoStart → managers 组
      const updates = workspaceState.workspaceConfigurationUpdates;
      expect(updates.some(u => u.key === 'kbengine.engineVersion' && u.value === '2.5.10')).toBe(true);
      expect(updates.some(
        u => u.key === 'kbengine.autoStart'
          && JSON.stringify(u.value) === JSON.stringify(AUTO_START_PRESETS.managers)
      )).toBe(true);
      // 跳过步零写:解释器设置不动
      expect(updates.some(u => u.key === 'kbengine.python.interpreterPath')).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('roots 后任意一步 Esc:后续全跳过,已完成步骤保留,设置零写', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const created = await store.create({
      displayName: 'pre',
      assetsRoot: '',
      engineRoot: '',
      interpreterPath: null,
      interpreterSource: 'missing'
    });
    await setActiveProfile(memento, created.id);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    try {
      const windowish = stubWindow as unknown as Record<string, unknown>;
      windowish.showOpenDialog = async (): Promise<[vscode.Uri]> =>
        [Uri.file(assetsRoot) as unknown as vscode.Uri];
      installQuickPickRouter((placeHolder, items) =>
        placeHolder.includes('Review the identified layout') ? pickByLabel('Apply roots')('', items) : undefined
      );

      const outcomes = await runProjectWizard({ workspaceState: memento });
      expect(outcomes.length).toBe(5);
      expect(outcomes.map(o => o.applied)).toEqual([true, false, false, false, false]);
      // roots 已保留在 profile;其余四面零写
      expect(store.get(created.id)?.assetsRoot).toBe(assetsRoot);
      expect(workspaceState.workspaceConfigurationUpdates).toEqual([]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('roots 步 Esc(未选目录):只有一步、零写、profile 不动', async () => {
    const { base } = buildProjectTree();
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const created = await store.create({
      displayName: 'pre',
      assetsRoot: 'old-root',
      engineRoot: '',
      interpreterPath: null,
      interpreterSource: 'missing'
    });
    await setActiveProfile(memento, created.id);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    try {
      const outcomes = await runProjectWizard({ workspaceState: memento });
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].step).toBe('roots');
      expect(outcomes[0].applied).toBe(false);
      expect(store.get(created.id)?.assetsRoot).toBe('old-root');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('component paths 步动作项转发既有命令(真分发记账)', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const created = await store.create({
      displayName: 'pre',
      assetsRoot: '',
      engineRoot: '',
      interpreterPath: null,
      interpreterSource: 'missing'
    });
    await setActiveProfile(memento, created.id);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    const executed: string[] = [];
    stubCommands.registerCommand('kbengine.python.syncExtraPaths', () => {
      executed.push('kbengine.python.syncExtraPaths');
    });
    try {
      const windowish = stubWindow as unknown as Record<string, unknown>;
      windowish.showOpenDialog = async (): Promise<[vscode.Uri]> =>
        [Uri.file(assetsRoot) as unknown as vscode.Uri];
      installQuickPickRouter((placeHolder, items) => {
        if (placeHolder.includes('Review the identified layout')) return pickByLabel('Apply roots')('', items);
        if (placeHolder.includes('kbengine.engineVersion')) return pickByLabel('Keep current version')('', items);
        if (placeHolder.includes('interpreter to record')) return items[0];
        if (placeHolder.includes('pick an action or continue')) return pickByLabel('Run Python wiring sync')('', items);
        if (placeHolder.includes('current autoStart')) return pickByLabel('Keep current autoStart group')('', items);
        if (placeHolder.includes('debug launch entries')) return pickByLabel('Skip launch.json')('', items);
        return undefined;
      });

      const outcomes = await runProjectWizard({ workspaceState: memento });
      expect(outcomes.find(o => o.step === 'componentPaths')).toMatchObject({
        applied: true,
        detail: 'kbengine.python.syncExtraPaths'
      });
      expect(executed).toEqual(['kbengine.python.syncExtraPaths']);
      // 保留当前版本/保留启动组 → 引擎版本与 autoStart 零写
      expect(workspaceState.workspaceConfigurationUpdates).toEqual([]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('无活动 profile 时先种默认档再走流程(kbe/ 形态的显式根归一后探测仍命中)', async () => {
    const { base, assetsRoot } = buildProjectTree();
    const memento = new MemoryMemento();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    try {
      const windowish = stubWindow as unknown as Record<string, unknown>;
      windowish.showOpenDialog = async (): Promise<[vscode.Uri]> =>
        [Uri.file(assetsRoot) as unknown as vscode.Uri];
      // roots 步即 Esc:只验种子档建立,流程一步即停
      const outcomes = await runProjectWizard(
        { workspaceState: memento },
        {
          ensureProfile: deps => ensureDefaultDeploymentProfile({
            ...deps,
            resolveAssetsRoot: () => assetsRoot,
            resolveInterpreter: () => ({ interpreterPath: null, interpreterSource: 'missing' })
          })
        }
      );
      const store = new ProjectProfileStore(memento);
      expect(store.list().length).toBe(1);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].applied).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('无工作区/种不出 profile:警告 + 零步零写', async () => {
    stubWorkspace.workspaceFolders = [];
    await expect(runProjectWizard({ workspaceState: new MemoryMemento() })).resolves.toEqual([]);

    const { base } = buildProjectTree();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(base), name: 'base', index: 0 }];
    try {
      const outcomes = await runProjectWizard(
        { workspaceState: new MemoryMemento() },
        { ensureProfile: async () => null }
      );
      expect(outcomes).toEqual([]);
      const windowish = stubWindow as unknown as Record<string, unknown>;
      expect(windowish.showOpenDialog).toBeDefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
