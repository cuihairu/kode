/**
 * FOLDER-COLOR-001 呈现面 + 装配(fake-vscode 同形契约)。
 *
 * 契约钉子(provider/装配侧):门关=零装饰输出(即便规则命中);命中文件=
 * badge+ThemeColor+tooltip;目录零输出(钉子⑧:原生 Explorer 无文件夹
 * 底色 API,如实不装);配置/主题变更触发刷新与门联动回调(钉子②运行中
 * 切走 Kode 主题即停);rules 配置校验(脏条目滤除,数组序保留);实体树
 * 四分组图标(钉子⑦)双条件门控换/卸。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  configurationOverrides,
  memoryFileSystem,
  workspace as vscodeWorkspace,
  workspaceEvents,
  workspaceState
} from './fake-vscode/workspaceState';
import type { FolderColorFace } from '../src/backend/folderColorRules';
import { DEFAULT_FOLDER_COLOR_RULES } from '../src/backend/folderColorRules';
import { FolderColorDecorationProvider, folderColorTooltipOf } from '../src/folderColorDecorations';
import {
  activateFolderColorDecorations,
  folderColorGroupIconPath,
  folderColorsEnabledFromConfig,
  folderColorsGateNow,
  folderColorRulesFromConfig
} from '../src/activate/folderColors';
import { ExplorerGroupItem } from '../src/explorerProvidersModel';

const ASSETS_FACE: FolderColorFace = { badge: 'A', colorId: 'charts.orange', semantic: 'assets', process: null };

interface Harness {
  provider: FolderColorDecorationProvider;
  isActive: { value: boolean };
  resolveFace: (fsPath: string) => FolderColorFace | null;
  isDirectory: { value: boolean };
}

const makeHarness = (active = true): Harness => {
  const isActive = { value: active };
  const isDirectory = { value: false };
  const provider = new FolderColorDecorationProvider({
    isActive: () => isActive.value,
    resolveFace: fsPath => (fsPath.startsWith('/ws/assets/') ? ASSETS_FACE : null),
    isDirectory: _fsPath => isDirectory.value
  });
  return { provider, isActive, resolveFace: () => null, isDirectory };
};

const decorate = async (harness: Harness, fsPath: string) =>
  harness.provider.provideFileDecoration(vscode.Uri.file(fsPath), new vscode.CancellationToken());

describe('FolderColorDecorationProvider(文件树角标)', () => {
  it('门关 → 零装饰输出(规则命中也不出)', async () => {
    const harness = makeHarness(false);
    expect(await decorate(harness, '/ws/assets/Avatar.py')).toBeUndefined();
  });

  it('门开 + 命中 → badge/ThemeColor/tooltip', async () => {
    const harness = makeHarness(true);
    const decoration = await decorate(harness, '/ws/assets/Avatar.py')!;
    expect(decoration!.badge).toBe('A');
    expect(decoration!.color).toBeInstanceOf(vscode.ThemeColor);
    expect((decoration!.color as vscode.ThemeColor).id).toBe('charts.orange');
    expect(decoration!.tooltip).toContain('Assets');
  });

  it('目录 → 零输出(钉子⑧:无文件夹底色 API,只装饰文件)', async () => {
    const harness = makeHarness(true);
    harness.isDirectory.value = true;
    expect(await decorate(harness, '/ws/assets/entities')).toBeUndefined();
  });

  it('门开但无规则命中 → 零输出', async () => {
    const harness = makeHarness(true);
    expect(await decorate(harness, '/ws/README.md')).toBeUndefined();
  });

  it('进程面孔 tooltip 带进程名', () => {
    const tooltip = folderColorTooltipOf({ badge: 'B', colorId: 'charts.blue', semantic: 'process', process: 'baseapp' });
    expect(tooltip).toContain('baseapp');
  });

  it('refresh 触发 onDidChangeFileDecorations(VS Code 重渲染)', () => {
    const harness = makeHarness(true);
    let fired = 0;
    harness.provider.onDidChangeFileDecorations(() => {
      fired += 1;
    });
    harness.provider.refresh();
    expect(fired).toBe(1);
  });
});

describe('folderColors 装配面(activate/folderColors)', () => {
  describe('rules 配置校验', () => {
    it('未设置/非数组 → 内置默认', () => {
      expect(folderColorRulesFromConfig(undefined)).toEqual(DEFAULT_FOLDER_COLOR_RULES);
      expect(folderColorRulesFromConfig('nope')).toEqual(DEFAULT_FOLDER_COLOR_RULES);
      expect(folderColorRulesFromConfig(null)).toEqual(DEFAULT_FOLDER_COLOR_RULES);
    });
    it('脏条目滤除(glob 空串/语义未知/非对象),数组序保留', () => {
      const rules = folderColorRulesFromConfig([
        { glob: '', semantic: 'docs', enabled: true },
        { glob: '**/x/**', semantic: 'not-a-semantic', enabled: true },
        'garbage',
        { glob: '**/docs/**', semantic: 'docs' },
        { glob: '**/logs/**', semantic: 'logs', enabled: false }
      ]);
      expect(rules).toEqual([
        { glob: '**/docs/**', semantic: 'docs', enabled: true },
        { glob: '**/logs/**', semantic: 'logs', enabled: false }
      ]);
    });
    it('空数组=用户显式全关(零规则),不回落默认', () => {
      expect(folderColorRulesFromConfig([])).toEqual([]);
    });
  });

  it('总开关默认 true(任务书口径);显式 false 读得到', () => {
    expect(folderColorsEnabledFromConfig({ get: (_k, d) => d })).toBe(true);
    expect(folderColorsEnabledFromConfig({ get: () => false })).toBe(false);
  });

  it('门现值(2026-11-27 用户令:只看 enabled,主题不参与)', () => {
    expect(folderColorsGateNow(true, 'KBEngine (One Dark)')).toBe(true);
    expect(folderColorsGateNow(true, 'Default Dark+')).toBe(true);
    expect(folderColorsGateNow(false, 'KBEngine (One Dark)')).toBe(false);
  });

  describe('实体树四分组图标(钉子⑦)', () => {
    it('门开 → group-<category>.svg;门关 → undefined(走默认 ThemeIcon)', () => {
      const uri = vscode.Uri.file('/ext');
      const icon = folderColorGroupIconPath(uri, 'type', true)!;
      expect(icon.toString()).toContain('resources/icons/folder-colors/group-type.svg');
      expect(folderColorGroupIconPath(uri, 'entity', true)!.toString()).toContain('group-entity.svg');
      expect(folderColorGroupIconPath(uri, 'interface', true)!.toString()).toContain('group-interface.svg');
      expect(folderColorGroupIconPath(uri, 'component', true)!.toString()).toContain('group-component.svg');
      expect(folderColorGroupIconPath(uri, 'type', false)).toBeUndefined();
    });

    it('ExplorerGroupItem:iconPathOverride 覆盖 ThemeIcon;未提供=ThemeIcon', () => {
      const override = folderColorGroupIconPath(vscode.Uri.file('/ext'), 'entity', true)! as vscode.Uri;
      const withIcon = new ExplorerGroupItem('Entities', 'entity', 3, override);
      expect(withIcon.iconPath).toBe(override);
      const fallback = new ExplorerGroupItem('Entities', 'entity', 3);
      expect(fallback.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    });
  });
});

describe('activateFolderColorDecorations(装配到 fake 工作区)', () => {
  let gateChanged = 0;
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    workspaceState.reset();
    gateChanged = 0;
    (vscodeWorkspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
      { uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 }
    ];
    configurationOverrides.set('kbengine', { 'folderColors.enabled': true });
    configurationOverrides.set('workbench', { colorTheme: 'KBEngine (One Dark)' });
    const subscriptions: { dispose(): void }[] = [];
    context = {
      extensionUri: vscode.Uri.file('/ext'),
      subscriptions,
      workspaceState: {
        get: () => undefined,
        update: async () => undefined,
        keys: () => []
      }
    } as unknown as vscode.ExtensionContext;
  });

  afterEach(() => {
    workspaceState.reset();
    (vscodeWorkspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
  });

  it('门开 + docs 命中 → D 角标(经真装配链:配置读取+多根锚定+fs 目录判定)', async () => {
    memoryFileSystem.set('/ws/docs/a.md', 'hello');
    const provider = activateFolderColorDecorations({ context, onGateChanged: () => (gateChanged += 1) });
    const decoration = await provider.provideFileDecoration(
      vscode.Uri.file('/ws/docs/a.md'),
      new vscode.CancellationToken()
    );
    expect(decoration?.badge).toBe('D');
    expect((decoration?.color as vscode.ThemeColor)?.id).toBe('charts.blue');
  });

  it('目录零输出(stat 判目录,钉子⑧)', async () => {
    memoryFileSystem.setDirectory('/ws/docs', [['a.md', 1]]);
    const provider = activateFolderColorDecorations({ context, onGateChanged: () => (gateChanged += 1) });
    const decoration = await provider.provideFileDecoration(
      vscode.Uri.file('/ws/docs'),
      new vscode.CancellationToken()
    );
    expect(decoration).toBeUndefined();
  });

  it('主题切换不再影响门(2026-11-27 用户令:单条件);开关翻转仍即时生效', async () => {
    memoryFileSystem.set('/ws/docs/a.md', 'hello');
    const provider = activateFolderColorDecorations({ context, onGateChanged: () => (gateChanged += 1) });
    configurationOverrides.set('workbench', { colorTheme: 'Default Dark+' });
    const decoration = await provider.provideFileDecoration(
      vscode.Uri.file('/ws/docs/a.md'),
      new vscode.CancellationToken()
    );
    expect(decoration).toBeDefined(); // 非 Kode 主题也出装饰
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (key: string) => key === 'workbench.colorTheme' || key === 'workbench'
    });
    expect(gateChanged).toBe(1);
  });

  it('rules 用户自定义经配置链生效(数组序第一条赢)', async () => {
    memoryFileSystem.set('/ws/docs/a.md', 'hello');
    configurationOverrides.set('kbengine', {
      'folderColors.enabled': true,
      'folderColors.rules': [
        { glob: '**/docs/**', semantic: 'logs', enabled: true },
        { glob: '**/docs/**', semantic: 'venv', enabled: true }
      ]
    });
    const provider = activateFolderColorDecorations({ context, onGateChanged: () => (gateChanged += 1) });
    const decoration = await provider.provideFileDecoration(
      vscode.Uri.file('/ws/docs/a.md'),
      new vscode.CancellationToken()
    );
    expect(decoration?.badge).toBe('L');
  });
});
