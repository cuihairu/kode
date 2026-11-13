import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { l10n } from './helpers/vscodeStub';
import { setL10nBundle } from './fake-vscode/l10n';
import enBundle from '../l10n/bundle.l10n.json';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { HOOK_CATEGORY_NAMES } from '../src/hooks';
import { PLAYER_TASK_OUTCOME_LABELS } from '../src/backend/playerTaskStatus';
import { quickActionCategoryLabel } from '../src/quickActions';
import { QuickActionTreeProvider } from '../src/quickActionTree';
import { FinalConfigTreeProvider } from '../src/serverConfigMerge';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import {
  GENERATOR_FORM_CHOICES,
  NO_ATTACH_CHOICE,
  PROXY_METHOD_SECTION_CHOICES,
  YES_NO_CHOICES,
  runGeneratorFormWizard
} from '../src/generatorForms';
import { Uri, window as stubWindow, workspace as stubWorkspace } from './helpers/vscodeStub';
import type * as vscode from 'vscode';

// 分类标签双语(用户令:分类标签全量国际化,对齐 vscode.l10n 机制)。
// 两态断言:默认(未注入 bundle)= 英文源串,与真实 VS Code 英文 locale 同口径;
// 注入 zh-cn bundle = 中文,与真实 VS Code 中文 locale 同口径。

type PickCapture = { labels: string[]; placeHolder?: string };

/** 逐个回放 QuickPick:记录选项与 placeHolder 后返回 undefined 中止后续步骤 */
const captureQuickPicks = async (run: () => Promise<void>): Promise<PickCapture[]> => {
  const captured: PickCapture[] = [];
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const original = windowish.showQuickPick;
  windowish.showQuickPick = async (items: unknown, options?: { placeHolder?: string }): Promise<undefined> => {
    const resolved = (await items) as Array<{ label: string }>;
    captured.push({ labels: resolved.map(item => item.label), placeHolder: options?.placeHolder });
    return undefined;
  };
  try {
    await run();
  } finally {
    windowish.showQuickPick = original;
  }
  return captured;
};

afterEach(() => {
  setL10nBundle(null);
  stubWorkspace.workspaceFolders = [];
});

describe('l10n bundle 完整性(分类标签源串全量入包)', () => {
  const collectSources = (): string => {
    const chunks: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(target);
        } else if (entry.name.endsWith('.ts')) {
          chunks.push(fs.readFileSync(target, 'utf8'));
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    return chunks.join('\n');
  };

  /** t()/l10nText() 的字面量源串(直接包的) */
  const sourceLiterals = (): Set<string> => {
    const keys = new Set<string>();
    for (const match of collectSources().matchAll(/l10n(?:\.t|Text)?\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      keys.add(match[1].replace(/\\'/g, "'"));
    }
    return keys;
  };

  /** 经常量表/选择器间接进 t() 的分类源串:字面量扫描抓不到,单独点名对账 */
  const dynamicKeys = (): string[] => [
    ...Object.values(HOOK_CATEGORY_NAMES),
    'Start/Stop Servers',
    'Export Config Tables',
    'BaseMethods',
    'CellMethods',
    'ClientMethods',
    ...GENERATOR_FORM_CHOICES.flatMap(choice => [choice.label, choice.description]),
    ...PROXY_METHOD_SECTION_CHOICES.flatMap(choice => [choice.label, choice.description ?? '']),
    ...YES_NO_CHOICES.flatMap(choice => [choice.label, choice.description ?? '']),
    NO_ATTACH_CHOICE.label,
    NO_ATTACH_CHOICE.description,
    // UX-REVIEW-010d:玩家任务六态标签(PLAYER_TASK_OUTCOME_LABELS 值经
    // l10nText 动态取词,字面量扫描抓不到)
    ...Object.values(PLAYER_TASK_OUTCOME_LABELS)
  ];

  it('英文包与中文包键集一致', () => {
    expect(Object.keys(zhCnBundle).sort()).toEqual(Object.keys(enBundle).sort());
    expect(Object.keys(enBundle).length).toBeGreaterThanOrEqual(100);
    for (const [key, value] of Object.entries(zhCnBundle)) {
      expect(value, `zh-cn 缺译: ${key}`).toBeTruthy();
    }
  });

  it('源码里每个 l10n 字面量源串都有双语条目(正向不漏)', () => {
    const missing = [...sourceLiterals()].filter(key => !(key in enBundle) || !(key in zhCnBundle));
    expect(missing).toEqual([]);
  });

  it('动态传入的分类源串也有双语条目(常量表/选择器)', () => {
    const missing = dynamicKeys().filter(key => !(key in enBundle) || !(key in zhCnBundle));
    expect(missing).toEqual([]);
  });

  it('bundle 无死键:每个键都能在 src 源码里找到原文(反向不腐)', () => {
    const source = collectSources();
    const stale = Object.keys(enBundle).filter(key => !source.includes(key));
    expect(stale).toEqual([]);
  });
});

describe('package.nls 视图分类(侧栏分类标签)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const nlsDefault = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
  const nlsZhCn = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.zh-cn.json'), 'utf8'));
  const views = manifest.contributes.views['kbengine-explorer'] as Array<{ id: string; name: string }>;

  const resolve = (bundle: Record<string, string>): string[] =>
    views.map(view => view.name.replace(/^%([^%]+)%$/, (_m, key: string) => bundle[key] ?? key));

  it('manifest 用 %key% 占位,两个语言包键集一致', () => {
    for (const view of views) {
      expect(view.name, `${view.id} 未走 nls 占位`).toMatch(/^%[^%]+%$/);
    }
    expect(Object.keys(nlsZhCn).sort()).toEqual(Object.keys(nlsDefault).sort());
  });

  it('默认英文 locale 出英文,中文 locale 出中文(正反两态)', () => {
    const en = resolve(nlsDefault);
    const zh = resolve(nlsZhCn);
    // UX-REVIEW-011①:实体视图置顶(用户选定的排序)
    expect(en).toEqual(['Entities', 'Get Started', 'Quick Actions', 'Hot Reload History', 'Servers', 'Component Status (machined discovery)', 'Telnet', 'Player Data (Read-Only)', 'Remote Servers', 'Debug Targets', 'Config', 'File History', 'Selection History']);
    expect(zh).toEqual(['实体', '开始', '快速执行', '热更历史', '服务器', '组件状态（machined 发现）', 'Telnet', '玩家数据(只读)', '远程服务器', '调试目标', '配置', '文件历史', '选区历史']);
    expect(zh).not.toEqual(en);
  });
});

describe('快速执行面板分类(两态)', () => {
  it('扫描清单动作分类:默认英文 / zh-cn 中文', () => {
    expect(quickActionCategoryLabel('server')).toBe('Start/Stop Servers');
    expect(quickActionCategoryLabel('export')).toBe('Export Config Tables');

    setL10nBundle(zhCnBundle);
    expect(quickActionCategoryLabel('server')).toBe('启停服务器');
    expect(quickActionCategoryLabel('export')).toBe('导配置表');
  });

  it('面板分组标题:默认英文 / zh-cn 中文', async () => {
    const make = (): QuickActionTreeProvider => new QuickActionTreeProvider({
      getActions: async () => ({
        registered: [{ name: 'start', type: 'script' as const, target: '/ws/start.bat' }],
        scripts: [{ name: 'cleanup', type: 'script' as const, target: '/ws/cleanup.ps1' }],
        httpRequests: [
          { name: 'health', type: 'http' as const, method: 'GET', target: 'http://127.0.0.1/health', requestIndex: 0 },
          { name: 'login', type: 'http' as const, method: 'POST', target: 'http://127.0.0.1/login', requestIndex: 1 }
        ]
      })
    });

    const enGroups = await make().getChildren();
    expect(enGroups.map(group => group.label)).toEqual(['Registered 1', 'All Scripts 1', 'HTTP Requests 2']);

    setL10nBundle(zhCnBundle);
    const zhGroups = await make().getChildren();
    expect(zhGroups.map(group => group.label)).toEqual(['已登记 1', '全部脚本 1', 'HTTP 请求 2']);
  });
});

describe('配置面板分类标签(两态)', () => {
  it('默认英文 / zh-cn 中文', () => {
    const labelOf = (): string => new FinalConfigTreeProvider().getChildren()[0].label as string;
    expect(labelOf()).toBe('Final Configuration');

    setL10nBundle(zhCnBundle);
    expect(labelOf()).toBe('最终配置');
  });
});

describe('钩子分类标签(两态)', () => {
  const zhByCategory = [
    '实体生命周期', '数据库与归档', '移动', '空间', '传送', '陷阱', 'Cell', '视野', '控制权', '客户端'
  ];

  it('默认英文 / zh-cn 中文,分类键域不变', () => {
    const categories = Object.keys(HOOK_CATEGORY_NAMES);
    expect(categories).toHaveLength(10);
    expect(categories.map(key => l10n.t(HOOK_CATEGORY_NAMES[key as keyof typeof HOOK_CATEGORY_NAMES]))).toEqual([
      'Entity Lifecycle', 'Database & Archiving', 'Movement', 'Space', 'Teleport',
      'Trap', 'Cell', 'Witness', 'Control', 'Client'
    ]);

    setL10nBundle(zhCnBundle);
    expect(categories.map(key => l10n.t(HOOK_CATEGORY_NAMES[key as keyof typeof HOOK_CATEGORY_NAMES]))).toEqual(zhByCategory);
  });
});

describe('实体模板分类(两态)', () => {
  it('模板 QuickPick 选项与 placeHolder 跟随语言', async () => {
    const generator = new KBEngineCodeGenerator({} as unknown as vscode.ExtensionContext);
    try {
      const en = await captureQuickPicks(() => generator.showTemplates());
      expect(en).toHaveLength(1);
      expect(en[0].placeHolder).toBe('Select entity template');
      expect(en[0].labels).toEqual([
        'Account entity', 'Character entity', 'NPC entity', 'Item entity', 'Monster entity',
        'Scene entity', 'Guild entity', 'Team entity', 'Mail entity', 'Empty entity'
      ]);

      setL10nBundle(zhCnBundle);
      const zh = await captureQuickPicks(() => generator.showTemplates());
      expect(zh[0].placeHolder).toBe('选择实体模板');
      expect(zh[0].labels).toEqual([
        '账号实体', '角色实体', 'NPC 实体', '物品实体', '怪物实体',
        '场景实体', '公会实体', '队伍实体', '邮件实体', '空实体'
      ]);
    } finally {
      (generator as unknown as { dispose?: () => void }).dispose?.();
    }
  });
});

describe('实体向导定义形态分类(两态)', () => {
  it('形态 QuickPick 选项与 placeHolder 跟随语言', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    const en = await captureQuickPicks(() => runGeneratorFormWizard());
    expect(en).toHaveLength(1);
    expect(en[0].placeHolder).toBe('Select the definition form to generate');
    expect(en[0].labels).toEqual([
      'Proxy Entity (proxy)', 'Space Entity (space)', 'Component (component)', 'Fixed Dict Type (fixedDict)'
    ]);

    setL10nBundle(zhCnBundle);
    const zh = await captureQuickPicks(() => runGeneratorFormWizard());
    expect(zh[0].placeHolder).toBe('选择要生成的定义形态');
    expect(zh[0].labels).toEqual([
      '代理实体 (proxy)', '空间实体 (space)', '组件 (component)', '固定字典类型 (fixedDict)'
    ]);
  });
});
